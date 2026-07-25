// src/turn-queue.js
// Serializes supervisor turns: one `claude -p` at a time (parallel resumes of the same
// session would fork it). Events that land mid-turn coalesce into the NEXT turn as one
// labeled prompt. A failed turn retries once, then surfaces through onError — the
// channel never fails silently.
const MAX_EVENT_CHARS = 20_000;
const MAX_PROMPT_CHARS = 120_000;
const truncate = (s, n) => (s.length <= n ? s : s.slice(0, n) + '\n…[truncated]');

export function createTurnQueue({ runTurn, onError = () => {}, maxItems = 40 } = {}) {
  let queue = [];
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, queue.length);
        const prompt = batch.length === 1
          ? batch[0].text
          : batch.map((e, i) => `[event ${i + 1}: ${e.label}]\n${e.text}`).join('\n\n');
        const capped = truncate(prompt, MAX_PROMPT_CHARS);
        try {
          await runTurn(capped, batch);
        } catch {
          try { await runTurn(capped, batch); }         // one retry
          catch (err2) { await Promise.resolve(onError(err2, batch)).catch(() => {}); }
        }
      }
    } finally { running = false; }
  }

  return {
    push(label, text) {
      queue.push({ label, text: truncate(String(text), MAX_EVENT_CHARS) });
      if (queue.length > maxItems) queue = queue.slice(-maxItems); // runaway guard
      drain().catch(() => {});
    },
    get busy() { return running; },
    get size() { return queue.length; },
  };
}
