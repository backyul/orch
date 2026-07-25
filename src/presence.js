// GUI presence detection: typing in a cockpit pane means the operator is AT the cockpit.
//
// Why this is a reliable signal: human keystrokes reach the host over the browser WebSocket
// ({t:'i'} messages), while every machine-injected message (daemon nudges, orch's cli.js
// send/answer) uses POST /api/send instead. So WS input = a human hand, never automation.
//
// Effect: flips the shared away flag to false, which re-routes orch's `say` from Telegram back
// to the pane (the operator is reading it right here) and restores the 90s escalation grace.
// The mirror rule already exists on the daemon side: any plain Telegram message from the
// operator sets away=true ("a message from the phone means they're on the phone").
//
// Throttled so a burst of typing costs one state read — not a file write per keystroke; the
// write itself only happens on a true->false transition (away is rarely true while typing).
export function createPresenceMarker({ bus, now = () => Date.now(), throttleMs = 5000, stampMs = 60_000 } = {}) {
  let lastCheck = -Infinity; // the FIRST keystroke must always check, whatever the clock says
  let lastStamp = -Infinity; // when we last wrote presentAt (refreshed while typing continues)
  return function markPresent() {
    const t = now();
    if (t - lastCheck < throttleMs) return false;
    lastCheck = t;
    try {
      const st = bus.readState();
      // presentAt is the heartbeat the daemon's AUTO-AWAY watches: presence must EXPIRE when the
      // operator stops typing (otherwise one evening keystroke pins away=false all night and orch's
      // `say` never reaches the phone). Refresh it at most once per stampMs while typing continues.
      // Also stamp lastChannel: typing here is a TERMINAL-side signal, which is what re-routes
      // orch's `say` back to the pane (see channelFor below).
      if (st.away === true) { bus.writeState({ away: false, presentAt: t, lastChannel: 'terminal', lastChannelAt: t }); lastStamp = t; return true; }
      if (t - lastStamp >= stampMs) { bus.writeState({ presentAt: t, lastChannel: 'terminal', lastChannelAt: t }); lastStamp = t; }
    } catch { /* state unreadable — never let presence tracking break input handling */ }
    return false;
  };
}

// WHERE orch's `say` should deliver. The operator's LAST-USED channel wins; `away` (manual
// /away, or the daemon's auto-away when the typing heartbeat goes stale) forces Telegram even if
// the terminal was last — that is the idle-timer half of automatic presence. A state with no
// lastChannel yet (first run after upgrade) degrades to exactly the legacy away-flag routing.
//
// Telegram-recency authority: a single stray/stale cockpit keystroke sets lastChannel='terminal'
// + presentAt and would steal routing away from a phone-bound operator for up to PRESENT_TIMEOUT_MS.
// So an inbound Telegram message at least as recent as the last cockpit heartbeat (lastTelegramAt
// >= presentAt) wins back the route — the operator's most-recent EXPLICIT contact decides. Genuine
// newer cockpit typing (presentAt > lastTelegramAt) still shows in the pane, unchanged.
export function channelFor(state) {
  if (state.away === true || state.lastChannel === 'telegram') return 'telegram';
  if ((state.lastTelegramAt || 0) >= (state.presentAt || 0) && (state.lastTelegramAt || 0) > 0) return 'telegram';
  return 'terminal';
}
