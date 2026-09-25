#!/usr/bin/env node
// Android system bar regression test for AirGap Vault (issue #247).
//
// Installs one APK on one device or emulator, then checks with real touches
// that the signing button, the header back button and the tab bar stay inside
// the area not covered by the status and navigation bars. The checks run on a
// cold start and after visiting the Scanner tab, which is where 3.34.x broke.
//
// Requires Node 22+, adb on PATH, and a debuggable build (WebView inspection).
// Exit code: 0 all assertions passed, 1 assertion failures, 2 harness error.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { runOnboarding } from './onboarding.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { values: opts } = parseArgs({
  options: {
    apk: { type: 'string' },
    nav: { type: 'string' },
    out: { type: 'string', default: 'results' },
    serial: { type: 'string' },
    package: { type: 'string', default: 'it.airgap.vault' },
    pin: { type: 'string', default: '1111' },
    'cdp-port': { type: 'string', default: '9333' },
    'skip-install': { type: 'boolean', default: false },
    'skip-onboarding': { type: 'boolean', default: false },
    label: { type: 'string', default: '' }
  }
})

const PKG = opts.package
const OUT = opts.out
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures', 'requests.json'), 'utf8'))
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- adb helpers

function adb(args, { allowFail = false, binary = false, timeout = 120_000 } = {}) {
  const full = opts.serial ? ['-s', opts.serial, ...args] : args
  const r = spawnSync('adb', full, { encoding: binary ? 'buffer' : 'utf8', timeout, maxBuffer: 256 << 20 })
  if ((r.status !== 0 || r.error) && !allowFail) {
    throw new Error('adb ' + args.join(' ') + ' failed: ' + (r.error?.message ?? r.stderr?.toString() ?? r.status))
  }
  return binary ? r.stdout : (r.stdout ?? '').toString()
}
const sh = (cmd, o) => adb(['shell', cmd], o)
const log = (...a) => console.log('[' + new Date().toISOString().slice(11, 19) + ']', ...a)

async function waitFor(what, fn, { timeout = 30_000, interval = 500 } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e
    }
    await sleep(interval)
  }
  throw new Error('timed out waiting for ' + what + (last instanceof Error ? ': ' + last.message : ''))
}

function currentFocus() {
  const out = sh('dumpsys window', { allowFail: true })
  const m = out.match(/mCurrentFocus=Window\{\S+ \S+ ([^}]+)\}/)
  return m ? m[1].trim() : ''
}

function screenshot(name) {
  const png = adb(['exec-out', 'screencap', '-p'], { binary: true, allowFail: true })
  if (png && png.length > 1000) {
    const file = name + '.png'
    writeFileSync(join(OUT, file), png)
    return file
  }
  return undefined
}

// ------------------------------------------------------------- device state

function deviceInfo() {
  const prop = (p) => sh('getprop ' + p).trim()
  const wv = sh('dumpsys webviewupdate', { allowFail: true }).match(/Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/)
  const size = sh('wm size').match(/(\d+)x(\d+)/)
  const density = sh('wm density').match(/(\d+)\s*$/m)
  return {
    model: prop('ro.product.model'),
    api: Number(prop('ro.build.version.sdk')),
    release: prop('ro.build.version.release'),
    webview: wv ? wv[1] + ' ' + wv[2] : 'unknown',
    webviewMajor: wv ? Number(wv[2].split('.')[0]) : undefined,
    screen: size ? { width: Number(size[1]), height: Number(size[2]) } : undefined,
    density: density ? Number(density[1]) : undefined
  }
}

const NAV_OVERLAY = {
  gestural: 'com.android.internal.systemui.navbar.gestural',
  threebutton: 'com.android.internal.systemui.navbar.threebutton'
}
const NAV_MODE = { threebutton: '0', gestural: '2' }

async function setNavigation(mode) {
  if (!mode) return { threebutton: '0', gestural: '2' }[sh('settings get secure navigation_mode', { allowFail: true }).trim()] ?? 'unknown'
  if (!NAV_OVERLAY[mode]) throw new Error('unknown --nav ' + mode)
  sh('cmd overlay enable-exclusive --category ' + NAV_OVERLAY[mode])
  await waitFor('navigation mode ' + mode, () => sh('settings get secure navigation_mode').trim() === NAV_MODE[mode], { timeout: 20_000 })
  await sleep(2000) // let SystemUI relayout the navigation bar
  return mode
}

