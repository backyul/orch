import { randomUUID } from 'node:crypto';
import { createRingBuffer } from './ring-buffer.js';

// Holds every agent and is the only place that talks to PTYs. ptyFactory(name, opts)
// returns an object with write/onData/onExit/kill/pid — real node-pty in production,
// a fake in tests. store persists the resume manifest.
export function createRegistry({ ptyFactory, store, ringBytes = 2_000_000, now = () => Date.now() }) {
  const agents = new Map(); // name -> { name, pty, sessionId, status, ring, exitCode }
  const lastSize = new Map(); // name -> { cols, rows } — survives restart so the new PTY matches the pane
  const listeners = new Set(); // (event) => void  — for the WebSocket layer

  function emit(event) { for (const l of listeners) { try { l(event); } catch { /* ignore */ } } }
  function snapshot(a) { return { name: a.name, status: a.status, sessionId: a.sessionId, exitCode: a.exitCode, persona: a.persona, role: a.role }; }
  function persist() { store.save([...agents.values()].map(snapshot)); }
  function getAgent(name) { const a = agents.get(name); if (!a) throw new Error(`unknown agent: ${name}`); return a; }

  function wire(a) {
    // `a.dead` is set when we deliberately kill/supersede an agent. We gate both handlers on
    // it so a late/duplicate onExit (or trailing onData) from a dying PTY can't double-emit a
    // status event or clobber a same-named replacement agent. This also means we don't depend
    // on node-pty firing onExit after .kill() (which is unreliable on Windows).
    a.pty.onData((d) => { if (a.dead) return; a.ring.push(d); emit({ type: 'data', name: a.name, data: String(d) }); });
    a.pty.onExit(({ exitCode }) => {
      if (a.dead) return;            // already transitioned by kill()/supersede
      // Resume failure: a resumed agent that couldn't load its session (missing / empty /
      // corrupt — claude prints "No conversation found with session ID"). Retry ONCE as a fresh
      // agent so the pane comes up. Detected by the error string in the output (reliable) OR a
      // quick non-zero exit (catches other resume failures). The fresh retry has no sessionId
      // (wasResume=false) so it can't loop.
      const resumeFailed = a.wasResume && !a.retried && (exitCode ?? 0) !== 0 &&
        (/no conversation found/i.test(a.ring.text()) || (now() - a.spawnedAt) < 10000);
      if (resumeFailed) {
        a.dead = true; a.retried = true;
        agents.delete(a.name);
        spawn(a.name, { persona: a.persona, role: a.role });
        return;
      }
      a.status = 'exited'; a.exitCode = exitCode ?? 0;
      emit({ type: 'status', agent: snapshot(a) }); persist();
    });
  }

  function spawn(name, { sessionId = null, resume = false, persona = '', role } = {}) {
    const existing = agents.get(name);
    if (existing?.status === 'running') return snapshot(existing);
    if (existing) existing.dead = true; // supersede an exited same-named slot: silence its stale PTY
    // Mechanism A: fresh agents get a host-assigned UUID so the manifest is resumable immediately.
    const sid = resume ? sessionId : (sessionId || randomUUID());
    const ring = createRingBuffer(ringBytes);
    const pty = ptyFactory(name, { sessionId: sid, resume, persona });
    const sz = lastSize.get(name); // restart/respawn: size the new PTY to match the pane
    if (sz) { try { pty.resize?.(sz.cols, sz.rows); } catch { /* not resizable */ } }
    const a = { name, pty, sessionId: sid, status: 'running', ring, exitCode: null, dead: false,
      persona, role: role || (name === 'orch' ? 'orchestrator' : 'worker'),
      wasResume: !!resume, retried: false, spawnedAt: now() }; // becomes running once spawned; UI shows 'resuming' only during boot
    agents.set(name, a);
    wire(a);
    emit({ type: 'spawn', agent: snapshot(a) });
    persist();
    return snapshot(a);
  }

  // Self-heal the resume manifest: an agent's Claude session id changes on /compact, /clear, and
  // resume. The agent's SessionStart/Notification hook reports the live id (via orc-signal); we
  // refresh the stored id + persist so a host restart's `--resume` targets the CURRENT session, not
  // a stale one. No-op (changed:false) when the agent is gone or the id is unchanged.
  function setSessionId(name, sessionId) {
    const a = agents.get(name);
    if (!a || !sessionId || a.sessionId === sessionId) return { changed: false };
    a.sessionId = sessionId;
    persist();
    return { changed: true };
  }

  // Update an agent's STORED persona without restarting it. The persona is applied at (re)spawn
  // (--append-system-prompt-file), so this doesn't change the live session — it guarantees the next
  // restart/resume bakes the new text instead of resurrecting the old one from the manifest.
  function setPersona(name, persona) {
    const a = agents.get(name);
    if (!a || typeof persona !== 'string' || a.persona === persona) return { changed: false };
    a.persona = persona;
    persist();
    return { changed: true };
  }

  function send(name, text) { getAgent(name).pty.write(text); return true; }
  function resize(name, cols, rows) { lastSize.set(name, { cols, rows }); getAgent(name).pty.resize?.(cols, rows); return true; }
  function capture(name, lines = null) { return getAgent(name).ring.tail(lines); }
  function list() { return [...agents.values()].map(snapshot); }
  function get(name) { return agents.get(name) ? snapshot(agents.get(name)) : null; }
  function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }

  function kill(name) {
    const a = getAgent(name);
    a.dead = true;                  // gate the PTY handlers: we own the status transition now
    try { a.pty.kill(); } catch { /* already dead */ }
    a.status = 'exited';
    emit({ type: 'status', agent: snapshot(a) });
    persist();
    return snapshot(a);
  }

  // Permanently remove an agent: kill the PTY and drop it from the registry + store (and its
  // saved size). Unlike kill() (which leaves an EXITED, resumable slot), the agent is gone — it
  // won't reappear on resumeAll. The conversation still lives in Claude's own session store.
  function remove(name) {
    const a = agents.get(name);
    if (a && a.role === 'orchestrator') throw new Error('cannot remove the orchestrator');
    if (a) { a.dead = true; try { a.pty.kill(); } catch { /* already dead */ } }
    agents.delete(name);
    lastSize.delete(name);
    emit({ type: 'remove', name });
    persist();
    return { name, removed: true };
  }

  function restart(name, { persona } = {}) {
    const a = getAgent(name);
    const sessionId = a.sessionId;
    const nextPersona = persona !== undefined ? persona : a.persona; // edit applies the new system prompt
    const role = a.role;
    a.dead = true;                  // silence the old PTY before its slot is replaced
    try { a.pty.kill(); } catch { /* already dead */ }
    agents.delete(name);
    return spawn(name, { sessionId, resume: !!sessionId, persona: nextPersona, role });
  }

  // Rename an agent: re-key under the new name, resuming the SAME session (its conversation
  // is tied to the session id, not the name) and keeping its persona/role.
  function rename(from, to) {
    const a = getAgent(from);
    if (agents.has(to)) throw new Error(`agent ${to} already exists`);
    const { sessionId, persona, role } = a;
    a.dead = true;
    try { a.pty.kill(); } catch { /* already dead */ }
    agents.delete(from);
    return spawn(to, { sessionId, resume: !!sessionId, persona, role });
  }

  function resumeAll() {
    for (const m of store.load()) {
      const name = m.name?.trim();
      if (!name) continue;
      if (m.status === 'exited') continue; // don't revive agents the operator deliberately stopped
      spawn(name, { sessionId: m.sessionId ?? null, resume: !!m.sessionId, persona: m.persona ?? '', role: m.role });
    }
    return list();
  }

  return { spawn, send, resize, capture, list, get, subscribe, kill, remove, restart, rename, resumeAll, setSessionId, setPersona, _agents: agents };
}
