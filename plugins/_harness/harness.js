// @ts-check
/**
 * Throwaway fake SDK (not shipped). Loads one visualizer from a local repo folder, feeds it
 * synthetic audio on rAF, and publishes timing stats on `window.__stats()`.
 *
 * Query: ?repo=builtin&viz=bars[&rep=N][&reduce=0|1][&motion=reduce][&audio=proto][&strobe=1]
 *        [&finish=1][&lum=1][&p.<id>=v]
 *   audio=proto  the Cosmic Peanut prototype's demo signal instead of the synth
 *   audio=drums  a separable kick / snare / hat pattern (synth.js createDrums)
 *   audio=music  drone + pad chords + melody + drums with a real-looking spectrum (createMusic)
 *   audio=tones  sustained sine tones, loud/quiet pairs, on from 1 s (synth.js createTones)
 *   audio=melody a bass note per bar under a plucked arpeggio with harmonics (synth.js createMelody)
 *   finish=1  gl.finish() inside the timed region, so the number includes GPU work
 *   sync=1    a 1-pixel gl.readPixels after each frame inside the timed region: WebKit's finish()
 *             returns without waiting, a readback can't, so this is the one that includes GPU time
 *   lum=1     record mean frame luminance (for the flash-limiter check)
 *   bg=light  a bright, busy backdrop behind the transparent canvas (default black, like the shell)
 *   nocanvas=1  hide the canvas (screenshot the backdrop alone)
 *   silent=1  the synth outputs silence (all-zero frames, silent: true)
 *   still=N   deterministic: seeded Math.random, fixed 1/60 s steps, stop after N frames
 *   gain=G    scale the audio's level (waveform, rms, peak, spectrum, bands) by G, e.g. 0.05 for a
 *             quiet passage
 *   level=L   like gain, but also scales bass/mid/treb (+Att), onsetStrength and flux; level=0 is
 *             the host's silence (all zero, no onsets, silent: true)
 *   bgm=R     background-motion probe (use with still=N): per frame, mean |Δ luminance| over a
 *             320×180 copy of the canvas outside a circle of radius R (screen units, half the
 *             short side = 1) round the centre, plus per-pixel black/white alternation counts;
 *             published as __stats().bgm (see run.py --motion)
 */
import { createDrums, createMelody, createMusic, createProtoDemo, createSynth, createTones } from "./synth.js";

const q = new URLSearchParams(location.search);
const repo = q.get("repo") ?? "builtin";
const vizId = q.get("viz") ?? "bars";
const finish = q.get("finish") === "1";
const sync = q.get("sync") === "1";
const px = new Uint8Array(4);
const measureLum = q.get("lum") === "1";
// WebKit coarsens performance.now() to 1 ms; rep=N runs frame() N times per rAF and divides.
const rep = Number(q.get("rep") ?? 1);
const base = `/plugins/${repo}/`;
const w = /** @type {any} */ (window);
const still = Number(q.get("still") ?? 0);
const gain = Number(q.get("gain") ?? 1);
const level = q.get("level") === null ? null : Number(q.get("level"));
const bgmRadius = q.get("bgm") === null ? null : Number(q.get("bgm"));

/** Scale a frame's level in place (the synth rebuilds it every update). @param {any} a @param {number} g */
function applyGain(a, g) {
  for (const k of ["waveform", "spectrum", "bands", "left", "right"]) if (a[k]) for (let i = 0; i < a[k].length; i++) a[k][i] *= g;
  a.rms *= g;
  a.peak *= g;
}

/** Scalar fields `level` scales on top of the arrays. */
const LEVEL_SCALARS = ["rms", "peak", "bass", "mid", "treb", "bassAtt", "midAtt", "trebAtt", "onsetStrength", "flux"];
/** @type {any} */
const levelled = {};
/** A copy of the frame at `level` (scalars copied each frame, so the synth's state is untouched). @param {any} a @param {number} g */
function applyLevel(a, g) {
  Object.assign(levelled, a);
  for (const k of ["waveform", "spectrum", "bands", "left", "right"]) if (a[k]) for (let i = 0; i < a[k].length; i++) a[k][i] *= g;
  for (const k of LEVEL_SCALARS) levelled[k] = (a[k] ?? 0) * g;
  if (g === 0) {
    levelled.onset = false;
    levelled.silent = true;
  }
  return levelled;
}