// Visible system bar frames in screen pixels, from WindowManager's insets state.
function systemBars() {
  const out = sh('dumpsys window')
  const re = /InsetsSource (?:id=\S+ )?type=(ITYPE_STATUS_BAR|ITYPE_NAVIGATION_BAR|statusBars|navigationBars) frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\] visible=(true|false)/g
  const bars = { status: [], navigation: [] }
  for (const m of out.matchAll(re)) {
    if (m[6] !== 'true') continue
    const frame = { left: +m[2], top: +m[3], right: +m[4], bottom: +m[5] }
    if (frame.bottom <= frame.top) continue
    ;(/STATUS|status/.test(m[1]) ? bars.status : bars.navigation).push(frame)
  }
  const statusBottom = Math.max(0, ...bars.status.map((f) => f.bottom))
  const navTops = bars.navigation.filter((f) => f.top > 0).map((f) => f.top)
  return { statusBottom, navigationTop: navTops.length ? Math.min(...navTops) : undefined }
}

function uiDump() {
  for (let i = 0; i < 4; i++) {
    const r = sh('uiautomator dump /sdcard/e2e-ui.xml', { allowFail: true })
    if (/dumped to/i.test(r)) return sh('cat /sdcard/e2e-ui.xml', { allowFail: true })
  }
  return ''
}

function webViewBounds() {
  const xml = uiDump()
  const m = xml.match(/class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if (!m) throw new Error('WebView not found in uiautomator dump')
  return { left: +m[1], top: +m[2], right: +m[3], bottom: +m[4] }
}

async function ensureUnlocked() {
  sh('svc power stayon true', { allowFail: true })
  sh('input keyevent KEYCODE_WAKEUP', { allowFail: true })
  sh('wm dismiss-keyguard', { allowFail: true })
  await sleep(500)
  if (/Keyguard|NotificationShade|StatusBar|Bouncer/i.test(currentFocus())) {
    sh('input keyevent 82', { allowFail: true })
    await sleep(700)
    sh('input text ' + opts.pin, { allowFail: true })
    sh('input keyevent 66', { allowFail: true })
    await sleep(1000)
  }
}

function ensureDevicePin() {
  const v = sh('locksettings verify --old ' + opts.pin, { allowFail: true })
  if (!/verified successfully/i.test(v)) sh('locksettings set-pin ' + opts.pin)
}

// Answers the system credential prompt used by Vault's secure storage.
async function answerAuthPrompt(timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const f = currentFocus()
    if (f && !f.startsWith(PKG + '/') && /(ConfirmDeviceCredential|ConfirmLock|Biometric|AuthContainer|systemui|settings|Keyguard)/i.test(f)) {
      await sleep(600)
      sh('input text ' + opts.pin, { allowFail: true })
      sh('input keyevent 66', { allowFail: true })
      await sleep(1500)
      return true
    }
    await sleep(400)
  }
  return false
}

// ------------------------------------------------------------------- CDP

// Helpers evaluated inside the WebView before every expression. String.raw
// keeps the regex escapes in them intact.
const PAGE_HELPERS = String.raw`
var __shown = function (el) {
  if (!el) return false
  var r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  if (el.closest('.ion-page-hidden, .ion-page-invisible, [aria-hidden="true"], .overlay-hidden')) return false
  for (var n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
    var s = getComputedStyle(n)
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
  }
  return true
}
var __rect = function (el) {
  var r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}
var __visible = function (sel) {
  return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(__shown)
}
var __text = function (el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() }
var __clickText = function (re, scopeSel) {
  var rx = new RegExp(re, 'i')
  var scopes = scopeSel ? __visible(scopeSel) : [document]
  var scope = scopes[scopes.length - 1] || document
  var cands = Array.prototype.slice.call(scope.querySelectorAll('ion-button, button, ion-item[button], ion-item, ion-tab-button, ion-radio, ion-checkbox, ion-toggle, a, [role="button"]')).filter(__shown)
  var hit = cands.filter(function (el) { return rx.test(__text(el)) }).pop()
  if (!hit) return false
  hit.click()
  return __text(hit) || true
}
`

class Cdp {
  static async connect() {
    return waitFor('inspectable Vault WebView', async () => {
      const pid = sh('pidof ' + PKG, { allowFail: true }).trim().split(/\s+/)[0]
      if (!pid) return undefined
      adb(['forward', 'tcp:' + opts['cdp-port'], 'localabstract:webview_devtools_remote_' + pid], { allowFail: true })
      const targets = await (await fetch('http://127.0.0.1:' + opts['cdp-port'] + '/json')).json()
      const page = targets.find((t) => t.type === 'page' && /^(https?|capacitor):\/\/localhost/.test(t.url ?? ''))
      if (!page) return undefined
      const cdp = new Cdp(page.webSocketDebuggerUrl)
      await cdp.open()
      return cdp
    }, { timeout: 60_000, interval: 1000 })
  }

  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data)
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      })
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP ' + method + ' timed out'))
      }, 20_000)
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression: PAGE_HELPERS + ';' + expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
    return r.result.value
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

