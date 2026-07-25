import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchitect } from '../src/architect.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const webDir = path.join(root, 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(path.join(webDir, 'styles.css'), 'ORIGINAL');
  fs.writeFileSync(path.join(webDir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(webDir, 'app.js'), '// app');
  return { root, webDir };
}
function mk(root, webDir, run) {
  return createArchitect({
    root, webDir,
    stateFile: path.join(root, 'arch-session.json'),
    backupDir: path.join(root, 'arch-backup'),
    personaFile: path.join(root, 'arch-persona.txt'),
    run,
  });
}

test('first ask uses --session-id and persists it; reply is returned', async () => {
  const { root, webDir } = fixture();
  const calls = [];
  const arch = mk(root, webDir, (args) => { calls.push(args); return { stdout: 'I changed the accent color.' }; });
  const res = await arch.ask('make it blue');
  assert.equal(res.reply, 'I changed the accent color.');
  assert.ok(calls[0].includes('--session-id'));
  assert.ok(!calls[0].includes('--resume'));
  assert.ok(calls[0].includes('--permission-mode'));
  assert.ok(arch.loadSid()); // persisted
});

test('second ask resumes the same session', async () => {
  const { root, webDir } = fixture();
  const calls = [];
  const arch = mk(root, webDir, (args) => { calls.push(args); return { stdout: 'ok' }; });
  await arch.ask('first');
  await arch.ask('second');
  const sid = arch.loadSid();
  assert.ok(calls[1].includes('--resume'));
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], sid);
});

test('ask checkpoints the editable files so revert can undo a change', async () => {
  const { root, webDir } = fixture();
  // run simulates the architect editing styles.css
  const arch = mk(root, webDir, () => { fs.writeFileSync(path.join(webDir, 'styles.css'), 'EDITED'); return { stdout: 'edited' }; });
  await arch.ask('change styles');
  assert.equal(fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8'), 'EDITED');
  const r = arch.revert();
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8'), 'ORIGINAL'); // restored from pre-turn backup
});

test('a run error surfaces as the reply instead of throwing', async () => {
  const { root, webDir } = fixture();
  const arch = mk(root, webDir, () => ({ stdout: '', stderr: 'boom' }));
  const res = await arch.ask('do something');
  assert.match(res.reply, /architect error.*boom/);
});
