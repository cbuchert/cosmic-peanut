// Spike shell: WS -> MessagePort (transfer) -> sandboxed cross-origin iframe.
const now = () => performance.timeOrigin + performance.now();
const hud = document.getElementById("hud");
const cfg = await (await fetch("/config.json")).json();

const shell = {
  wsRecv: [],      // [idx, absMs] per frame
  fwdCost: [],     // ms per frame (performance.now granularity!)
  handlerCost: [], // ms, whole onmessage handler
  raf: [],         // shell rAF timestamps (abs ms)
  vis: [],         // visibility events
  clock: null,     // {offset, rtt}  python_ms = shell_ms + offset
  ifClock: null,   // {offset, rtt}  shell_ms = iframe_ms + offset
  probe: [],       // messages from probe.js (CSP violations etc.)
  info: {},
  bench: null,
};
let frames = 0, ifMsgs = 0, rafCount = 0, port = null, iframeReady = false;

shell.info = {
  ua: navigator.userAgent,
  dpr: devicePixelRatio,
  inner: [innerWidth, innerHeight],
  screen: [screen.width, screen.height],
  timeOrigin: performance.timeOrigin,
  dateVsPerf: Date.now() - now(),
  crossOriginIsolated: self.crossOriginIsolated,
  hasPywebview: typeof window.pywebview,
};
// Measure performance.now() granularity.
{
  const seen = new Set(); let last = performance.now(); const end = last + 50;
  while (last < end) { const t = performance.now(); if (t !== last) { seen.add(+(t - last).toFixed(4)); last = t; } }
  shell.info.perfNowStepsMs = [...seen].sort((a, b) => a - b).slice(0, 5);
}

document.addEventListener("visibilitychange", () => shell.vis.push([now(), document.visibilityState, document.hidden]));
shell.vis.push([now(), document.visibilityState, document.hidden]);
(function loop(ts) { rafCount++; if (shell.raf.length < 20000) shell.raf.push(performance.timeOrigin + ts); requestAnimationFrame(loop); })(0);

// Micro-benchmark: cost of transferring 10,592-byte buffers over a MessagePort (main-thread side).
{
  const ch = new MessageChannel(); let got = 0; ch.port2.onmessage = () => got++;
  const N = 2000; const bufs = Array.from({ length: N }, () => new ArrayBuffer(10592));
  const t0 = performance.now();
  for (const b of bufs) ch.port1.postMessage(b, [b]);
  const t1 = performance.now();
  const copies = Array.from({ length: N }, () => new ArrayBuffer(10592));
  const t2 = performance.now();
  for (const b of copies) ch.port1.postMessage(b);
  const t3 = performance.now();
  shell.bench = { n: N, transferUsPerMsg: (t1 - t0) * 1000 / N, copyUsPerMsg: (t3 - t2) * 1000 / N };
  ch.port1.close(); ch.port2.close();
}

const ws = new WebSocket(`ws://${location.host}/ws`);
ws.binaryType = "arraybuffer";
const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function pingPython(n) {
  const samples = [];
  return new Promise((res) => {
    const onPong = (m) => {
      const t1 = now();
      samples.push({ offset: m.ts - (m.t0 + t1) / 2, rtt: t1 - m.t0 });
      if (samples.length >= n) { pongHandler = null; samples.sort((a, b) => a.rtt - b.rtt); res({ best: samples[0], all: samples }); }
      else setTimeout(() => send({ type: "ping", t0: now() }), 10);
    };
    pongHandler = onPong;
    send({ type: "ping", t0: now() });
  });
}
let pongHandler = null;

function pingIframe(n) {
  const samples = [];
  return new Promise((res) => {
    ifPong = (m) => {
      const t1 = now();
      samples.push({ offset: m.ts - (m.t0 + t1) / 2, rtt: t1 - m.t0 });
      // m.ts is iframe clock; shell = iframe - offset  => store as shell_ms = iframe_ms + (-offset)
      if (samples.length >= n) { ifPong = null; samples.sort((a, b) => a.rtt - b.rtt); res(samples[0]); }
      else setTimeout(() => port.postMessage({ type: "ping", t0: now() }), 10);
    };
    port.postMessage({ type: "ping", t0: now() });
  });
}
let ifPong = null;

ws.onmessage = (e) => {
  if (typeof e.data === "string") {
    const m = JSON.parse(e.data);
    if (m.type === "pong" && pongHandler) pongHandler(m);
    else if (m.type === "dump") dump();
    return;
  }
  const h0 = performance.now();
  const recv = now();
  frames++;
  const idx = new DataView(e.data).getUint32(8, true);
  if (port && iframeReady) {
    const f0 = performance.now();
    port.postMessage(e.data, [e.data]);
    shell.fwdCost.push(performance.now() - f0);
  }
  if (shell.wsRecv.length < 200000) shell.wsRecv.push([idx, recv]);
  shell.handlerCost.push(performance.now() - h0);
};

ws.onopen = async () => {
  const c = await pingPython(30);
  shell.clock = c.best;
  send({ type: "info", info: shell.info, bench: shell.bench, clock: c.best });
  mountIframe(cfg.pluginUrl);
  if (cfg.probeStrict) mountProbe(cfg.strictUrl);
};

// Heartbeat every 500 ms (the PRD's hang-detection signal).
setInterval(() => send({ type: "heartbeat", t: now(), rafCount, frames, ifMsgs, vis: document.visibilityState }), 500);
setInterval(() => { hud.textContent = `ws frames ${frames}  if msgs ${ifMsgs}  shell rAF ${rafCount}  dpr ${devicePixelRatio} ${innerWidth}x${innerHeight}`; }, 250);

// Messages that the plugin page posts to window.parent (probe.js: CSP violations, boot status).
addEventListener("message", (e) => {
  if (e.data && typeof e.data === "object" && e.data.probe) {
    shell.probe.push({ at: now(), origin: e.origin, ...e.data });
    send({ type: "probe", origin: e.origin, data: e.data });
  }
});

function mountIframe(url) {
  const f = document.createElement("iframe");
  if (cfg.sandbox !== "none") f.setAttribute("sandbox", cfg.sandbox);
  f.src = url;
  f.addEventListener("load", async () => {
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (e) => {
      ifMsgs++;
      const m = e.data;
      if (m.type === "pong" && ifPong) ifPong(m);
      else if (m.type === "ready") onReady(m);
      else if (m.type === "results") finish(m);
      else send({ type: "iframe:" + m.type, data: m });
    };
    f.contentWindow.postMessage({ type: "tidalviz:init" }, "*", [ch.port2]);
  });
  document.body.appendChild(f);
}

// A second tiny iframe with the exact §3 CSP (no hashes) to see what it blocks.
function mountProbe(url) {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:64px;height:64px;inset:auto 0 0 auto;opacity:.5";
  f.src = url + "&probeOnly=1";
  document.body.appendChild(f);
}

async function onReady(m) {
  send({ type: "iframe:ready", data: m });
  const c = await pingIframe(30);
  shell.ifClock = { offset: -c.offset, rtt: c.rtt };
  iframeReady = true;
  send({ type: "start" });
}

let finished = false;
function dump() {
  if (port) port.postMessage({ type: "dump" });
  setTimeout(() => finish({ timeout: true }), 1500); // iframe may be hung
}

function finish(iframeResults) {
  if (finished) return; finished = true;
  send({ type: "results", shell, iframe: iframeResults });
}
