// Build-time PNG icons: rasterize the glyph geometry with supersampling and
// encode it with a minimal PNG writer (8-bit RGBA, no filtering).
import { crc32, deflateSync } from 'node:zlib';
import { GLYPH_SHAPES, GLYPH_SIZE } from '../src/glyph.js';

const SAMPLES = 8; // per axis, per pixel

function hexColor(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Signed distance from (px, py) to a rounded rectangle; <= 0 means inside. */
function roundedRectDistance(px, py, { x, y, w, h, r }) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function prepare(shape) {
  const theta = ((shape.rotate?.angle ?? 0) * Math.PI) / 180;
  return { ...shape, rgb: hexColor(shape.fill), cos: Math.cos(theta), sin: Math.sin(theta) };
}

function covers(shape, sx, sy) {
  let px = sx;
  let py = sy;
  if (shape.rotate) {
    // Undo the SVG rotate(angle cx cy) to test in the shape's own frame.
    const dx = sx - shape.rotate.cx;
    const dy = sy - shape.rotate.cy;
    px = shape.rotate.cx + shape.cos * dx + shape.sin * dy;
    py = shape.rotate.cy - shape.sin * dx + shape.cos * dy;
  }
  return roundedRectDistance(px, py, shape) <= 0;
}

/** RGBA pixels of the glyph at size x size. */
export function rasterizeGlyph(size, shapes = GLYPH_SHAPES) {
  const prepared = shapes.map(prepare);
  const scale = GLYPH_SIZE / size;
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const sx = (px + (i + 0.5) / SAMPLES) * scale;
          const sy = (py + (j + 0.5) / SAMPLES) * scale;
          for (let k = prepared.length - 1; k >= 0; k--) {
            if (covers(prepared[k], sx, sy)) {
              const [cr, cg, cb] = prepared[k].rgb;
              r += cr;
              g += cg;
              b += cb;
              hits++;
              break;
            }
          }
        }
      }
      const o = (py * size + px) * 4;
      if (hits > 0) {
        rgba[o] = Math.round(r / hits);
        rgba[o + 1] = Math.round(g / hits);
        rgba[o + 2] = Math.round(b / hits);
        rgba[o + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES));
      }
    }
  }
  return rgba;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode 8-bit RGBA pixels as a PNG file. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const ICON_SIZES = [16, 32, 48, 128];

/** { 'icon-16.png': Buffer, ... } */
export function renderIcons(sizes = ICON_SIZES) {
  return Object.fromEntries(sizes.map((size) => [`icon-${size}.png`, encodePng(size, size, rasterizeGlyph(size))]));
}
