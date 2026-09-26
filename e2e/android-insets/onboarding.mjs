// First-run setup for the inset test: accepts the startup modals, imports the
// public BIP39 test vector as a secret and creates one Ethereum account, so
// the fixed signing requests in fixtures/requests.json resolve to a wallet.
//
// It runs as a small state machine keyed on the current route and the topmost
// overlay, because the startup modals and system credential prompts do not
// always appear in the same order across Android versions.

const LABEL = 'E2E test'

// Clicks the innermost visible element whose text matches, then its closest
// clickable ancestor, so the click reaches the Angular (click) handler.
const CLICK_TEXT = `function (re, scopeSel) {
  var rx = new RegExp(re, 'i')
  var scopes = scopeSel ? __visible(scopeSel) : [document.body]
  var scope = scopes[scopes.length - 1] || document.body
  var all = Array.prototype.slice.call(scope.querySelectorAll('*')).filter(function (el) { return rx.test(__text(el)) && __shown(el) })
  var leaves = all.filter(function (el) { return !all.some(function (o) { return o !== el && el.contains(o) }) })
  var hit = leaves[leaves.length - 1]
  if (!hit) return false
  var target = hit.closest('ion-button, button, ion-item, ion-card, ion-tab-button') || hit
  target.click()
  return __text(target) || true
}`

const clickText = (cdp, re, scopeSel) =>
  cdp.eval('(' + CLICK_TEXT + ')(' + JSON.stringify(re) + ', ' + JSON.stringify(scopeSel ?? null) + ')')

const probe = (cdp) =>
  cdp.eval(`(function () {
    var overlay = __visible('ion-modal, ion-alert, ion-popover').pop()
    var page = __visible('.ion-page:not(.ion-page-hidden) ion-content').pop() || document.body
    return {
      path: location.pathname,
      overlay: overlay ? overlay.tagName.toLowerCase() : null,
      loading: __visible('ion-loading').length > 0,
      text: __text(overlay || document.body).slice(0, 600),
      pageText: __text(page).slice(0, 600)
    }
  })()`)

const WORD_COUNT = "__visible('.secret--container__inner ion-button').map(__text).filter(function (t) { return /[a-z]/.test(t) }).length"

// Text typed so far for the current word, as shown above the keyboard. The
// span is empty (zero width) between words, so read it through its container.
const TYPED = "(function () { var c = __visible('.input--container').pop(); if (!c) return null; var s = c.querySelector('span'); return s ? (s.textContent || '').trim() : '' })()"
const keyReady = (letter) =>
  "(function () { var k = document.getElementById('key-" + letter + "'); return !!k && __shown(k) && !k.disabled && !k.hasAttribute('disabled') })()"
const clickKey = (letter) => "(function () { document.getElementById('key-" + letter + "').click(); return true })()"
const clickSuggestion = (word) =>
  "(function () { var s = __visible('.suggestion--container ion-button').filter(function (b) { return __text(b) === " + JSON.stringify(word) + " })[0]; s && s.click(); return !!s })()"

async function poll(cdp, expr, sleep, timeout) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await cdp.eval(expr).catch(() => undefined)
    if (v) return v
    if (Date.now() > end) return v
    await sleep(100)
  }
}

// Types the mnemonic on Vault's own keyboard. Every step waits for the page to
// reflect the previous one, so slow emulators (CI without GPU) do not drop or
// double letters: the keyboard renders late after navigation, and each key
// press repaints it.
async function typeMnemonic(cdp, words, sleep) {
  if (!(await poll(cdp, keyReady(words[0][0]), sleep, 20_000))) throw new Error('mnemonic keyboard did not appear')
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const fail = (why) => new Error('could not enter word ' + (i + 1) + ' of the test mnemonic: ' + why)
    const before = await cdp.eval(WORD_COUNT)
    const committed = () => poll(cdp, WORD_COUNT + ' > ' + before, sleep, 3000)
    if ((await poll(cdp, TYPED + " === ''", sleep, 3000)) !== true) throw fail('input not empty')
    let done = false
    for (let n = 0; n < word.length && !done; n++) {
      // Several words share the prefix: pick the exact suggestion once shown.
      if (n > 0 && (await cdp.eval(clickSuggestion(word)))) {
        done = await committed()
        break
      }
      if (!(await poll(cdp, keyReady(word[n]), sleep, 3000))) throw fail('key ' + word[n] + ' disabled after ' + word.slice(0, n))
      await cdp.eval(clickKey(word[n]))
      // Either the prefix shows up, or the word was completed and committed.
      const prefix = JSON.stringify(word.slice(0, n + 1))
      const moved = await poll(cdp, '(' + TYPED + ' === ' + prefix + ') || (' + WORD_COUNT + ' > ' + before + ')', sleep, 3000)
      if (!moved) throw fail('letter ' + word[n] + ' not registered')
      if (await cdp.eval(WORD_COUNT + ' > ' + before)) done = true
    }
    if (!done && !(await cdp.eval(clickSuggestion(word)))) throw fail('no suggestion for ' + word)
    if (!done && !(await committed())) throw fail('word not committed')
  }
}

