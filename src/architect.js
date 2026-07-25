import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// The Architect: a headless Claude session that edits the cockpit's own web/ files in response
// to the user's chat. One turn per message via `claude -p --resume` (clean text out, perfect
// for a chat bubble). Scope is the cockpit's editable files; we checkpoint them before each
// turn so a bad change is one click to undo.
export const ARCHITECT_PERSONA = [
  'You are the Architect for the "agent·grid" cockpit — a local web UI. The user chats with you',
  'to change the GUI. You edit ONLY these files in the current directory: index.html, styles.css,',
  'and app.js. Do NOT touch vendor/ or anything outside this directory.',
  '',
  'How the cockpit works (so your edits keep it working):',
  '- app.js fetches /api/agents and renders one pane per agent; each pane mounts an xterm.js',
  '  Terminal (global `Terminal`) bound to a per-agent WebSocket. A reconciling render() must not',
  '  be broken. Theme tokens are CSS variables in styles.css ([data-theme="claude"|"dark"]).',
  '- Keep changes minimal and valid; the page hot-reloads after you save.',
  '',
  'After editing, reply in 1-3 sentences describing what you changed. If the request is unclear,',
  'ask a brief question instead of guessing.',
].join('\n');

const EDITABLE = ['index.html', 'styles.css', 'app.js'];

export function createArchitect({
  root,
  webDir = path.join(root, 'web'),
  stateFile = path.join(root, '.omc', 'architect-session.json'),
  backupDir = path.join(root, '.omc', 'architect-backup'),
  personaFile = path.join(root, '.omc', 'architect-persona.txt'),
  run,
} = {}) {
  function loadSid() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessionId || null; } catch { return null; } }
  function saveSid(sessionId) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId }));
  }

  // Checkpoint the editable files so revert() can undo the most recent turn.
  function backup() {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const f of EDITABLE) {
      try { fs.copyFileSync(path.join(webDir, f), path.join(backupDir, f)); } catch { /* file may not exist yet */ }
    }
  }
  function restore() {
    let restored = 0;
    for (const f of EDITABLE) {
      try { fs.copyFileSync(path.join(backupDir, f), path.join(webDir, f)); restored++; } catch { /* no backup */ }
    }
    return restored;
  }

  // Async so a multi-second claude turn never blocks the host event loop. The prompt is fed via
  // STDIN (not a -p arg) so a message with spaces survives shell:true (which Windows needs to
  // resolve the claude.cmd shim) — every argv token below is space-free.
  const doRun = run || ((args, opts) => new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: opts.cwd, shell: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => resolve({ stdout: out, stderr: err }));
    child.on('error', (e) => resolve({ stdout: '', stderr: String(e.message) }));
    if (opts.input != null) { try { child.stdin.write(opts.input); child.stdin.end(); } catch { /* ignore */ } }
  }));

  async function ask(message) {
    backup();
    fs.mkdirSync(path.dirname(personaFile), { recursive: true });
    fs.writeFileSync(personaFile, ARCHITECT_PERSONA);

    let sid = loadSid();
    const fresh = !sid;
    if (!sid) sid = randomUUID();
    const idArgs = fresh ? ['--session-id', sid] : ['--resume', sid];
    // --allowedTools enables file editing in headless mode; prompt comes via stdin (opts.input).
    const args = ['-p', ...idArgs, '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Edit', 'Write', 'Read', '--append-system-prompt-file', personaFile];

    const r = await doRun(args, { cwd: webDir, input: message });
    if (fresh) saveSid(sid);
    const reply = (r && (r.stdout || '')).trim() || (r && r.stderr ? `(architect error) ${r.stderr.trim()}` : '(no reply)');
    return { reply, sessionId: sid };
  }

  function revert() { return { ok: true, restored: restore() }; }

  return { ask, revert, loadSid, ARCHITECT_PERSONA };
}
