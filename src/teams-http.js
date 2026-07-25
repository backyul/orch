import { URL } from 'node:url';

function readJson(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

// Teams: save the current registry as a named snapshot; import a team (resume all) or a single
// member (resume one). Import is spawn(name, { sessionId, resume:true, persona }) — it reuses the
// existing resume path. The live "(last session)" team is composed from the registry at list time.
export function createTeamsHandler({ registry, teams }) {
  return async function handler(req, res) {
    const p = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && p === '/api/teams') {
        const lastSession = { team: '(last session)', auto: true, members: registry.list() };
        return json(res, 200, [lastSession, ...teams.listTeams()]);
      }
      if (req.method === 'POST' && p === '/api/teams/save') {
        const { team } = await readJson(req);
        teams.saveTeam(team, registry.list());
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/teams/import') {
        const { team } = await readJson(req);
        const t = teams.loadTeam(team);
        if (!t) return json(res, 404, { error: `no team ${team}` });
        for (const m of t.members) registry.spawn(m.name, { sessionId: m.sessionId ?? null, resume: !!m.sessionId, persona: m.persona ?? '' });
        return json(res, 200, { ok: true, imported: t.members.length });
      }
      if (req.method === 'POST' && p === '/api/import-member') {
        const { team, name } = await readJson(req);
        const t = teams.loadTeam(team);
        const m = t?.members.find((x) => x.name === name);
        if (!m) return json(res, 404, { error: `no member ${name} in ${team}` });
        registry.spawn(m.name, { sessionId: m.sessionId ?? null, resume: !!m.sessionId, persona: m.persona ?? '' });
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: `no teams route ${req.method} ${p}` });
    } catch (e) { return json(res, 500, { error: e.message }); }
  };
}
