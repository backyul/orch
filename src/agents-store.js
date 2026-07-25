import fs from 'node:fs';
import path from 'node:path';

// Persists the resume manifest (which agents should exist + their Claude session ids)
// so a host restart can re-spawn them with `claude --resume`. Atomic write so a crash
// mid-save can't truncate it.
export function createAgentsStore(file) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
    },
    save(list) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}
