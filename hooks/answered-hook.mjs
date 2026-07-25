#!/usr/bin/env node
// PostToolUse[AskUserQuestion] hook: fires once a question has been answered (in
// the pane OR via the orchestrator). Clears any still-open pending for this worker
// so a stale Telegram escalation can't linger and double-deliver. If the question
// had been escalated, the daemon's tick reconciliation then sends a "resolved at the
// terminal" note. Reading stdin is not required, but we drain it so the pipe closes.
import { listPending, removePending } from '../src/bus.js';

await new Promise((resolve) => {
  let drained = false;
  const done = () => { if (!drained) { drained = true; resolve(); } };
  process.stdin.on('data', () => {});
  process.stdin.on('end', done);
  process.stdin.on('error', done);
  // Safety: if stdin never closes, don't hang the hook.
  setTimeout(done, 500);
});

const worker = process.env.ORCH_WORKER || 'worker';
for (const p of listPending()) {
  if (p.worker === worker) removePending(p.ref);
}

process.exit(0);
