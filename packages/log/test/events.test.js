import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { connect } from 'node:net';
import { describe, test } from 'node:test';
import { EventHub, MAX_BUFFERED_BYTES } from '../src/events.js';

describe('log event streams', () => {
  test('a subscriber that stops reading is dropped once 1 MB waits for it, while readers stay', { timeout: 10_000 }, async () => {
    const hub = new EventHub({ snapshot: () => ({}) });
    const server = createServer(hub.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const stalled = connect(port, '127.0.0.1');
    stalled.on('error', () => {});
    stalled.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    stalled.pause();
    const reader = await new Promise((resolve, reject) => get({ host: '127.0.0.1', port, path: '/events' }, resolve).on('error', reject));
    let received = 0;
    reader.on('data', (chunk) => (received += chunk.length));
    try {
      while (hub.size < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      const blob = { blob: 'x'.repeat(16 * 1024) };
      let sent = 0;
      while (hub.size === 2 && sent < 64 * MAX_BUFFERED_BYTES) {
        for (let i = 0; i < 8; i++) hub.publish('blob', blob);
        sent += 8 * blob.blob.length;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(hub.size, 1, `the stalled subscriber is dropped (after ${sent} bytes)`);
      const connections = () => new Promise((resolve) => server.getConnections((err, n) => resolve(n)));
      while ((await connections()) > 1) await new Promise((resolve) => setTimeout(resolve, 5));
      // The one left is the reader: it keeps receiving.
      const before = received;
      hub.publish('blob', blob);
      while (received === before) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(hub.size, 1);
      assert.ok(received > MAX_BUFFERED_BYTES);
    } finally {
      reader.destroy();
      stalled.destroy();
      hub.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
