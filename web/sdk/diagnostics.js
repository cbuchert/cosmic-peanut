// @ts-check
/** Error location, error description and log formatting for the dev overlay. */

/** Longest string the SDK sends to the shell (log text, error message). */
export const MAX_TEXT = 2000;

// One stack line: V8 "    at fn (URL:line:col)" / "    at URL:line:col", JSC "fn@URL:line:col".
const FRAME_RE = /((?:https?|blob|file):\S+?):(\d+)(?::\d+)?\)?$/;

/** @param {string} s */
function truncate(s) {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + "…" : s;
}

/**
 * Find the most useful file/line in a stack: the first frame outside the SDK (`/sdk/`), else the
 * first frame at all. Files inside the repo are reported relative to `base` (absolute URL).
 * @param {string | undefined} stack
 * @param {string} base
 * @returns {{ file?: string, line?: number }}
 */
export function locate(stack, base) {
  if (!stack) return {};
  /** @type {{ file: string, line: number } | null} */
  let fallback = null;
  for (const raw of stack.split("\n")) {
    const m = FRAME_RE.exec(raw.trim());
    if (!m) continue;
    const url = m[1], line = Number(m[2]);
    const hit = { file: url.startsWith(base) ? url.slice(base.length) : url, line };
    if (!new URL(url).pathname.startsWith("/sdk/")) return hit;
    fallback ??= hit;
  }
  return fallback ?? {};
}

/**
 * @param {unknown} err anything thrown
 * @param {string} base absolute repo base URL
 * @returns {{ message: string, file?: string, line?: number }}
 */
export function describeError(err, base) {
  if (err instanceof Error || (typeof err === "object" && err !== null && "message" in err)) {
    const e = /** @type {Error} */ (err);
    const message = truncate(e.name ? `${e.name}: ${e.message}` : String(e.message));
    return { message, ...locate(typeof e.stack === "string" ? e.stack : undefined, base) };
  }
  return { message: truncate(String(err)) };
}

/** @param {unknown} v */
function stringify(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === "object" && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * `ctx.log(...args)` → one plain-text line.
 * @param {unknown[]} args
 */
export function formatLog(args) {
  return truncate(args.map(stringify).join(" "));
}
