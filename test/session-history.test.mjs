// test/session-history.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSlug, transcriptPath, parseTranscript, readHistory } from '../src/session-history.js';

const L = (o) => JSON.stringify(o);
const user = (text, extra = {}) => L({ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-07-29T00:00:00Z', ...extra });
const asst = (blocks) => L({ type: 'assistant', message: { role: 'assistant', content: blocks }, timestamp: '2026-07-29T00:00:01Z' });

test('projectSlug flattens every non-alphanumeric to a dash (claude convention)', () => {
  assert.equal(projectSlug('C:\\Users\\Public\\orch'), 'C--Users-Public-orch');
  assert.equal(projectSlug('/home/me/my.repo'), '-home-me-my-repo');
});

test('transcriptPath builds <claudeHome>/projects/<slug>/<sessionId>.jsonl', () => {
  const p = transcriptPath({ claudeHome: 'X', cwd: 'C:\\a\\b', sessionId: 'sid-1' });
  assert.equal(p, path.join('X', 'projects', 'C--a-b', 'sid-1.jsonl'));
});

test('parseTranscript: strings, text+tool_use blocks; thinking/sidechain/garbage skipped', () => {
  const jsonl = [
    user('hello agent'),
    L({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent noise' } }),
    'not json at all',
    asst([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi operator' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
  ].join('\n');
  const { messages, total } = parseTranscript(jsonl);
  assert.equal(total, 2);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(messages[0].text, 'hello agent');
  assert.match(messages[1].text, /hi operator/);
  assert.match(messages[1].text, /⚙ Bash \{"command":"ls"\}/);
  assert.ok(!messages[1].text.includes('hmm'));
});

test('parseTranscript windows: limit takes the LAST n; before pages earlier; start reported', () => {
  const jsonl = Array.from({ length: 10 }, (_, i) => user(`m${i}`)).join('\n');
  const last3 = parseTranscript(jsonl, { limit: 3 });
  assert.deepEqual(last3.messages.map((m) => m.text), ['m7', 'm8', 'm9']);
  assert.equal(last3.total, 10); assert.equal(last3.start, 7);
  const earlier = parseTranscript(jsonl, { limit: 3, before: 3 });
  assert.deepEqual(earlier.messages.map((m) => m.text), ['m4', 'm5', 'm6']);
  const top = parseTranscript(jsonl, { limit: 5, before: 8 });
  assert.deepEqual(top.messages.map((m) => m.text), ['m0', 'm1']); // clipped at the beginning
  assert.equal(top.start, 0);
});

test('readHistory: 404 unknown agent, 409 no session, 404 missing file, 200 happy path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const cwd = 'C:\\demo\\repo';
  const reg = (map) => ({ get: (n) => map[n] || null });
  assert.equal(readHistory({ name: 'ghost', registry: reg({}), cwd, claudeHome: home }).code, 404);
  assert.equal(readHistory({ name: 'a', registry: reg({ a: { sessionId: null } }), cwd, claudeHome: home }).code, 409);
  assert.equal(readHistory({ name: 'a', registry: reg({ a: { sessionId: 's1' } }), cwd, claudeHome: home }).code, 404);
  const dir = path.join(home, 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [user('q'), asst([{ type: 'text', text: 'a' }])].join('\n'));
  const r = readHistory({ name: 'a', registry: reg({ a: { sessionId: 's1' } }), cwd, claudeHome: home });
  assert.equal(r.code, 200);
  assert.equal(r.total, 2);
  assert.equal(r.sessionId, 's1');
  assert.deepEqual(r.messages.map((m) => m.text), ['q', 'a']);
});
