// Core pane delivery for a resolved pending. Reused by the daemon (deliverReply)
// and the CLI (`answer`). Options select on the option NUMBER (no Enter); free-text
// types the text + Enter. Targets the registered session-qualified pane.
export function routeAnswer(p, answer, source, { bus, tmux, now = Date.now }) {
  bus.writeReply({ ref: p.ref, answer, source, answeredAt: now() });
  const pane = bus.readState().workers?.[p.worker] || p.paneId;
  let delivered = false;
  if (pane) {
    try {
      if (p.type === 'options') {
        const idx = (p.options || []).indexOf(answer);
        if (idx >= 0) tmux.sendKeys(pane, String(idx + 1), { enter: false });
        else tmux.sendKeys(pane, answer);
      } else {
        tmux.sendKeys(pane, answer);
      }
      delivered = true;
    } catch { delivered = false; }
  }
  bus.removePending(p.ref);
  return { delivered, pane };
}
