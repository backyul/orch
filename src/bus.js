import fs from 'node:fs';
import path from 'node:path';
import { ORCH_DIR, PENDING_DIR, REPLIES_DIR, STATE_FILE, INBOX_DIR, OUTBOX_DIR } from './config.js';

export function ensureDirs() {
  for (const d of [ORCH_DIR, PENDING_DIR, REPLIES_DIR, INBOX_DIR, OUTBOX_DIR]) fs.mkdirSync(d, { recursive: true });
}

function atomicWrite(file, obj) {
  ensureDirs();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function genRef(worker, randFn = Math.random) {
  let s = '';
  for (let i = 0; i < 3; i++) s += ALPHABET[Math.floor(randFn() * ALPHABET.length)];
  const safe = String(worker).replace(/[^A-Za-z0-9_-]/g, '');
  return `${safe}.${s}`;
}

const pj = (ref) => path.join(PENDING_DIR, `${ref}.json`);
const rj = (ref) => path.join(REPLIES_DIR, `${ref}.json`);

export function writePending(rec) { atomicWrite(pj(rec.ref), rec); return rec; }
export function readPending(ref) {
  try { return JSON.parse(fs.readFileSync(pj(ref), 'utf8')); } catch { return null; }
}
export function listPending() {
  try {
    return fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
export function updatePending(ref, patch) {
  const cur = readPending(ref);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  writePending(next);
  return next;
}
export function removePending(ref) { try { fs.unlinkSync(pj(ref)); } catch { /* gone already */ } }

export function writeReply(rec) { atomicWrite(rj(rec.ref), rec); return rec; }
export function readReply(ref) {
  try { return JSON.parse(fs.readFileSync(rj(ref), 'utf8')); } catch { return null; }
}

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { away: false, workers: {} }; }
}
export function writeState(patch) {
  const next = { ...readState(), ...patch };
  atomicWrite(STATE_FILE, next);
  return next;
}

// Outbox: `say` messages that were shown at the TERMINAL and are awaiting either operator
// terminal activity (seen -> daemon drops them) or the escalation timeout (unseen -> daemon
// pushes them to Telegram). One JSON file per entry, id = filename, ordered by name.
let outboxSeq = 0;
export function writeOutbox(rec) {
  ensureDirs();
  const id = `${String(rec.shownAt ?? Date.now())}-${String(process.pid)}-${String(outboxSeq++).padStart(4, '0')}`;
  const entry = { ...rec, id };
  atomicWrite(path.join(OUTBOX_DIR, `${id}.json`), entry);
  return entry;
}
export function listOutbox() {
  try {
    return fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json')).sort()
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(OUTBOX_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
export function removeOutbox(id) { try { fs.unlinkSync(path.join(OUTBOX_DIR, `${id}.json`)); } catch { /* gone already */ } }

let inboxSeq = 0;
export function writeInbox(text) {
  ensureDirs();
  const name = `${String(Date.now())}-${String(inboxSeq++).padStart(4, '0')}.txt`;
  fs.writeFileSync(path.join(INBOX_DIR, name), String(text));
}
export function readAndClearInbox() {
  try {
    const files = fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.txt')).sort();
    const out = [];
    for (const f of files) {
      const full = path.join(INBOX_DIR, f);
      try { out.push(fs.readFileSync(full, 'utf8')); } catch { /* skip */ }
      try { fs.unlinkSync(full); } catch { /* gone */ }
    }
    return out;
  } catch { return []; }
}
export function inboxCount() {
  try { return fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.txt')).length; } catch { return 0; }
}