// ------------------------------------------------------------ app actions

function launchActivity() {
  const out = sh('cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ' + PKG)
  return out.trim().split(/\r?\n/).pop()
}

async function coldStart() {
  sh('am force-stop ' + PKG)
  await sleep(500)
  sh('am start -W -n ' + launchActivity())
  const cdp = await Cdp.connect()
  await waitFor('Angular app ready', () => cdp.eval('!!document.querySelector("ion-app") && document.readyState === "complete"'), { timeout: 60_000 })
  return cdp
}

function openDeeplink(url) {
  sh("am start -W -a android.intent.action.VIEW -d '" + url + "' " + PKG)
}

const route = (cdp) => cdp.eval('location.pathname')

const readState = (cdp) =>
  cdp.eval(`(function () {
    var overlay = __visible('ion-modal, ion-alert, ion-action-sheet, ion-loading, ion-popover').pop()
    var scope = overlay || document
    var buttons = Array.prototype.slice.call(scope.querySelectorAll('ion-button, button, ion-tab-button, ion-item, ion-radio, ion-checkbox')).filter(__shown).map(__text).filter(Boolean).slice(0, 30)
    return {
      path: location.pathname,
      overlay: overlay ? overlay.tagName.toLowerCase() + (overlay.getAttribute('class') ? '.' + overlay.getAttribute('class').split(' ').slice(0, 3).join('.') : '') : null,
      title: __visible('ion-title').map(__text).pop() || '',
      heading: __visible('h1, h2, h3').map(__text).slice(0, 3),
      buttons: buttons
    }
  })()`)

// ---------------------------------------------------------- measurements

async function measure(cdp, what) {
  const css = await cdp.eval(`(function () {
    var pick = function (sel) { var v = __visible(sel); return v.length ? __rect(v[v.length - 1]) : null }
    return {
      path: location.pathname,
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      fab: pick('ion-fab[vertical="bottom"] ion-button, ion-fab.fab-vertical-bottom ion-button'),
      back: pick('ion-header ion-back-button'),
      toolbar: pick('ion-header ion-toolbar'),
      tabbar: pick('ion-tab-bar')
    }
  })()`)
  const wv = webViewBounds()
  const bars = systemBars()
  const scale = (wv.right - wv.left) / css.innerWidth
  const toScreen = (r) =>
    r && {
      left: Math.round(wv.left + r.left * scale),
      top: Math.round(wv.top + r.top * scale),
      right: Math.round(wv.left + r.right * scale),
      bottom: Math.round(wv.top + r.bottom * scale)
    }
  const elements = {}
  for (const key of what) elements[key] = toScreen(css[key])
  return { path: css.path, dpr: css.dpr, scale, webview: wv, bars, elements }
}

// ------------------------------------------------------------- assertions

const results = []
function check(name, pass, details) {
  results.push({ name, pass: Boolean(pass), details })
  log((pass ? 'PASS ' : 'FAIL ') + name + (details ? ' ' + JSON.stringify(details) : ''))
  return Boolean(pass)
}

function assertInsideSafeArea(scenario, m, key) {
  const r = m.elements[key]
  if (!r) return check(scenario + '.' + key + '.present', false, { path: m.path })
  const safeTop = m.bars.statusBottom
  const safeBottom = m.bars.navigationTop ?? m.webview.bottom
  const tol = 1
  check(scenario + '.' + key + '.clear-of-status-bar', r.top >= safeTop - tol, { top: r.top, statusBarBottom: safeTop })
  check(scenario + '.' + key + '.clear-of-navigation-bar', r.bottom <= safeBottom + tol, { bottom: r.bottom, navigationBarTop: safeBottom })
  if (key === 'fab') {
    // The FAB should sit just above the bar: Ionic's own offset is 10 CSS px.
    const gapCss = (safeBottom - r.bottom) / m.scale
    check(scenario + '.fab.not-floating-high', gapCss <= 48, { gapCssPx: Math.round(gapCss) })
  }
}

