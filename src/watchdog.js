// src/watchdog.js
// Cheap mechanical GUI-health checks, in plain code — no Claude turn, no tokens, while
// everything is green. A check that stays red for `strikes` consecutive sweeps emits ONE
// alert string (the supervisor turn's prompt); the episode re-arms only after a green.
import fs from 'node:fs';
import { loadEnv, WATCHDOG_INTERVAL_MS } from './config.js';
import { pollerLockFile, pidAlive } from './poller-lock.js';

export function createWatchdog({ checks, now = () => Date.now(), intervalMs = WATCHDOG_INTERVAL_MS, strikes = 2 } = {}) {
  let lastSweep = -Infinity;
  const red = Object.create(null);      // name -> consecutive failures
  const alerted = Object.create(null);  // name -> alerted this red episode
  return async function sweep() {
    if (now() - lastSweep < intervalMs) return [];
    lastSweep = now();
    const alerts = [];
    for (const c of checks) {
      let ok = false, detail = '';
      try { const r = await c.check(); ok = !!r.ok; detail = r.detail || ''; }
      catch (e) { detail = String(e?.message || e); }
      if (ok) { red[c.name] = 0; delete alerted[c.name]; continue; }
      red[c.name] = (red[c.name] || 0) + 1;
      if (red[c.name] >= strikes && !alerted[c.name]) {
        alerted[c.name] = true;
        alerts.push(`WATCHDOG: GUI check "${c.name}" failing (${red[c.name]} consecutive sweeps): ` +
          `${detail || 'no detail'}. Diagnose and fix it (logs, ./restart-host.ps1, ./orch-gui.ps1); ` +
          `then confirm health. FYI the operator only if you actually did something.`);
      }
    }
    return alerts;
  };
}

// The two real checks from the spec: cockpit host API reachable; GUI daemon process alive
// (via its poller-lock file — the GUI bot token comes from .env.gui, read fresh each check).
export function buildGuiChecks({ repoRoot, port = 7610, envFile, fetchImpl = fetch } = {}) {
  const guiEnv = envFile || `${repoRoot}/.env.gui`;
  return [
    {
      name: 'gui-host-api',
      check: async () => {
        try {
          const res = await fetchImpl(`http://127.0.0.1:${port}/api/agents`, { signal: AbortSignal.timeout(3000) });
          return { ok: res.ok, detail: res.ok ? '' : `HTTP ${res.status}` };
        } catch (e) { return { ok: false, detail: `host :${port} unreachable (${String(e?.message || e).slice(0, 80)})` }; }
      },
    },
    {
      name: 'gui-daemon',
      check: async () => {
        const { botToken } = loadEnv(guiEnv);
        if (!botToken) return { ok: true, detail: '' }; // no GUI bot configured -> nothing to watch
        try {
          const holder = JSON.parse(fs.readFileSync(pollerLockFile(botToken), 'utf8'));
          return pidAlive(holder.pid)
            ? { ok: true }
            : { ok: false, detail: `GUI daemon lock holder PID ${holder.pid} is dead` };
        } catch { return { ok: false, detail: 'GUI daemon poller lock missing (daemon not running)' }; }
      },
    },
  ];
}
