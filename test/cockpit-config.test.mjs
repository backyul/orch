import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCockpitConfig, PERMISSION_MODES } from '../src/cockpit-config.js';

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-')), 'cockpit.json'); }

test('permission mode defaults to bypassPermissions when unset', () => {
  assert.equal(createCockpitConfig({ file: tmpFile() }).getPermissionMode(), 'bypassPermissions');
});

test('setPermissionMode persists and reads back', () => {
  const file = tmpFile();
  createCockpitConfig({ file }).setPermissionMode('acceptEdits');
  assert.equal(createCockpitConfig({ file }).getPermissionMode(), 'acceptEdits');
});

test('setPermissionMode rejects an invalid mode', () => {
  assert.throws(() => createCockpitConfig({ file: tmpFile() }).setPermissionMode('nope'), /invalid permission mode/);
});

test('an unknown stored mode falls back to the default', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ permissionMode: 'bogus' }));
  assert.equal(createCockpitConfig({ file }).getPermissionMode(), 'bypassPermissions');
});

test('PERMISSION_MODES lists the four supported modes', () => {
  assert.deepEqual(PERMISSION_MODES, ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
});
