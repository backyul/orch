// Refresh-proof per-agent history: reads the agent's Claude session transcript (the
// .jsonl claude itself writes under ~/.claude/projects/<slug>/<sessionId>.jsonl) and
// renders it as plain {role, ts, text} messages. The terminal's scrollback dies with
// the tab; this is the durable source of truth.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code's project-dir slug: the absolute cwd with every non-alphanumeric
// character flattened to '-'. (C:\Users\Public\orch -> C--Users-Public-orch)
export function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function transcriptPath({ claudeHome = path.join(os.homedir(), '.claude'), cwd, sessionId }) {
  return path.join(claudeHome, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

// One transcript line -> a display message, or null (thinking, sidechains, empties).
function toMessage(o) {
  if (!o || o.isSidechain) return null;
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  const c = o.message?.content;
  const parts = [];
  if (typeof c === 'string') parts.push(c);
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text' && b.text) parts.push(b.text);
      else if (b.type === 'tool_use') {
        const arg = b.input ? JSON.stringify(b.input) : '';
        parts.push(`⚙ ${b.name}${arg && arg !== '{}' ? ' ' + (arg.length > 120 ? arg.slice(0, 120) + '…' : arg) : ''}`);
      }
      // thinking / tool_result blocks are noise in a history view — skipped.
    }
  }
  const text = parts.join('\n').trim();
  if (!text) return null;
  return { role: o.type, ts: o.timestamp || null, text };
}

// Parse a whole .jsonl transcript. `limit` returns the LAST n messages; `before`
// shifts the window earlier (for "load earlier" paging). total = all messages.
export function parseTranscript(jsonlText, { limit = 300, before = 0 } = {}) {
  const messages = [];
  for (const line of String(jsonlText).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = toMessage(o);
    if (m) messages.push(m);
  }
  const total = messages.length;
  const end = Math.max(0, total - before);
  const start = Math.max(0, end - limit);
  return { messages: messages.slice(start, end), total, start };
}

// Route-facing helper: find and parse the current transcript for a live agent.
export function readHistory({ name, registry, cwd = process.cwd(), claudeHome, limit, before }) {
  const a = registry.get(name);
  if (!a) return { error: `no such agent "${name}"`, code: 404 };
  if (!a.sessionId) return { error: 'agent has no session yet', code: 409 };
  const file = transcriptPath({ claudeHome, cwd, sessionId: a.sessionId });
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { error: 'transcript not found (session may be brand new)', code: 404 }; }
  return { code: 200, sessionId: a.sessionId, ...parseTranscript(text, { limit, before }) };
}
