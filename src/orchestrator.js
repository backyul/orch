import { execFileSync as defaultExec } from 'node:child_process';
import fs from 'node:fs';
import { SESSION_FILE, BRAIN_TIMEOUT_MS } from './config.js';

export function createOrchestrator({ exec = defaultExec, sessionFile = SESSION_FILE } = {}) {
  function loadSid() {
    try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessionId; } catch { return null; }
  }
  function saveSid(id) {
    try { fs.writeFileSync(sessionFile, JSON.stringify({ sessionId: id })); } catch { /* best effort */ }
  }
  return {
    ask(question, contextText) {
      const sid = loadSid();
      const prompt =
        `You are the orchestrator for several Claude Code worker sessions.\n` +
        `Current worker state (tail of each pane):\n${contextText}\n\n` +
        `The operator asks: ${question}\n` +
        `Answer concisely and plainly for a phone screen. No markdown tables.`;
      const args = ['-p', prompt, '--output-format', 'json'];
      if (sid) args.push('--resume', sid);
      const out = exec('claude', args, { encoding: 'utf8', timeout: BRAIN_TIMEOUT_MS });
      let text = out, newSid = sid;
      try { const j = JSON.parse(out); text = j.result ?? text; newSid = j.session_id ?? newSid; } catch { /* plain text */ }
      if (newSid && newSid !== sid) saveSid(newSid);
      return typeof text === 'string' ? text : String(text);
    },
  };
}
