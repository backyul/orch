import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The settings.json every cockpit agent launches with (via --settings). It combines:
//   - statusLine: blank the OMC HUD line for a clean pane.
//   - hooks -> run orc-hook.js so the agent reports back to the PTY host:
//       * Stop        — the PRIMARY, Nova-style signal: fires at true turn-END, i.e. the worker just
//                       finished and is now waiting. Unlike a mid-turn idle poll, it never fires
//                       between the worker's own tool calls, so it needs no debounce.
//       * Notification — secondary: idle_prompt / permission_prompt (the 60s-idle path; flaky, but
//                       free to keep as a backup).
//       * SessionStart — self-heal the resume manifest's session id (/compact, /clear, resume).
//   No matcher, so the hook fires for every event; orc-signal.js decides what to act on server-side.
// NOTE: Claude snapshots hooks when a session launches, so this file must exist BEFORE an agent
// spawns (pty-host writes it once at startup and passes the path into the pty factory).
export function buildAgentSettings({ hookScript, node = 'node' }) {
  const command = `${node} "${hookScript}"`;
  const hook = [{ hooks: [{ type: 'command', command }] }];
  return {
    statusLine: { type: 'command', command: 'node -e 0' },
    hooks: { Stop: hook, Notification: hook, SessionStart: hook },
  };
}

export function writeAgentSettingsFile({ root, dir = path.join(os.tmpdir(), 'agent-grid-personas') } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const hookScript = path.join(root, 'src', 'orc-hook.js');
  const f = path.join(dir, 'agent-settings.json');
  fs.writeFileSync(f, JSON.stringify(buildAgentSettings({ hookScript }), null, 2));
  return f;
}
