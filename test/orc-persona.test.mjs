import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ORC_PERSONA, migrateOrcPersona } from '../src/orc-persona.js';

test('migrates a legacy default orchestrator persona to the current default', () => {
  const manifest = [
    { name: 'orch', role: 'orchestrator', persona: 'You are THE ORCHESTRATOR...\nDo NOT self-schedule work. Never start a "/loop"...\nSpawn tendency: ...' },
    { name: 'w1', role: 'worker', persona: 'Do NOT self-schedule work. (worker copy)' },
  ];
  assert.equal(migrateOrcPersona(manifest), true);
  assert.equal(manifest[0].persona, DEFAULT_ORC_PERSONA);       // orchestrator upgraded
  assert.match(manifest[1].persona, /worker copy/);             // workers never touched
});

test('a CURRENT default persona is left alone (idempotent)', () => {
  const manifest = [{ name: 'orch', role: 'orchestrator', persona: DEFAULT_ORC_PERSONA }];
  assert.equal(migrateOrcPersona(manifest), false);
});

test('a custom persona (no legacy marker) is never overwritten', () => {
  const manifest = [{ name: 'orch', role: 'orchestrator', persona: 'My hand-written custom orchestrator rules.' }];
  assert.equal(migrateOrcPersona(manifest), false);
  assert.match(manifest[0].persona, /hand-written/);
});

test('empty/missing manifests are safe', () => {
  assert.equal(migrateOrcPersona([]), false);
  assert.equal(migrateOrcPersona(undefined), false);
});
