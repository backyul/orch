// src/approvals.js
// File-based approval handshake between the approvals MCP server (runs as a child of the
// headless claude process) and the daemon (owns Telegram). Same pattern as bus.js pendings:
// one JSON file per request (req-<id>.json), one per answer (ans-<id>.json), in
// <stateDir>/approvals. Files, not IPC — both sides already share the state dir.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function approvalsDir(stateDir) { return path.join(stateDir, 'approvals'); }
const reqFile = (d, id) => path.join(approvalsDir(d), `req-${id}.json`);
const ansFile = (d, id) => path.join(approvalsDir(d), `ans-${id}.json`);

// Write-then-rename so concurrent readers (the MCP server polls while the daemon
// writes) never JSON.parse a half-written file. Same convention as bus.js.
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeRequest(stateDir, { toolName, input, worker, now = () => Date.now() }) {
  fs.mkdirSync(approvalsDir(stateDir), { recursive: true });
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const rec = { id, toolName: String(toolName || 'unknown'), input: input ?? {}, ts: now() };
  if (worker) rec.worker = String(worker);
  atomicWrite(reqFile(stateDir, id), JSON.stringify(rec));
  return rec;
}

export function readRequest(stateDir, id) {
  try { return JSON.parse(fs.readFileSync(reqFile(stateDir, id), 'utf8')); } catch { return null; }
}

export function updateRequest(stateDir, id, patch) {
  const cur = readRequest(stateDir, id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  atomicWrite(reqFile(stateDir, id), JSON.stringify(next));
  return next;
}

export function answerRequest(stateDir, id, allow, now = () => Date.now()) {
  fs.mkdirSync(approvalsDir(stateDir), { recursive: true });
  atomicWrite(ansFile(stateDir, id), JSON.stringify({ allow: !!allow, at: now() }));
}

export function readAnswer(stateDir, id) {
  try { return JSON.parse(fs.readFileSync(ansFile(stateDir, id), 'utf8')); } catch { return null; }
}

export function listRequests(stateDir) {
  let names = [];
  try { names = fs.readdirSync(approvalsDir(stateDir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = n.match(/^req-(.+)\.json$/);
    if (!m) continue;
    const rec = readRequest(stateDir, m[1]);
    if (rec) out.push({ ...rec, answered: readAnswer(stateDir, m[1]) !== null });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// Answered requests are done — clear them after a ttl so the dir doesn't grow forever.
// UNANSWERED requests are kept regardless of age (still awaiting the operator).
export function purgeOld(stateDir, { now = () => Date.now(), ttlMs = 24 * 3_600_000 } = {}) {
  for (const r of listRequests(stateDir)) {
    if (!r.answered || now() - r.ts < ttlMs) continue;
    try { fs.unlinkSync(reqFile(stateDir, r.id)); } catch { /* gone */ }
    try { fs.unlinkSync(ansFile(stateDir, r.id)); } catch { /* gone */ }
  }
}
