// Entry point: wires the real browser APIs into the app. Served as /shell/main.js.

import { createApp } from "./app.js";
import { createConnection } from "./connection.js";

const root = document.getElementById("app");
if (!root) throw new Error("missing #app");

/** @type {ReturnType<typeof createConnection> | null} */
let conn = null;
const app = createApp({ root, send: (m) => conn?.send(m) ?? false, dpr: window.devicePixelRatio || 1 });
conn = createConnection({
  location: window.location,
  fetch: (url) => fetch(url, { cache: "no-store" }),
  WebSocket: window.WebSocket,
  onMessage: app.handle,
  onFrame: app.frame,
  onState: app.setConnection,
});
void conn.start();
