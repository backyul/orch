import { URL } from 'node:url';
import { DEFAULT_ORC_PERSONA } from './orc-persona.js';
import { handleHookEvent } from './orc-signal.js';
import { readHistory } from './session-history.js';

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Maps the host HTTP API onto the registry. Pure routing — the server (pty-host.js) plugs
// this into node:http. Unknown agent -> 404 so callers get a real failure (no silent misroute).
// `bus` (optional) backs the orchestrator spawn-request approve/dismiss flow.
export function createHostHandler(registry, { bus } = {}) {
  return async function handler(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      if (req.method === 'GET' && p === '/api/agents') return sendJson(res, 200, registry.list());
      if (req.method === 'GET' && p === '/api/spawn-requests') {
        const reqs = bus ? bus.listPending().filter((x) => x.type === 'spawn-request') : [];
        return sendJson(res, 200, reqs);
      }
      if (req.method === 'GET' && p === '/api/history') {
        // Durable per-agent history from the claude session transcript (refresh-proof,
        // unlike terminal scrollback). ?before=N pages earlier; ?limit=N sizes the window.
        const r = readHistory({
          name: u.searchParams.get('name'), registry,
          limit: u.searchParams.get('limit') ? Number(u.searchParams.get('limit')) : undefined,
          before: u.searchParams.get('before') ? Number(u.searchParams.get('before')) : undefined,
        });
        return sendJson(res, r.code, r);
      }
      if (req.method === 'GET' && p === '/api/capture') {
        const name = u.searchParams.get('name');
        const lines = u.searchParams.get('lines');
        // Capture BEFORE writing headers: registry.capture() throws for an unknown agent, and if the
        // headers were already sent the catch below would sendJson() again -> ERR_HTTP_HEADERS_SENT,
        // which (with no process guard) crashes the whole host. Compute first so a throw is caught clean.
        const text = registry.capture(name, lines ? Number(lines) : null);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(text);
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (p === '/api/spawn') {
          // An agent named "orch" with no explicit persona gets the default orchestrator persona.
          const persona = body.persona || (body.name === 'orch' ? DEFAULT_ORC_PERSONA : '');
          return sendJson(res, 200, registry.spawn(body.name, { persona }));
        }
        if (p === '/api/hook') {
          // Agent-fired Claude hook (Notification / SessionStart) -> orchestrator coordination:
          // self-heal the session id and, for an idle worker, drop a pending the daemon triages.
          return sendJson(res, 200, { ok: true, ...handleHookEvent({ bus, registry }, body) });
        }
        if (p === '/api/kill')    return sendJson(res, 200, registry.kill(body.name));
        if (p === '/api/remove') {
          const cur = registry.get(body.name);
          if (cur && cur.role === 'orchestrator') return sendJson(res, 400, { error: 'The orchestrator cannot be removed.' });
          const snap = registry.remove(body.name);
          if (bus) { // drop the worker from bus state so the daemon stops addressing it
            const st = bus.readState();
            const workers = { ...(st.workers || {}) }; delete workers[body.name];
            bus.writeState({ workers, orchestratorWorker: st.orchestratorWorker === body.name ? null : st.orchestratorWorker });
          }
          return sendJson(res, 200, snap);
        }
        if (p === '/api/restart') return sendJson(res, 200, registry.restart(body.name, { persona: body.persona }));
        if (p === '/api/persona') {
          // Update the STORED persona only — no restart, live session untouched; the new text is
          // baked in at the agent's next restart/resume instead of the manifest's old one.
          if (typeof body.persona !== 'string') return sendJson(res, 400, { error: 'missing persona' });
          return sendJson(res, 200, { name: body.name, ...registry.setPersona(body.name, body.persona) });
        }
        if (p === '/api/send')  {
          registry.send(body.name, body.text);
          // Input arrived for this worker, so its outstanding "needs input" signal is now stale —
          // clear it so the NEXT idle re-signals fresh (and a never-answered pending can't wedge
          // dedup forever). Only pendings keyed to this worker are touched.
          if (bus?.listPending && body.name) {
            for (const x of bus.listPending()) if (x.worker === body.name) bus.removePending?.(x.ref);
          }
          return sendJson(res, 200, { ok: true });
        }
        if (p === '/api/rename') {
          if (!body.to) return sendJson(res, 400, { error: 'missing new name' });
          const snap = registry.rename(body.from, body.to);
          if (bus) { // re-key the worker in bus state (host subscribe already added the new name)
            const st = bus.readState();
            const workers = { ...(st.workers || {}) }; delete workers[body.from]; workers[body.to] = body.to;
            bus.writeState({ workers, orchestratorWorker: st.orchestratorWorker === body.from ? body.to : st.orchestratorWorker });
          }
          return sendJson(res, 200, snap);
        }
        if (p === '/api/spawn-request/approve') {
          const pend = bus?.readPending(body.ref);
          if (!pend) return sendJson(res, 404, { error: 'no such request' });
          registry.spawn(pend.proposedName);
          bus.removePending(body.ref);
          return sendJson(res, 200, { ok: true, spawned: pend.proposedName });
        }
        if (p === '/api/spawn-request/dismiss') { bus?.removePending(body.ref); return sendJson(res, 200, { ok: true }); }
      }
      return sendJson(res, 404, { error: `no route ${req.method} ${p}` });
    } catch (e) {
      const code = /unknown agent/.test(e.message) ? 404 : 500;
      return sendJson(res, code, { error: e.message });
    }
  };
}
