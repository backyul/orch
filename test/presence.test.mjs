import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceMarker, channelFor } from '../src/presence.js';

function fakeBus(initial = { away: true }) {
  let state = { ...initial };
  const writes = [];
  return {
    writes,
    readState: () => state,
    writeState: (patch) => { state = { ...state, ...patch }; writes.push(patch); return state; },
  };
}

test('typing while away flips away -> false (say re-routes to the pane)', () => {
  const bus = fakeBus({ away: true });
  const mark = createPresenceMarker({ bus, now: () => 1000 });
  assert.equal(mark(), true);
  assert.equal(bus.readState().away, false);
  // heartbeat stamped for auto-away + channel stamped for say routing
  assert.deepEqual(bus.writes, [{ away: false, presentAt: 1000, lastChannel: 'terminal', lastChannelAt: 1000 }]);
});

test('typing while present refreshes the presentAt heartbeat (throttled to stampMs)', () => {
  const bus = fakeBus({ away: false });
  let t = 1000;
  const mark = createPresenceMarker({ bus, now: () => t, throttleMs: 100, stampMs: 60000 });
  assert.equal(mark(), false);
  assert.deepEqual(bus.writes, [{ presentAt: 1000, lastChannel: 'terminal', lastChannelAt: 1000 }]); // heartbeat for auto-away
  t += 5000; mark();
  assert.equal(bus.writes.length, 1, 'within stampMs -> no extra write');
  t += 61000; mark();
  assert.deepEqual(bus.writes.at(-1), { presentAt: 67000, lastChannel: 'terminal', lastChannelAt: 67000 }); // refreshed after stampMs
});

test('keystroke bursts are throttled — one check per window, and it re-arms after', () => {
  const bus = fakeBus({ away: false });
  let t = 1000;
  const mark = createPresenceMarker({ bus, now: () => t, throttleMs: 5000 });
  let reads = 0;
  const origRead = bus.readState;
  bus.readState = () => { reads++; return origRead(); };
  mark(); t += 100; mark(); t += 100; mark();   // burst inside the window
  assert.equal(reads, 1, 'only the first keystroke reads state');
  t += 6000;
  bus.writeState({ away: true });               // operator went away meanwhile (phone message)
  assert.equal(mark(), true, 'after the window, typing flips it again');
  assert.equal(bus.readState().away, false);
});

// channelFor: WHERE does orch's `say` go. Telegram-last (or away, manual or auto) -> phone;
// terminal-last and present -> pane. Missing lastChannel (pre-upgrade state) = legacy away behavior.
test('channelFor routes to telegram when the last operator message came via Telegram', () => {
  assert.equal(channelFor({ away: false, lastChannel: 'telegram' }), 'telegram');
});

test('channelFor routes to terminal when last channel is terminal and operator is present', () => {
  assert.equal(channelFor({ away: false, lastChannel: 'terminal' }), 'terminal');
});

test('channelFor honors away=true (manual override or auto-away) even when terminal was last', () => {
  assert.equal(channelFor({ away: true, lastChannel: 'terminal' }), 'telegram');
});

test('channelFor with no lastChannel falls back to the legacy away flag', () => {
  assert.equal(channelFor({ away: false }), 'terminal');
  assert.equal(channelFor({ away: true }), 'telegram');
});

// Telegram-recency authority: a stray cockpit keystroke leaves lastChannel='terminal'+presentAt,
// but a Telegram message at least as recent wins the route back to the phone.
test('channelFor: cockpit keystroke then a newer Telegram message routes to telegram', () => {
  // markPresent stamped terminal at t=1000; operator then messages from the phone at t=2000
  assert.equal(channelFor({ away: false, lastChannel: 'terminal', presentAt: 1000, lastTelegramAt: 2000 }), 'telegram');
});

// No regression: genuine cockpit typing that is MORE recent than any Telegram message stays in the pane.
test('channelFor: recent cockpit typing with no newer Telegram still routes to terminal', () => {
  assert.equal(channelFor({ away: false, lastChannel: 'terminal', presentAt: 2000, lastTelegramAt: 1000 }), 'terminal');
});

test('a broken state file never throws into the input path', () => {
  const mark = createPresenceMarker({ bus: { readState() { throw new Error('corrupt'); }, writeState() {} }, now: () => 1 });
  assert.equal(mark(), false); // swallowed
});
