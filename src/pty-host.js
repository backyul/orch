import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as bus from './bus.js';
import { createRegistry } from './agent-registry.js';
import { createAgentsStore } from './agents-store.js';
import { makeRealPtyFactory } from './pty-factory.js';
import { createHostHandler } from './host-http.js';
import { createSettingsHandler } from './settings.js';
import { createTeamsStore } from './teams-store.js';
import { createTeamsHandler } from './teams-http.js';
import { DEFAULT_ORC_PERSONA, migrateOrcPersona } from './orc-persona.js';
import { createArchitect } from './architect.js';
import { createUsage } from './usage.js';
import { createCockpitConfig } from './cockpit-config.js';
import { writeAgentSettingsFile } from './agent-settings.js';
import { createPresenceMarker } from './presence.js';
import { ORCH_DIR } from './config.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.HOST_PORT || 7610);

// Crash guard: a stray error in a request/WS handler (e.g. a throw after headers were already sent)
// must NOT take the whole cockpit down. Log and keep serving — the host is a long-lived singleton
// and one bad request should never kill every agent's pane. (EADDRINUSE is handled at server.error.)
process.on('uncaughtException', (e) => { console.error('[host] uncaught:', e?.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[host] unhandledRejection:', e?.stack || e); });

const store = createAgentsStore(path.join(ORCH_DIR, 'agents.json'));
const cockpitConfig = createCockpitConfig();
// Written once BEFORE any agent spawns: Claude snapshots hooks at launch, so the settings file
// (quiet HUD + Notification/SessionStart hooks -> orc-hook.js) must exist first.
const agentSettingsFile = writeAgentSettingsFile({ root: ROOT });
const registry = createRegistry({ ptyFactory: makeRealPtyFactory({ cwd: ROOT, getPermissionMode: cockpitConfig.getPermissionMode, settingsFile: agentSettingsFile }), store });
// Reflect spawned agents into the bus state so the daemon/route address workers by NAME
// (replacing the old omc:%N pane-target registration). An agent named 'orch' (or role
// orchestrator) becomes the orchestratorWorker the daemon nudges.
registry.subscribe((ev) => {
  if (ev.type !== 'spawn') return;
  const st = bus.readState();
  const patch = { workers: { ...(st.workers || {}), [ev.agent.name]: ev.agent.name } };
  if (ev.agent.role === 'orchestrator' || ev.agent.name === 'orch') patch.orchestratorWorker = ev.agent.name;
  bus.writeState(patch);
});

// Typing in any pane over the browser WebSocket = the operator is AT the cockpit -> away=false,
// so orch's `say` re-routes from Telegram to the pane. Injected messages (daemon/orch) use
// /api/send, a different path, so automation can never fake presence.
const markPresent = createPresenceMarker({ bus });

const apiHandler = createHostHandler(registry, { bus });
const settingsHandler = createSettingsHandler({
  root: ROOT,
  cockpitConfig,
  // Mirror the cockpit brand: the orchestrator-role agent, else the first spawned agent.
  firstAgentName: () => { const l = registry.list(); const f = l.find((a) => a.role === 'orchestrator') || l[0]; return f ? f.name : null; },
});
const teams = createTeamsStore(ORCH_DIR);
const teamsHandler = createTeamsHandler({ registry, teams });
const architect = createArchitect({ root: ROOT });

// Usage/rate-limit line (via OMC's `omc hud`), cached + refreshed so the cockpit can show it
// without putting OMC into the agents themselves.
const usage = createUsage(); // direct Claude usage API (no OMC dependency)
let usageLine = null;
// Keep the last good line on a failed/empty read (getUsageLine returns null on a transient API
// error — it doesn't throw — so guarding on truthiness is what actually prevents the pill blanking).
async function refreshUsage() { try { const line = await usage.getUsageLine(); if (line) usageLine = line; } catch { /* keep last */ } }
refreshUsage();
setInterval(refreshUsage, 60000);

function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
}
function jsonRes(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

// Architect: chat that edits the cockpit's own web/ files (headless claude). Async so the
// multi-second turn doesn't block the host.
async function architectHandler(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'POST' && p === '/api/architect') {
      const body = await readBody(req);
      const msg = String(body.message || '').trim();
      if (!msg) return jsonRes(res, 400, { error: 'empty message' });
      const { reply } = await architect.ask(msg);
      return jsonRes(res, 200, { reply });
    }
    if (req.method === 'POST' && p === '/api/architect/revert') {
      return jsonRes(res, 200, architect.revert());
    }
    return jsonRes(res, 404, { error: `no architect route ${req.method} ${p}` });
  } catch (e) { return jsonRes(res, 500, { error: e.message }); }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serveStatic(req, res) {
  const rel = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// One-click backend restart (Settings button). We can't restart in-place (the PTYs die with the
// process), so: spawn a DETACHED helper that (1) bounces the Telegram daemon, (2) waits for our
// port to free, (3) starts a fresh host — then exit. The helper inherits our env (HOST_PORT /
// ORCH_STATE_DIR / ORCH_ENV_FILE / ORCH_DRIVER), so the new host is configured identically and
// resumeAll() brings every agent back with its conversation.
function selfRestart() {
  console.log('[host] restart requested — relaunching via detached helper');
  const helper = `Start-Sleep -Milliseconds 400; & '${path.join(ROOT, 'orch-gui.ps1')}' restart | Out-Null; ` +
    `Start-Sleep -Milliseconds 1200; Set-Location '${ROOT}'; node src/pty-host.js`;
  try {
    spawn('pwsh', ['-NoLogo', '-Command', helper], { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 250); // respond first, then die so the port frees for the successor
    return true;
  } catch (e) { console.error('[host] selfRestart failed:', e.message); return false; }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/host/restart')) {
    const ok = selfRestart();
    return jsonRes(res, ok ? 200 : 500, { ok, restarting: ok });
  }
  if (req.url.startsWith('/api/usage')) return jsonRes(res, 200, { line: usageLine });
  if (req.url.startsWith('/api/architect')) return architectHandler(req, res);
  if (req.url.startsWith('/api/settings')) return settingsHandler(req, res);
  if (req.url.startsWith('/api/teams') || req.url.startsWith('/api/import-member')) return teamsHandler(req, res);
  if (req.url.startsWith('/api/')) return apiHandler(req, res);
  return serveStatic(req, res);
});

// WebSocket: /ws?name=<agent> streams that PTY (replay ring first, then live data),
// and accepts keystrokes as inbound messages. We use noServer + a manual upgrade handler so
// `ws` never attaches to the http server's lifecycle — otherwise it re-emits the server's
// EADDRINUSE on the WebSocketServer instance, bypassing the singleton guard below.
const wss = new WebSocketServer({ noServer: true });
const reloadSockets = new Set(); // /ws-reload clients — told to refresh when the Architect edits web/
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname !== '/ws' && pathname !== '/ws-reload') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ws-reload') { reloadSockets.add(ws); ws.on('close', () => reloadSockets.delete(ws)); return; }
  const name = u.searchParams.get('name');
  try { ws.send(JSON.stringify({ type: 'replay', data: registry.capture(name) })); } catch { /* no such agent */ }
  const unsub = registry.subscribe((ev) => {
    if (ev.type === 'data' && ev.name === name) ws.send(JSON.stringify({ type: 'data', data: ev.data }));
    if (ev.type === 'status' && ev.agent?.name === name) ws.send(JSON.stringify({ type: 'status', agent: ev.agent }));
  });
  ws.on('message', (m) => {
    // Browser->host protocol: {t:'i',d} keystrokes, {t:'r',cols,rows} resize. Anything that
    // isn't that JSON is treated as raw keystrokes (backward-compatible).
    let msg; try { msg = JSON.parse(m.toString()); } catch { msg = null; }
    try {
      if (msg && msg.t === 'r') registry.resize(name, msg.cols, msg.rows);
      else if (msg && msg.t === 'i') { markPresent(); registry.send(name, msg.d); }
      else { markPresent(); registry.send(name, m.toString()); }
    } catch { /* gone */ }
  });
  ws.on('close', unsub);
});

