// test/turn-queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnQueue } from '../src/turn-queue.js';

const tickAsync = () => new Promise((r) => setImmediate(r));

test('one event runs immediately; its text is the whole prompt', async () => {
  const prompts = [];
  const q = createTurnQueue({ runTurn: async (p) => { prompts.push(p); } });
  q.push('operator message', 'hello');
  await tickAsync();
  assert.deepEqual(prompts, ['hello']);
});

test('events landing mid-turn coalesce into ONE labeled follow-up turn', async () => {
  const prompts = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createTurnQueue({ runTurn: async (p) => { prompts.push(p); if (prompts.length === 1) await gate; } });
  q.push('operator message', 'first');
  await tickAsync();
  q.push('watchdog', 'host down');
  q.push('worker', 'Worker1 needs input');
  release();
  await tickAsync(); await tickAsync(); await tickAsync();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /\[event 1: watchdog\]/);
  assert.match(prompts[1], /host down/);
  assert.match(prompts[1], /\[event 2: worker\]/);
});

test('the runaway guard keeps only the newest maxItems', async () => {
  const prompts = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const q = createTurnQueue({
    maxItems: 3,
    runTurn: async (p) => { prompts.push(p); if (prompts.length === 1) await gate; },
  });
  q.push('operator message', 'first');
  await tickAsync();
  q.push('worker', 'event-1');
  q.push('worker', 'event-2');
  q.push('worker', 'event-3');
  q.push('worker', 'event-4');
  q.push('worker', 'event-5');
  release();
  await tickAsync(); await tickAsync(); await tickAsync();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /event-3/);
  assert.match(prompts[1], /event-4/);
  assert.match(prompts[1], /event-5/);
  assert.doesNotMatch(prompts[1], /event-1/);
  assert.doesNotMatch(prompts[1], /event-2/);
});

test('the queue keeps draining after a double failure', async () => {
  const ran = [];
  let failCalls = 0;
  const q = createTurnQueue({
    runTurn: async (p) => {
      if (p.includes('bad')) { failCalls++; throw new Error('nope'); }
      ran.push(p);
    },
    onError: () => {},
  });
  q.push('operator message', 'bad news');
  await tickAsync();
  q.push('operator message', 'good news');
  await tickAsync(); await tickAsync(); await tickAsync();
  assert.equal(failCalls, 2);                      // both attempts on the bad event
  assert.ok(ran.some((p) => p.includes('good news')));
});

test('a failed turn retries once, then reports via onError', async () => {
  let calls = 0; let reported = null;
  const q = createTurnQueue({
    runTurn: async () => { calls++; throw new Error('down'); },
    onError: (err) => { reported = err; },
  });
  q.push('operator message', 'hi');
  await tickAsync(); await tickAsync(); await tickAsync();
  assert.equal(calls, 2);
  assert.match(String(reported), /down/);
});
