// Auto-answer Claude Code's boot dialog on `--resume` of a large session:
//   "Resuming the full session will consume a substantial portion of your usage limits.
//    We recommend resuming from a summary."
//      > Resume from summary (recommended)     <- first option, pre-highlighted
//        Resume full session as-is
// There is no CLI flag / setting to skip it (checked docs + the installed binary), so the
// host answers it: one Enter picks the highlighted "summary" option. Gated to resumed
// spawns, a single answer, and a boot window — a stray Enter on an empty input box is a
// no-op, so the worst-case false positive is harmless.
const DIALOG = /Resume from summary \(recommended\)/;
const ANSI = /\x1b\[[0-9;:?]*[A-Za-z]/g;

export function createResumeDialogAnswerer({
  write,
  windowMs = 120_000,
  now = () => Date.now(),
  defer = (fn) => setTimeout(fn, 150), // let the dialog finish mounting before the keypress
} = {}) {
  const spawnedAt = now();
  let buf = '';
  let done = false;
  // Returns true once the dialog has been answered (caller may unsubscribe then).
  return function onData(chunk) {
    if (done) return true;
    if (now() - spawnedAt > windowMs) return false;
    // Keep a rolling window so the match survives chunk splits and interleaved ANSI codes.
    buf = (buf + String(chunk)).slice(-8000);
    if (!DIALOG.test(buf.replace(ANSI, ''))) return false;
    done = true;
    defer(() => write('\r'));
    return true;
  };
}
