/* agent·grid cockpit. Classic script: top-level function declarations are global (callable
   from inline onclick). xterm.js UMD exposes `Terminal`; addon-fit UMD exposes `FitAddon`. */

const THEMES = {
  claude: { background: '#fbfaf7', foreground: '#2b2a27', cursor: '#c2410c' },
  dark:   { background: '#0a0e14', foreground: '#d7dde6', cursor: '#d7dde6' },
};

// Claude's TUI paints its secondary/dim text with a hard-coded 24-bit gray (ESC[38;2;153;153;153m),
// not the ANSI dim attribute or the bright-black slot — so no xterm theme entry can touch it. We
// rewrite that exact SGR in the incoming PTY stream to a theme-appropriate blue, recoloring ONLY the
// dim text and leaving body text and the cyan/pink emphasis tokens alone.
const DIM_GRAY_SGR = '\x1b[38;2;153;153;153m';
const DIM_BLUE_SGR = { claude: '\x1b[38;2;37;99;235m', dark: '\x1b[38;2;124;162;224m' };
function recolorDim(s) { return s.split(DIM_GRAY_SGR).join(DIM_BLUE_SGR[currentTheme()] || DIM_GRAY_SGR); }
const panes = new Map(); // name -> { term, fit, ws, el }
let focused = null, zoomTarget = null, layout = 'tiled';
const freePos = {};
// Zoom button: outward arrows (expand) when not zoomed; inward arrows (compress) when this pane is zoomed.
const ZOOM_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
const ZOOM_COMPRESS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

function currentTheme() { return document.body.getAttribute('data-theme') || 'claude'; }

