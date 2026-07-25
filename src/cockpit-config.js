import fs from 'node:fs';
import path from 'node:path';
import { ORCH_DIR } from './config.js';

// Per-instance cockpit preferences (persisted in the instance's state dir so the GUI and terminal
// instances keep their own). Currently just the permission mode every agent launches in.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const DEFAULT_MODE = 'bypassPermissions';

export function createCockpitConfig({ file = path.join(ORCH_DIR, 'cockpit.json') } = {}) {
  function read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  }
  function getPermissionMode() {
    const m = read().permissionMode;
    return PERMISSION_MODES.includes(m) ? m : DEFAULT_MODE;
  }
  function setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`invalid permission mode: ${mode}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...read(), permissionMode: mode }, null, 2));
    return mode;
  }
  return { getPermissionMode, setPermissionMode, modes: PERMISSION_MODES };
}