/**
 * Background-motion probe: frame-to-frame luminance change and per-pixel black/white alternation
 * outside the centre circle (the foreground object), at a fixed 320×180.
 * @param {number} radius screen units (half the canvas's short side = 1)
 */
function createMotionProbe(radius) {
  const W = 320, H = 180, WIN = 60; // WIN: frames in a 1 s window (still mode steps 1/60 s)
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d", { willReadFrequently: true }));
  const n = W * H;
  const mask = new Uint8Array(n);
  let area = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = ((x + 0.5) / W * 2 - 1) * (W / H), sy = (y + 0.5) / H * 2 - 1;
    if (Math.hypot(sx, sy) > radius) { mask[y * W + x] = 1; area++; }
  }
  const prev = new Float32Array(n);
  const state = new Int8Array(n); // −1 black, 1 white, 0 unknown
  const ring = new Uint8Array(n * WIN); // flips per pixel per frame, last WIN frames
  const inWin = new Uint16Array(n);
  const maxWin = new Uint16Array(n);
  const total = new Uint32Array(n);
  /** @type {number[]} */ const motion = [];
  /** @type {number[]} */ const onsets = [];
  let frame = 0;
  return {
    /** @param {HTMLCanvasElement} canvas @param {any} audio */
    sample(canvas, audio, measure = true) {
      g.clearRect(0, 0, W, H);
      g.drawImage(canvas, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      let sum = 0;
      const slot = (frame % WIN) * n;
      for (let i = 0; i < n; i++) {
        const l = (0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2]) / 255;
        if (mask[i] && frame > 0) sum += Math.abs(l - prev[i]);
        prev[i] = l;
        const s = l > 0.65 ? 1 : l < 0.35 ? -1 : state[i];
        const flip = measure && mask[i] && state[i] !== 0 && s !== state[i] ? 1 : 0;
        state[i] = s;
        inWin[i] += flip - ring[slot + i];
        ring[slot + i] = flip;
        if (inWin[i] > maxWin[i]) maxWin[i] = inWin[i];
        total[i] += flip;
      }
      if (measure) {
        motion.push(frame > 0 ? sum / area : 0);
        onsets.push(audio.onset ? audio.onsetStrength : 0);
      }
      frame++;
    },
    /** @param {number} seconds measured span */
    stats(seconds) {
      const maxs = [], rates = [];
      for (let i = 0; i < n; i++) if (mask[i]) { maxs.push(maxWin[i]); rates.push(total[i] / seconds); }
      const p = (/** @type {number[]} */ a, /** @type {number} */ q) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];
      // Where the worst pixels are (probe x, y; screen units from the centre), for debugging.
      const worst = [];
      for (let i = 0; i < n; i++) if (mask[i]) worst.push([maxWin[i], i]);
      worst.sort((a, b) => b[0] - a[0]);
      const at = worst.slice(0, 5).map(([m, i]) => [m / 2, +((((i % W) + 0.5) / W * 2 - 1) * (W / H)).toFixed(2), +(1 - ((Math.floor(i / W) + 0.5) / H) * 2).toFixed(2)]);
      // An alternation (Hz) is a black→white→black cycle: two flips.
      return {
        motion, onsets,
        altHzP95: p(maxs, 0.95) / 2, altHzP99: p(maxs, 0.99) / 2, altHzMax: Math.max(...maxs) / 2, altMaxAt: at,
        meanFlipRateP95: p(rates, 0.95),
      };
    },
  };
}

