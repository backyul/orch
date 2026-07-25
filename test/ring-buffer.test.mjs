import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer } from '../src/ring-buffer.js';

test('accumulates pushed chunks and returns them all', () => {
  const r = createRingBuffer(1000);
  r.push('hello ');
  r.push('world');
  assert.equal(r.text(), 'hello world');
});

test('drops oldest bytes past maxBytes', () => {
  const r = createRingBuffer(5);
  r.push('abcdefg');           // 7 bytes into a 5-byte buffer
  assert.equal(r.text(), 'cdefg');
});

test('tail(n) returns only the last n lines', () => {
  const r = createRingBuffer(1000);
  r.push('l1\nl2\nl3\nl4');
  assert.equal(r.tail(2), 'l3\nl4');
});
