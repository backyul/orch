import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSettings } from '../src/agent-settings.js';

test('buildAgentSettings wires Stop + Notification + SessionStart to the hook script and blanks the HUD', () => {
  const s = buildAgentSettings({ hookScript: '/proj/src/orc-hook.js' });
  assert.equal(s.statusLine.type, 'command');
  const stopCmd = s.hooks.Stop[0].hooks[0];
  const nCmd = s.hooks.Notification[0].hooks[0];
  const sCmd = s.hooks.SessionStart[0].hooks[0];
  assert.equal(stopCmd.type, 'command');
  assert.match(stopCmd.command, /orc-hook\.js/);
  assert.equal(nCmd.command, stopCmd.command);
  assert.equal(sCmd.command, stopCmd.command);
});

test('buildAgentSettings honors a custom node path', () => {
  const s = buildAgentSettings({ hookScript: '/p/h.js', node: '/usr/bin/node' });
  assert.match(s.hooks.Notification[0].hooks[0].command, /^\/usr\/bin\/node /);
});
