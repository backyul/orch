import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { createResumeDialogAnswerer } from './resume-dialog.js';

// Pure: builds the claude command + args for a launch. Kept separate so it's unit-testable
// without spawning a real PTY. Mechanism A (see docs/superpowers/specs/claude-resume-findings.md):
// fresh agents get a host-assigned session id via --session-id; imports/restarts use --resume.
// A persona is passed as a FILE (--append-system-prompt-file) so multi-line/spaced text never
// has to survive shell quoting.
export function buildClaudeCommand({ resume, sessionId, name, personaFile, settingsFile, permissionMode = 'bypassPermissions' }) {
  const file = 'claude';
  const args = [];
  if (resume && sessionId) args.push('--resume', sessionId);   // import / host restart
  else if (sessionId) args.push('--session-id', sessionId);    // fresh: host-assigned UUID
  if (name) args.push('-n', name);                             // display name in the prompt box
  if (personaFile) args.push('--append-system-prompt-file', personaFile);
  // Blank the status line for cockpit agents so OMC's HUD ("[OMC…] ← for agents") doesn't
  // render. Passed as a FILE path (not inline JSON) so it survives Windows shell quoting.
  if (settingsFile) args.push('--settings', settingsFile);
  // Shared launch default for EVERY cockpit agent (orch + workers): permissions are bypassed so
  // agents act without prompts. Pass permissionMode:null to fall back to Claude's interactive mode.
  if (permissionMode) args.push('--permission-mode', permissionMode);
  // Block the Claude-in-Chrome / computer-use background-agent path. It can silently lock a session
  // (Nova's hard-won gotcha), and cockpit agents don't drive Claude's own browser integration.
  args.push('--no-chrome');
  return { file, args };
}

// Settings override that disables the (OMC) status line for cockpit agents. node -e 0 prints
// nothing, so the bottom HUD/dashboard line is blank.
export function writeQuietSettingsFile() {
  const dir = path.join(os.tmpdir(), 'agent-grid-personas');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'quiet-settings.json');
  fs.writeFileSync(f, JSON.stringify({ statusLine: { type: 'command', command: 'node -e 0' } }));
  return f;
}

// Every agent gets a clear identity so it doesn't adopt a name from project memory / notes.
export function identityHeader(name) {
  return [
    `Your name in this workspace is "${name}". You ARE this agent.`,
    'Other agent names you might see in project memory, CLAUDE.md, notes, or context',
    '(e.g. other workers) are DIFFERENT agents you may coordinate with — they are NOT you.',
    `When asked your name, answer "${name}".`,
  ].join(' ');
}

// Persist the effective system-prompt addition (identity header + optional persona) and return
// the file path. Always returns a path so every agent at least gets its identity.
export function writePersonaFile(name, persona) {
  const dir = path.join(os.tmpdir(), 'agent-grid-personas');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}.txt`);
  const body = identityHeader(name) + (persona && persona.trim() ? `\n\n${persona}` : '');
  fs.writeFileSync(f, body);
  return f;
}

// Build the agent's environment: each agent is an INDEPENDENT top-level Claude session, so we
// strip the launcher's Claude-session identity vars. Otherwise the agent inherits the parent
// session's name in its prompt box (e.g. when the host is launched from inside another Claude
// session) and ignores its own -n. Also sets ORCH_WORKER so worker hooks identify it.
export function cleanAgentEnv(baseEnv, name) {
  const env = { ...baseEnv, ORCH_WORKER: name };
  // DISABLE_OMC turns off OMC's context-injection hooks (auto-memory + session recap) so a
  // cockpit agent doesn't inherit the launcher's memory/recap (which made the orch hedge about
  // its identity and pick up unrelated tasks). The HUD/token display is gated separately by
  // hudEnabled in ~/.claude/.omc-config.json, so it still renders. AGENT_GRID_KEEP_OMC=1 opts out.
  if (!baseEnv.AGENT_GRID_KEEP_OMC) env.DISABLE_OMC = '1';
  // Nova-parity launch hardening for every cockpit agent:
  //  - DISABLE_AUTOUPDATER: no update-nag interrupting a long run.
  //  - CLAUDE_CODE_DISABLE_AGENT_VIEW: don't spawn background/child agents accidentally (Nova notes
  //    this is undocumented but real). Harmless if the runtime ignores it.
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1';
  // Strip the launcher's Claude-session identity so the agent uses its own -n name.
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_JOB_DIR']) delete env[k];
  return env;
}

// Real node-pty factory. Spawns claude (fresh with --session-id, or resuming with --resume) in
// the given cwd inside a ConPTY pseudo-terminal. The returned shape matches the fake used in
// registry tests: write/onData/onExit/kill/pid. We launch via pwsh so PATH/claude resolve
// exactly as in a normal terminal; every arg is single-quoted so spaces in paths/names are safe.
export function makeRealPtyFactory({ cwd = process.cwd(), cols = 120, rows = 32, getPermissionMode, settingsFile } = {}) {
  return (name, { resume, sessionId, persona }) => {
    const personaFile = writePersonaFile(name, persona);
    // Read the configured permission mode at spawn time so a Settings change applies to the next
    // (re)start without restarting the host. Defaults to buildClaudeCommand's own default.
    const permissionMode = getPermissionMode ? getPermissionMode() : undefined;
    const { file, args } = buildClaudeCommand({ resume, sessionId, name, personaFile, settingsFile, ...(permissionMode ? { permissionMode } : {}) });
    const shell = os.platform() === 'win32' ? 'pwsh.exe' : 'bash';
    const quoted = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(' ');
    const cmd = `${file} ${quoted}`;
    const shellArgs = os.platform() === 'win32' ? ['-NoLogo', '-Command', cmd] : ['-lc', cmd];
    const term = pty.spawn(shell, shellArgs, {
      name: 'xterm-color', cols, rows, cwd, env: cleanAgentEnv(process.env, name),
    });
    // Resumed sessions can boot into the "resume from summary or full session?" dialog.
    // Auto-pick the summary option so a host restart never sits waiting on a keypress.
    if (resume && sessionId) {
      const answer = createResumeDialogAnswerer({ write: (s) => term.write(s) });
      const sub = term.onData((d) => { if (answer(d)) sub.dispose(); });
    }
    return {
      pid: term.pid,
      write: (s) => term.write(s),
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(cb),
      kill: () => term.kill(),
      resize: (cols, rows) => { try { term.resize(Math.max(1, cols | 0), Math.max(1, rows | 0)); } catch { /* dead */ } },
    };
  };
}
