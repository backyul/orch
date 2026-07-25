#!/usr/bin/env node
// Live workspace dashboard. Runs in the top-left pane of the `omc` workspace and
// refreshes every ~1.5s. It shows, for every registered worker (the orchestrator
// excluded): activity status, context usage, session time and current model — plus
// the shared account token limits (5h / weekly / sonnet) read straight off the OMC
// HUD status line that each Claude Code pane already renders. No new tracking infra:
// everything here is scraped from `tmux capture-pane`, the single source of truth.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bus from './bus.js';

const REFRESH_MS = 1500;

// Pane targets are session-qualified ("omc:%9") or bare ("%9"); capture-pane accepts both.
function capture(target) {
  const r = spawnSync('tmux', ['capture-pane', '-p', '-t', target], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null; // null => pane gone
}

// The set of pane ids that currently exist anywhere, so we can flag dead registrations.
function livePaneIds() {
  const r = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
  if (r.status !== 0) return null; // tmux unavailable -> don't claim panes are dead
  return new Set(r.stdout.split('\n').map(s => s.trim()).filter(Boolean));
}

const barePane = (t) => String(t).includes(':') ? String(t).split(':').pop() : String(t);

// Pull the interesting fields out of a captured pane. The OMC HUD line looks like:
//   ...| Model: Opus 4.8 | 5h:13%(4h33m) wk:29%(1d13h) sn:2%(1d13h) | thinking | session:8m | ctx:6% | T:11
export function parsePane(text) {
  const t = String(text || '');
  const m1 = (re) => { const m = t.match(re); return m ? m[1] : null; };
  const busy = /esc to interrupt/i.test(t); // authoritative "a turn is generating"
  return {
    busy,
    model: m1(/Model:\s*([^|]+?)\s*(?:\||$)/m)?.trim() || null,
    ctx: m1(/\bctx:(\d+)%/),
    session: m1(/\bsession:(\S+)/),
    turns: m1(/\bT:(\d+)/),
    limits: {
      h5: t.match(/\b5h:(\d+)%\(([^)]+)\)/),
      wk: t.match(/\bwk:(\d+)%\(([^)]+)\)/),
      sn: t.match(/\bsn:(\d+)%\(([^)]+)\)/),
    },
  };
}

// ── tiny ANSI helpers ──────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
// colour a "NN%" usage figure: green < 60, yellow < 85, red otherwise.
function pct(v) {
  if (v == null) return C.gray + '  -' + C.reset;
  const n = Number(v), col = n >= 85 ? C.red : n >= 60 ? C.yellow : C.green;
  return col + String(n).padStart(3) + '%' + C.reset;
}

function statusBadge(s) {
  if (s === 'waiting') return C.yellow + '● waiting' + C.reset;
  if (s === 'working') return C.green + '● working' + C.reset;
  if (s === 'dead')    return C.red + '○ gone   ' + C.reset;
  return C.gray + '○ idle   ' + C.reset;
}

function render() {
  const state = bus.readState();
  const pending = bus.listPending();
  const orchName = state.orchestratorWorker;
  const workersMap = state.workers || {};
  const live = livePaneIds();

  // Build the worker rows: every registered name except the orchestrator, deduped by pane.
  const seen = new Set();
  const orchPaneBare = orchName && workersMap[orchName] ? barePane(workersMap[orchName]) : null;
  const rows = [];
  let accountLimits = null;
  for (const [name, target] of Object.entries(workersMap)) {
    if (name === orchName) continue;
    const pb = barePane(target);
    if (pb === orchPaneBare) continue;       // a stale alias pointing at the orch pane
    if (seen.has(pb)) continue;
    seen.add(pb);

    const alive = live ? live.has(pb) : true;
    const text = alive ? capture(target) : null;
    const info = parsePane(text);
    const waiting = pending.some(p => p.worker === name);
    const status = !alive || text == null ? 'dead' : waiting ? 'waiting' : info.busy ? 'working' : 'idle';

    // The 5h/wk/sn limits are account-global (shared across panes) — grab the first we see.
    if (!accountLimits && (info.limits.h5 || info.limits.wk || info.limits.sn)) accountLimits = info.limits;

    rows.push({ name, status, info, waiting });
  }

  const out = [];
  out.push(C.bold + C.cyan + 'WORKSPACE DASHBOARD' + C.reset + C.dim + `   refresh ${REFRESH_MS}ms   workers: ${rows.length}` + C.reset);

  // Account token limits banner.
  const fmtLim = (lbl, m) => m ? `${lbl} ${pct(m[1])}${C.dim}(${m[2]})${C.reset}` : `${lbl} ${C.gray}-${C.reset}`;
  if (accountLimits) {
    out.push('  ' + C.dim + 'token limits:' + C.reset + '  ' +
      fmtLim('5h', accountLimits.h5) + '   ' +
      fmtLim('week', accountLimits.wk) + '   ' +
      fmtLim('sonnet', accountLimits.sn));
  } else {
    out.push('  ' + C.dim + 'token limits: (no status line captured yet)' + C.reset);
  }
  out.push('');

  // Worker table.
  out.push(C.dim + '  ' + pad('WORKER', 10) + pad('STATUS', 12) + pad('CTX', 7) + pad('SESSION', 10) + pad('MODEL', 14) + C.reset);
  if (rows.length === 0) {
    out.push('  ' + C.gray + '(no workers registered — start some with start-worker.ps1)' + C.reset);
  }
  for (const r of rows) {
    out.push('  ' +
      pad(r.name, 10) +
      statusBadge(r.status) + '   ' +  // every badge is a fixed 9 visible chars; 3-space gap = 12-wide column
      pad(r.info.ctx != null ? r.info.ctx + '%' : '-', 7) +
      pad(r.info.session || '-', 10) +
      pad(r.info.model || '-', 14));
    if (r.waiting) {
      const q = pending.find(p => p.worker === r.name);
      if (q) out.push('      ' + C.yellow + '↳ needs input: ' + C.reset + String(q.text).slice(0, 70));
    }
  }

  process.stdout.write('\x1b[2J\x1b[H' + out.join('\n') + '\n');
}

function loop() {
  try { render(); } catch (e) { process.stdout.write('\x1b[2J\x1b[Hdashboard error: ' + (e?.message || e) + '\n'); }
  setTimeout(loop, REFRESH_MS);
}

// Only take over the terminal when run directly (importing for tests must stay side-effect free).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write('\x1b[?25l'); // hide cursor
  process.on('SIGINT', () => { process.stdout.write('\x1b[?25h\n'); process.exit(0); });
  loop();
}
