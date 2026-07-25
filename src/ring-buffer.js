// A bounded text buffer holding the most recent output of one PTY. Used to replay
// scrollback to a (re)connecting browser and to answer capture() calls. Byte-capped
// so a chatty agent can't grow memory without bound.
export function createRingBuffer(maxBytes = 200_000) {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk);
      if (buf.length > maxBytes) buf = buf.slice(buf.length - maxBytes);
    },
    text() { return buf; },
    tail(lines) {
      if (lines == null) return buf;
      const arr = buf.split('\n');
      return arr.slice(Math.max(0, arr.length - lines)).join('\n');
    },
  };
}
