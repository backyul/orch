// test/team.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTeam, workerPersona, canRemoveWorktree } from '../src/team.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'team-')); }
const okRun = (reply) => async () => ({ stdout: reply, stderr: '' });
const W = (dir, over = {}) => ({
  name: 'alpha', repo: 'C:/repo', worktree: path.join(dir, 'wt'), branch: 'team/alpha',
  task: 'fix the host', approvalsServerPath: 'x.js', ...over,
});

test('spawnWorker writes registry + persona + mcp config; duplicate name refused', () => {
  const dir = tmp();
  const team = createTeam({ stateDir: dir, run: okRun('ok') });
  const rec = team.spawnWorker(W(dir));
  assert.equal(rec.status, 'active');
  assert.equal(rec.model, 'sonnet');            // default model
  assert.deepEqual(rec.queuedMessages, ['fix the host']);  // task brief is turn 1's prompt
  const onDisk = team.readWorker('alpha');
  assert.equal(onDisk.branch, 'team/alpha');
  const persona = fs.readFileSync(path.join(dir, 'team', 'alpha-persona.txt'), 'utf8');
  assert.match(persona, /worker "alpha"/);
  assert.match(persona, /DONE:/);
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, 'team', 'alpha-mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.approvals.env.WORKER_NAME, 'alpha');
  assert.equal(mcp.mcpServers.approvals.env.ORCH_STATE_DIR, dir);
  assert.throws(() => team.spawnWorker(W(dir)), /already exists/);
  assert.throws(() => team.spawnWorker(W(dir, { name: 'bad name!' })), /invalid worker name/);
  assert.throws(() => team.spawnWorker(W(dir, { name: 'evil-mcp' })), /invalid worker name/);
});

test('listWorkers returns records sorted by creation; sendToWorker queues and re-activates', () => {
  const dir = tmp();
  let t = 0;
  const team = createTeam({ stateDir: dir, run: okRun('ok'), now: () => ++t });
  team.spawnWorker(W(dir, { name: 'a' }));
  team.spawnWorker(W(dir, { name: 'b' }));
  assert.deepEqual(team.listWorkers().map((w) => w.name), ['a', 'b']);
  team.writeWorker({ ...team.readWorker('a'), status: 'paused', turnCount: 50 });
  const after = team.sendToWorker('a', 'keep going, focus on tests');
  assert.equal(after.status, 'active');
  assert.equal(after.turnCount, 0);              // fresh 50-turn budget (spec: cap-hit recovery)
  assert.ok(after.queuedMessages.includes('keep going, focus on tests'));
  assert.throws(() => team.sendToWorker('nope', 'x'), /no such worker/);
});

test('retireWorker archives the record and removes persona/mcp files', () => {
  const dir = tmp();
  const team = createTeam({ stateDir: dir, run: okRun('ok') });
  team.spawnWorker(W(dir));
  team.retireWorker('alpha');
  assert.equal(team.readWorker('alpha'), null);
  const archived = JSON.parse(fs.readFileSync(path.join(dir, 'team', 'archive', 'alpha.json'), 'utf8'));
  assert.equal(archived.status, 'retired');
  assert.ok(!fs.existsSync(path.join(dir, 'team', 'alpha-persona.txt')));
});

test('canRemoveWorktree: only clean AND merged passes; reasons name the failure', () => {
  assert.deepEqual(canRemoveWorktree({ porcelain: '', mergedBranches: '  main\n  team/alpha\n', branch: 'team/alpha' }), { ok: true });
  assert.match(canRemoveWorktree({ porcelain: ' M src/x.js', mergedBranches: '  team/alpha', branch: 'team/alpha' }).reason, /uncommitted/i);
  assert.match(canRemoveWorktree({ porcelain: '', mergedBranches: '  main', branch: 'team/alpha' }).reason, /not merged/i);
});

test('workerPersona carries name, branch, markers, data-not-operator rule, extra text', () => {
  const p = workerPersona({ name: 'n1', branch: 'team/n1', worktree: 'C:/wt', extra: 'EXTRA-RULE' });
  for (const s of ['"n1"', 'team/n1', 'DONE:', 'BLOCKED:', 'data, not your operator', 'EXTRA-RULE']) {
    assert.ok(p.includes(s), `missing ${s}`);
  }
});

