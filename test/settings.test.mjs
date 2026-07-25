import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTelegram, telegramStatus, claudeStatus, createSettingsHandler, testTelegram, validateTelegram } from '../src/settings.js';
import { createCockpitConfig } from '../src/cockpit-config.js';

// HERMETIC: never let an ambient ORCH_ENV_FILE (e.g. exported by orc-gui.ps1 for the running
// cockpit) redirect these writes into the real .env.gui. A prior incident clobbered the live
// cockpit token because the suite was run in a shell where ORCH_ENV_FILE pointed at .env.gui.
// Every test drives an explicit tmp root instead; the one test that exercises ORCH_ENV_FILE sets
// and restores it locally.
delete process.env.ORCH_ENV_FILE;

// Real-looking Telegram bot tokens (numeric bot id : ~35 chars of [A-Za-z0-9_-]) so they pass the
// saveTelegram validation gate. The exact secrets are arbitrary test values.
const TOKEN = '8123456789:AAHkq3nQ-test_token-abcdefghijklmnop-012345';
const TOKEN2 = '9987654321:BBGjw8xR-second_token-qrstuvwxyz-987654';

function reqres(method, url, body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = { method, url, on(ev, cb) { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); } };
  const res = { statusCode: 200, body: '', headers: {},
    writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, end(s) { this.body = s || ''; } };
  return { req, res };
}

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'settings-')); }

test('saveTelegram writes token + chat id into .env', () => {
  const root = tmpRoot();
  saveTelegram(root, { token: TOKEN, chatId: '777' });
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.match(env, new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN}`));
  assert.match(env, /TELEGRAM_ALLOWED_CHAT_ID=777/);
});

test('saveTelegram updates an existing key in place (no duplicate)', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.env'), 'TELEGRAM_BOT_TOKEN=old\nOTHER=keep\n');
  saveTelegram(root, { token: TOKEN2, chatId: '5' });
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.equal((env.match(/TELEGRAM_BOT_TOKEN=/g) || []).length, 1);
  assert.match(env, new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN2}`));
  assert.match(env, /OTHER=keep/);
});

test('saveTelegram with an empty token leaves an existing token untouched', () => {
  const root = tmpRoot();
  saveTelegram(root, { token: TOKEN, chatId: '777' });
  saveTelegram(root, { token: '', chatId: '888' }); // save just the chat id; blank token must not clobber
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.match(env, new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN}`));
  assert.match(env, /TELEGRAM_ALLOWED_CHAT_ID=888/);
});

test('validateTelegram flags placeholder/test values and passes real ones', () => {
  assert.deepEqual(validateTelegram({ token: TOKEN, chatId: '42' }), {});
  assert.deepEqual(validateTelegram({ token: TOKEN, chatId: '-1001234567890' }), {}); // group chat id
  assert.ok(validateTelegram({ token: 'zzz' }).token);        // the value the incident wrote
  assert.ok(validateTelegram({ token: '123:ABC' }).token);    // too-short secret
  assert.ok(validateTelegram({ token: 'test' }).token);
  assert.ok(validateTelegram({ chatId: 'not-a-number' }).chatId);
  assert.deepEqual(validateTelegram({ token: '', chatId: '' }), {}); // blank = leave unchanged, no error
});

test('saveTelegram refuses a placeholder token and writes nothing', () => {
  const root = tmpRoot();
  assert.throws(() => saveTelegram(root, { token: 'zzz', chatId: '3' }), (e) => !!(e.validation && e.validation.token));
  assert.ok(!fs.existsSync(path.join(root, '.env'))); // never created a file with junk creds
});

test('saveTelegram will not clobber a stored real token with a placeholder', () => {
  const root = tmpRoot();
  saveTelegram(root, { token: TOKEN, chatId: '777' });
  assert.throws(() => saveTelegram(root, { token: 'zzz', chatId: '3' }), /Telegram bot token/);
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.match(env, new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN}`)); // real token survives the bad Save
  assert.match(env, /TELEGRAM_ALLOWED_CHAT_ID=777/);           // and so does the chat id
});

test('testTelegram posts a sendMessage to the Bot API with stored creds', async () => {
  const root = tmpRoot();
  saveTelegram(root, { token: TOKEN, chatId: '42' });
  let seen = null;
  const fetch = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ ok: true }) }; };
  const r = await testTelegram(root, { fetch, brand: 'orch' });
  assert.equal(r.ok, true);
  assert.match(seen.url, new RegExp(`api\\.telegram\\.org/bot${TOKEN}/sendMessage`));
  assert.equal(seen.body.chat_id, '42');
  assert.match(seen.body.text, /^✅ Orch is connected/); // first agent name, sentence-cased
});

