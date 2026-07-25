import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Token/rate-limit display WITHOUT OMC: read the Claude OAuth token and call the same usage
// endpoint OMC uses. No dependency on the `omc` CLI — works even with OMC uninstalled.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export function readAccessToken(credPath = path.join(os.homedir(), '.claude', '.credentials.json')) {
  try { return JSON.parse(fs.readFileSync(credPath, 'utf8'))?.claudeAiOauth?.accessToken || null; }
  catch { return null; }
}

// Build a compact display string from the API response (e.g. "5h 52% (resets 19:10) · 7d 31%").
export function formatUsage(data, now = Date.now()) {
  if (!data) return null;
  const pct = (x) => (x == null ? '—' : Math.round(x) + '%');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => { const ap = d.getHours() < 12 ? 'AM' : 'PM'; const h = d.getHours() % 12 || 12; return `${h}:${pad(d.getMinutes())} ${ap}`; };
  // Within ~20h (the 5h window) -> "4:10 AM"; further out (the 7d) -> "Jun 28 8:00 AM". Local time.
  const reset = (iso) => {
    try {
      const d = new Date(iso);
      return (d.getTime() - now) / 3.6e6 < 20 ? hm(d) : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d)}`;
    } catch { return ''; }
  };
  const win = (label, w) => w ? `${label} ${pct(w.utilization)}${w.resets_at ? ` (resets ${reset(w.resets_at)})` : ''}` : null;
  return [win('5h', data.five_hour), win('7d', data.seven_day), win('opus 7d', data.seven_day_opus)]
    .filter(Boolean).join(' · ') || null;
}

export function createUsage({ fetch = globalThis.fetch, getToken = () => readAccessToken(), url = USAGE_URL } = {}) {
  async function getUsage() {
    const token = getToken();
    if (!token) return null;
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' } });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }
  async function getUsageLine() { return formatUsage(await getUsage()); }
  return { getUsage, getUsageLine };
}
