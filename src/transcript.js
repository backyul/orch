// Unified operator<->orch transcript: one append-only JSONL file on LOCAL disk, mirroring every
// message exchanged on EITHER channel (terminal and Telegram, both directions). This is what lets
// the operator come back to the terminal and read the whole conversation — Telegram traffic
// otherwise exists only in the phone app, and the inbox is read-and-cleared.
//
// Mirroring is best-effort by contract: callers wrap append() so a disk hiccup can never block
// actual message delivery on the live comms path.
import fs from 'node:fs';
import path from 'node:path';
import { ORCH_DIR } from './config.js';

export const TRANSCRIPT_FILE = path.join(ORCH_DIR, 'transcript.jsonl');

export function append({ ts, from, channel, text }) {
  fs.mkdirSync(ORCH_DIR, { recursive: true });
  fs.appendFileSync(TRANSCRIPT_FILE, JSON.stringify({ ts, from, channel, text }) + '\n');
}

export function readLast(n = 50) {
  let raw = '';
  try { raw = fs.readFileSync(TRANSCRIPT_FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* corrupt line — skip, never break reading */ }
  }
  return out.slice(-n);
}
