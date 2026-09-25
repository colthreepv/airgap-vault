import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gradleFile = process.argv[2]
if (!gradleFile) throw new Error('Usage: enable-appium-debuggable.mjs <android/app/build.gradle>')

const path = resolve(gradleFile)
const source = readFileSync(path, 'utf8')
const appiumBlock = /^([ \t]*)appium[ \t]*\{\r?\n([\s\S]*?)^([ \t]*)\}/m.exec(source)
if (!appiumBlock) throw new Error(`Could not find an appium build type block in ${path}`)
if (appiumBlock[1] !== appiumBlock[3]) {
  throw new Error(`Unexpected indentation in the appium build type block in ${path}`)
}

const body = appiumBlock[2]
const existingDebuggable = /^([ \t]*)debuggable\s+.*$/m
const existingSetting = existingDebuggable.exec(body)
let updatedBody
if (existingSetting) {
  updatedBody = body.replace(existingDebuggable, `${existingSetting[1]}debuggable true`)
} else {
  const indentation = body.match(/^([ \t]+)\S/m)?.[1] ?? `${appiumBlock[1]}    `
  updatedBody = `${indentation}debuggable true\n${body}`
}

const replacement = `${appiumBlock[1]}appium {\n${updatedBody}${appiumBlock[3]}}`
writeFileSync(path, source.replace(appiumBlock[0], replacement))
console.log(`Set appium.debuggable = true in ${path}`)
