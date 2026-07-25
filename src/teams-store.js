import fs from 'node:fs';
import path from 'node:path';

// Named, keepable team snapshots under <dir>/teams/<team>.json. A team is { team, members }
// where each member is { name, role, sessionId, persona }. The live "(last session)" team is
// NOT stored here — the host composes it from the registry/agents.json at list time.
export function createTeamsStore(dir) {
  const teamsDir = path.join(dir, 'teams');
  const file = (name) => path.join(teamsDir, `${name.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  return {
    saveTeam(team, members) {
      fs.mkdirSync(teamsDir, { recursive: true });
      const tmp = `${file(team)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ team, members }, null, 2));
      fs.renameSync(tmp, file(team));
    },
    loadTeam(team) {
      try { return JSON.parse(fs.readFileSync(file(team), 'utf8')); } catch { return null; }
    },
    listTeams() {
      try {
        return fs.readdirSync(teamsDir).filter((f) => f.endsWith('.json'))
          .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(teamsDir, f), 'utf8')); } catch { return null; } })
          .filter(Boolean);
      } catch { return []; }
    },
  };
}
