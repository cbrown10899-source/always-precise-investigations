/**
 * Generates the PWA PNG icons.
 *
 * A dependency-free rasteriser and PNG encoder, rather than pulling in an
 * image library for four files that never change. It draws the same shapes as
 * `public/icons/icon.svg` so the SVG and the PNGs cannot drift apart visually.
 *
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(OUT, { recursive: true })

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]

const SKY_TOP = hex('#2f83e4')
const SKY_BOTTOM = hex('#10233f')
const BACK_RIDGE = hex('#8fc1f5')
const FRONT_RIDGE = hex('#ffffff')
const SNOW = hex('#e2eefc')
const BELT = hex('#1f6fd0')

/** Signed area test: is (px,py) inside the polygon? Even-odd rule. */
function inPolygon(px, py, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i]
    const yi = pts[i + 1]
    const xj = pts[j]
    const yj = pts[j + 1]
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

/**
 * Draws one icon at `size`, supersampled 2x for smooth diagonals.
 * `maskable` skips the rounded corners and insets the art into the safe zone,
 * because a maskable icon is cropped to whatever shape the platform chooses.
 */
function draw(size, { maskable = false } = {}) {
  const SS = 2
  const W = size * SS
  const rgba = Buffer.alloc(W * W * 4)

  // In maskable mode the artwork is scaled into the middle 80%, which is the
  // safe zone every platform mask keeps.
  const inset = maskable ? W * 0.1 : 0
  const artW = W - inset * 2
  const radius = maskable ? 0 : W * 0.219 // 112/512

  const S = (v) => (v / 512) * artW + inset

  const backRidge = [0, 330, 86, 232, 156, 300, 246, 196, 330, 292, 410, 226, 512, 320, 512, 512, 0, 512].map(
    (v, i) => (i % 2 === 0 ? S(v) : S(v)),
  )
  const frontRidge = [0, 386, 92, 292, 168, 356, 256, 246, 344, 350, 424, 288, 512, 372, 512, 512, 0, 512].map(
    (v) => S(v),
  )
  const snow = [256, 246, 288, 284, 268, 292, 256, 284, 244, 292, 224, 284].map((v) => S(v))

  const beltTop = S(426)
  const beltBottom = S(478)
  const stripe1 = [S(150), S(176)]
  const stripe2 = [S(196), S(222)]

  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4

      // Rounded-corner mask for the non-maskable icons.
      if (!maskable) {
        const cx = Math.min(x, W - 1 - x)
        const cy = Math.min(y, W - 1 - y)
        if (cx < radius && cy < radius) {
          const dx = radius - cx
          const dy = radius - cy
          if (dx * dx + dy * dy > radius * radius) {
            rgba[i + 3] = 0
            continue
          }
        }
      }

      let color
      if (x < inset || x >= W - inset || y < inset || y >= W - inset) {
        // Outside the art box on a maskable icon: fill with the deep navy so
        // the mask never crops into transparency.
        color = SKY_BOTTOM
      } else {
        const t = (y - inset) / artW
        color = mix(SKY_TOP, SKY_BOTTOM, Math.min(1, Math.max(0, t)))
        if (inPolygon(x, y, backRidge)) color = mix(color, BACK_RIDGE, 0.5)
        if (inPolygon(x, y, frontRidge)) color = FRONT_RIDGE
        if (inPolygon(x, y, snow)) color = SNOW
        if (y >= beltTop && y < beltBottom) {
          const onStripe =
            (x >= stripe1[0] && x < stripe1[1]) || (x >= stripe2[0] && x < stripe2[1])
          color = onStripe ? [255, 255, 255] : BELT
        }
      }

      rgba[i] = color[0]
      rgba[i + 1] = color[1]
      rgba[i + 2] = color[2]
      rgba[i + 3] = 255
    }
  }

  // Downsample the supersampled buffer to the requested size.
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const si = ((y * SS + sy) * W + (x * SS + sx)) * 4
          r += rgba[si]
          g += rgba[si + 1]
          b += rgba[si + 2]
          a += rgba[si + 3]
        }
      }
      const n = SS * SS
      const di = (y * size + x) * 4
      out[di] = Math.round(r / n)
      out[di + 1] = Math.round(g / n)
      out[di + 2] = Math.round(b / n)
      out[di + 3] = Math.round(a / n)
    }
  }
  return out
}

/* ------------------------------------------------------------ PNG encoder */

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n += 1) {
    c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const FILES = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon.png', size: 180, maskable: true },
]

for (const file of FILES) {
  const pixels = draw(file.size, { maskable: file.maskable })
  writeFileSync(join(OUT, file.name), encodePng(pixels, file.size))
  console.log(`wrote ${file.name} (${file.size}x${file.size})`)
}
