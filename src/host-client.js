import { spawnSync } from 'node:child_process';

// Drop-in replacement for src/tmux.js against the PTY host. `target` IS the agent name.
// Mirrors tmux.js exactly: sendKeys(name, text, {enter}) and capturePane(name). sendKeys is
// fire-and-forget (the daemon doesn't await it); capturePane is SYNCHRONOUS — daemon.js and
// route.js use its return value inline, so we keep the exact synchronous interface (via curl)
// and need no logic changes at the call sites. `captureSync`/`fetch` are injectable for tests.
export function createHostClient({
  base = `http://127.0.0.1:${process.env.HOST_PORT || 7610}`,
  fetch = globalThis.fetch,
  captureSync,
} = {}) {
  const pending = [];

  const post = (name, text) => fetch(`${base}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, text }),
  }).catch(() => {});

  function sendKeys(name, text, { enter = true } = {}) {
    // Delivery hardening, learned the hard way:
    //  - FLATTEN newlines: multi-line text puts Claude's input box into multi-line mode, where an
    //    injected \r strands the whole message unsubmitted (orch's answer to a worker sat visibly
    //    "typed" but never sent — the worker stayed blocked while orch believed it had answered).
    //  - Text and Enter as SEPARATE writes: a single "text\r" chunk is treated as a paste and the
    //    \r becomes a literal newline.
    //  - VERIFY-AND-RETRY instead of fire-and-forget: after Enter, capture the pane; if our text is
    //    still sitting near the bottom (unsubmitted/queued), press Enter again — up to twice. A
    //    false positive (the submitted text's echo also sits near the bottom) just sends Enter to
    //    an empty box, which is a no-op, so retries are free; a true strand gets unstuck.
    const flat = String(text).replace(/\s*\r?\n\s*/g, ' ');
    const wait = (ms) => () => new Promise((r) => setTimeout(r, ms));
    if (!enter) { pending.push(post(name, flat)); return true; }
    const probe = flat.slice(-24).trim();
    const stranded = () => {
      if (probe.length < 8) return false; // too short to match reliably — skip verification
      try {
        const clean = String(doCapture(name)).replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\r/g, '');
        const tail = clean.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()).slice(-8).join(' ');
        return tail.includes(probe);
      } catch { return false; } // capture failed — assume delivered rather than hammer Enter blind
    };
    pending.push(
      post(name, flat).then(wait(250)).then(() => post(name, '\r'))
        .then(wait(1200)).then(() => { if (stranded()) return post(name, '\r'); })
        .then(wait(1200)).then(() => { if (stranded()) return post(name, '\r'); }),
    );
    return true;
  }

  const doCapture = captureSync || ((name) => {
    const r = spawnSync('curl', ['-s', `${base}/api/capture?name=${encodeURIComponent(name)}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`capture failed for ${name}: ${r.stderr || ''}`);
    return r.stdout;
  });
  function capturePane(name) { return doCapture(name); }

  async function spawn(name, persona) {
    await fetch(`${base}/api/spawn`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(persona ? { name, persona } : { name }),
    }).catch(() => {});
  }

  async function flush() { await Promise.all(pending.splice(0)); }

  return { sendKeys, capturePane, spawn, flush };
}