// Real touch through the system input pipeline: the navigation bar and status
// bar windows swallow it if they cover the touched point. The tap lands at 75%
// of the target's height so a partly covered button fails too.
async function tapAndExpectTrustedClick(cdp, name, tags, rect, yFraction = 0.75) {
  await cdp.eval(`(function () {
    window.__e2eClicks = []
    if (!window.__e2eListener) {
      window.__e2eListener = true
      document.addEventListener('click', function (e) {
        var path = e.composedPath ? e.composedPath() : [e.target]
        window.__e2eClicks.push({ trusted: e.isTrusted, tags: path.filter(function (n) { return n.tagName }).slice(0, 8).map(function (n) { return n.tagName.toLowerCase() }) })
      }, true)
    }
    return true
  })()`)
  const x = Math.round((rect.left + rect.right) / 2)
  const y = Math.round(rect.top + (rect.bottom - rect.top) * yFraction)
  sh('input tap ' + x + ' ' + y)
  await sleep(800)
  const clicks = (await cdp.eval('window.__e2eClicks || []').catch(() => [])) ?? []
  const hit = clicks.some((c) => c.trusted && c.tags.some((t) => tags.includes(t)))
  return check(name + '.real-tap-reaches-app', hit, { x, y, clicks: clicks.length })
}

// -------------------------------------------------------------- scenarios

// Real tap on the element returned by a page expression, mapped from CSS to
// screen pixels through the WebView's on-screen bounds.
async function tapElement(cdp, expr) {
  const r = await cdp.eval('(function () { var el = ' + expr + '; if (!el) return null; return { rect: __rect(el), width: window.innerWidth } })()')
  if (!r) throw new Error('nothing to tap for ' + expr)
  const wv = webViewBounds()
  const scale = (wv.right - wv.left) / r.width
  const x = Math.round(wv.left + ((r.rect.left + r.rect.right) / 2) * scale)
  const y = Math.round(wv.top + ((r.rect.top + r.rect.bottom) / 2) * scale)
  sh('input tap ' + x + ' ' + y)
  return { x, y }
}

async function signTransactionScenario(cdp, scenario) {
  openDeeplink(fixtures.signTransaction)
  await waitFor('signing page', async () => (await route(cdp)).includes('deserialized-detail'), { timeout: 30_000 })
  await waitFor('sign button', async () => (await measure(cdp, ['fab'])).elements.fab, { timeout: 20_000 })
  await sleep(800)
  const m = await measure(cdp, ['fab', 'back'])
  screenshot(scenario + '-sign')
  assertInsideSafeArea(scenario + '.sign', m, 'fab')
  assertInsideSafeArea(scenario + '.sign', m, 'back')
  const tapped = await tapAndExpectTrustedClick(cdp, scenario + '.sign.fab', ['ion-fab', 'ion-button'], m.elements.fab)
  let signed = false
  if (tapped) {
    await answerAuthPrompt(10_000)
    signed = await waitFor('signed page', async () => (await route(cdp)).includes('transaction-signed'), { timeout: 30_000 }).catch(() => false)
  }
  check(scenario + '.sign.transaction-signed', signed)
  if (!signed) {
    // Leave the signing page so the next scenario starts from the tabs.
    await cdp.eval('history.back(); true').catch(() => {})
    return
  }
  await sleep(800)
  const d = await measure(cdp, ['fab', 'back'])
  screenshot(scenario + '-signed')
  assertInsideSafeArea(scenario + '.signed', d, 'fab')
  await tapAndExpectTrustedClick(cdp, scenario + '.signed.fab', ['ion-fab', 'ion-button'], d.elements.fab)
  await waitFor('back on the tabs', async () => (await route(cdp)).includes('/tabs/'), { timeout: 15_000 }).catch(() => false)
}

async function assertTabBar(cdp, scenario) {
  await sleep(800)
  const m = await measure(cdp, ['tabbar'])
  screenshot(scenario + '-tabs')
  assertInsideSafeArea(scenario + '.tabs', m, 'tabbar')
  return m
}

async function tapTab(cdp, scenario, tab) {
  const m = await measure(cdp, ['tabbar'])
  const tabs = await cdp.eval(`__visible('ion-tab-button').map(function (el) { return { tab: el.getAttribute('tab'), r: __rect(el) } })`)
  const t = tabs.find((x) => x.tab === tab)
  if (!t) return check(scenario + '.' + tab + '.present', false)
  const rect = {
    left: m.webview.left + t.r.left * m.scale,
    right: m.webview.left + t.r.right * m.scale,
    top: m.webview.top + t.r.top * m.scale,
    bottom: m.webview.top + t.r.bottom * m.scale
  }
  await tapAndExpectTrustedClick(cdp, scenario + '.' + tab, ['ion-tab-button'], rect)
  const ok = await waitFor(tab, async () => (await route(cdp)).includes(tab), { timeout: 10_000 }).catch(() => false)
  if (!ok) {
    // Keep going so later checks still run: switch tabs through the DOM.
    await cdp.eval('(function(){var b=document.querySelector(\'ion-tab-button[tab="' + tab + '"]\'); b && b.click(); return true})()')
    await waitFor(tab + ' (DOM fallback)', async () => (await route(cdp)).includes(tab), { timeout: 10_000 })
  }
}

