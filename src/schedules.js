import fs from 'node:fs';
import path from 'node:path';

// Wall-clock schedules that live in the DAEMON, not in an agent's Claude session. An agent-side
// cron ("CronList") only fires if that agent's session happens to be alive and idle at the moment —
// which an event-driven orchestrator never guarantees (the 11:03pm nudge that silently didn't
// fire). The daemon ticks every ~2s regardless, so it is the right clock: at HH:MM it drops the
// schedule's message into the orchestrator inbox and nudges — the same push path as everything else.
//
// Semantics: daily, once per LOCAL day, with catch-up that survives midnight — fireDue reasons
// about the most recent occurrence at or before `now` (today's HH:MM, or yesterday's if today's
// hasn't arrived). An unhandled occurrence within `catchupMs` (default 12h, env
// ORCH_SCHED_CATCHUP_MS) fires late (flagged `late`); older than that it is returned once with
// `missed: true` so the operator gets told instead of a silent skip — the 23:03 nudge lost to an
// overnight daemon outage was exactly that silent skip. Occurrences from before a schedule was
// added never fire (addedDate guard). Adding a time already past today arms it for tomorrow.
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const LATE_GRACE_MS = 10 * 60_000; // fired this much after HH:MM -> flag as late

export function createSchedules({ file, catchupMs = Number(process.env.ORCH_SCHED_CATCHUP_MS) || 12 * 3600_000 }) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  const save = (l) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(l, null, 2)); };

  function add(time, message, { now = new Date() } = {}) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error('time must be HH:MM (24h)');
    if (!message || !String(message).trim()) throw new Error('message required');
    const l = load();
    const id = Math.random().toString(36).slice(2, 8);
    const [H, M] = String(time).split(':').map(Number);
    const passedToday = (now.getHours() * 60 + now.getMinutes()) >= (H * 60 + M);
    l.push({ id, time, message: String(message).trim(), addedDate: localDate(now), lastFiredDate: passedToday ? localDate(now) : null });
    save(l);
    return id;
  }
  function remove(id) { const l = load(); const next = l.filter((s) => s.id !== id); save(next); return next.length < l.length; }
  function list() { return load(); }
  function fireDue(now = new Date()) {
    const l = load();
    const today = localDate(now);
    const fired = [];
    for (const s of l) {
      const [H, M] = String(s.time).split(':').map(Number);
      // Most recent occurrence at or before `now`: today's HH:MM, else yesterday's.
      const occ = new Date(now.getFullYear(), now.getMonth(), now.getDate(), H, M);
      if (occ > now) occ.setDate(occ.getDate() - 1);
      const occDate = localDate(occ);
      if (s.lastFiredDate === occDate) continue;                               // already handled
      if (s.lastFiredDate == null) {
        // Never fired: only occurrences since the schedule existed count. Legacy entries
        // without addedDate get the conservative reading (today only — no retro-fire).
        if (s.addedDate ? occDate < s.addedDate : occDate !== today) continue;
      }
      const ageMs = now - occ;
      s.lastFiredDate = occDate;
      if (ageMs > catchupMs) fired.push({ ...s, missed: true, missedDate: occDate });
      else if (ageMs > LATE_GRACE_MS) fired.push({ ...s, late: true, missedDate: occDate });
      else fired.push({ ...s });
    }
    if (fired.length) save(l);
    return fired;
  }
  return { add, remove, list, fireDue };
}
