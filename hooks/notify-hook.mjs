#!/usr/bin/env node
import { genRef, writePending } from '../src/bus.js';

const raw = await new Promise((resolve) => {
  let d = '';
  process.stdin.on('data', (c) => (d += c));
  process.stdin.on('end', () => resolve(d));
  process.stdin.on('error', () => resolve(d));
});

let evt = {};
try { evt = JSON.parse(raw); } catch { /* empty/invalid stdin */ }

const message = evt.message || '';

// Idle/lifecycle notices are pure noise — the worker just finished a turn and is
// waiting, not blocked on a question. Never escalate these.
const IDLE = [/waiting for (your )?input/i];

// Permission prompts ARE actionable, but the bare notification carries no options.
// Flag them as type 'permission'; the daemon enriches them by reading the dialog's
// real choices off the pane and escalating them as buttons.
const PERMISSION = [/needs your permission/i, /permission to use/i];

if (!message || IDLE.some((re) => re.test(message))) {
  process.exit(0);
}

const worker = process.env.ORCH_WORKER || 'worker';
const paneId = process.env.TMUX_PANE || '';
const ref = genRef(worker);
const isPermission = PERMISSION.some((re) => re.test(message));

writePending({
  ref, worker, paneId,
  type: isPermission ? 'permission' : 'freetext',
  text: message,
  options: [], createdAt: Date.now(),
});

process.exit(0);
