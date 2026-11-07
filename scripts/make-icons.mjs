// Draws the app icon and writes resources/icon.png and resources/icon.ico.
// Run with `npm run icons`. It needs no dependencies, so the same bytes come out on any system.
//
// The mark is the app's own handoff marker: one line passing through a ringed dot.
// Below 32px a ring turns to mush, so small sizes draw a plain dot on a heavier line.
import { mkdirSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

const TILE = [27, 25, 23]
const RIM = [66, 61, 54]
const THREAD = [91, 157, 255]
const MARGIN = 0.05
const RADIUS = 0.22
const RIM_WIDTH = 0.018
const SAMPLES = 4
const LARGE_FROM = 32
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
const PNG_SIZE = 1024

function colorAt(x, y, size) {
  const large = size >= LARGE_FROM
  // Distance outside the rounded square: negative means inside.
  const half = 0.5 - MARGIN
  const qx = Math.abs(x - 0.5) - (half - RADIUS)
  const qy = Math.abs(y - 0.5) - (half - RADIUS)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - RADIUS
  if (outside > 0) return null

  const fromCenter = Math.hypot(x - 0.5, y - 0.5)
  if (large) {
    if (fromCenter < 0.15) return THREAD
    if (fromCenter < 0.205) return TILE
    if (fromCenter < 0.26) return THREAD
  } else if (fromCenter < 0.23) {
    return THREAD
  }
  const lineWidth = Math.max(0.07, 1.7 / size)
  if (Math.abs(x - 0.5) < lineWidth / 2) return THREAD
  return outside > -RIM_WIDTH && large ? RIM : TILE
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let [red, green, blue, covered] = [0, 0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = colorAt((column + (sx + 0.5) / SAMPLES) / size, (row + (sy + 0.5) / SAMPLES) / size, size)
          if (!color) continue
          red += color[0]
          green += color[1]
          blue += color[2]
          covered += 1
        }
      }
      if (covered === 0) continue
      const offset = (row * size + column) * 4
      pixels[offset] = Math.round(red / covered)
      pixels[offset + 1] = Math.round(green / covered)
      pixels[offset + 2] = Math.round(blue / covered)
      pixels[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255)
    }
  }
  return pixels
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, checksum])
}

function png(size) {
  const pixels = render(size)
  const scanlines = Buffer.alloc((size * 4 + 1) * size)
  for (let row = 0; row < size; row++) {
    pixels.copy(scanlines, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // Bits per channel.
  header[9] = 6 // RGBA.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** The classic icon bitmap: BGRA rows from the bottom up, followed by a 1-bit transparency mask. */
function bitmap(size) {
  const pixels = render(size)
  const maskRow = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // The height counts the color rows and the mask rows.
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const colors = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(maskRow * size)
  for (let row = 0; row < size; row++) {
    const flipped = size - 1 - row
    for (let column = 0; column < size; column++) {
      const from = (row * size + column) * 4
      const to = (flipped * size + column) * 4
      colors[to] = pixels[from + 2]
      colors[to + 1] = pixels[from + 1]
      colors[to + 2] = pixels[from]
      colors[to + 3] = pixels[from + 3]
      if (pixels[from + 3] === 0) mask[flipped * maskRow + (column >> 3)] |= 0x80 >> (column & 7)
    }
  }
  return Buffer.concat([header, colors, mask])
}

function ico(sizes) {
  // Some Windows loaders fail on small PNG entries, so only the largest size is compressed.
  const images = sizes.map((size) => (size >= 256 ? png(size) : bitmap(size)))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // Type: icon.
  header.writeUInt16LE(sizes.length, 4)
  const directory = Buffer.alloc(16 * sizes.length)
  let offset = header.length + directory.length
  sizes.forEach((size, index) => {
    const entry = index * 16
    // In this format, 0 means 256.
    directory[entry] = size % 256
    directory[entry + 1] = size % 256
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(images[index].length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += images[index].length
  })
  return Buffer.concat([header, directory, ...images])
}

mkdirSync('resources', { recursive: true })
writeFileSync('resources/icon.png', png(PNG_SIZE))
writeFileSync('resources/icon.ico', ico(ICO_SIZES))
console.log('resources/icon.png e resources/icon.ico gerados')
