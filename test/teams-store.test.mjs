import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTeamsStore } from '../src/teams-store.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'teams-')); }
const members = [
  { name: 'orch', role: 'orchestrator', sessionId: 's1', persona: 'p-orch' },
  { name: 'backend', role: 'worker', sessionId: 's2', persona: '' },
];

test('saveTeam then listTeams shows the named team with its members', () => {
  const store = createTeamsStore(tmpDir());
  store.saveTeam('parser', members);
  const list = store.listTeams();
  assert.equal(list.length, 1);
  assert.equal(list[0].team, 'parser');
  assert.deepEqual(list[0].members.map((m) => m.name), ['orch', 'backend']);
});

test('loadTeam returns the saved members incl. sessionId + persona', () => {
  const store = createTeamsStore(tmpDir());
  store.saveTeam('parser', members);
  assert.deepEqual(store.loadTeam('parser').members, members);
});

test('saveTeam overwrites a team of the same name (no duplicate)', () => {
  const store = createTeamsStore(tmpDir());
  store.saveTeam('parser', members);
  store.saveTeam('parser', [members[0]]);
  assert.equal(store.listTeams().length, 1);
  assert.equal(store.loadTeam('parser').members.length, 1);
});

test('loadTeam returns null for an unknown team', () => {
  assert.equal(createTeamsStore(tmpDir()).loadTeam('ghost'), null);
});
