// Control WebSocket to the host (docs/protocols.md §3–4): config fetch, reconnect with backoff,
// heartbeat, inbound validation. Binary frames go straight to `onFrame` untouched.

import { parseHostMessage } from "./validate.js";

/** @typedef {{ token: string; pluginOrigin: string; dev: boolean }} ShellConfig */
/** @typedef {"connecting" | "open" | "closed"} ConnState */
/** @typedef {{ ok: boolean; json(): Promise<unknown> }} FetchResponse */

/**
 * @typedef {object} ConnectionDeps
 * @property {{ search: string; host: string }} location
 * @property {(url: string) => Promise<FetchResponse>} fetch
 * @property {new (url: string) => WebSocket} WebSocket
 * @property {() => number} [now]
 * @property {(msg: import("./validate.js").HostMessage) => void} onMessage
 * @property {(buf: ArrayBuffer) => void} onFrame
 * @property {(config: ShellConfig) => void} [onConfig]
 * @property {(state: ConnState) => void} [onState]
 */

export const HEARTBEAT_MS = 500;
const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 5000;

/** @param {ConnectionDeps} deps */
export function createConnection(deps) {
  const now = deps.now ?? (() => performance.now());
  const token = new URLSearchParams(deps.location.search).get("token") ?? "";
  const q = `?token=${encodeURIComponent(token)}`;

  /** @type {WebSocket | null} */
  let ws = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let heartbeat;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retry;
  let backoff = BACKOFF_MIN_MS;
  let stopped = false;
  let haveConfig = false;

  function scheduleRetry() {
    if (stopped) return;
    clearTimeout(retry);
    retry = setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  /** @param {MessageEvent} ev */
  function onmessage(ev) {
    const data = ev.data;
    if (typeof data !== "string") {
      deps.onFrame(data);
      return;
    }
    const msg = parseHostMessage(data);
    if (msg) deps.onMessage(msg);
  }

  async function connect() {
    if (stopped) return;
    deps.onState?.("connecting");
    if (!haveConfig) {
      try {
        const res = await deps.fetch(`/config.json${q}`);
        if (!res.ok) throw new Error("config");
        const cfg = /** @type {ShellConfig} */ (await res.json());
        haveConfig = true;
        deps.onConfig?.(cfg);
      } catch {
        scheduleRetry();
        return;
      }
    }
    if (stopped) return;
    const sock = new deps.WebSocket(`ws://${deps.location.host}/ws${q}`);
    ws = sock;
    sock.binaryType = "arraybuffer";
    sock.onmessage = onmessage;
    sock.onopen = () => {
      backoff = BACKOFF_MIN_MS;
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send({ type: "heartbeat", t: now() }), HEARTBEAT_MS);
      deps.onState?.("open");
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      clearInterval(heartbeat);
      deps.onState?.("closed");
      scheduleRetry();
    };
  }

  /** @param {object} msg @returns {boolean} whether it was sent */
  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  return {
    start: connect,
    send,
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}
