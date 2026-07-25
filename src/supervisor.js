// src/supervisor.js
// The Supervisor: a persistent HEADLESS Claude session driven one turn at a time via
// `claude -p` (--session-id first, --resume after). Generalizes the architect.js pattern.
// The prompt goes in on stdin (survives Windows shell:true quoting); stdout is the reply.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TURN_TIMEOUT_MS } from './config.js';

// Auto-allowed tier (spec: reads, repo edits/commits, tests, tmux, restarts, cli verbs).
// Everything NOT matched here falls through to the approvals MCP tool -> Telegram buttons.
// Pragmatic first cut — patterns are tunable without touching any other code.
export const AUTO_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'TodoWrite',
  'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git branch:*)', 'Bash(git checkout:*)',
  'Bash(node:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(tmux:*)',
  'Bash(pwsh ./restart-host.ps1:*)', 'Bash(pwsh ./orch-gui.ps1:*)', 'Bash(pwsh ./orch.ps1:*)',
];

// Narrow resume-failure detection (mirrors agent-registry.js): only an explicit signal
// rotates the session — a healthy resumed turn with empty output must NOT cost us the
// persistent context.
export const RESUME_FAILURE = /no conversation found|no session found|couldn.t (find|resume)|invalid session/i;

// Default child-process runner for one headless `claude` turn. Exported so team.js
// drives worker sessions through the IDENTICAL runner (timeout kill-tree included).
export function makeClaudeRun() {
  return (args, opts) => new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: opts.cwd, shell: true });
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => {
      // shell:true means child is cmd.exe — kill the TREE or the real claude keeps running
      // and races the next turn on this same session.
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']).on('error', () => { /* spawn-fail must not crash the daemon */ });
        else child.kill('SIGKILL');
      } catch { /* already dead */ }
      finish({ stdout: out, stderr: `${err}\n(turn timed out after ${opts.timeoutMs}ms)` });
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 2_000_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 2_000_000) err += d; });
    child.on('close', () => { clearTimeout(timer); finish({ stdout: out, stderr: err }); });
    child.on('error', (e) => { clearTimeout(timer); finish({ stdout: '', stderr: String(e.message) }); });
    if (opts.input != null) { try { child.stdin.write(opts.input); child.stdin.end(); } catch { /* stdin closed */ } }
  });
}

export function createSupervisor({
  stateDir, cwd, personaText, approvalsServerPath,
  run, timeoutMs = TURN_TIMEOUT_MS,
} = {}) {
  const sessionFile = path.join(stateDir, 'supervisor-session.json');
  const personaFile = path.join(stateDir, 'supervisor-persona.txt');
  const mcpFile = path.join(stateDir, 'supervisor-mcp.json');

  function loadSid() { try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')).sessionId || null; } catch { return null; } }
  function saveSid(sessionId) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(sessionFile, JSON.stringify({ sessionId })); }
  function reset() {
    // NOTE: an in-flight turn intentionally COMPLETES on the old sid — it read the session file
    // before this rename, so nothing is interrupted. Only the NEXT turn starts fresh.
    try { fs.rmSync(`${sessionFile}.bak`, { force: true }); fs.renameSync(sessionFile, `${sessionFile}.bak`); }
    catch { /* nothing to reset */ }
  }

  const doRun = run || makeClaudeRun();

  function writeLaunchFiles() {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(personaFile, personaText);
    fs.writeFileSync(mcpFile, JSON.stringify({
      mcpServers: { approvals: { type: 'stdio', command: 'node', args: [approvalsServerPath], env: { ORCH_STATE_DIR: stateDir } } },
    }));
  }

  function askOnce(message, sid, fresh) {
    const idArgs = fresh ? ['--session-id', sid] : ['--resume', sid];
    const args = ['-p', ...idArgs,
      '--append-system-prompt-file', personaFile,
      '--permission-mode', 'default',
      '--allowedTools', ...AUTO_ALLOWED_TOOLS,
      '--mcp-config', mcpFile,
      '--permission-prompt-tool', 'mcp__approvals__permission_prompt'];
    return doRun(args, { cwd, input: message, timeoutMs });
  }

  async function ask(message) {
    writeLaunchFiles();
    let sid = loadSid();
    let fresh = !sid;
    if (!sid) sid = randomUUID();
    let r = await askOnce(message, sid, fresh);
    let note = '';
    if (!fresh && !(r.stdout || '').trim() && RESUME_FAILURE.test(String(r.stderr || ''))) {
      // Stale/corrupt session -> fresh fallback. The channel must never go dead.
      reset(); // archive the stale sid NOW — even if the fresh retry fails, the next ask must not reload it
      sid = randomUUID(); fresh = true;
      note = '(note: previous session could not be resumed — started a fresh one)\n';
      r = await askOnce(message, sid, fresh);
    }
    const reply = (r.stdout || '').trim();
    if (!reply) throw new Error(`supervisor turn failed: ${String(r.stderr || 'no output').trim().slice(0, 400)}`);
    if (fresh) saveSid(sid);
    return { reply: note + reply, sessionId: sid };
  }

  return { ask, reset, loadSid, _files: { sessionFile, personaFile, mcpFile } };
}
