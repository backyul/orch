import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTeamsHandler } from '../src/teams-http.js';

function fakeReg(list = []) {
  const calls = [];
  return { calls, list: () => list, spawn: (n, o) => { calls.push(['spawn', n, o]); return { name: n }; } };
}
function memTeams() {
  const teams = new Map();
  return { saveTeam: (t, m) => teams.set(t, { team: t, members: m }),
    loadTeam: (t) => teams.get(t) || null, listTeams: () => [...teams.values()] };
}
function reqres(method, url, body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = { method, url, on(ev, cb) { if (ev === 'data') chunks.forEach(cb); if (ev === 'end') cb(); } };
  const res = { statusCode: 200, body: '', writeHead(c) { this.statusCode = c; }, end(s) { this.body = s || ''; } };
  return { req, res };
}

test('POST /api/teams/save snapshots the current registry under the name', async () => {
  const reg = fakeReg([{ name: 'orch', role: 'orchestrator', sessionId: 's1', persona: 'p' }]);
  const teams = memTeams();
  const { req, res } = reqres('POST', '/api/teams/save', { team: 'parser' });
  await createTeamsHandler({ registry: reg, teams })(req, res);
  assert.equal(teams.loadTeam('parser').members[0].name, 'orch');
});

test('POST /api/teams/import resumes every member with its sessionId + persona', async () => {
  const reg = fakeReg();
  const teams = memTeams();
  teams.saveTeam('parser', [{ name: 'orch', sessionId: 's1', persona: 'p1' }, { name: 'be', sessionId: 's2', persona: '' }]);
  const { req, res } = reqres('POST', '/api/teams/import', { team: 'parser' });
  await createTeamsHandler({ registry: reg, teams })(req, res);
  assert.deepEqual(reg.calls[0], ['spawn', 'orch', { sessionId: 's1', resume: true, persona: 'p1' }]);
  assert.deepEqual(reg.calls[1], ['spawn', 'be', { sessionId: 's2', resume: true, persona: '' }]);
});

test('POST /api/import-member resumes just the one named member', async () => {
  const reg = fakeReg();
  const teams = memTeams();
  teams.saveTeam('parser', [{ name: 'orch', sessionId: 's1' }, { name: 'be', sessionId: 's2', persona: 'x' }]);
  const { req, res } = reqres('POST', '/api/import-member', { team: 'parser', name: 'be' });
  await createTeamsHandler({ registry: reg, teams })(req, res);
  assert.equal(reg.calls.length, 1);
  assert.deepEqual(reg.calls[0], ['spawn', 'be', { sessionId: 's2', resume: true, persona: 'x' }]);
});

test('GET /api/teams lists (last session) first then named teams', async () => {
  const reg = fakeReg([{ name: 'live', status: 'running' }]);
  const teams = memTeams();
  teams.saveTeam('parser', [{ name: 'orch' }]);
  const { req, res } = reqres('GET', '/api/teams');
  await createTeamsHandler({ registry: reg, teams })(req, res);
  const out = JSON.parse(res.body);
  assert.equal(out[0].team, '(last session)');
  assert.equal(out[0].auto, true);
  assert.equal(out[1].team, 'parser');
});
