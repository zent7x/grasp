// src/color.js
//
// Tiny zero-dependency ANSI styler. Colors are opt-in per stream: enabled only
// when the target stream is a TTY and NO_COLOR is unset (FORCE_COLOR overrides).
// When disabled, every styler is the identity function, so piped / redirected /
// spawned output is byte-for-byte identical to the uncolored text — which is
// exactly what keeps the CLI pipe-friendly and the snapshot tests stable.

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/** Should this stream get color? TTY + no NO_COLOR, unless FORCE_COLOR is set. */
export function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

/**
 * Build a styler object. Each method wraps a string in an ANSI code when
 * `enabled`, or returns it untouched when not.
 * @param {boolean} enabled
 */
export function makeStyler(enabled) {
  const style = {};
  for (const [name, code] of Object.entries(CODES)) {
    if (name === 'reset') continue;
    style[name] = enabled ? (s) => `${code}${s}${CODES.reset}` : (s) => `${s}`;
  }
  style.enabled = enabled;
  return style;
}

/** Convenience: a styler auto-configured for the given stream. */
export function stylerFor(stream = process.stdout) {
  return makeStyler(supportsColor(stream));
}
