import './_isolate-store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSchedules } from '../src/schedules.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sched-')), 'schedules.json');
const at = (h, m) => new Date(2026, 6, 7, h, m); // local time

test('fires once at/after HH:MM, then not again the same day', () => {
  const s = createSchedules({ file: tmpFile() });
  s.add('23:03', 'ask about the self-improve loop', { now: at(9, 0) });
  assert.equal(s.fireDue(at(22, 0)).length, 0);            // before time
  const fired = s.fireDue(at(23, 3));
  assert.equal(fired.length, 1);
  assert.match(fired[0].message, /self-improve/);
  assert.equal(s.fireDue(at(23, 30)).length, 0);           // already fired today
  assert.equal(s.fireDue(new Date(2026, 6, 8, 23, 3)).length, 1); // fires again next day
});

test('catch-up: fires late if the daemon was down at the scheduled minute', () => {
  const s = createSchedules({ file: tmpFile() });
  s.add('23:03', 'nudge', { now: at(9, 0) });
  assert.equal(s.fireDue(at(23, 50)).length, 1); // late but fired — never silently skipped
});

test('adding a time already past today arms it for tomorrow (no instant fire)', () => {
  const s = createSchedules({ file: tmpFile() });
  s.add('09:00', 'morning nudge', { now: at(21, 0) });
  assert.equal(s.fireDue(at(21, 1)).length, 0);            // not today
  assert.equal(s.fireDue(new Date(2026, 6, 8, 9, 0)).length, 1);
});

test('cross-midnight catch-up: a 23:03 missed overnight fires on the next morning tick', () => {
  const s = createSchedules({ file: tmpFile() });
  s.add('23:03', 'nightly self-improve check-in', { now: at(9, 0) });   // added 2026-07-07 09:00
  assert.equal(s.fireDue(at(23, 3)).length, 1);                          // 07-07 fires normally
  // Daemon down at 23:03 on 07-08; back the next morning (~9h later, inside the window).
  const fired = s.fireDue(new Date(2026, 6, 9, 8, 0));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].late, true);
  assert.equal(fired[0].missedDate, '2026-07-08');
  assert.match(fired[0].message, /self-improve/);
  assert.equal(s.fireDue(new Date(2026, 6, 9, 8, 1)).length, 0);         // caught up once, no repeat
  assert.equal(s.fireDue(new Date(2026, 6, 9, 23, 3)).length, 1);        // tonight still fires on time
});

test("beyond the catch-up window: reported as missed once, not auto-run, tonight unaffected", () => {
  const s = createSchedules({ file: tmpFile(), catchupMs: 12 * 3600_000 });
  s.add('23:03', 'nightly', { now: at(9, 0) });
  assert.equal(s.fireDue(at(23, 3)).length, 1);                          // 07-07 fires
  // Back 07-09 at 12:00 — the 07-08 23:03 occurrence is ~13h old, past the window.
  const res = s.fireDue(new Date(2026, 6, 9, 12, 0));
  assert.equal(res.length, 1);
  assert.equal(res[0].missed, true);
  assert.equal(res[0].missedDate, '2026-07-08');
  assert.equal(s.fireDue(new Date(2026, 6, 9, 12, 1)).length, 0);        // notified once, no repeat
  assert.equal(s.fireDue(new Date(2026, 6, 9, 23, 3)).length, 1);        // tonight fires normally
});

test("a schedule added after yesterday's time never retro-fires that occurrence", () => {
  const s = createSchedules({ file: tmpFile() });
  s.add('23:03', 'brand new', { now: new Date(2026, 6, 8, 7, 0) });      // yesterday 23:03 predates it
  assert.equal(s.fireDue(new Date(2026, 6, 8, 7, 1)).length, 0);
  assert.equal(s.fireDue(new Date(2026, 6, 8, 23, 3)).length, 1);        // its first real firing
});

test('a schedule armed today, never fired, and missed overnight still catches up', () => {
  const s = createSchedules({ file: tmpFile() });
  s.add('23:03', 'first night', { now: at(9, 0) });                      // armed for 07-07 23:03
  // Daemon down from before 23:03 until 07-08 08:00 — first-ever occurrence was missed.
  const fired = s.fireDue(new Date(2026, 6, 8, 8, 0));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].late, true);
  assert.equal(fired[0].missedDate, '2026-07-07');
});

test('list/remove manage entries; bad input rejected', () => {
  const s = createSchedules({ file: tmpFile() });
  const id = s.add('08:30', 'x', { now: at(9, 0) });
  assert.equal(s.list().length, 1);
  assert.equal(s.remove(id), true);
  assert.equal(s.list().length, 0);
  assert.throws(() => s.add('25:00', 'bad'), /HH:MM/);
  assert.throws(() => s.add('10:00', '  '), /message/);
});
