// Claude Code hook attached to every cockpit agent (Notification + SessionStart). It reports the
// event to the PTY host (/api/hook) so the orchestrator gets nudged when a WORKER needs input, and
// so the resume manifest self-heals when Claude changes the session id (/compact, /clear, resume).
// Identity comes from ORCH_WORKER (set per-agent in cleanAgentEnv); the host resolves the role.
// This is the GUI-native counterpart of Nova's orc-hook.sh. It always exits 0 quickly and swallows
// every error — a hook must never block or break the agent that fired it.
import http from 'node:http';

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    try { process.stdin.setEncoding('utf8'); } catch { /* ignore */ }
    process.stdin.on('data', (c) => { d += c; });
    process.stdin.on('end', () => resolve(d));
    setTimeout(() => resolve(d), 400); // don't hang if stdin never closes
  });
}

(async () => {
  const name = process.env.ORCH_WORKER;
  if (!name) process.exit(0);
  let ev = {};
  try { ev = JSON.parse((await readStdin()) || '{}'); } catch { ev = {}; }
  const port = process.env.HOST_PORT || 7610;
  const payload = JSON.stringify({
    name,
    event: ev.hook_event_name,
    notificationType: ev.notification_type,
    source: ev.source,
    sessionId: ev.session_id,
    message: ev.message,
  });
  try {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/hook', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
    req.on('error', () => process.exit(0));
    req.setTimeout(1500, () => { try { req.destroy(); } catch { /* ignore */ } process.exit(0); });
    req.write(payload);
    req.end();
  } catch { process.exit(0); }
})();
