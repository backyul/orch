import { IDLE_TIMEOUT_MS } from './config.js';

export function computeEscalations({ pending, state, now, timeoutMs = IDLE_TIMEOUT_MS }) {
  const out = [];
  for (const p of pending) {
    if (p.escalatedAt) continue;
    // A 'permission' pending is not yet actionable — it waits for the daemon to
    // read the dialog's options off the pane (enrich -> 'options') before escalating.
    if (p.type === 'permission') continue;
    if (state.away === true) out.push({ ref: p.ref, reason: 'away' });
    else if (now - p.createdAt >= timeoutMs) out.push({ ref: p.ref, reason: 'timeout' });
  }
  return out;
}