const FAB = "__visible('ion-fab ion-button')[0]"
const ETH_ITEM = "__visible('ion-item').filter(function (i) { return /^Ethereum ETH/.test(__text(i)) })[0]"

export async function runOnboarding(ctx) {
  const { cdp, fixtures, sleep, answerAuthPrompt, log, screenshot, tapElement } = ctx
  const words = fixtures.mnemonic.split(' ')
  const deadline = Date.now() + 300_000
  let last = ''
  let stuck = 0
  let createRequested = false

  while (Date.now() < deadline) {
    if (await answerAuthPrompt(300)) continue
    const s = await probe(cdp).catch(() => undefined)
    if (!s) {
      await sleep(500)
      continue
    }
    const key = s.path + '|' + s.overlay + '|' + s.text.slice(0, 80)
    stuck = key === last ? stuck + 1 : 0
    last = key
    if (stuck === 0) log('onboarding at', s.path, s.overlay ?? '', s.text.slice(0, 80))
    if (stuck > 40) {
      screenshot('onboarding-stuck')
      throw new Error('onboarding stuck at ' + s.path + ' (' + (s.overlay ?? 'no overlay') + '): ' + s.text.slice(0, 200))
    }
    if (s.loading) {
      await sleep(500)
      continue
    }

    if (s.path.startsWith('/account-address') && createRequested) {
      log('onboarding done: Ethereum account created')
      return
    }

    if (s.overlay) {
      if (/Device Unsecure/i.test(s.text)) throw new Error('Vault reports that the device lock screen is not set up')
      if (/Installation Type/i.test(s.text)) {
        await clickText(cdp, '^offline', 'ion-modal')
        await sleep(300)
        await clickText(cdp, '^Continue$', 'ion-modal')
      } else {
        await clickText(cdp, '^(Read Disclaimer|I understand and accept|Understood|Authenticate|Skip|Continue|Next|Got it|OK|Done)$', s.overlay)
      }
      await sleep(700)
      continue
    }

    if (/^\/secret-setup/.test(s.path)) {
      await clickText(cdp, '^Import Recovery Phrase$')
    } else if (s.path.startsWith('/secret-import')) {
      await typeMnemonic(cdp, words, sleep)
      await sleep(300)
      await cdp.eval('(function () { var b = ' + FAB + '; b && b.click(); return !!b })()')
    } else if (s.path.startsWith('/secret-add')) {
      await cdp.eval(`(async function () {
        var native = await __visible('ion-input')[0].getInputElement()
        native.focus()
        native.value = ${JSON.stringify(LABEL)}
        native.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await sleep(400)
      await cdp.eval('(function () { var b = ' + FAB + '; b && b.click(); return !!b })()')
    } else if (s.path.startsWith('/account-add')) {
      const checked = await cdp.eval('(function () { var i = ' + ETH_ITEM + '; return !!i && i.querySelector("ion-checkbox").checked })()')
      if (!checked) {
        // Real tap: a programmatic click on this checkbox does not update the form.
        await tapElement(cdp, ETH_ITEM + '.querySelector("ion-checkbox")')
        await sleep(700)
        continue
      }
      if (await cdp.eval('(function () { var b = ' + FAB + '; return !!b && !b.disabled })()')) {
        await tapElement(cdp, FAB)
        createRequested = true
        await answerAuthPrompt(6000)
      }
    } else if (/^\/(tabs\/tab-secrets|accounts-list)$/.test(s.path) && /Create a new account/i.test(s.pageText)) {
      // The secret exists but has no account yet, e.g. an interrupted earlier run.
      await cdp.eval("(function () { var b = __visible('ion-header ion-button'); b.length && b[b.length - 1].click(); return b.length })()")
      await sleep(800)
      await clickText(cdp, '^Add Account$', 'ion-popover')
    } else if (s.path.startsWith('/tabs/tab-secrets')) {
      const cards = await cdp.eval("__visible('ion-card').map(__text)")
      if (cards.includes(LABEL)) await clickText(cdp, '^' + LABEL + '$')
      else await cdp.eval("(function () { var c = __visible('ion-card.add-secret_card')[0]; c && c.click(); return !!c })()")
    }
    await sleep(700)
  }
  screenshot('onboarding-timeout')
  throw new Error('onboarding timed out')
}