async function freshStartOnSecrets() {
  const cdp = await coldStart()
  // Vault asks for the device credential on every launch once a secret exists.
  await answerAuthPrompt(8000)
  await waitFor('secrets tab', async () => (await route(cdp)).includes('tab-secrets'), { timeout: 30_000 })
  return cdp
}

// ------------------------------------------------------------------- main

let meta = {}

async function main() {
  const started = Date.now()
  meta.device = deviceInfo()
  log('device', meta.device)
  for (const s of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) sh('settings put global ' + s + ' 0', { allowFail: true })
  meta.nav = await setNavigation(opts.nav)
  ensureDevicePin()
  await ensureUnlocked()

  if (!opts['skip-install']) {
    if (!opts.apk) throw new Error('--apk is required unless --skip-install')
    adb(['uninstall', PKG], { allowFail: true })
    adb(['install', '-r', '-g', opts.apk], { timeout: 300_000 })
  }

  let cdp = await coldStart()
  if (!opts['skip-onboarding']) {
    await runOnboarding({ cdp, fixtures, sh, sleep, waitFor, answerAuthPrompt, readState, route, log, screenshot, tapElement })
  }
  cdp.close()
  meta.bars = systemBars()
  log('system bars', meta.bars)

  // 1. Cold start straight into signing.
  cdp = await freshStartOnSecrets()
  await assertTabBar(cdp, 'cold')
  await signTransactionScenario(cdp, 'cold')
  cdp.close()

  // 2. Secrets -> Scanner -> Secrets, then sign: the path from issue #247.
  cdp = await freshStartOnSecrets()
  await tapTab(cdp, 'scanner', 'tab-scan')
  await sleep(2500) // camera start, and where 3.34.x disabled the insets
  screenshot('scanner-open')
  await assertTabBar(cdp, 'scanner-open')
  await tapTab(cdp, 'scanner', 'tab-secrets')
  await assertTabBar(cdp, 'after-scanner')
  await signTransactionScenario(cdp, 'after-scanner')

  // 3. Scanner -> Settings -> sign.
  await tapTab(cdp, 'scanner-settings', 'tab-scan')
  await sleep(2500)
  await tapTab(cdp, 'scanner-settings', 'tab-settings')
  await assertTabBar(cdp, 'scanner-settings')
  await signTransactionScenario(cdp, 'scanner-settings')
  cdp.close()

  meta.durationSec = Math.round((Date.now() - started) / 1000)
}

function writeReports(error) {
  const failed = results.filter((r) => !r.pass)
  const report = { label: opts.label, apk: opts.apk, ...meta, error: error ? String(error.stack ?? error) : undefined, passed: results.length - failed.length, failed: failed.length, results }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  const d = meta.device ?? {}
  const lines = [
    '### ' + (opts.label || opts.apk || PKG) + ': API ' + d.api + ', ' + (meta.nav ?? opts.nav ?? '?') + ' navigation',
    '',
    'Device: ' + d.model + ', Android ' + d.release + ', WebView ' + d.webview,
    '',
    error ? '**Harness error:** ' + (error.message ?? error) : '**' + (failed.length ? failed.length + ' failed' : 'all passed') + '** (' + results.length + ' checks)',
    '',
    '| Check | Result | Details |',
    '| --- | --- | --- |',
    ...results.map((r) => '| ' + r.name + ' | ' + (r.pass ? 'pass' : '**FAIL**') + ' | ' + (r.details ? '<code>' + JSON.stringify(r.details).replace(/\|/g, '/').slice(0, 160) + '</code>' : '') + ' |'),
    ''
  ]
  writeFileSync(join(OUT, 'report.md'), lines.join('\n'))
}

try {
  await main()
  writeReports()
  process.exitCode = results.length && results.every((r) => r.pass) ? 0 : 1
} catch (error) {
  log('harness error', error)
  try {
    meta.device ??= deviceInfo()
  } catch {}
  screenshot('harness-error')
  writeReports(error)
  process.exitCode = 2
}
