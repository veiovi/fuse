// Build-time icons, the worker shim, and display formatting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { ICON_SIZES, renderIcons } from '../scripts/icons.js';
import { displayHost, duration, seconds, shortHex } from '../src/format.js';
import { glyphSvg } from '../src/glyph.js';
import { EXTENSION_ORIGIN, createFakeChrome } from './fakes.js';

function readPng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    const body = buffer.subarray(at + 4, at + 8 + length);
    assert.equal(buffer.readUInt32BE(at + 8 + length), crc32(body), 'chunk CRC');
    chunks.push({ type: body.subarray(0, 4).toString('ascii'), data: body.subarray(4) });
    at += 12 + length;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const alpha = (x, y) => raw[y * (width * 4 + 1) + 1 + x * 4 + 3];
  return { width, height, depth: ihdr[8], colorType: ihdr[9], raw, alpha, last: chunks.at(-1).type };
}

test('icons are valid RGBA PNGs: transparent rounded corners, opaque body', () => {
  const icons = renderIcons();
  for (const size of ICON_SIZES) {
    const png = readPng(icons[`icon-${size}.png`]);
    assert.deepEqual([png.width, png.height, png.depth, png.colorType, png.last], [size, size, 8, 6, 'IEND']);
    assert.equal(png.raw.length, (size * 4 + 1) * size);
    assert.equal(png.alpha(0, 0), 0);
    assert.equal(png.alpha(size >> 1, size >> 1), 255);
  }
});

test('the inline SVG glyph matches the icon geometry', () => {
  const svg = glyphSvg(24);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 128 128" width="24" height="24"/);
  assert.equal(svg.match(/<rect /g).length, 6);
});

test('blob: prover workers are redirected to the packaged thread script', async () => {
  class FakeWorker {
    constructor(url) {
      this.url = String(url);
    }
  }
  globalThis.Worker = FakeWorker;
  globalThis.chrome = createFakeChrome();
  await import('../src/worker-shim.js');
  assert.equal(new Worker('blob:chrome-extension://x/9c1f').url, `${EXTENSION_ORIGIN}/prover-thread.js`);
  assert.equal(new Worker('https://example.test/worker.js').url, 'https://example.test/worker.js');
  delete globalThis.Worker;
  delete globalThis.chrome;
});

test('display formatting', () => {
  assert.equal(seconds(930), '0.9 s');
  assert.equal(seconds(12_400), '12 s');
  assert.equal(duration(13 * 3_600_000 + 20 * 60_000 + 5_000), '13 h 20 min');
  assert.equal(duration(2 * 3_600_000), '2 h');
  assert.equal(duration(4 * 60_000), '4 min');
  assert.equal(duration(30_000), 'less than a minute');
  assert.equal(shortHex('0x' + 'ab'.repeat(32)), '0xabab…abab');
  assert.equal(displayHost('http://forum.localhost:4710'), 'forum.localhost:4710');
});
