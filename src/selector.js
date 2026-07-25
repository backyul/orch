// Parse a Claude Code numbered-selector dialog (permission prompt or any "❯ 1. …"
// picker) out of a captured pane. Returns { question, options:string[] } or null
// when no selector is present. Used to turn a permission prompt into actionable
// Telegram buttons; the option's position (index+1) is the number key that selects it.

const OPT_RE = /^[\s│>❯]*(\d+)\.\s+(.*\S)\s*$/;
// Lines that mark the END of the option list (the dialog footer / navigation hints).
const FOOTER_RE = /^(enter to select|esc to|tab |↑|↓|·\s|\d+ selected)/i;

function clean(label) {
  return label.replace(/\s*\(esc\)\s*$/i, '').trim();
}

export function parseSelector(text) {
  const lines = String(text || '').split(/\r?\n/);
  let best = null;
  let cur = null;
  let curStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPT_RE);
    if (m) {
      const num = Number(m[1]);
      if (num === 1) { cur = [clean(m[2])]; curStart = i; }
      else if (cur && num === cur.length + 1) { cur.push(clean(m[2])); }
      else { cur = null; continue; }
      if (cur.length >= 2) best = { options: [...cur], start: curStart };
    } else if (cur) {
      // In a narrow pane a long option wraps onto a continuation line (no number).
      // Stitch it onto the current option's label. A blank line or the dialog footer
      // ends the option list.
      const t = lines[i].replace(/^[\s│>❯]+/, '').trim();
      if (!t || FOOTER_RE.test(t)) { cur = null; continue; }
      cur[cur.length - 1] = clean(`${cur[cur.length - 1]} ${t}`);
      if (cur.length >= 2) best = { options: [...cur], start: curStart };
    }
  }
  if (!best) return null;

  // Question = nearest non-empty, non-option line just above the first option.
  let question = 'Permission requested';
  for (let j = best.start - 1; j >= 0 && j >= best.start - 6; j--) {
    const t = lines[j].replace(/^[\s│]+/, '').trim();
    if (t && !OPT_RE.test(lines[j])) { question = t; break; }
  }
  return { question, options: best.options };
}
