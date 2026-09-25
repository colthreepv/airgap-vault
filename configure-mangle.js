const fs = require('fs')
const path = require('path')

const configPath = path.join(
  __dirname,
  'node_modules/@angular-devkit/build-angular/src/tools/webpack/configs/common.js'
)
const original = 'keepNames: isPlatformServer'
const replacement = 'keepNames: true'
const config = fs.readFileSync(configPath, 'utf8')

if (config.includes(original)) {
  fs.writeFileSync(configPath, config.replace(original, replacement))
} else if (!config.includes(replacement)) {
  throw new Error('Angular minifier configuration changed; cannot preserve constructor names')
}
