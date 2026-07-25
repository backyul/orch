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

const ti = evt.tool_input || {};
const q = (ti.questions && ti.questions[0]) || {};
const worker = process.env.ORCH_WORKER || 'worker';
const paneId = process.env.TMUX_PANE || '';
const ref = genRef(worker);
const options = (q.options || []).map((o) => o.label).filter(Boolean);

writePending({
  ref, worker, paneId,
  type: options.length ? 'options' : 'freetext',
  text: q.question || 'Worker has a question',
  options, createdAt: Date.now(),
});

process.exit(0);
