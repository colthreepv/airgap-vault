import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [apkArg, ref, outputArg] = process.argv.slice(2)
if (!apkArg || !ref || !outputArg) {
  throw new Error('Usage: write-build-info.mjs <apk> <repository@ref> <output-json>')
}

const apk = resolve(apkArg)
const output = resolve(outputArg)
const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
if (!sdkRoot) throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT must be set')

const buildToolsRoot = join(sdkRoot, 'build-tools')
const buildTools = readdirSync(buildToolsRoot)
  .filter((entry) => /^\d+(\.\d+)*$/.test(entry))
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  .at(-1)
if (!buildTools) throw new Error(`No Android build-tools found under ${buildToolsRoot}`)

const aapt = join(buildToolsRoot, buildTools, process.platform === 'win32' ? 'aapt.exe' : 'aapt')
const badging = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' })
const manifestTree = execFileSync(aapt, ['dump', 'xmltree', apk, 'AndroidManifest.xml'], { encoding: 'utf8' })
const packageLine = badging.match(/^package:.*$/m)?.[0]
const applicationId = packageLine?.match(/\bname='([^']+)'/)?.[1]
const versionName = packageLine?.match(/\bversionName='([^']*)'/)?.[1]
if (!applicationId || versionName === undefined) {
  throw new Error(`Could not read package name and version from ${apk}`)
}
const debuggableEntry = manifestTree.match(/android:debuggable(?:\([^)]*\))?\s*=\s*(true|false)/)
if (debuggableEntry?.[1] !== 'true') {
  throw new Error(`Expected the appium APK to be debuggable; found ${debuggableEntry?.[1] ?? 'no manifest flag'}`)
}

const resolvedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: process.env.GITHUB_WORKSPACE ? join(process.env.GITHUB_WORKSPACE, 'app') : process.cwd(),
  encoding: 'utf8'
}).trim()

const buildInfo = { ref, resolvedSha, variant: 'appium', debuggable: true, applicationId, versionName }
writeFileSync(output, `${JSON.stringify(buildInfo, null, 2)}\n`)
console.log(JSON.stringify(buildInfo))
