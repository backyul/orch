import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturePane, sendKeys } from '../src/tmux.js';

function fakeSpawn(calls, results) {
  return (cmd, args) => { calls.push([cmd, ...args]); return results.shift() ?? { status: 0, stdout: '', stderr: '' }; };
}

test('capturePane runs capture-pane -p -t and returns stdout', () => {
  const calls = [];
  const spawnSync = fakeSpawn(calls, [{ status: 0, stdout: 'screen text', stderr: '' }]);
  const out = capturePane('%3', { spawnSync });
  assert.equal(out, 'screen text');
  assert.deepEqual(calls[0], ['tmux', 'capture-pane', '-p', '-t', '%3']);
});

test('sendKeys sends literal text then Enter', () => {
  const calls = [];
  const spawnSync = fakeSpawn(calls, [{ status: 0 }, { status: 0 }]);
  sendKeys('%3', 'yes do it', { spawnSync });
  assert.deepEqual(calls[0], ['tmux', 'send-keys', '-t', '%3', '-l', 'yes do it']);
  assert.deepEqual(calls[1], ['tmux', 'send-keys', '-t', '%3', 'Enter']);
});

test('sendKeys with enter:false sends only the literal text (no Enter)', () => {
  const calls = [];
  const spawnSync = fakeSpawn(calls, [{ status: 0 }]);
  sendKeys('%3', '2', { spawnSync, enter: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['tmux', 'send-keys', '-t', '%3', '-l', '2']);
});

test('capturePane throws on nonzero status', () => {
  const spawnSync = () => ({ status: 1, stderr: 'no pane' });
  assert.throws(() => capturePane('%9', { spawnSync }), /capture-pane failed/);
});