async function api(method, path, body) {
  try {
    const r = await fetch('/api' + path, {
      method, headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, data: null, error: e.message }; }
}

// ---- Grid reconcile (never nukes live terminals) ----
async function refresh() {
  const res = await api('GET', '/agents');
  const agents = res.ok && Array.isArray(res.data) ? res.data : [];
  window._agents = agents;
  const names = new Set(agents.map((a) => a.name));
  for (const [name, p] of panes) {
    if (!names.has(name)) { try { p.ro.disconnect(); } catch {} try { p.ws.close(); } catch {} try { p.term.dispose(); } catch {} p.el.remove(); panes.delete(name); }
  }
  for (const a of agents) if (!panes.has(a.name)) addPane(a);
  for (const a of agents) updateBadge(a.name, a.status, a.exitCode);
  // Re-layout every tick — this also self-corrects a pane whose first fit raced with load (otherwise
  // it can render blank). It no longer causes the "panes keep moving" flicker because sendResize is
  // now idempotent (see mountTerminal): a steady-state refit fits to the same size and sends nothing.
  applyLayout(agents.length);
  updateBrandAndTitle();
}

function addPane(a) {
  const el = document.createElement('div');
  el.className = 'pane'; el.dataset.name = a.name;
  el.innerHTML = `
    <div class="pane-head" data-drag="${a.name}">
      <span class="pane-title">${a.name.toUpperCase()}</span>
      <span class="badge ${a.status}" data-badge="${a.name}">${a.status}</span>
      <span class="spacer"></span>
      <button class="icon-btn" title="persona"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="9.7" r="3"/><path d="M5.8 19a6.4 6.4 0 0 1 12.4 0"/></svg></button>
      <button class="icon-btn" title="history (full session transcript)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3.5 2"/></svg></button>
      <button class="icon-btn zoom-btn" title="zoom">${ZOOM_EXPAND}</button>
      <button class="icon-btn" title="restart">↻</button>
      <button class="icon-btn min-btn" title="minimize (Free layout)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 15h12"/></svg></button>
      <button class="icon-btn danger close-btn" title="stop the agent">✕</button>
    </div>
    <div class="term"></div>`;
  // mousedown (not click): focus + raise must happen on PRESS — a drag from the title bar
  // never completes a click, and the pane should already be on top while it moves.
  el.addEventListener('mousedown', () => focusPane(a.name));
  const head = el.querySelector('.pane-head');
  head.addEventListener('dblclick', () => {
    // Double-clicking a minimized strip restores it; otherwise the usual zoom toggle.
    if (el.classList.contains('minimized')) toggleMinimize(a.name);
    else toggleZoom(a.name);
  });
  const btns = el.querySelectorAll('.icon-btn');
  btns[0].addEventListener('click', (e) => { e.stopPropagation(); openPersona(a.name); });
  btns[1].addEventListener('click', (e) => { e.stopPropagation(); openHistory(a.name); });
  btns[2].addEventListener('click', (e) => { e.stopPropagation(); toggleZoom(a.name); });
  btns[3].addEventListener('click', (e) => { e.stopPropagation(); restartAgent(a.name); });
  btns[4].addEventListener('click', (e) => { e.stopPropagation(); toggleMinimize(a.name); });
  btns[5].addEventListener('click', (e) => { e.stopPropagation(); closeAgent(a.name); });
  document.getElementById('grid').appendChild(el);
  mountTerminal(a, el.querySelector('.term'), el);
  applyPaneAccent(a.name); // re-apply the saved tab color on (re)create
}

function mountTerminal(a, termEl, paneEl) {
  const term = new Terminal({
    // Font fallback chain matters: Cascadia/Consolas have NO Hangul and few emoji/symbol glyphs, so
    // without explicit fallbacks the browser substitutes random fonts with mismatched cell widths —
    // "broken letters" (Korean) and mangled "images" (emoji/TUI symbols) in the input box. Malgun
    // Gothic covers Korean, Segoe UI Emoji/Symbol cover Claude's glyphs, all Windows-standard.
    fontSize: 12,
    fontFamily: '"Cascadia Code", Consolas, "Malgun Gothic", "Segoe UI Emoji", "Segoe UI Symbol", monospace',
    scrollback: 20000, cursorBlink: true, theme: THEMES[currentTheme()],
    // Claude's TUI renders secondary text with the ANSI "dim" attribute, which xterm draws by
    // lowering opacity — nearly invisible on the light Claude background. minimumContrastRatio forces
    // any too-faint glyph up to a legible contrast vs. the active background (1 = off, 4.5 = WCAG AA,
    // 7 = AAA). 4.5 keeps the light cyan/pink emphasis tokens readable; our dim blue (#2563eb) already
    // passes 4.5 so it isn't darkened. The dim-gray recolor is handled in recolorDim(), not here.
    minimumContrastRatio: 4.5,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);
  try { fit.fit(); } catch {}
  // Refit whenever the pane's terminal area changes size — window resize, zoom, layout switch,
  // add/remove of sibling panes. More reliable than a single window 'resize' listener.
  const ro = new ResizeObserver(() => {
    try { fit.fit(); } catch {}
    // In free layout, capture a manual (corner) resize into freePos so the periodic refresh()
    // re-applies the user's size instead of snapping the pane back to the stored default.
    if (layout === 'free' && freePos[a.name] && paneEl.offsetWidth && !paneEl.classList.contains('minimized')) {
      const fp = freePos[a.name];
      // A manual resize of a snapped pane ends the snap — its remembered pre-snap size is stale now.
      if (fp.snap && (Math.abs(paneEl.offsetWidth - fp.w) > 4 || Math.abs(paneEl.offsetHeight - fp.h) > 4)) delete fp.snap;
      fp.w = paneEl.offsetWidth; fp.h = paneEl.offsetHeight;
      scheduleOcclusionSweep(); // a grown window may now fully bury a neighbor
    }
  });
  ro.observe(termEl);
  const ws = new WebSocket(`ws://${location.host}/ws?name=${encodeURIComponent(a.name)}`);
  // Idempotent resize: only tell the PTY when cols/rows actually changed. A same-size resize would
  // make Claude redraw its whole TUI, which — fired by the 4s refit — was the "panes keep moving"
  // flicker. `force` re-sends regardless (on connect, where the PTY must learn our size).
  let lastSentSize = '';
  const sendResize = (force = false) => {
    if (ws.readyState !== 1) return;
    const key = `${term.cols}x${term.rows}`;
    if (!force && key === lastSentSize) return;
    lastSentSize = key;
    ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows }));
  };
  ws.onopen = () => { try { fit.fit(); } catch {} sendResize(true); }; // tell the PTY our real size on connect
  // Force the TUI to fully repaint: jiggle rows down/up so the PTY sees a REAL resize even when the
  // final cols/rows are unchanged. Used once per layout change — a transient mid-layout paint can
  // leave stale artifacts (e.g. a doubled status footer) that idempotent sendResize never clears,
  // because a same-size refit sends nothing and Claude only redraws on a resize event.
  const forceRepaint = () => {
    if (ws.readyState !== 1 || term.rows < 3) return;
    try {
      ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows - 1 }));
      setTimeout(() => { try { ws.send(JSON.stringify({ t: 'r', cols: term.cols, rows: term.rows })); } catch { /* gone */ } }, 80);
    } catch { /* gone */ }
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'replay' || m.type === 'data') term.write(recolorDim(m.data));
    else if (m.type === 'status') updateBadge(a.name, m.agent.status, m.agent.exitCode);
  };
  term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });
  term.onResize(sendResize); // xterm refit -> propagate cols/rows down to the PTY (claude reflows)
  // Ctrl+V / Cmd+V paste: xterm by default turns Ctrl+V into the raw control char 0x16 (no paste),
  // so we intercept it, read the clipboard, and feed it through term.paste() — which wraps the text
  // in bracketed-paste markers when the TUI has that mode on, so multi-line content lands as ONE
  // block instead of each newline submitting. Returning false stops xterm from also emitting 0x16.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => toast('Clipboard blocked by the browser'));
      return false;
    }
    return true;
  });
  // Click-to-position the input cursor: Claude's TUI has no native mouse positioning, so we fake
  // it — a click on the CURSOR'S OWN ROW synthesizes exactly enough ←/→ arrow presses to land on
  // the clicked cell (counting real glyphs, so wide CJK chars move one press per character, not
  // per column). Clicks on any other row are ignored on purpose: sending arrows while a selector
  // or history is on screen would change selections, and continuation rows of a TUI-wrapped line
  // aren't addressable by ←/→ alone. Selection drags and modifier-clicks pass through untouched.
  termEl.addEventListener('click', (ev) => {
    try {
      if (ws.readyState !== 1 || term.hasSelection() || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const screen = termEl.querySelector('.xterm-screen');
      if (!screen) return;
      const r = screen.getBoundingClientRect();
      const col = Math.floor((ev.clientX - r.left) / (r.width / term.cols));
      const row = Math.floor((ev.clientY - r.top) / (r.height / term.rows));
      const buf = term.buffer.active;
      if (buf.viewportY + row !== buf.baseY + buf.cursorY) return; // only the row the cursor is on
      if (col === buf.cursorX || col < 0 || col >= term.cols) return;
      const line = buf.getLine(buf.baseY + buf.cursorY);
      if (!line) return;
      const [from, to] = col > buf.cursorX ? [buf.cursorX, col] : [col, buf.cursorX];
      let presses = 0;
      for (let x = from; x < to && x < term.cols; x++) { const c = line.getCell(x); if (c && c.getWidth() > 0) presses++; }
      if (!presses || presses > 300) return; // sanity cap
      ws.send(JSON.stringify({ t: 'i', d: (col > buf.cursorX ? '\x1b[C' : '\x1b[D').repeat(presses) }));
    } catch { /* positioning is best-effort — never break click-to-focus */ }
  });
  panes.set(a.name, { term, fit, ws, ro, sendResize, forceRepaint, el: paneEl });
}

function updateBadge(name, status, code) {
  const b = document.querySelector(`[data-badge="${name}"]`);
  if (b) { b.className = `badge ${status}`; b.textContent = (status === 'exited' && code != null) ? `exited ${code}` : status; }
  const cb = document.querySelector(`.pane[data-name="${name}"] .close-btn`);
  if (cb) cb.title = status === 'running' ? 'stop the agent' : 'end — remove from the cockpit';
}

