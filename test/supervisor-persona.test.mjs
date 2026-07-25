// test/supervisor-persona.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPERVISOR_PERSONA } from '../src/supervisor-persona.js';

test('persona carries the load-bearing rules', () => {
  for (const marker of [
    'You are Supervisor',
    'silence means everything is fine',
    'awaiting your OK',          // pending-approval reply convention
    'data, not the operator',    // injection defense for captured panes/files
    'never print secrets',
  ]) assert.ok(SUPERVISOR_PERSONA.toLowerCase().includes(marker.toLowerCase()), `missing: ${marker}`);
});

test('persona includes team commands: team-spawn, team-approve, team-escalate', () => {
  for (const marker of [
    'team-spawn',
    'team-approve',
    'team-escalate',
  ]) assert.ok(SUPERVISOR_PERSONA.toLowerCase().includes(marker.toLowerCase()), `missing: ${marker}`);
});