// Live reload: when the Architect (or anyone) edits an editable web file, tell open tabs to
// refresh. Debounced; ignores vendor/ and non-editable assets.
let reloadTimer = null;
try {
  fs.watch(WEB, (_event, filename) => {
    const f = String(filename || '');
    if (!/\.(html|css|js)$/.test(f) || f.startsWith('vendor')) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      for (const ws of reloadSockets) { try { ws.send(JSON.stringify({ type: 'reload' })); } catch { /* dead socket */ } }
    }, 250);
  });
} catch { /* fs.watch unsupported — live reload simply won't fire */ }

// Singleton: refuse to double-bind the port (same pattern as the daemon).
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`[host] already running on :${PORT}`); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[host] cockpit on http://127.0.0.1:${PORT}`);
  // Upgrade a legacy default orchestrator persona in the manifest BEFORE resuming, so this very
  // restart bakes the current rules (presence/delivery) instead of resurrecting the old text.
  try {
    const manifest = store.load();
    if (migrateOrcPersona(manifest)) { store.save(manifest); console.log('[host] migrated orchestrator persona to the current default'); }
  } catch (e) { console.error('[host] persona migration skipped:', e.message); }
  registry.resumeAll();
  // A workspace always has an orchestrator: if nothing was resumed, spawn a default 'orch'
  // with the default orchestrator persona. Set HOST_NO_DEFAULT_ORCH=1 to opt out.
  if (!process.env.HOST_NO_DEFAULT_ORCH && registry.list().length === 0) {
    registry.spawn('orch', { persona: DEFAULT_ORC_PERSONA, role: 'orchestrator' });
    console.log('[host] no agents to resume — spawned default orchestrator "orch"');
  }
});
