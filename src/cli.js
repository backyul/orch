#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as bus from './bus.js';
import { createTelegram } from './telegram.js';
import { createOrchestrator } from './orchestrator.js';
import { runDaemon } from './daemon.js';
import { loadEnv } from './config.js';
import { routeAnswer } from './route.js';
import { makeSpawnRequest } from './spawn-request.js';
import { createHostClient } from './host-client.js';
import { sendKeys as tmuxSendKeys, capturePane as tmuxCapturePane } from './tmux.js';
import { createSchedules } from './schedules.js';
import { ORCH_DIR, APPROVAL_WAIT_MS } from './config.js';
import { readRequest as readApprovalRequest, answerRequest, updateRequest as updateApprovalRequest } from './approvals.js';
import { runSay } from './say.js';
import { readLast } from './transcript.js';
import { acquirePollerLock } from './poller-lock.js';
import { createSupervisor } from './supervisor.js';
import { SUPERVISOR_PERSONA } from './supervisor-persona.js';
import { createWatchdog, buildGuiChecks } from './watchdog.js';

const cmd = process.argv[2];
const schedules = createSchedules({ file: path.join(ORCH_DIR, 'schedules.json') });
// ORCH_ENV_FILE lets an isolated instance load a different bot token (e.g. .env.gui for the cockpit).
const envPath = process.env.ORCH_ENV_FILE
  ? path.resolve(process.env.ORCH_ENV_FILE)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (cmd === 'daemon') {
  const { botToken, allowedChatId } = loadEnv(envPath);
  if (!botToken || !allowedChatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHAT_ID (set in .env).');
    process.exit(1);
  }
  // getUpdates is exclusive per token: refuse to start a SECOND poller on the same bot (the
  // 409-Conflict log flood). Loud + fatal beats two daemons silently fighting for updates.
  const lock = acquirePollerLock(botToken);
  if (!lock.ok) {
    console.error(`Another daemon (PID ${lock.holderPid}) is already polling this bot token — refusing to start a second poller.`);
    console.error('Stop it first (./orch.ps1 stop or ./orch-gui.ps1 stop), or give this instance its own bot token.');
    process.exit(1);
  }
  process.on('exit', () => lock.release());
  const tg = createTelegram({ token: botToken });
  const orch = createOrchestrator({});
  const hostClient = createHostClient({});
  // Two delivery drivers, selected by ORCH_DRIVER:
  //   host  -> the cockpit GUI daemon drives the PTY host, addressing agents by NAME.
  //   psmux -> the terminal daemon drives psmux panes by pane id (the original tmux interface).
  // The GUI launcher (orch-gui.ps1) sets ORCH_DRIVER=host; the terminal launcher defaults to psmux.
  // hostClient is still passed for the spawn-request approve path ("Approve & spawn").
  const useHost = process.env.ORCH_DRIVER === 'host';
  const driver = useHost
    ? hostClient
    : { sendKeys: (t, text, o) => tmuxSendKeys(t, text, o), capturePane: (t) => tmuxCapturePane(t) };
  console.log(`[daemon] starting; sole Telegram poller. Driver: ${useHost ? 'host' : 'psmux'}. Allowed chat:`, allowedChatId);
  // Supervisor mode (spec: docs/superpowers/specs/2026-07-18-telegram-supervisor-design.md):
  // the daemon routes events into a headless Claude session instead of a TUI orch pane.
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(srcDir, '..');
  const supervisorMode = (process.env.ORCH_MODE || loadEnv(envPath).orchMode) === 'supervisor';
  let supervisor = null, watchdog = null;
  if (supervisorMode) {
    // Env hygiene: the watchdog's gui-daemon check reads .env.gui via loadEnv, whose
    // process.env.TELEGRAM_BOT_TOKEN fallback would silently make it watch the WRONG bot.
    // Our own token is already loaded above — drop the ambient var so file wins.
    delete process.env.TELEGRAM_BOT_TOKEN;
    supervisor = createSupervisor({
      stateDir: ORCH_DIR,
      // cwd = SUPERVISOR_CWD if set, else the operator's home dir — the inherited design
      // session lives in the home-dir project, and --resume only finds sessions of its
      // own project dir. Tools use absolute paths / cd, so cwd is not limiting.
      cwd: process.env.SUPERVISOR_CWD || os.homedir(),
      personaText: SUPERVISOR_PERSONA,
      approvalsServerPath: path.join(srcDir, 'approvals-mcp.js'),
    });
    watchdog = createWatchdog({ checks: buildGuiChecks({ repoRoot }) });
    console.log('[daemon] SUPERVISOR mode: headless session, no orch pane.');
  }
  const { createTeam: _createTeam } = await import('./team.js');
  const team = supervisorMode ? _createTeam({ stateDir: ORCH_DIR }) : null;
  runDaemon({ bus, tg, tmux: driver, hostClient, orch, schedules, supervisor, watchdog, team,
    orchDir: ORCH_DIR, chatId: allowedChatId, now: () => Date.now() });
} else if (cmd === 'away') {
  bus.writeState({ away: true, awaySetAt: Date.now() });
  console.log('away = true');
} else if (cmd === 'back') {
  // Manual override run at the terminal: also assert the terminal as last channel, else a
  // lingering telegram-last stamp would keep routing `say` to the phone.
  bus.writeState({ away: false, lastChannel: 'terminal', lastChannelAt: Date.now() });
  console.log('away = false (terminal is the active channel)');
} else if (cmd === 'status') {
  console.log(JSON.stringify({ state: bus.readState(), pending: bus.listPending(), outbox: bus.listOutbox() }, null, 2));
} else if (cmd === 'register-worker') {
  const name = process.argv[3];
  const target = process.argv[4] || name; // name-addressed via the host; target defaults to the name
  if (!name) { console.error('usage: cli.js register-worker <name>'); process.exit(1); }
  const st = bus.readState();
  bus.writeState({ workers: { ...(st.workers || {}), [name]: target } });
  console.log(`registered ${name} -> ${target}`);
} else if (cmd === 'reset-workers') {
  // Clear the worker registry (and orchestrator pointer) so a fresh workspace doesn't
  // inherit stale pane ids from a previous session. Panes register themselves on launch.
  bus.writeState({ workers: {}, orchestratorWorker: null });
  console.log('workers reset');
} else if (cmd === 'set-orchestrator') {
  const name = process.argv[3];
  if (!name) { console.error('usage: cli.js set-orchestrator <name>'); process.exit(1); }
  bus.writeState({ orchestratorWorker: name });
  console.log(`orchestrator = ${name}`);
} else if (cmd === 'inbox') {
  const msgs = bus.readAndClearInbox();
  console.log(msgs.length ? msgs.map((m, i) => `--- message ${i + 1} ---\n${m}`).join('\n\n') : '(inbox empty)');
} else if (cmd === 'answer') {
  const ref = process.argv[3];
  let choice = process.argv.slice(4).join(' ');
  const p = bus.readPending(ref);
  if (!p) { console.error(`no pending ${ref}`); process.exit(1); }
  if (p.type === 'options' && /^\d+$/.test(choice)) { choice = p.options?.[Number(choice) - 1] ?? choice; }
  const { delivered, pane } = routeAnswer(p, choice, 'orchestrator', { bus, tmux: createHostClient({}) });
  console.log(delivered ? `answered ${ref} (${p.worker}@${pane}): ${choice}`
                        : `could not deliver to ${p.worker} — pane gone (answer recorded, pending cleared)`);
} else if (cmd === 'schedule') {
  // Daily wall-clock nudge, run by the DAEMON (fires even when this agent's session is asleep —
  // unlike an agent-side cron). At HH:MM the daemon puts <message> in the orchestrator inbox + nudges.
  const time = process.argv[3];
  const message = process.argv.slice(4).join(' ');
  const id = schedules.add(time, message);
  console.log(`scheduled ${id} — daily at ${time}: ${message}`);
} else if (cmd === 'schedules') {
  const l = schedules.list();
  console.log(l.length ? l.map((s) => `${s.id}  ${s.time} daily  ${s.message}`).join('\n') : '(no schedules)');
} else if (cmd === 'unschedule') {
  const id = process.argv[3];
  if (!id) { console.error('usage: cli.js unschedule <id>'); process.exit(1); }
  console.log(schedules.remove(id) ? `removed ${id}` : `no schedule ${id}`);
} else if (cmd === 'dismiss') {
  // Clear a worker's "needs input" flag WITHOUT sending anything to the worker — for when the
  // worker simply finished (or is idle with no task) and nothing is needed. Paired with the
  // daemon's per-episode signaling, this is how the orchestrator ends the reminders: the flag
  // won't re-fire until that worker goes busy and idles again.
  const ref = process.argv[3];
  if (!ref) { console.error('usage: cli.js dismiss <ref>'); process.exit(1); }
  const p = bus.readPending(ref);
  if (!p) { console.log(`no pending ${ref} (already cleared)`); process.exit(0); }
  bus.removePending(ref);
  console.log(`dismissed ${ref} (${p.worker}) — no input sent, reminders stopped for this idle episode`);
} else if (cmd === 'say') {
  const msg = process.argv.slice(3).join(' ');
  if (!msg) { console.error('usage: cli.js say "<message>"'); process.exit(1); }
  // Channel-aware delivery: follows the operator's last-used channel (see presence.channelFor).
  // Terminal-shown messages are outboxed so the daemon escalates them to Telegram if unseen.
  await runSay({
    bus, text: msg,
    loadTg: () => {
      const { botToken, allowedChatId } = loadEnv(envPath);
      if (!botToken || !allowedChatId) throw new Error('missing TELEGRAM_BOT_TOKEN / CHAT_ID');
      return { tg: createTelegram({ token: botToken }), chatId: allowedChatId };
    },
  });
} else if (cmd === 'transcript') {
  // The unified operator<->orch history (both channels, both directions) — how the operator
  // catches up at the terminal on everything that happened over Telegram.
  const n = Number(process.argv[3]) || 50;
  const rows = readLast(n);
  console.log(rows.length
    ? rows.map((e) => {
        const hhmm = new Date(e.ts).toTimeString().slice(0, 5);
        return `${hhmm} ${e.from === 'orch' ? 'orch    ' : 'operator'} [${e.channel}] ${e.text}`;
      }).join('\n')
    : '(transcript empty)');
} else if (cmd === 'send') {
  const name = process.argv[3];
  const text = process.argv.slice(4).join(' ');
  if (!name || !text) { console.error('usage: cli.js send <name> "<text>"'); process.exit(1); }
  const hc = createHostClient({});
  hc.sendKeys(name, text);
  await hc.flush();
  console.log(`sent to ${name}`);
} else if (cmd === 'capture') {
  const name = process.argv[3];
  if (!name) { console.error('usage: cli.js capture <name>'); process.exit(1); }
  console.log(createHostClient({}).capturePane(name));
} else if (cmd === 'suggest-spawn') {
  const name = process.argv[3];
  const why = process.argv.slice(4).join(' ');
  if (!name) { console.error('usage: cli.js suggest-spawn <name> "<why>"'); process.exit(1); }
  const rec = makeSpawnRequest(bus, { name, why });
  console.log(`proposed spawn ${name} (${rec.ref}) — awaiting operator approval`);
} else if (cmd === 'team-spawn') {
  // team-spawn <name> --repo <path> --task "<brief>" [--model m] [--worktree <existing>] [--persona "<text>"]
  const { execFileSync } = await import('node:child_process');
  const { createTeam } = await import('./team.js');
  const name = process.argv[3];
  const opt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  const repo = opt('--repo'); const task = opt('--task');
  if (!name || !repo || !task) { console.error('usage: cli.js team-spawn <name> --repo <path> --task "<brief>" [--model sonnet|opus|haiku] [--worktree <path>] [--persona "<text>"]'); process.exit(1); }
  const branch = `team/${name}`;
  let worktree = opt('--worktree');
  const team = createTeam({ stateDir: ORCH_DIR });
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  if (!worktree) {
    worktree = path.join(repo, '.claude', 'worktrees', `team-${name}`);
    // Fails loudly (throws, non-zero exit) on collision/git trouble — nothing half-created.
    execFileSync('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branch], { stdio: 'pipe' });
  }
  try {
    const rec = team.spawnWorker({ name, repo, worktree, branch, model: opt('--model') || 'sonnet',
      task, personaExtra: opt('--persona') || '', approvalsServerPath: path.join(srcDir, 'approvals-mcp.js') });
    console.log(`spawned worker ${rec.name} (model ${rec.model}) in ${worktree} on ${branch}; first turn on next daemon tick`);
  } catch (e) {
    // Roll back a worktree we just created so a failed spawn leaves nothing behind.
    if (!opt('--worktree')) { try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { stdio: 'pipe' }); } catch { /* leave for manual cleanup */ } }
    console.error(e.message); process.exit(1);
  }
} else if (cmd === 'team-status') {
  const { createTeam } = await import('./team.js');
  const ws = createTeam({ stateDir: ORCH_DIR }).listWorkers();
  if (!ws.length) console.log('(no workers)');
  for (const w of ws) console.log(`${w.name}\t${w.status}\tturns=${w.turnCount}\t${w.branch}\t${w.model}\t${(w.lastReplyTail || '').slice(-120).replace(/\n/g, ' ')}`);
} else if (cmd === 'team-send') {
  const { createTeam } = await import('./team.js');
  const name = process.argv[3]; const msg = process.argv[4];
  if (!name || !msg) { console.error('usage: cli.js team-send <name> "<message>"'); process.exit(1); }
  try { const w = createTeam({ stateDir: ORCH_DIR }).sendToWorker(name, msg); console.log(`queued for ${name} (status now ${w.status})`); }
  catch (e) { console.error(e.message); process.exit(1); }
} else if (cmd === 'team-retire') {
  const { execFileSync } = await import('node:child_process');
  const { createTeam, canRemoveWorktree } = await import('./team.js');
  const name = process.argv[3];
  const keep = process.argv.includes('--keep-worktree');
  const team = createTeam({ stateDir: ORCH_DIR });
  const w = team.readWorker(name);
  if (!w) { console.error(`no such worker "${name}"`); process.exit(1); }
  if (!keep) {
    let porcelain = '', mergedBranches = '';
    try {
      porcelain = execFileSync('git', ['-C', w.worktree, 'status', '--porcelain'], { encoding: 'utf8' });
      mergedBranches = execFileSync('git', ['-C', w.repo, 'branch', '--merged'], { encoding: 'utf8' });
    } catch (e) { console.error(`git check failed: ${e.message} — retire with --keep-worktree to skip removal`); process.exit(1); }
    const gate = canRemoveWorktree({ porcelain, mergedBranches, branch: w.branch });
    if (!gate.ok) { console.error(`REFUSED: ${gate.reason}. Merge/commit first, or retire with --keep-worktree.`); process.exit(1); }
    execFileSync('git', ['-C', w.repo, 'worktree', 'remove', w.worktree], { stdio: 'pipe' });
  }
  team.retireWorker(name);
  console.log(`retired ${name}${keep ? ' (worktree kept)' : ''}`);
} else if (cmd === 'team-approve') {
  const { createTeam } = await import('./team.js');
  const id = process.argv[3]; const verdict = process.argv[4];
  if (!id || !['allow', 'deny'].includes(verdict)) { console.error('usage: cli.js team-approve <id> allow|deny'); process.exit(1); }
  const req = readApprovalRequest(ORCH_DIR, id);
  if (!req) { console.error(`no approval request ${id}`); process.exit(1); }
  answerRequest(ORCH_DIR, id, verdict === 'allow');
  // If the worker's turn already gave up waiting (deny-with-PENDING), tell it to retry.
  if (verdict === 'allow' && req.worker && Date.now() - req.ts > APPROVAL_WAIT_MS) {
    try { createTeam({ stateDir: ORCH_DIR }).sendToWorker(req.worker, `Your earlier permission request (${req.toolName}) was APPROVED — you may retry that action now.`); } catch { /* worker gone */ }
  }
  console.log(`${verdict} recorded for ${id}`);
} else if (cmd === 'team-escalate') {
  const id = process.argv[3];
  if (!id) { console.error('usage: cli.js team-escalate <id>'); process.exit(1); }
  if (!updateApprovalRequest(ORCH_DIR, id, { escalated: true })) { console.error(`no approval request ${id}`); process.exit(1); }
  console.log(`escalated ${id} to the operator (buttons on next tick)`);
} else {
  console.log('usage: cli.js daemon | away | back | status | register-worker <name> | reset-workers | set-orchestrator <name> | inbox | answer <ref> <choice> | dismiss <ref> | schedule <HH:MM> "<msg>" | schedules | unschedule <id> | say <message> | transcript [n] | send <name> "<text>" | capture <name> | suggest-spawn <name> "<why>" | team-spawn <name> --repo <path> --task "<brief>" | team-status | team-send <name> "<msg>" | team-retire <name> | team-approve <id> allow|deny | team-escalate <id>');
}
