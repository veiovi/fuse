import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSseParser, formatSseFrame } from '../src/sse.js';

function parseAll(chunks) {
  const events = [];
  const parser = createSseParser((e) => events.push(e));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

describe('SSE parser', () => {
  test('named events, JSON data, ids and comments', () => {
    const events = parseAll([': keepalive\n\nid: 7\nevent: entry\ndata: {"type":"entry"}\n\n']);
    assert.deepEqual(events, [{ type: 'entry', data: '{"type":"entry"}', id: '7', retry: undefined }]);
  });

  test('events split across arbitrary chunk boundaries, including inside \\r\\n', () => {
    const text = 'event: a\r\ndata: one\r\n\r\nevent: b\rdata: two\r\rdata: three\n\n';
    const whole = parseAll([text]);
    for (let cut = 1; cut < text.length; cut++) {
      assert.deepEqual(parseAll([text.slice(0, cut), text.slice(cut)]), whole, `cut at ${cut}`);
    }
    assert.deepEqual(
      whole.map((e) => [e.type, e.data]),
      [['a', 'one'], ['b', 'two'], ['message', 'three']],
    );
  });

  test('multi-line data, missing space after colon, id persists, leading BOM', () => {
    const events = parseAll(['﻿id: 1\ndata:first\ndata: second\n\ndata: next\n\n']);
    assert.deepEqual(events.map((e) => [e.data, e.id]), [['first\nsecond', '1'], ['next', '1']]);
  });

  test('blocks without data are not dispatched; incomplete trailing event waits', () => {
    const events = parseAll(['event: nothing\n\nretry: 100\n\ndata: partial']);
    assert.equal(events.length, 0);
  });

  test('formatSseFrame round-trips through the parser', () => {
    const frame = formatSseFrame({ id: 3, type: 'scenario-output', data: 'line one\nline two' });
    assert.deepEqual(parseAll([frame]), [{ type: 'scenario-output', data: 'line one\nline two', id: '3', retry: undefined }]);
  });
});
