// Channel-aware `say` (orch -> operator). Replaces the manual-away routing that lost 3 nights of
// 23:03 nudges: delivery now follows the operator's LAST-USED channel (see presence.channelFor),
// and a terminal-shown message is additionally queued in the outbox so the daemon can push it to
// Telegram if the operator doesn't show up at the terminal within SAY_ESCALATE_MS. Every message
// is mirrored to the unified transcript on either path.
import { channelFor } from './presence.js';
import * as defaultTranscript from './transcript.js';

export async function runSay({ bus, text, loadTg, now = () => Date.now(), print = console.log, transcript = defaultTranscript }) {
  const channel = channelFor(bus.readState());
  if (channel === 'telegram') {
    // Deliver FIRST, mirror after — a transcript/disk problem must never cost the message.
    const { tg, chatId } = loadTg();
    await tg.sendMessage(chatId, text);
    try { transcript.append({ ts: now(), from: 'orch', channel, text }); } catch { /* best-effort mirror */ }
    print('sent (telegram)');
    return { channel, sent: true };
  }
  // Terminal: stdout lands in orch's pane (as before). The outbox entry is the delivery guarantee:
  // the daemon sweep escalates it to Telegram if no terminal activity follows within the timeout.
  print(`(operator at terminal — shown here; escalates to Telegram if unseen):\n${text}`);
  try { transcript.append({ ts: now(), from: 'orch', channel, text }); } catch { /* best-effort mirror */ }
  try { bus.writeOutbox({ text, shownAt: now() }); } catch { /* outbox failure degrades to legacy print-only */ }
  return { channel, sent: false };
}
