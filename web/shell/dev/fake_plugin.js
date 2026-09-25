// @ts-nocheck — dev-only mock, not shipped.
// Stand-in for the SDK + a plugin, served by mock_host.py from the plugin port. Speaks the
// shell ⇄ iframe protocol (docs/protocols.md §5) and draws the frame's bands.
const kind = document.documentElement.dataset.kind || "bars";
const canvas = document.querySelector("canvas");
const g = canvas.getContext("2d");
/** @type {MessagePort | null} */
let port = null;
let params = {};
let last = null;
let readySent = false;
let frames = 0;
let rendered = 0;
let lastPerf = performance.now();
let lastOnset = -1;
let visible = true;

window.addEventListener("message", (ev) => {
  if (port || ev.source !== window.parent || !ev.data || ev.data.type !== "tidalviz:init") return;
  port = ev.ports[0];
  params = { ...ev.data.params };
  visible = ev.data.visible;
  port.onmessage = (e) => {
    const d = e.data;
    if (d instanceof ArrayBuffer) {
      last = d;
      frames++;
      return;
    }
    if (d.type === "params") {
      Object.assign(params, d.changed);
      if (params.crash === true) {
        port.postMessage({ type: "error", message: "Crash requested", file: "fake_plugin.js", line: 42, fatal: true });
      }
    } else if (d.type === "visibility") visible = d.visible;
    else if (d.type === "dispose") port.postMessage({ type: "log", text: "disposed" });
  };
  port.postMessage({ type: "log", text: `init ${kind} quality=${ev.data.quality} maxDpr=${ev.data.maxDpr} fpsCap=${ev.data.fpsCap}` });
  requestAnimationFrame(draw);
});

function draw(now) {
  requestAnimationFrame(draw);
  if (!last || !visible) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const dv = new DataView(last);
  const flags = dv.getUint16(6, true);
  const index = dv.getUint32(8, true);
  const nb = dv.getUint16(24, true), nc = dv.getUint16(30, true);
  const scalars = new Float32Array(last, 32, nc);
  const bands = new Float32Array(last, 32 + 4 * nc, nb);
  const hue = typeof params.hue === "number" ? params.hue : 220;
  g.fillStyle = "rgba(5,5,12,0.35)";
  g.fillRect(0, 0, w, h);
  if (kind === "orbit") {
    const r = Math.min(w, h) * (0.15 + scalars[0] * 0.5);
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + now / 2000;
      const rr = r + bands[i] * r;
      g.fillStyle = `hsl(${hue + i * 2} 80% 60%)`;
      g.beginPath();
      g.arc(w / 2 + Math.cos(a) * rr, h / 2 + Math.sin(a) * rr, 4 * dpr + bands[i] * 10 * dpr, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    const bw = w / nb;
    for (let i = 0; i < nb; i++) {
      const bh = bands[i] * h * 0.8;
      g.fillStyle = `hsl(${hue + i * 1.5} 75% ${45 + bands[i] * 25}%)`;
      g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
    }
  }
  rendered++;
  if ((flags & 1) && index !== lastOnset) {
    lastOnset = index;
    port.postMessage({ type: "onsetSeen", frameIndex: index });
  }
  if (!readySent) {
    readySent = true;
    port.postMessage({ type: "ready" });
  }
  if (now - lastPerf >= 1000) {
    const fps = (rendered * 1000) / (now - lastPerf);
    port.postMessage({ type: "perf", fps, frameMsP50: 16.6, frameMsP99: 18, pluginMsP50: 0.4, renderScale: 1, dropped: 0 });
    rendered = 0;
    lastPerf = now;
  }
}
