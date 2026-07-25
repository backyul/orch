import { spawnSync as defaultSpawnSync } from 'node:child_process';

export function capturePane(paneId, { spawnSync = defaultSpawnSync } = {}) {
  const r = spawnSync('tmux', ['capture-pane', '-p', '-t', paneId], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`capture-pane failed for ${paneId}: ${r.stderr || ''}`);
  return r.stdout;
}

// Send literal text to a pane. By default it follows with Enter (to submit a
// free-text prompt). Pass { enter: false } for cases that select on the keystroke
// itself — e.g. Claude's AskUserQuestion picker selects an option the instant you
// press its number key, so a trailing Enter would leak into the next prompt.
export function sendKeys(paneId, text, { spawnSync = defaultSpawnSync, enter = true } = {}) {
  const a = spawnSync('tmux', ['send-keys', '-t', paneId, '-l', text], { encoding: 'utf8' });
  if (a.status !== 0) throw new Error(`send-keys text failed for ${paneId}: ${a.stderr || ''}`);
  if (enter) {
    const b = spawnSync('tmux', ['send-keys', '-t', paneId, 'Enter'], { encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`send-keys Enter failed for ${paneId}: ${b.stderr || ''}`);
  }
  return true;
}