// ---- Focus / zoom / layout ----
let zTop = 10; // Free-layout stacking: monotonically increasing, session-only (like freePos)
function focusPane(n) {
  focused = n;
  document.querySelectorAll('.pane').forEach((el) => el.classList.toggle('focused', el.dataset.name === n));
  // Free layout: the clicked pane comes to the front, like windows on a desktop.
  if (layout === 'free') {
    const el = document.querySelector(`.pane[data-name="${CSS.escape(n)}"]`);
    if (el && !el.classList.contains('minimized')) { el.style.zIndex = ++zTop; scheduleOcclusionSweep(); }
  }
  panes.get(n)?.term.focus();
}
function toggleZoom(n) {
  if (layout === 'free') { focusPane(n); return; }
  zoomTarget = zoomTarget === n ? null : n;
  applyLayout(panes.size);
}
// Orchestrator-anchored tiling: orch always owns the ENTIRE far-left column; workers fill to the
// right. <=3 workers -> one worker column (stacked rows). 4-6 workers -> two worker columns split
// mid-heavy (4=2+2, 5=3+2, 6=3+3); >6 keeps the same split with more rows. Columns never exceed 3.
// Mixed row counts (e.g. 3 mid vs 2 right) use an LCM row grid so each column divides evenly.
function lcm(a, b) { const g = (x, y) => (y ? g(y, x % y) : x); return (a / g(a, b)) * b; }
function applyOrcTiling(grid) {
  grid.className = 'grid';
  const order = (window._agents || []).map((a) => a.name).filter((n) => panes.has(n));
  for (const n of panes.keys()) if (!order.includes(n)) order.push(n); // panes not yet in _agents
  const orchAgent = (window._agents || []).find((a) => a.role === 'orchestrator');
  const orchName = orchAgent && panes.has(orchAgent.name) ? orchAgent.name : (order.includes('orch') ? 'orch' : null);
  const place = (n, col, row, span) => { const el = panes.get(n)?.el; if (el) { el.style.gridColumn = String(col); el.style.gridRow = `${row} / span ${span}`; } };
  const workers = order.filter((n) => n !== orchName);
  // Session-side tile order (drag-to-swap): overrides server order; unknown names keep
  // their natural relative order at the end (stable sort), so new spawns slot in cleanly.
  if (tileOrder) workers.sort((a, b) => { const ia = tileOrder.indexOf(a), ib = tileOrder.indexOf(b); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
  panes.forEach((p, n) => p.el.classList.toggle('orch-pane', n === orchName)); // marks the anchored column (cursor styling)
  if (!orchName) { // no orchestrator pane -> plain equal grid
    const cols = order.length <= 1 ? 1 : order.length <= 4 ? 2 : 3;
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`; grid.style.gridTemplateRows = '';
    order.forEach((n) => { const el = panes.get(n)?.el; if (el) { el.style.gridColumn = ''; el.style.gridRow = ''; } });
    return;
  }
  if (workers.length === 0) {
    grid.style.gridTemplateColumns = '1fr'; grid.style.gridTemplateRows = '1fr';
    place(orchName, 1, 1, 1);
  } else if (workers.length <= 3) {
    grid.style.gridTemplateColumns = '1fr 1fr'; grid.style.gridTemplateRows = `repeat(${workers.length}, 1fr)`;
    place(orchName, 1, 1, workers.length);
    workers.forEach((n, i) => place(n, 2, i + 1, 1));
  } else {
    const m = Math.ceil(workers.length / 2), r = workers.length - m, T = lcm(m, r);
    grid.style.gridTemplateColumns = '1fr 1fr 1fr'; grid.style.gridTemplateRows = `repeat(${T}, 1fr)`;
    place(orchName, 1, 1, T);
    workers.slice(0, m).forEach((n, i) => place(n, 2, i * (T / m) + 1, T / m));
    workers.slice(m).forEach((n, i) => place(n, 3, i * (T / r) + 1, T / r));
  }
}
function clearTileStyles(grid) {
  grid.style.gridTemplateColumns = ''; grid.style.gridTemplateRows = '';
  panes.forEach((p) => { p.el.style.gridColumn = ''; p.el.style.gridRow = ''; });
}
function applyLayout(count) {
  const grid = document.getElementById('grid');
  const tiled = layout !== 'free' && !zoomTarget;
  if (tiled) applyOrcTiling(grid);
  else { clearTileStyles(grid); grid.className = 'grid cols-1'; } // zoomed/free: CSS rules take over
  document.body.classList.toggle('zoomed', !!zoomTarget && layout !== 'free');
  document.querySelectorAll('.pane').forEach((el) => el.classList.toggle('zoom-target', el.dataset.name === zoomTarget));
  // Flip the zoom button to the inward (compress) arrow on the zoomed pane so it reads as "restore".
  const isZoomed = !!zoomTarget && layout !== 'free';
  document.querySelectorAll('.pane .zoom-btn').forEach((zb) => {
    zb.innerHTML = (isZoomed && zb.closest('.pane').dataset.name === zoomTarget) ? ZOOM_COMPRESS : ZOOM_EXPAND;
  });
  if (layout === 'free') applyFreePositions();
  else document.querySelectorAll('.pane').forEach((el) => { el.style.left = el.style.top = el.style.width = el.style.height = el.style.zIndex = ''; }); // let the grid size tiled panes (and drop free-mode stacking)
  document.getElementById('layoutHint').textContent = `${count} agents · ${layout === 'free' ? 'free' : 'auto-tiled'}`;
  // Refit after the grid reflow has painted (double rAF), then push each PTY its new size so a live
  // agent reflows its output to match. Fitting too early measures the old (free) size -> clipped,
  // awkward output when returning to auto-tile. The delayed backstop catches slow reflows.
  const refit = () => panes.forEach((p) => { try { p.fit.fit(); p.sendResize?.(); } catch {} });
  requestAnimationFrame(() => requestAnimationFrame(refit));
  setTimeout(refit, 180);
  // One forced repaint per GEOMETRY change: a transient mid-layout paint can leave stale artifacts
  // (doubled status footer) that the idempotent sendResize never clears — same-size refits send
  // nothing and the TUI only redraws on a real resize. Fires only when the signature changes, so
  // the steady-state 4s tick stays completely quiet (no flicker regression).
  const sig = layout + "|" + (zoomTarget || "") + "|" + grid.style.gridTemplateColumns + "|" + grid.style.gridTemplateRows + "|" + panes.size;
  if (applyLayout._sig !== undefined && applyLayout._sig !== sig) setTimeout(() => panes.forEach((p) => { try { p.forceRepaint?.(); } catch {} }), 320);
  applyLayout._sig = sig;
}
function setLayout(mode) {
  layout = mode;
  document.body.classList.toggle('layout-free', mode === 'free');
  document.body.classList.toggle('layout-tiled', mode === 'tiled');
  if (mode !== 'free') zoomTarget = null;
  document.querySelectorAll('#layoutSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  applyLayout(panes.size);
}
function setTheme(t) {
  document.body.setAttribute('data-theme', t);
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.pick === t));
  panes.forEach((p) => { p.term.options.theme = THEMES[t]; });
}
// Default rect for a pane entering free layout with no saved position. Sized off the REAL viewport
// (a 2x2 split, clamped sane) and placed into non-overlapping grid slots; only when the slots run
// out does a later pane cascade (+32px per cycle) over the first ones. Replaces the old 380x240
// tight cascade where every pane piled onto the previous one.
function defaultFreeRect(i) {
  const grid = document.getElementById('grid');
  const W = grid.clientWidth || window.innerWidth;
  const H = grid.clientHeight || (window.innerHeight - 60);
  const gap = 14;
  // ~42% of the viewport per pane (a touch under half) so defaults feel roomy but not dominant.
  const w = Math.max(380, Math.min(760, Math.floor((W - gap * 3) * 0.42)));
  const h = Math.max(260, Math.min(560, Math.floor((H - gap * 3) * 0.42)));
  const cols = Math.max(1, Math.floor((W - gap) / (w + gap)));
  const rows = Math.max(1, Math.floor((H - gap) / (h + gap)));
  const perPage = cols * rows;
  const slot = i % perPage, cycle = Math.floor(i / perPage);
  return {
    x: gap + (slot % cols) * (w + gap) + cycle * 32,
    y: gap + Math.floor(slot / cols) * (h + gap) + cycle * 32,
    w, h,
  };
}
function applyFreePositions() {
  [...document.querySelectorAll('.pane')].forEach((el, i) => {
    const n = el.dataset.name;
    if (!freePos[n]) freePos[n] = defaultFreeRect(i);
    if (el.classList.contains('minimized')) return; // the dock owns strip positions
    const p = freePos[n];
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.width = p.w + 'px'; el.style.height = p.h + 'px';
  });
  dockMinimized();
}
// Minimized strips line up along the bottom edge like a taskbar — far left first, in the
// order they were minimized, never overlapping. Strips stack above windows (z 10000+) so
// a maximized/snapped window can never bury the dock.
const DOCK_GAP = 8;
let minDock = []; // pane names, in minimize order
function dockMinimized() {
  const g = document.getElementById('grid');
  if (!g) return;
  minDock = minDock.filter((n) => document.querySelector(`.pane[data-name="${CSS.escape(n)}"]`)?.classList.contains('minimized'));
  let x = DOCK_GAP;
  for (const n of minDock) {
    const el = document.querySelector(`.pane[data-name="${CSS.escape(n)}"]`);
    if (!el) continue;
    el.style.left = x + 'px';
    el.style.top = (g.clientHeight - el.offsetHeight - DOCK_GAP) + 'px';
    el.style.zIndex = 10000 + minDock.indexOf(n);
    x += el.offsetWidth + DOCK_GAP;
  }
}
// Auto-dock, but ONLY when the ENTIRE workspace is covered by windows (e.g. left half +
// right half snapped): any window buried underneath is unreachable and pointless, so it
// docks. While free space remains, buried windows stay put — the user can drag them out.
function workspaceFullyCovered() {
  const g = document.getElementById('grid');
  const W = g.clientWidth, H = g.clientHeight;
  const rects = [...document.querySelectorAll('.pane:not(.minimized)')].map((el) => {
    const p = freePos[el.dataset.name];
    return p ? { x1: Math.max(0, p.x), y1: Math.max(0, p.y), x2: Math.min(W, p.x + el.offsetWidth), y2: Math.min(H, p.y + el.offsetHeight) } : null;
  }).filter((r) => r && r.x2 > r.x1 && r.y2 > r.y1);
  if (!rects.length) return false;
  // Exact rectangle-union coverage via x-slab sweep (1px rounding tolerance).
  const xs = [...new Set([0, W, ...rects.flatMap((r) => [r.x1, r.x2])])].sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    if (xs[i + 1] - xs[i] < 1) continue;
    const mx = (xs[i] + xs[i + 1]) / 2;
    const ys = rects.filter((r) => r.x1 <= mx && r.x2 >= mx).map((r) => [r.y1, r.y2]).sort((a, b) => a[0] - b[0]);
    let cover = 0;
    for (const [a, b] of ys) { if (a > cover + 1) return false; cover = Math.max(cover, b); }
    if (cover < H - 1) return false;
  }
  return true;
}
let occlTimer = null;
function scheduleOcclusionSweep() { clearTimeout(occlTimer); occlTimer = setTimeout(occlusionSweep, 200); }
function occlusionSweep() {
  if (layout !== 'free' || drag) return;
  // An open modal overlay sits above everything and would read as "covered" — skip the sweep.
  if ([...document.querySelectorAll('.overlay')].some((o) => getComputedStyle(o).display !== 'none')) return;
  if (!workspaceFullyCovered()) return;
  for (const el of document.querySelectorAll('.pane:not(.minimized)')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let covered = true;
    for (let i = 1; i <= 3 && covered; i++) {
      for (let j = 1; j <= 3 && covered; j++) {
        const hit = document.elementFromPoint(r.left + (r.width * i) / 4, r.top + (r.height * j) / 4);
        const pane = hit && hit.closest('.pane');
        if (!pane || pane === el) covered = false; // this spot is visible (or under non-pane chrome)
      }
    }
    if (covered) toggleMinimize(el.dataset.name, { auto: true });
  }
}

// ---- Lifecycle ----
// The "first agent" is the orchestrator (or the first one) — its name brands the app.
function firstAgent() {
  const a = window._agents || [];
  return a.find((x) => x.role === 'orchestrator') || a[0] || null;
}
function updateBrandAndTitle() {
  const f = firstAgent();
  const name = f ? f.name : 'agent·grid';
  document.title = name;
  const b = document.getElementById('brand');
  if (b) b.textContent = name;
}
function setSpeakers() { const f = firstAgent(); const s = f ? f.name : ''; document.querySelectorAll('.speaker').forEach((el) => { el.textContent = s; }); }

let _toastT = null;
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(_toastT); _toastT = setTimeout(() => t.classList.remove('show'), 3000);
}

// Custom dialogs (no browser-native "localhost says").
function openAdd() {
  document.getElementById('addName').value = ''; document.getElementById('addPersona').value = '';
  setSpeakers(); document.getElementById('addModal').classList.add('open'); document.getElementById('addName').focus();
}
function closeAdd() { document.getElementById('addModal').classList.remove('open'); }
async function submitAdd() {
  const name = document.getElementById('addName').value.trim(); if (!name) { toast('Enter a name'); return; }
  const persona = document.getElementById('addPersona').value;
  closeAdd();
  const r = await api('POST', '/spawn', persona.trim() ? { name, persona } : { name });
  if (!r.ok) toast('spawn failed: ' + (r.data?.error || r.status));
  await refresh();
}
function addAgent() { openAdd(); } // toolbar button

let _promptCb = null;
function openPrompt(title, value, cb) {
  _promptCb = cb; document.getElementById('promptTitle').textContent = title;
  const i = document.getElementById('promptInput'); i.value = value || ''; setSpeakers();
  document.getElementById('promptModal').classList.add('open'); i.focus(); i.select();
}
function closePrompt() { document.getElementById('promptModal').classList.remove('open'); _promptCb = null; }
function promptOK() { const v = document.getElementById('promptInput').value.trim(); const cb = _promptCb; closePrompt(); if (cb && v) cb(v); }

function renameFirst() {
  const f = firstAgent(); if (!f) return;
  openPrompt(`Rename "${f.name}"`, f.name, async (to) => {
    if (to === f.name) return;
    const r = await api('POST', '/rename', { from: f.name, to });
    if (r.ok) { toast(`Renamed to "${to}"`); await refresh(); } else toast('Rename failed: ' + (r.data?.error || r.status));
  });
}
async function killAgent(n) { await api('POST', '/kill', { name: n }); await refresh(); }
// The ✕ button is context-aware: stop a running agent (kill, resumable), or end an idle/stopped
// one (remove, with confirmation). Status is read live from the badge (updated by WS events).
function closeAgent(n) {
  const badge = document.querySelector(`[data-badge="${n}"]`);
  if (badge && badge.classList.contains('running')) { killAgent(n); return; } // running -> stop the process
  const a = (window._agents || []).find((x) => x.name === n);
  if (a && a.role === 'orchestrator') { toast("The orchestrator can't be removed — use ↻ to restart it"); return; }
  endAgent(n); // idle/exited worker -> end (confirm + remove)
}
// Minimize collapses the pane to a compact strip — name + status + restore button (Free layout
// only — in auto-tile the grid owns sizing). freePos keeps the pre-minimize rect (the resize
// observer skips minimized panes), so restore returns to the exact previous size and spot.
const MIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 15h12"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
function toggleMinimize(n, { auto = false } = {}) {
  if (layout !== 'free') { if (!auto) toast('Minimize is available in Free layout'); return; }
  const p = panes.get(n); if (!p) return;
  if (auto && p.el.classList.contains('minimized')) return; // sweep never restores
  const minimized = p.el.classList.toggle('minimized');
  const btn = p.el.querySelector('.min-btn');
  if (btn) { btn.title = minimized ? 'restore' : 'minimize (Free layout)'; btn.innerHTML = minimized ? RESTORE_ICON : MIN_ICON; }
  if (minimized) {
    if (!minDock.includes(n)) minDock.push(n);
    dockMinimized();
    if (auto) toast(`Workspace is fully covered — "${n}" docked at the bottom`);
  } else {
    minDock = minDock.filter((x) => x !== n);
    const fp = freePos[n];
    if (fp) { p.el.style.left = fp.x + 'px'; p.el.style.top = fp.y + 'px'; p.el.style.width = fp.w + 'px'; p.el.style.height = fp.h + 'px'; }
    focusPane(n); // restored window comes to the front — never straight back under the pile
    dockMinimized();
    requestAnimationFrame(() => { try { p.fit.fit(); p.sendResize?.(); } catch {} }); // restored -> refit
    scheduleOcclusionSweep(); // the restored window may now bury another
  }
}
// End removes the agent from the cockpit entirely (vs. kill, which keeps a resumable EXITED pane).
function endAgent(n) {
  openConfirm(`End "${n}"?`,
    `This removes "${n}" from the cockpit — its pane closes and it won't come back on restart. Use the stop button instead if you only want to pause it (it stays resumable with ↻).`,
    async () => { await api('POST', '/remove', { name: n }); await refresh(); toast(`Ended "${n}"`); });
}
let _confirmCb = null;
// Settings > Backend > Restart: bounce host + daemon in one click, then auto-reconnect the tab.
// The host resumes every agent from its manifest, so conversations survive; current TURNS are
// interrupted, hence the confirm.
function restartHost() {
  openConfirm('Restart backend?',
    'Restarts the host and Telegram daemon to apply updated code. Agents resume with their conversations, but any in-progress turn is interrupted.',
    async () => {
      const r = await api('POST', '/host/restart', {});
      if (!r.ok) { toast('Restart failed: ' + (r.data?.error || r.status)); return; }
      toast('Backend restarting — reconnecting…');
      const poll = setInterval(async () => {
        try { const res = await fetch('/api/agents'); if (res.ok) { clearInterval(poll); location.reload(); } } catch { /* still down */ }
      }, 1000);
      setTimeout(() => clearInterval(poll), 60000); // give up silently after a minute (use restart-host.ps1)
    }, 'Restart');
}

function openConfirm(title, body, cb, okLabel = 'End agent') {
  _confirmCb = cb;
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmBody').textContent = body;
  document.getElementById('confirmOkBtn').textContent = okLabel;
  document.getElementById('confirmModal').classList.add('open');
}
function closeConfirm() { document.getElementById('confirmModal').classList.remove('open'); _confirmCb = null; }
function confirmOK() { const cb = _confirmCb; closeConfirm(); if (cb) cb(); }
async function restartAgent(n) {
  await api('POST', '/restart', { name: n });
  await refresh();
  // The pane/xterm persist across restart (same agent name), so re-push our size to the NEW PTY
  // once it's up — otherwise it renders at the default 120x32 and looks shrunk.
  setTimeout(() => { const p = panes.get(n); if (p) { try { p.fit.fit(); } catch {} p.sendResize?.(); } }, 700);
}

// ---- Settings ----
function openSettings() { document.getElementById('settings').classList.add('open'); loadSettings(); }
function closeSettings() { document.getElementById('settings').classList.remove('open'); }
async function loadSettings() {
  const c = await api('GET', '/settings/claude/status');
  const dot = document.getElementById('claudeDot'), st = document.getElementById('claudeStatus');
  if (c.ok) { const on = !!c.data?.connected; dot.className = 'status-dot ' + (on ? 'on' : 'off'); st.textContent = on ? 'Connected' : 'Not connected'; }
  else st.textContent = '(status endpoint lands in a later task)';
  const t = await api('GET', '/settings/telegram');
  if (t.ok) { document.getElementById('tgNote').textContent = t.data?.tokenSet ? 'token set' : 'not set'; if (t.data?.chatId) document.getElementById('tgChat').value = t.data.chatId; }
  const a = await api('GET', '/settings/agent');
  if (a.ok && a.data?.permissionMode) { const sel = document.getElementById('permMode'); if (sel) sel.value = a.data.permissionMode; }
}
async function savePermMode(mode) {
  const note = document.getElementById('permNote');
  const r = await api('POST', '/settings/agent', { permissionMode: mode });
  if (r.ok) { toast('Permission mode: ' + r.data.permissionMode); note.textContent = '· restart (↻) to apply to running agents'; }
  else { toast('Save failed: ' + (r.data?.error || r.status)); note.textContent = ''; }
}
async function connectClaude() {
  const r = await api('POST', '/settings/claude/connect');
  document.getElementById('claudeStatus').textContent = r.ok ? 'Opening browser…' : '(connect endpoint lands in a later task)';
  if (r.ok) setTimeout(loadSettings, 1500);
}
async function pasteInto(id) {
  try {
    const t = await navigator.clipboard.readText();
    if (t && t.trim()) { document.getElementById(id).value = t.trim(); toast('Pasted from clipboard'); }
    else toast('Clipboard is empty');
  } catch { toast('Clipboard blocked — paste manually with Ctrl+V'); }
}
async function saveTg(which) {
  const note = document.getElementById('tgNote');
  const body = which === 'token'
    ? { token: document.getElementById('tgToken').value }
    : { chatId: document.getElementById('tgChat').value };
  if (which === 'token' && !body.token.trim()) { toast('Enter or paste a token first'); return; }
  if (which === 'chat' && !body.chatId.trim()) { toast('Enter a chat ID first'); return; }
  const r = await api('POST', '/settings/telegram', body);
  if (r.ok) {
    toast(which === 'token' ? 'Bot token saved' : 'Chat ID saved');
    note.textContent = r.data?.tokenSet ? 'token set' : 'not set';
    if (which === 'token') document.getElementById('tgToken').value = ''; // clear the secret field after a successful save
  } else toast('Save failed: ' + (r.data?.error || r.status));
}
async function testTelegram() {
  const note = document.getElementById('tgNote');
  note.textContent = 'sending test message…';
  const r = await api('POST', '/settings/telegram/test');
  if (r.ok && r.data?.ok) { toast('✅ Test message sent — check Telegram'); note.textContent = 'connected ✓'; }
  else { const e = r.data?.error || 'failed'; toast('Test failed: ' + e); note.textContent = e; }
}
const EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17.3 17.3 0 0 1-3.1 3.9M6.6 6.6A17.3 17.3 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4.3-1M3 3l18 18"/></svg>';
// Eye toggle lives inside the token input box (no separate show/hide button).
function toggleEye(btn) {
  const el = btn.closest('.tg-input').querySelector('input');
  const reveal = el.type === 'password';
  el.type = reveal ? 'text' : 'password';
  btn.innerHTML = reveal ? EYE_OFF : EYE_ON;
  btn.title = reveal ? 'hide token' : 'show token';
}

// ---- Import / teams ----
async function toggleImport(e) { e.stopPropagation(); await renderImportMenu(); document.getElementById('importMenu').classList.toggle('open'); }
async function renderImportMenu() {
  const m = document.getElementById('importMenu');
  const r = await api('GET', '/teams');
  const teams = r.ok && Array.isArray(r.data) ? r.data : [];
  if (!teams.length) { m.innerHTML = '<div class="group">No saved teams</div><div class="menu-item"><span class="sub">Save the current team, or teams land in a later task</span></div>'; return; }
  m.innerHTML =
    '<div class="group">Import a team — resumes all, replaces grid</div>' +
    teams.map((t) => `<div class="menu-item" data-team="${t.team}"><span>${t.auto ? '🕘' : '📁'} ${t.team}</span><span class="sub">${(t.members || []).length} agents · resume</span></div>`).join('') +
    '<div class="group">…or import one member</div>' +
    teams.flatMap((t) => (t.members || []).filter((x) => x.role !== 'orchestrator').map((x) =>
      `<div class="menu-item member" data-team="${t.team}" data-member="${x.name}"><span>${t.team} / ${String(x.name).toLowerCase()}</span><span class="sub">resume</span></div>`)).join('');
  m.querySelectorAll('.menu-item[data-team]').forEach((el) => el.addEventListener('click', () => {
    el.dataset.member ? importMember(el.dataset.team, el.dataset.member) : importTeam(el.dataset.team);
  }));
}
async function importTeam(team) { document.getElementById('importMenu').classList.remove('open'); await api('POST', '/teams/import', { team }); await refresh(); }
async function importMember(team, name) { document.getElementById('importMenu').classList.remove('open'); await api('POST', '/import-member', { team, name }); await refresh(); }
function saveTeam() {
  openPrompt('Save current team as…', '', async (team) => {
    const r = await api('POST', '/teams/save', { team });
    toast(r.ok ? `Saved team "${team}"` : 'Save failed: ' + (r.data?.error || r.status));
  });
}

// ---- Pane accent colors (picked in the persona modal, stored per-browser) ----
const PANE_ACCENTS = ['', '#f9b4b4', '#fcd9a8', '#f5e6a8', '#b5e3b5', '#a8dcd9', '#aecbf5', '#cabffb', '#f5bede']; // pastel palette
let paneColors = {};
try { paneColors = JSON.parse(localStorage.getItem('paneColors') || '{}'); } catch { paneColors = {}; }
function applyPaneAccent(name) {
  const el = document.querySelector(`.pane[data-name="${name}"]`);
  if (!el) return;
  const c = paneColors[name];
  if (c) { el.style.setProperty('--pane-accent', c); el.setAttribute('data-accent', ''); }
  else { el.style.removeProperty('--pane-accent'); el.removeAttribute('data-accent'); }
}
function setPaneAccent(name, color) {
  if (color) paneColors[name] = color; else delete paneColors[name];
  try { localStorage.setItem('paneColors', JSON.stringify(paneColors)); } catch { /* private mode */ }
  applyPaneAccent(name);
  renderSwatches(name); // refresh the selected ring
}
function renderSwatches(name) {
  const box = document.getElementById('colorSwatches');
  if (!box) return;
  const current = paneColors[name] || '';
  box.innerHTML = PANE_ACCENTS.map((c) => c
    ? `<button class="swatch${c === current ? ' picked' : ''}" style="background:${c}" title="${c}" onclick="setPaneAccent('${name}','${c}')"></button>`
    : `<button class="swatch none${current === '' ? ' picked' : ''}" title="default (no color)" onclick="setPaneAccent('${name}','')"></button>`,
  ).join('');
}

// ---- Session history (durable transcript view) ----
let histAgent = null, histBefore = 0;
function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function histRow(m) {
  const when = m.ts ? new Date(m.ts).toLocaleString() : '';
  const who = m.role === 'user' ? 'operator' : 'agent';
  return `<div class="hist-row ${m.role}"><div class="hist-meta">${who}${when ? ' · ' + when : ''}</div><pre class="hist-text">${escHtml(m.text)}</pre></div>`;
}
async function openHistory(name) {
  histAgent = name; histBefore = 0;
  document.getElementById('historyName').textContent = name;
  document.getElementById('histList').innerHTML = '';
  document.getElementById('histNote').textContent = 'loading…';
  document.getElementById('historyModal').classList.add('open');
  const r = await api('GET', `/history?name=${encodeURIComponent(name)}`);
  const note = document.getElementById('histNote');
  if (!r.ok) { note.textContent = `(${r.data?.error || 'failed to load history'})`; return; }
  const list = document.getElementById('histList');
  list.innerHTML = r.data.messages.map(histRow).join('');
  histBefore = r.data.messages.length;
  document.getElementById('histEarlier').style.display = r.data.start > 0 ? '' : 'none';
  note.textContent = `${r.data.total} messages in session ${r.data.sessionId.slice(0, 8)}…`;
  list.scrollTop = list.scrollHeight; // open at the newest
}
async function loadEarlierHistory() {
  const r = await api('GET', `/history?name=${encodeURIComponent(histAgent)}&before=${histBefore}`);
  if (!r.ok || !r.data.messages.length) { document.getElementById('histEarlier').style.display = 'none'; return; }
  const list = document.getElementById('histList');
  const keepHeight = list.scrollHeight;
  list.insertAdjacentHTML('afterbegin', r.data.messages.map(histRow).join(''));
  list.scrollTop = list.scrollHeight - keepHeight; // keep the reading position
  histBefore += r.data.messages.length;
  if (r.data.start === 0) document.getElementById('histEarlier').style.display = 'none';
}
function closeHistory() { document.getElementById('historyModal').classList.remove('open'); histAgent = null; }

// ---- Persona ----
let personaEditing = null;
function openPersona(name) {
  personaEditing = name;
  const a = (window._agents || []).find((x) => x.name === name) || {};
  document.getElementById('personaName').textContent = name;
  document.getElementById('personaText').value = a.persona || '';
  document.getElementById('personaNote').textContent = '';
  renderSwatches(name);
  document.getElementById('personaModal').classList.add('open');
}
function closePersona() { document.getElementById('personaModal').classList.remove('open'); personaEditing = null; }
async function savePersona() {
  const persona = document.getElementById('personaText').value;
  const r = await api('POST', '/restart', { name: personaEditing, persona }); // restart applies the system prompt at relaunch
  if (r.ok) { closePersona(); await refresh(); }
  else document.getElementById('personaNote').textContent = '(persona save lands in a later task)';
}

// ---- Orc spawn-request banner ----
async function pollSpawnRequests() {
  const r = await api('GET', '/spawn-requests');
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) { document.getElementById('spawnBanner').classList.remove('show'); return; }
  const p = r.data[0];
  showSpawnBanner(p.ref, p.proposedName, p.why);
}
function showSpawnBanner(ref, name, why) {
  const b = document.getElementById('spawnBanner');
  b.innerHTML = `<span>🤖 <b>orch</b> proposes spawning worker <b>${name}</b></span><span class="why">${why || ''}</span><span class="spacer"></span>` +
    `<button class="btn primary" id="approveBtn">Approve &amp; spawn</button><button class="btn" id="dismissBtn">Dismiss</button>`;
  b.classList.add('show');
  b.querySelector('#approveBtn').onclick = async () => { await api('POST', '/spawn-request/approve', { ref }); b.classList.remove('show'); await refresh(); };
  b.querySelector('#dismissBtn').onclick = async () => { await api('POST', '/spawn-request/dismiss', { ref }); b.classList.remove('show'); };
}

// ---- Tiled-mode swap drag ----
// Dragging a WORKER pane's title bar onto another worker swaps their tile slots. The
// orchestrator is anchored (full-height far-left column) — it neither drags nor receives.
let tileOrder = null; // worker tile order override (session-only); null = server order
let tdrag = null;
function orchPaneName() {
  const oa = (window._agents || []).find((a) => a.role === 'orchestrator');
  return oa && panes.has(oa.name) ? oa.name : (panes.has('orch') ? 'orch' : null);
}
document.addEventListener('pointerdown', (e) => {
  if (layout === 'free' || zoomTarget) return;
  const head = e.target.closest('.pane-head'); if (!head || e.target.closest('.icon-btn')) return;
  const n = head.dataset.drag;
  if (!n || n === orchPaneName()) return; // orch is anchored
  tdrag = { n, sx: e.clientX, sy: e.clientY, moved: false, over: null };
});
document.addEventListener('pointermove', (e) => {
  if (!tdrag) return;
  if (!tdrag.moved && Math.hypot(e.clientX - tdrag.sx, e.clientY - tdrag.sy) < 6) return; // dblclick stays intact
  tdrag.moved = true;
  document.querySelector(`.pane[data-name="${CSS.escape(tdrag.n)}"]`)?.classList.add('tile-dragging');
  const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pane');
  const over = hit && hit.dataset.name !== tdrag.n && hit.dataset.name !== orchPaneName() ? hit.dataset.name : null;
  if (over !== tdrag.over) {
    document.querySelectorAll('.pane.swap-target').forEach((el) => el.classList.remove('swap-target'));
    if (over) document.querySelector(`.pane[data-name="${CSS.escape(over)}"]`)?.classList.add('swap-target');
    tdrag.over = over;
  }
});
document.addEventListener('pointerup', () => {
  if (!tdrag) return;
  document.querySelectorAll('.pane.tile-dragging, .pane.swap-target').forEach((el) => el.classList.remove('tile-dragging', 'swap-target'));
  if (tdrag.moved && tdrag.over) {
    const orchName = orchPaneName();
    if (!tileOrder) {
      const order = (window._agents || []).map((a) => a.name).filter((x) => panes.has(x));
      for (const x of panes.keys()) if (!order.includes(x)) order.push(x);
      tileOrder = order.filter((x) => x !== orchName);
    }
    const i = tileOrder.indexOf(tdrag.n), j = tileOrder.indexOf(tdrag.over);
    if (i >= 0 && j >= 0) { [tileOrder[i], tileOrder[j]] = [tileOrder[j], tileOrder[i]]; applyLayout(panes.size); }
  }
  tdrag = null;
});

// ---- Free-mode drag + edge/corner snap ----
// Dragging the cursor to a workspace edge shows a preview and snaps on release:
// left/right/top/bottom edges -> that half; corners -> that quadrant. A snapped pane
// remembers its pre-snap size and pops back to it when dragged away (Windows-style).
let drag = null;
const SNAP_EDGE = 28, SNAP_CORNER = 90;
function gridSpace(e) {
  const g = document.getElementById('grid');
  const r = g.getBoundingClientRect();
  return { gx: e.clientX - r.left, gy: e.clientY - r.top, W: g.clientWidth, H: g.clientHeight };
}
function snapZone(gx, gy, W, H) {
  const L = gx < SNAP_EDGE, R = gx > W - SNAP_EDGE, T = gy < SNAP_EDGE, B = gy > H - SNAP_EDGE;
  if (L) return gy < SNAP_CORNER ? { x: 0, y: 0, w: W / 2, h: H / 2 }            // 2nd quadrant
       : gy > H - SNAP_CORNER   ? { x: 0, y: H / 2, w: W / 2, h: H / 2 }         // 3rd
       : { x: 0, y: 0, w: W / 2, h: H };                                          // left half
  if (R) return gy < SNAP_CORNER ? { x: W / 2, y: 0, w: W / 2, h: H / 2 }        // 1st quadrant
       : gy > H - SNAP_CORNER   ? { x: W / 2, y: H / 2, w: W / 2, h: H / 2 }     // 4th
       : { x: W / 2, y: 0, w: W / 2, h: H };                                      // right half
  if (T) return gx < SNAP_CORNER ? { x: 0, y: 0, w: W / 2, h: H / 2 }
       : gx > W - SNAP_CORNER   ? { x: W / 2, y: 0, w: W / 2, h: H / 2 }
       : { x: 0, y: 0, w: W, h: H / 2 };                                          // top half
  if (B) return gx < SNAP_CORNER ? { x: 0, y: H / 2, w: W / 2, h: H / 2 }
       : gx > W - SNAP_CORNER   ? { x: W / 2, y: H / 2, w: W / 2, h: H / 2 }
       : { x: 0, y: H / 2, w: W, h: H / 2 };                                      // bottom half
  return null;
}
function snapPreviewEl() {
  let el = document.getElementById('snapPreview');
  if (!el) { el = document.createElement('div'); el.id = 'snapPreview'; document.getElementById('grid').appendChild(el); }
  return el;
}
document.addEventListener('pointerdown', (e) => {
  if (layout !== 'free') return;
  const head = e.target.closest('.pane-head'); if (!head || e.target.closest('.icon-btn')) return;
  if (head.closest('.pane')?.classList.contains('minimized')) return; // dock strips don't drag
  const n = head.dataset.drag; const p = freePos[n]; if (!p) return;
  // Un-snap: a snapped pane pops back to its remembered size, centered under the cursor.
  if (p.snap) {
    const { gx } = gridSpace(e);
    p.w = p.snap.w; p.h = p.snap.h; delete p.snap;
    p.x = Math.max(0, Math.round(gx - p.w / 2)); // y stays — the head remains under the cursor
    const el = document.querySelector(`.pane[data-name="${n}"]`);
    if (el) { el.style.left = p.x + 'px'; el.style.width = p.w + 'px'; el.style.height = p.h + 'px'; }
    const pp = panes.get(n);
    requestAnimationFrame(() => { try { pp.fit.fit(); pp.sendResize?.(); } catch {} });
  }
  drag = { n, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, zone: null };
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return; const p = freePos[drag.n];
  p.x = Math.max(0, drag.ox + (e.clientX - drag.sx)); p.y = Math.max(0, drag.oy + (e.clientY - drag.sy));
  const el = document.querySelector(`.pane[data-name="${drag.n}"]`);
  if (el) { el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; }
  const { gx, gy, W, H } = gridSpace(e);
  drag.zone = snapZone(gx, gy, W, H);
  const prev = snapPreviewEl();
  if (drag.zone) {
    const z = drag.zone;
    prev.style.left = z.x + 'px'; prev.style.top = z.y + 'px'; prev.style.width = z.w + 'px'; prev.style.height = z.h + 'px';
    prev.classList.add('show');
  } else prev.classList.remove('show');
});
document.addEventListener('pointerup', () => {
  if (!drag) return;
  const el = document.querySelector(`.pane[data-name="${drag.n}"]`);
  const p = freePos[drag.n];
  if (drag.zone && el && !el.classList.contains('minimized')) {
    const z = drag.zone;
    p.snap = { w: p.w, h: p.h };                      // remember pre-snap size for un-snap
    p.x = z.x; p.y = z.y; p.w = Math.round(z.w); p.h = Math.round(z.h);
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.width = p.w + 'px'; el.style.height = p.h + 'px';
    const pp = panes.get(drag.n);
    requestAnimationFrame(() => { try { pp.fit.fit(); pp.sendResize?.(); } catch {} });
  } else if (el) { p.w = el.offsetWidth; p.h = el.offsetHeight; }
  snapPreviewEl().classList.remove('show');
  drag = null;
  scheduleOcclusionSweep(); // the drop may have fully buried another window
});
document.addEventListener('click', () => document.getElementById('importMenu')?.classList.remove('open'));
window.addEventListener('resize', () => panes.forEach((p) => { try { p.fit.fit(); } catch {} }));

// ---- Architect chat (edits this GUI) ----
function archAppend(who, text) {
  const log = document.getElementById('archLog');
  const div = document.createElement('div');
  div.className = 'arch-msg arch-' + who;
  div.textContent = (who === 'you' ? 'You: ' : 'Architect: ') + text;
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  return div;
}
async function architectSend() {
  const inp = document.getElementById('archInput');
  const msg = inp.value.trim(); if (!msg) return;
  archAppend('you', msg); inp.value = ''; inp.disabled = true;
  const thinking = archAppend('architect', '…thinking (a few seconds)');
  const r = await api('POST', '/architect', { message: msg });
  thinking.textContent = 'Architect: ' + (r.ok ? (r.data?.reply || '(no reply)') : `(error) ${r.data?.error || r.status}`);
  document.getElementById('archLog').scrollTop = 1e9;
  inp.disabled = false; inp.focus();
}
async function architectRevert() {
  const r = await api('POST', '/architect/revert');
  archAppend('architect', r.ok ? `Reverted the last change (${r.data?.restored ?? 0} files). Reloading…` : '(revert failed)');
}

// Live reload: the host pushes {type:'reload'} when web/ changes (e.g. the Architect edited it).
try {
  const rls = new WebSocket(`ws://${location.host}/ws-reload`);
  rls.onmessage = (ev) => { try { if (JSON.parse(ev.data).type === 'reload') location.reload(); } catch {} };
} catch {}

// ---- Token / rate-limit display (agents stay OMC-free; the host runs `omc hud` for this) ----
async function pollUsage() {
  const el = document.getElementById('usage'); if (!el) return;
  const r = await api('GET', '/usage');
  const line = r.ok && r.data && r.data.line ? r.data.line : '';
  el.textContent = line ? `⚡ ${line}` : '';
}

// ---- Boot ----
refresh();
setInterval(refresh, 4000);           // backstop: pick up spawns/exits not driven from this tab
setInterval(pollSpawnRequests, 3000);
pollUsage();
setInterval(pollUsage, 60000);