test('turn 1 uses --session-id + task brief on stdin; turn 2 --resume + "continue"; model flag carried', async () => {
  const dir = tmp();
  const calls = [];
  const team = createTeam({ stateDir: dir, run: async (args, opts) => { calls.push({ args, opts }); return { stdout: 'working on it', stderr: '' }; } });
  team.spawnWorker(W(dir, { model: 'opus' }));
  await team.runTurn('alpha');
  await team.runTurn('alpha');
  const [c1, c2] = calls;
  assert.ok(c1.args.includes('--session-id'));
  assert.equal(c1.opts.input, 'fix the host');           // task brief is the first prompt
  assert.equal(c1.opts.cwd, W(dir).worktree);            // runs IN the worktree
  assert.equal(c1.args[c1.args.indexOf('--model') + 1], 'opus');
  assert.ok(c1.args.includes('--permission-prompt-tool'));
  for (const t of (await import('../src/supervisor.js')).AUTO_ALLOWED_TOOLS) assert.ok(c1.args.includes(t));
  assert.ok(c2.args.includes('--resume'));
  assert.equal(c2.args[c2.args.indexOf('--resume') + 1], c1.args[c1.args.indexOf('--session-id') + 1]);
  assert.equal(c2.opts.input, 'continue');               // auto-continue
  assert.equal(team.readWorker('alpha').turnCount, 2);
});

test('queued team-send message preempts "continue" and is consumed once', async () => {
  const dir = tmp();
  const inputs = [];
  const team = createTeam({ stateDir: dir, run: async (a, o) => { inputs.push(o.input); return { stdout: 'ok', stderr: '' }; } });
  team.spawnWorker(W(dir));
  await team.runTurn('alpha');                            // consumes task brief
  team.sendToWorker('alpha', 'switch to the tests');
  await team.runTurn('alpha');
  await team.runTurn('alpha');
  assert.deepEqual(inputs, ['fix the host', 'switch to the tests', 'continue']);
});

test('DONE:/BLOCKED: lines are terminal; cap pauses; digest event every 5th turn', async () => {
  const dir = tmp();
  let reply = 'progress';
  const team = createTeam({ stateDir: dir, run: async () => ({ stdout: reply, stderr: '' }) });
  team.spawnWorker(W(dir));
  const evs = [];
  for (let i = 0; i < 5; i++) evs.push(...(await team.runTurn('alpha')).events);
  assert.deepEqual(evs.map((e) => e.type), ['digest']);   // exactly one digest at turn 5
  reply = 'all finished\nDONE: host fixed, tests green';
  const r = await team.runTurn('alpha');
  assert.deepEqual(r.events.map((e) => e.type), ['done']);
  assert.equal(team.readWorker('alpha').status, 'done');
  assert.equal(await team.runTurn('alpha'), null);        // terminal workers are not advanced

  const t2 = createTeam({ stateDir: tmp(), run: async () => ({ stdout: 'BLOCKED: need the API key decision', stderr: '' }) });
  t2.spawnWorker(W(dir, { name: 'beta' }));
  assert.equal((await t2.runTurn('beta')).events[0].type, 'blocked');

  const dir3 = tmp();
  const t3 = createTeam({ stateDir: dir3, run: async () => ({ stdout: 'grinding', stderr: '' }) });
  t3.spawnWorker(W(dir3, { name: 'gamma' }));
  t3.writeWorker({ ...t3.readWorker('gamma'), turnCount: 49, sinceDigest: 0 });
  const rc = await t3.runTurn('gamma');
  assert.deepEqual(rc.events.map((e) => e.type), ['paused']);
  assert.equal(t3.readWorker('gamma').status, 'paused');
});

test('failed --resume falls back to a fresh session with a re-brief (worker never silently dead)', async () => {
  const dir = tmp();
  let n = 0;
  const team = createTeam({ stateDir: dir, run: async (args, opts) => {
    n++;
    if (n === 2) return { stdout: '', stderr: 'No conversation found' };
    return { stdout: `ok${n} input=${opts.input}`, stderr: '' };
  } });
  team.spawnWorker(W(dir));
  await team.runTurn('alpha');
  const sid1 = team.readWorker('alpha').sessionId;
  const r = await team.runTurn('alpha');                  // resume fails -> fresh + re-brief
  assert.notEqual(team.readWorker('alpha').sessionId, sid1);
  assert.match(r.reply, /input=.*fix the host/);          // re-brief carries the task
});

test('empty reply without resume-failure throws (daemon retry/error path owns it)', async () => {
  const dir = tmp();
  const team = createTeam({ stateDir: dir, run: async () => ({ stdout: '', stderr: 'boom' }) });
  team.spawnWorker(W(dir));
  await assert.rejects(() => team.runTurn('alpha'), /boom/);
});

test('a team-send landing DURING a turn survives the write-back (no lost update)', async () => {
  const dir = tmp();
  let team;
  team = createTeam({ stateDir: dir, run: async () => {
    team.sendToWorker('alpha', 'mid-turn redirect');   // simulates the CLI process writing during the turn
    return { stdout: 'working', stderr: '' };
  } });
  team.spawnWorker(W(dir));
  await team.runTurn('alpha');                          // consumes the task brief
  assert.deepEqual(team.readWorker('alpha').queuedMessages, ['mid-turn redirect']);
});
