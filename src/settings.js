import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { loadEnv } from './config.js';

// Honor ORCH_ENV_FILE so the cockpit (an isolated instance) reads/writes its own bot-token file
// (e.g. .env.gui) instead of the repo's default .env.
function envPath(root) { return process.env.ORCH_ENV_FILE ? path.resolve(process.env.ORCH_ENV_FILE) : path.join(root, '.env'); }

function upsertEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n';
}

// A real Telegram bot token is "<numeric bot id>:<~35 chars of [A-Za-z0-9_-]>", and a chat id is a
// (possibly negative, for groups/channels) integer. Placeholder/test junk like "zzz", "123:ABC", or
// "test" fails these shapes. We validate BEFORE writing so a bogus Save can never overwrite a real
// stored credential — an earlier incident clobbered the live cockpit token with a test value ("zzz").
const TELEGRAM_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT_ID_RE = /^-?\d+$/;

// Returns a { token?, chatId? } map of human-readable errors for any field that carries a value but
// isn't real-looking. Blank fields are omitted (blank = "leave unchanged"), so this never complains
// about a field the caller didn't intend to set.
export function validateTelegram({ token, chatId } = {}) {
  const errors = {};
  const t = token && token.trim();
  const c = chatId != null && String(chatId).trim();
  if (t && !TELEGRAM_TOKEN_RE.test(t))
    errors.token = "That doesn't look like a real Telegram bot token (expected <botid>:<secret>). Not saved.";
  if (c && !TELEGRAM_CHAT_ID_RE.test(c))
    errors.chatId = 'Chat ID must be a number. Not saved.';
  return errors;
}

// Write-only from the UI's perspective: we accept new values and store them in the gitignored
// .env, but never read the token back out to callers.
//
// Throws a validation Error (with `.validation` = the per-field error map) if any provided value is
// not real-looking, and writes NOTHING in that case — a partial/placeholder Save must never clobber
// a good stored credential.
export function saveTelegram(root, { token, chatId }) {
  const errors = validateTelegram({ token, chatId });
  if (Object.keys(errors).length) {
    const e = new Error(Object.values(errors).join(' '));
    e.validation = errors;
    throw e;
  }
  let text = '';
  try { text = fs.readFileSync(envPath(root), 'utf8'); } catch { /* new file */ }
  // Only write fields that carry a value. An empty/blank string means "leave unchanged" so
  // saving one field (e.g. just the Chat ID) never blanks an already-stored token.
  if (token && token.trim()) text = upsertEnv(text, 'TELEGRAM_BOT_TOKEN', token.trim());
  if (chatId && String(chatId).trim()) text = upsertEnv(text, 'TELEGRAM_ALLOWED_CHAT_ID', String(chatId).trim());
  fs.writeFileSync(envPath(root), text);
}

// Prove connectivity end-to-end: read the stored creds and send a real Telegram message to the
// allowed chat. The token is read server-side and never returned to the caller.
export async function testTelegram(root, { fetch = globalThis.fetch, brand } = {}) {
  const { botToken, allowedChatId } = loadEnv(envPath(root));
  if (!botToken) return { ok: false, error: 'Bot token not set — paste it and Save first.' };
  if (!allowedChatId) return { ok: false, error: 'Chat ID not set — enter it and Save first.' };
  const raw = (brand && brand.trim()) || 'agent·grid';
  const name = raw.charAt(0).toUpperCase() + raw.slice(1); // sentence-case the first agent's name
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: allowedChatId, text: `✅ ${name} is connected to this chat. Worker questions will reach you here.` }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) return { ok: true };
    return { ok: false, error: data.description || `Telegram API HTTP ${r.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

export function telegramStatus(root) {
  let text = '';
  try { text = fs.readFileSync(envPath(root), 'utf8'); } catch { /* none */ }
  const tokenSet = /^TELEGRAM_BOT_TOKEN=.+$/m.test(text);
  const chatMatch = text.match(/^TELEGRAM_ALLOWED_CHAT_ID=(.+)$/m);
  return { tokenSet, chatId: chatMatch ? chatMatch[1].trim() : null };
}

// connected = does the claude CLI report an authenticated session? Injectable for tests.
// (Per the Task 6 spike there is no clean non-interactive auth-status command, so the default
// check is a coarse "claude is installed and runnable".)
export function claudeStatus({ check } = {}) {
  const fn = check || (() => {
    // shell:true so Windows resolves the `claude.cmd` shim (a bare spawn can't find it).
    const r = defaultSpawnSync('claude', ['--version'], { encoding: 'utf8', shell: true });
    return r.status === 0;
  });
  return { connected: !!fn() };
}

function readJson(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

// Default Claude-login launcher: opens the official OAuth flow. `claude` run interactively
// triggers its own browser sign-in; we spawn it detached in a new window.
function defaultLaunchClaudeLogin() {
  defaultSpawnSync('cmd', ['/c', 'start', '', 'claude'], { windowsHide: false });
}

export function createSettingsHandler({ root, launchClaudeLogin = defaultLaunchClaudeLogin, firstAgentName, cockpitConfig } = {}) {
  return async function handler(req, res) {
    const p = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && p === '/api/settings/telegram') return json(res, 200, telegramStatus(root));
      if (req.method === 'POST' && p === '/api/settings/telegram') {
        const b = await readJson(req);
        try { saveTelegram(root, { token: b.token, chatId: b.chatId }); }
        catch (e) { if (e.validation) return json(res, 400, { error: e.message, errors: e.validation }); throw e; }
        return json(res, 200, telegramStatus(root)); // returns status, never the token
      }
      if (req.method === 'POST' && p === '/api/settings/telegram/test') {
        return json(res, 200, await testTelegram(root, { brand: firstAgentName?.() }));
      }
      if (req.method === 'GET' && p === '/api/settings/agent') {
        return json(res, 200, { permissionMode: cockpitConfig?.getPermissionMode?.() ?? 'bypassPermissions', modes: cockpitConfig?.modes ?? [] });
      }
      if (req.method === 'POST' && p === '/api/settings/agent') {
        const b = await readJson(req);
        try { return json(res, 200, { permissionMode: cockpitConfig.setPermissionMode(b.permissionMode) }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && p === '/api/settings/claude/status') return json(res, 200, claudeStatus());
      if (req.method === 'POST' && p === '/api/settings/claude/connect') { launchClaudeLogin(); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: `no settings route ${req.method} ${p}` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  };
}