const bgEl = /** @type {HTMLElement} */ (document.getElementById("bg"));
if (q.get("bg") === "light") {
  bgEl.className = "light";
  const words = "Finder Mail Notes Terminal Safari Music Photos Calendar Xcode Preview".split(" ");
  const hues = ["#e63946", "#2a9d8f", "#457b9d", "#f4a261", "#1d3557", "#ffffff"];
  for (let i = 0; i < 60; i++) {
    const el = document.createElement("span");
    el.textContent = words[i % words.length];
    bgEl.append(el);
    if (i % 5 === 4) {
      const box = document.createElement("span");
      box.className = "box";
      box.style.background = hues[(i / 5) % hues.length | 0];
      bgEl.append(box);
    }
  }
}
if (q.get("nocanvas") === "1") /** @type {HTMLElement} */ (document.getElementById("c")).style.display = "none";
if (still) {
  // mulberry32: same stars, same hats, every run.
  let seed = 1;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @type {string[]} */
const errors = [];
w.__errors = errors;
addEventListener("error", (e) => errors.push(String(e.message)));
addEventListener("unhandledrejection", (e) => errors.push(String(e.reason?.stack ?? e.reason)));

async function main() {
  const manifest = await (await fetch(base + "tidalviz.json")).json();
  const entry = manifest.visualizers.find((/** @type {any} */ v) => v.id === vizId);
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("c"));
  const dpr = devicePixelRatio;
  const size = { width: 0, height: 0, cssWidth: 0, cssHeight: 0, dpr };
  const setSize = (/** @type {number} */ cw, /** @type {number} */ ch) => {
    Object.assign(size, { cssWidth: cw, cssHeight: ch, width: Math.round(cw * dpr), height: Math.round(ch * dpr) });
    canvas.width = size.width;
    canvas.height = size.height;
  };
  setSize(innerWidth, innerHeight);

  /** @type {Record<string, any>} */
  const params = {};
  for (const p of entry.params ?? []) params[p.id] = p.default;
  for (const [k, v] of q) {
    if (!k.startsWith("p.")) continue;
    const id = k.slice(2);
    params[id] = typeof params[id] === "number" ? Number(v) : typeof params[id] === "boolean" ? v === "true" : v;
  }

  /** @type {any} */
  const ctx = {
    apiVersion: 1, id: entry.id, name: entry.name, renderer: entry.renderer, canvas,
    ctx2d: null, gl: null, gpu: null, three: null,
    params, size, renderScale: 1, quality: "high",
    reduceFlashing: q.get("reduce") !== "0",
    reduceMotion: q.get("motion") === "reduce",
    log: (/** @type {unknown[]} */ ...a) => console.log("[plugin]", ...a),
    assets: {
      url: (/** @type {string} */ p) => new URL(p, location.origin + base).href,
      text: async (/** @type {string} */ p) => (await fetch(base + p)).text(),
      json: async (/** @type {string} */ p) => (await fetch(base + p)).json(),
      arrayBuffer: async (/** @type {string} */ p) => (await fetch(base + p)).arrayBuffer(),
      image: async (/** @type {string} */ p) => createImageBitmap(await (await fetch(base + p)).blob()),
    },
  };
  // Same context options as web/sdk/renderer.js: transparent, premultiplied canvases.
  const glOpts = { powerPreference: /** @type {const} */ ("high-performance"), antialias: false, preserveDrawingBuffer: false, alpha: true, premultipliedAlpha: true };
  /** @type {WebGL2RenderingContext | null} */
  let gl = null;
  if (entry.renderer === "2d") ctx.ctx2d = canvas.getContext("2d", { alpha: true });
  if (entry.renderer === "webgl2") gl = ctx.gl = /** @type {WebGL2RenderingContext} */ (canvas.getContext("webgl2", glOpts));
  if (entry.renderer === "three") {
    const THREE = await import("three");
    const renderer = new THREE.WebGLRenderer({ canvas, ...glOpts });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(dpr);
    renderer.setSize(size.cssWidth, size.cssHeight, false);
    const camera = new THREE.PerspectiveCamera(60, size.width / size.height, 0.1, 1000);
    camera.position.z = 5;
    ctx.three = { THREE, renderer, scene: new THREE.Scene(), camera, autoRender: true };
    gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());
  }
  w.__ctx = ctx;

  const mod = await import(base + entry.entry);
  const viz = await mod.default(ctx);
  w.__viz = viz; // for synchronous GPU benchmarks (readPixels after N frames)

  w.__resize = (/** @type {number} */ cw, /** @type {number} */ ch) => {
    setSize(cw, ch);
    if (ctx.three) {
      ctx.three.renderer.setSize(cw, ch, false);
      if (ctx.three.camera.isPerspectiveCamera) {
        ctx.three.camera.aspect = cw / ch;
        ctx.three.camera.updateProjectionMatrix();
      }
    }
    viz.resize?.(size);
  };
  w.__setParam = (/** @type {string} */ id, /** @type {any} */ v) => {
    params[id] = v;
    viz.params?.({ [id]: v });
  };
  w.__dispose = () => {
    running = false;
    viz.dispose?.();
  };

  const audioMode = q.get("audio");
  const synth =
    audioMode === "proto" ? createProtoDemo()
    : audioMode === "drums" ? createDrums()
    : audioMode === "music" ? createMusic()
    : audioMode === "tones" ? createTones()
    : audioMode === "melody" ? createMelody()
    : createSynth({ strobe: q.get("strobe") === "1", silent: q.get("silent") === "1" });

  // Drags on the canvas go to the plugin's pointer hook (one reused event object).
  const pe = { kind: /** @type {"down" | "move" | "up"} */ ("move"), x: 0, y: 0, dx: 0, dy: 0 };
  let dragging = false;
  let lx = 0;
  let ly = 0;
  /** @param {PointerEvent} e @param {"down" | "move" | "up"} kind */
  const forward = (e, kind) => {
    pe.kind = kind;
    pe.x = e.offsetX;
    pe.y = e.offsetY;
    pe.dx = kind === "down" ? 0 : e.clientX - lx;
    pe.dy = kind === "down" ? 0 : e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
    viz.pointer?.(pe);
  };
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    forward(e, "down");
  });
  canvas.addEventListener("pointermove", (e) => dragging && forward(e, "move"));
  canvas.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    forward(e, "up");
  });
  /** @type {number[]} */ const times = [];
  /** @type {number[]} */ const intervals = [];
  /** @type {number[]} */ const lum = [];
  const probe = document.createElement("canvas");
  probe.width = 32;
  probe.height = 18;
  const pg = /** @type {CanvasRenderingContext2D} */ (probe.getContext("2d", { willReadFrequently: true }));
  const time = { now: 0, dt: 0, frame: 0 };
  const probe2 = bgmRadius !== null ? createMotionProbe(bgmRadius) : null;
  const BGM_WARMUP = 60; // frames before the probe starts measuring
  let running = true;
  let last = performance.now();
  const start = last;
  let frames = 0;

  /** @param {number} ts */
  function tick(ts) {
    if (!running) return;
    if (still) ts = start + (frames * 1000) / 60;
    const dt = Math.min(0.1, (ts - last) / 1000);
    if (frames > 0) intervals.push(ts - last);
    last = ts;
    time.now = (ts - start) / 1000;
    time.dt = frames === 0 ? 1 / 60 : dt;
    time.frame = frames++;
    let audio = synth.update(time.now, time.dt);
    if (gain !== 1) applyGain(audio, gain);
    if (level !== null) audio = applyLevel(audio, level);
    const t0 = performance.now();
    try {
      for (let r = 0; r < rep; r++) {
        viz.frame(audio, time);
        if (ctx.three?.autoRender) ctx.three.renderer.render(ctx.three.scene, ctx.three.camera);
        if (finish && gl) gl.finish();
        if (sync && gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
    } catch (e) {
      errors.push(String(/** @type {any} */ (e)?.stack ?? e));
    }
    times.push((performance.now() - t0) / rep);
    if (measureLum) {
      pg.drawImage(canvas, 0, 0, probe.width, probe.height);
      const d = pg.getImageData(0, 0, probe.width, probe.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum.push(s / (d.length / 4) / 255);
    }
    if (probe2) probe2.sample(canvas, audio, frames > BGM_WARMUP);
    if (still && frames >= still) {
      w.__still = true;
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  w.__reset = () => {
    times.length = 0;
    intervals.length = 0;
    lum.length = 0;
  };
  w.__stats = () => {
    const pct = (/** @type {number[]} */ a, /** @type {number} */ p) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    };
    return {
      frames: times.length,
      p50: pct(times, 0.5),
      p99: pct(times, 0.99),
      max: Math.max(...times),
      fps: 1000 / pct(intervals, 0.5),
      intervalP99: pct(intervals, 0.99),
      size: [size.width, size.height],
      lum,
      bgm: probe2 ? probe2.stats((frames - BGM_WARMUP) / 60) : null,
      errors,
    };
  };
  w.__ready = true;
}

main().catch((e) => {
  errors.push(String(e?.stack ?? e));
  w.__ready = true;
});
