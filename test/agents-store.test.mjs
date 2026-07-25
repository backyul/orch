import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentsStore } from '../src/agents-store.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-')), 'agents.json');
}

test('load returns [] when file is missing', () => {
  const store = createAgentsStore(tmpFile());
  assert.deepEqual(store.load(), []);
});

test('save then load round-trips the manifest', () => {
  const file = tmpFile();
  const store = createAgentsStore(file);
  store.save([{ name: 'orch', sessionId: 'abc', status: 'running' }]);
  assert.deepEqual(store.load(), [{ name: 'orch', sessionId: 'abc', status: 'running' }]);
});

test('load tolerates a corrupt file by returning []', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(createAgentsStore(file).load(), []);
});
