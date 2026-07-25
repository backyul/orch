import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResumeDialogAnswerer } from '../src/resume-dialog.js';

const immediate = (fn) => fn();

test('answers the resume dialog with a single Enter', () => {
  const writes = [];
  const onData = createResumeDialogAnswerer({ write: (s) => writes.push(s), defer: immediate });
  assert.equal(onData('Resuming the full session will consume a substantial portion'), false);
  assert.equal(onData(' of your usage limits. We recommend resuming from a summary.\r\n'), false);
  assert.equal(onData('  \x1b[36m> Resume from summary (recommended)\x1b[0m\r\n    Resume full session as-is\r\n'), true);
  assert.deepEqual(writes, ['\r']);
});

test('matches across chunk splits and interleaved ANSI codes', () => {
  const writes = [];
  const onData = createResumeDialogAnswerer({ write: (s) => writes.push(s), defer: immediate });
  onData('> Resume from \x1b[1msum');
  onData('mary\x1b[0m (recommended)');
  assert.deepEqual(writes, ['\r']);
});

test('never answers twice, even if the dialog text repaints', () => {
  const writes = [];
  const onData = createResumeDialogAnswerer({ write: (s) => writes.push(s), defer: immediate });
  onData('> Resume from summary (recommended)');
  assert.equal(onData('> Resume from summary (recommended)'), true); // repaint after answer
  assert.deepEqual(writes, ['\r']);
});

test('ignores ordinary output and text outside the boot window', () => {
  const writes = [];
  let t = 0;
  const onData = createResumeDialogAnswerer({ write: (s) => writes.push(s), defer: immediate, now: () => t, windowMs: 1000 });
  assert.equal(onData('normal conversation output, no dialog here'), false);
  t = 2000; // window expired — a late replay of the phrase must not press Enter
  assert.equal(onData('> Resume from summary (recommended)'), false);
  assert.deepEqual(writes, []);
});