test('testTelegram reports an error when the token is missing', async () => {
  const root = tmpRoot();
  saveTelegram(root, { chatId: '42' });
  const r = await testTelegram(root, { fetch: async () => { throw new Error('should not be called'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /token not set/i);
});

test('telegramStatus reports set/not-set without revealing the secret', () => {
  const root = tmpRoot();
  assert.deepEqual(telegramStatus(root), { tokenSet: false, chatId: null });
  saveTelegram(root, { token: TOKEN, chatId: '9' });
  const st = telegramStatus(root);
  assert.equal(st.tokenSet, true);
  assert.equal(st.chatId, '9');
  assert.ok(!JSON.stringify(st).includes(TOKEN)); // never echoes the token
});

test('ORCH_ENV_FILE redirects where the token is read/written (isolated GUI instance)', () => {
  const root = tmpRoot();
  const alt = path.join(tmpRoot(), 'custom.env');
  const prev = process.env.ORCH_ENV_FILE;
  process.env.ORCH_ENV_FILE = alt;
  try {
    saveTelegram(root, { token: TOKEN, chatId: '5' });
    assert.ok(!fs.existsSync(path.join(root, '.env')));        // default location untouched
    assert.match(fs.readFileSync(alt, 'utf8'), new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN}`));
    assert.equal(telegramStatus(root).tokenSet, true);         // reads back from ORCH_ENV_FILE
  } finally {
    if (prev === undefined) delete process.env.ORCH_ENV_FILE; else process.env.ORCH_ENV_FILE = prev;
  }
});

test('claudeStatus returns connected boolean from the injected checker', () => {
  assert.equal(claudeStatus({ check: () => true }).connected, true);
  assert.equal(claudeStatus({ check: () => false }).connected, false);
});

test('GET /api/settings/telegram reports set/not-set', async () => {
  const root = tmpRoot();
  const { req, res } = reqres('GET', '/api/settings/telegram');
  await createSettingsHandler({ root })(req, res);
  assert.deepEqual(JSON.parse(res.body), { tokenSet: false, chatId: null });
});

test('POST /api/settings/telegram saves and never echoes the token', async () => {
  const root = tmpRoot();
  const { req, res } = reqres('POST', '/api/settings/telegram', { token: TOKEN, chatId: '3' });
  await createSettingsHandler({ root })(req, res);
  assert.ok(!res.body.includes(TOKEN));
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), new RegExp(`TELEGRAM_BOT_TOKEN=${TOKEN}`));
});

test('POST /api/settings/telegram rejects a placeholder token with 400 and does not write', async () => {
  const root = tmpRoot();
  const { req, res } = reqres('POST', '/api/settings/telegram', { token: 'zzz', chatId: '3' });
  await createSettingsHandler({ root })(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(JSON.parse(res.body).errors.token); // per-field error for the UI
  assert.ok(!fs.existsSync(path.join(root, '.env')));
});

test('GET/POST /api/settings/agent reads and sets the permission mode', async () => {
  const cockpitConfig = createCockpitConfig({ file: path.join(tmpRoot(), 'cockpit.json') });
  let rr = reqres('GET', '/api/settings/agent');
  await createSettingsHandler({ root: tmpRoot(), cockpitConfig })(rr.req, rr.res);
  assert.equal(JSON.parse(rr.res.body).permissionMode, 'bypassPermissions'); // default
  rr = reqres('POST', '/api/settings/agent', { permissionMode: 'plan' });
  await createSettingsHandler({ root: tmpRoot(), cockpitConfig })(rr.req, rr.res);
  assert.equal(JSON.parse(rr.res.body).permissionMode, 'plan');
  assert.equal(cockpitConfig.getPermissionMode(), 'plan'); // persisted
});

test('POST /api/settings/agent rejects an invalid mode with 400', async () => {
  const cockpitConfig = createCockpitConfig({ file: path.join(tmpRoot(), 'cockpit.json') });
  const { req, res } = reqres('POST', '/api/settings/agent', { permissionMode: 'bad' });
  await createSettingsHandler({ root: tmpRoot(), cockpitConfig })(req, res);
  assert.equal(res.statusCode, 400);
});

test('POST /api/settings/claude/connect invokes the launcher', async () => {
  const root = tmpRoot();
  let launched = false;
  const { req, res } = reqres('POST', '/api/settings/claude/connect');
  await createSettingsHandler({ root, launchClaudeLogin: () => { launched = true; } })(req, res);
  assert.equal(launched, true);
});
