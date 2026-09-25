// @ts-check
/**
 * Dev-only harness playing the shell's role (docs/protocols.md §5): loads one visualizer in a
 * sandboxed iframe, sends init with a MessagePort, feeds synthetic binary frames at ~94 Hz
 * (transferred), and records every SDK message in `window.__msgs` (shown on the page).
 * Query: ?viz=<id>&quality=<mode>&fpsCap=<n>
 */
import { encodeFrame } from "./encode.js";

const q = new URLSearchParams(location.search);
const viz = q.get("viz") ?? "bars";
/** @type {any[]} */
const msgs = [];
const w = /** @type {any} */ (window);
w.__msgs = msgs;

const iframe = /** @type {HTMLIFrameElement} */ (document.getElementById("viz"));
const out = /** @type {HTMLElement} */ (document.getElementById("out"));
const channel = new MessageChannel();
w.__send = (/** @type {unknown} */ m) => channel.port1.postMessage(m);

channel.port1.onmessage = (e) => {
  msgs.push(e.data);
  const last = msgs.filter((m) => m.type !== "perf").slice(-12);
  const perf = msgs.filter((m) => m.type === "perf").at(-1);
  out.textContent = `viz=${viz}\nperf: ${JSON.stringify(perf ?? null)}\n` + last.map((m) => JSON.stringify(m)).join("\n");
};

iframe.addEventListener("load", () => {
  const init = {
    type: "tidalviz:init",
    params: {},
    quality: q.get("quality") ?? "auto",
    renderScaleMax: 1,
    maxDpr: null,
    fpsCap: q.has("fpsCap") ? Number(q.get("fpsCap")) : null,
    reduceFlashing: true,
    visible: true,
  };
  /** @type {Window} */ (iframe.contentWindow).postMessage(init, "*", [channel.port2]);
  let i = 0;
  setInterval(() => {
    const t = i / 94;
    const buf = encodeFrame({
      frameIndex: i,
      hostTime: t,
      onset: i % 47 === 0,
      stereo: true,
      fill: (plane, k) =>
        plane === "bands" ? 0.5 + 0.5 * Math.sin(t * 3 + k * 0.2)
        : plane === "scalars" ? (k === 5 ? 1 + 0.5 * Math.sin(t * 2) : 0.5)
        : Math.sin(k * 0.1 + t * 20),
    });
    channel.port1.postMessage(buf, [buf]);
    i++;
  }, 1000 / 94);
});
iframe.src = `/v/dev/${viz}/`;
