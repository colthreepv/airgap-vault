const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')

const root = path.join(__dirname, 'app', 'src')
const originalColors = [
  [74, 42, 151], // Main shield stroke
  [161, 150, 199] // Right shield stroke
]
const palettes = {
  debug: [
    { top: [199, 29, 51], bottom: [199, 29, 51] },
    { top: [234, 105, 117], bottom: [234, 105, 117] }
  ],
  fork: [
    { top: [45, 204, 245], bottom: [23, 79, 198] },
    { top: [127, 221, 246], bottom: [72, 138, 218] }
  ]
}

function projectedCoverage(pixel, original) {
  const direction = original.map((component) => component - 255)
  const numerator = pixel.reduce((sum, component, index) => sum + (component - 255) * direction[index], 0)
  const denominator = direction.reduce((sum, component) => sum + component * component, 0)
  const coverage = Math.max(0, Math.min(1, numerator / denominator))
  const error = pixel.reduce((sum, component, index) => {
    const distance = component - (255 + coverage * direction[index])
    return sum + distance * distance
  }, 0)

  return { coverage, error }
}

function recolor(source, palette) {
  const result = PNG.sync.read(source)
  let coloredPixels = 0

  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      const offset = (y * result.width + x) * 4
      if (result.data[offset + 3] === 0) continue

      const pixel = [result.data[offset], result.data[offset + 1], result.data[offset + 2]]
      const matches = originalColors.map((original) => projectedCoverage(pixel, original))
      const index = matches[0].error <= matches[1].error ? 0 : 1
      const { coverage } = matches[index]
      if (coverage < 0.025) continue

      const gradient = palette[index]
      const position = y / (result.height - 1)
      for (let channel = 0; channel < 3; channel++) {
        const color = gradient.top[channel] * (1 - position) + gradient.bottom[channel] * position
        result.data[offset + channel] = Math.round(255 * (1 - coverage) + color * coverage)
      }
      coloredPixels++
    }
  }

  if (coloredPixels < result.width * result.height * 0.1) {
    throw new Error('Launcher source image did not contain the expected Vault logo colors')
  }

  return PNG.sync.write(result)
}

for (const density of ['ldpi', 'mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    const source = fs.readFileSync(path.join(root, 'main', 'res', `mipmap-${density}`, name))
    for (const [variant, palette] of Object.entries(palettes)) {
      const destination = path.join(root, variant, 'res', `mipmap-${density}`)
      fs.mkdirSync(destination, { recursive: true })
      fs.writeFileSync(path.join(destination, name), recolor(source, palette))
    }
  }
}
