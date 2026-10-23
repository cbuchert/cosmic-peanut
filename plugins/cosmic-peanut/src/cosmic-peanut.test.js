// @ts-check
/**
 * The real entry module on a recording fake WebGL2 context: checks what the GL glue sends the
 * GPU, which the pure-lib tests can't see.
 */
import { describe, expect, it } from "vitest";
import create from "./cosmic-peanut.js";
import createField from "./mobius-field.js";

// Node built-ins are loaded untyped so node's globals don't leak into the DOM-typed program.
/** @type {(specifier: string) => Promise<any>} */
const load = (specifier) => import(specifier);
const { readFile } = await load("node:fs/promises");
const { fileURLToPath } = await load("node:url");
/** @param {string} p path under the pack @returns {string} */
const pack = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** Whether the fake copies texture uploads and logs calls (off while counting the entry's own allocations). */
let recordUploads = true;

/** FNV-1a over bytes, for compact call logs. @param {Uint8Array} b */
function fnv(b) {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return h.toString(16);
}

/** One GL call argument, serialized: handles by id, arrays by content hash, floats to 7 digits. @param {any} v */
function arg(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toPrecision(7);
  if (typeof v === "string") return v.length > 40 ? `src#${fnv(new TextEncoder().encode(v))}` : v;
  if (ArrayBuffer.isView(v)) {
    return `${v.constructor.name}[${/** @type {any} */ (v).length}]#${fnv(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}`;
  }
  if (v && typeof v === "object") return v.id ?? (v.name ? `@${v.name}` : "{}");
  return String(v);
}

/** A WebGL2 stand-in that records float uniforms by name and R32F/RG32F row uploads. */
function fakeGl() {
  /** @type {Map<string, number>} */
  const uniforms = new Map();
  /** @type {{ tex: any, w: number, y: number, ch: number, data: Float32Array }[]} */
  const uploads = [];
  /** @type {any[]} */
  const units = [];
  let unit = 0;
  /** @type {any[]} textures on unit 0 at each draw */
  const drawUnit0 = [];
  /** @type {{ kind: string, instances: number }[]} every draw call */
  const draws = [];
  /** @type {any[]} every array handed to the GPU (uniform matrices, buffer uploads) */
  const sent = [];
  /** @type {string[]} every GL call, serialized (classic look: must match the pre-Look snapshot) */
  const log = [];
  let made = 0;
  /** @type {Record<string, any>} */
  const impl = {
    createShader: () => ({ src: "" }),
    shaderSource: (/** @type {any} */ s, /** @type {string} */ src) => (s.src = src),
    createProgram: () => ({ srcs: [] }),
    attachShader: (/** @type {any} */ p, /** @type {any} */ s) => p.srcs.push(s.src),
    getShaderParameter: () => true,
    getProgramParameter: (/** @type {any} */ p, /** @type {any} */ pname) =>
      pname === "ACTIVE_UNIFORMS" ? names(p).length : true,
    getActiveUniform: (/** @type {any} */ p, /** @type {number} */ i) => ({ name: names(p)[i] }),
    getUniformLocation: (/** @type {any} */ _p, /** @type {string} */ name) => ({ name }),
    uniform1f: (/** @type {any} */ loc, /** @type {number} */ v) => loc && uniforms.set(loc.name, v),
    getParameter: () => 4,
    isContextLost: () => false,
    createTexture: () => ({}),
    activeTexture: (/** @type {string} */ u) => (unit = Number(String(u).replace("TEXTURE", ""))),
    bindTexture: (/** @type {any} */ _t, /** @type {any} */ tex) => (units[unit] = tex),
    drawElements: () => {
      drawUnit0.push(units[0]);
      draws.push({ kind: "elements", instances: 1 });
    },
    drawElementsInstanced: (/** @type {any[]} */ ...a) => {
      drawUnit0.push(units[0]);
      draws.push({ kind: "instanced", instances: a[4] });
    },
    drawArrays: () => draws.push({ kind: "arrays", instances: 1 }),
    bufferSubData: (/** @type {any[]} */ ...a) => sent.push(a[2]),
    uniformMatrix4fv: (/** @type {any[]} */ ...a) => sent.push(a[2]),
    texSubImage2D: (/** @type {any[]} */ ...a) => {
      // (target, level, x, y, w, h, format, type, data)
      if (!recordUploads) return;
      const ch = a[6] === "RG" ? 2 : 1;
      if (a[4] === 512) units[unit].isHistory = true;
      uploads.push({ tex: units[unit], w: a[4], y: a[3], ch, data: Float32Array.from(a[8].subarray(0, a[4] * a[5] * ch)) });
    },
  };
  /** @param {any} p */
  function names(p) {
    const out = [];
    for (const src of p.srcs) {
      for (const m of src.matchAll(/uniform\s+(?:highp\s+)?\w+\s+([^;]+);/g)) {
        out.push(...m[1].split(",").map((/** @type {string} */ s) => s.trim().replace(/\[.*$/, "")));
      }
    }
    return out;
  }
  const gl = new Proxy(impl, {
    get(t, prop) {
      if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop) && !(prop in t)) return prop;
      const name = String(prop);
      const fn = prop in t ? t[name] : () => ({});
      return (/** @type {any[]} */ ...a) => {
        let r = fn(...a);
        if (name.startsWith("create") && r && typeof r === "object") r.id = `${name.slice(6)}#${made++}`;
        if (recordUploads) log.push(`${name}(${a.map(arg).join(", ")})`);
        return r;
      };
    },
  });
  return { gl, uniforms, uploads, drawUnit0, draws, sent, log };
}

/** @param {string} id */
async function start(id, /** @type {Record<string, unknown>} */ overrides = {}) {
  const manifest = JSON.parse(await readFile(pack("tidalviz.json"), "utf8"));
  const viz = manifest.visualizers.find((/** @type {any} */ v) => v.id === id);
  /** @type {Record<string, unknown>} */
  const params = {};
  for (const p of viz.params) params[p.id] = p.default;
  Object.assign(params, overrides);
  const fake = fakeGl();
  const ctx = /** @type {any} */ ({
    id,
    gl: fake.gl,
    params,
    size: { width: 1280, height: 720, cssWidth: 640, cssHeight: 360 },
    reduceMotion: false,
    reduceFlashing: false,
    assets: {
      text: (/** @type {string} */ p) => readFile(pack(p), "utf8"),
      json: async (/** @type {string} */ p) => JSON.parse(await readFile(pack(p), "utf8")),
    },
  });
  const viz2 = await (id === "mobius-field" ? createField : create)(ctx);
  const shaders = { mobius: "mobius.vert", "mobius-field": "field.vert", "cosmic-peanut": "rings.vert" };
  const vert = await readFile(pack(`shaders/${shaders[/** @type {keyof typeof shaders} */ (id)]}`), "utf8");
  return { viz: viz2, ...fake, vert };
}

/** 120 BPM with a kick on every beat (bass up to 3× its average), a steady 220 Hz tone. */
function audioAt(/** @type {number} */ f) {
  const t = f / 60;
  const ph = (t * 2) % 1;
  const waveform = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) waveform[i] = 0.5 * Math.sin((2 * Math.PI * 220 * (f * 800 + i)) / 48000);
  return /** @type {any} */ ({
    waveform,
    sampleRate: 48000,
    bass: 0.4 + 2.6 * Math.exp(-7 * ph),
    bpm: 120,
    beatPhase: ph,
    onset: false,
    onsetStrength: 0,
  });
}

describe.each([
  ["cosmic-peanut", {}],
  ["cosmic-peanut", { lines: "fine" }],
  ["cosmic-peanut", { antialias: false }],
  ["mobius", {}],
  ["mobius", { track: "figure-8", length: 0.5 }],
  ["mobius-field", {}],
  ["mobius-field", { lines: "fine" }],
])("%s %o in the classic look", (id, overrides) => {
  it("issues exactly the GL calls it did before the Look param existed", async () => {
    const { viz, log } = await start(id, { ...overrides, look: "classic" });
    for (let f = 0; f < 6; f++) viz.frame(audioAt(f * 20), /** @type {any} */ ({ dt: 1 / 60, t: f / 3 }));
    viz.resize?.(/** @type {any} */ ({ width: 1280, height: 720, cssWidth: 640, cssHeight: 360, dpr: 2 }));
    viz.frame(audioAt(140), /** @type {any} */ ({ dt: 1 / 60, t: 7 / 3 }));
    expect(log.join("\n")).toMatchSnapshot();
  });
});

describe.each(["mobius", "mobius-field"])("%s on the beat", (id) => {
  it("changes nothing frame-wide about the strip's size or amplitude (only the wring rolls it)", async () => {
    const { viz, uniforms, vert } = await start(id);
    // Every float uniform the vertex shader reads, except the age clock and the wring.
    const geom = [...vert.matchAll(/uniform\s+float\s+([^;]+);/g)]
      .flatMap((m) => m[1].split(",").map((/** @type {string} */ s) => s.trim()))
      .filter((n) => n !== "uFrac" && n !== "uTwist");
    expect(geom).toContain("uAmp");
    /** @type {Record<string, number[]>} */
    const seen = {};
    for (let f = 0; f < 60 * 4; f++) {
      viz.frame(audioAt(f), /** @type {any} */ ({ dt: 1 / 60, t: f / 60 }));
      if (f < 60) continue;
      for (const n of geom) (seen[n] ??= []).push(/** @type {number} */ (uniforms.get(n)));
    }
    const moving = geom.filter((n) => Math.max(...seen[n]) - Math.min(...seen[n]) > 1e-9);
    expect(moving).toEqual([]);
  });

  it("bakes each slice's size at push: beat slices are bigger, slices already laid never change", async () => {
    const { viz, uploads } = await start(id);
    const N = 240;
    /** @type {Float32Array[]} */
    const rows = []; // the per-row place/size texture after each frame
    /** History rows written while the beat at 6 s plays (their sizes are new). */
    const rewritten = new Set();
    for (let f = 0; f < 60 * 8; f++) {
      uploads.length = 0;
      viz.frame(audioAt(f), /** @type {any} */ ({ dt: 1 / 60, t: f / 60 }));
      const pos = uploads.filter((u) => u.w === N).at(-1);
      rows.push(pos ? pos.data : rows[rows.length - 1]);
      if (f >= 60 * 6 - 1 && f <= 60 * 6 + 10) for (const u of uploads) if (u.w === 512) rewritten.add(u.y);
    }
    const last = rows[rows.length - 1];
    expect(last.length).toBe(N * 2); // RG: place (the field's bands don't read it), size
    // Rows laid before the beat at 6 s keep both values through it.
    const before = rows[60 * 6 - 2];
    let kept = 0;
    for (let r = 0; r < N; r++) {
      const after = rows[60 * 6 + 10];
      if (before[r * 2 + 1] === 0) continue; // not written yet
      if (rewritten.has(r)) continue; // overwritten by a newer slice
      expect(after[r * 2]).toBe(before[r * 2]);
      expect(after[r * 2 + 1]).toBe(before[r * 2 + 1]);
      kept++;
    }
    expect(kept).toBeGreaterThan(200);
    let lo = Infinity;
    let hi = 0;
    for (let r = 0; r < N; r++) {
      lo = Math.min(lo, last[r * 2 + 1]);
      hi = Math.max(hi, last[r * 2 + 1]);
    }
    expect(lo).toBeGreaterThanOrEqual(1 - 1e-6); // between beats: as drawn without the beat
    expect(hi).toBeGreaterThan(1.05); // on the beat: breath (and the bass swell) baked in
  });

  it("always draws with the waveform history on unit 0 (uHist), pushes or not", async () => {
    const { viz, drawUnit0 } = await start(id);
    for (let f = 0; f < 120; f++) viz.frame(audioAt(f), /** @type {any} */ ({ dt: 1 / 60, t: f / 60 }));
    expect(drawUnit0.length).toBe(120);
    expect(drawUnit0.filter((t) => !t?.isHistory).length).toBe(0);
  });
});

/** Count typed arrays made while `fn` runs (constructors and the prototype methods that copy). */
function typedArraysMade(/** @type {() => void} */ fn) {
  const g = /** @type {any} */ (globalThis);
  const kinds = ["Float32Array", "Float64Array", "Int32Array", "Uint32Array", "Uint16Array", "Uint8Array"];
  const saved = kinds.map((k) => g[k]);
  const proto = Object.getPrototypeOf(Float32Array.prototype);
  const methods = ["subarray", "slice", "map", "filter"];
  const savedMethods = methods.map((m) => proto[m]);
  let made = 0;
  kinds.forEach((k, i) => {
    g[k] = class extends saved[i] {
      constructor(/** @type {any[]} */ ...a) {
        super(...a);
        made++;
      }
    };
  });
  methods.forEach((m, i) => {
    proto[m] = function (/** @type {any[]} */ ...a) {
      made++;
      return savedMethods[i].apply(this, a);
    };
  });
  try {
    fn();
  } finally {
    kinds.forEach((k, i) => (g[k] = saved[i]));
    methods.forEach((m, i) => (proto[m] = savedMethods[i]));
  }
  return made;
}

describe("Möbius Field", () => {
  const time = (/** @type {number} */ f) => /** @type {any} */ ({ dt: 1 / 60, t: f / 60 });

  it("draws every band in one instanced call per frame, with the history on unit 0", async () => {
    const { viz, draws, drawUnit0 } = await start("mobius-field");
    for (let f = 0; f < 120; f++) {
      draws.length = 0;
      viz.frame(audioAt(f), time(f));
      const bands = draws.filter((d) => d.kind !== "arrays"); // the soft-lines blit is drawArrays
      expect(bands.length).toBe(1);
      expect(bands[0].kind).toBe("instanced");
      expect(bands[0].instances).toBeGreaterThan(5);
    }
    expect(drawUnit0.length).toBe(120);
    expect(drawUnit0.filter((t) => !t?.isHistory).length).toBe(0);
  });

  it("allocates nothing per frame: no typed arrays, and the same arrays go to the GPU every frame", async () => {
    const { viz, sent } = await start("mobius-field");
    for (let f = 0; f < 60; f++) viz.frame(audioAt(f), time(f)); // warm up
    sent.length = 0;
    const audio = Array.from({ length: 60 * 6 }, (_, f) => audioAt(f));
    recordUploads = false;
    const made = typedArraysMade(() => {
      for (let f = 60; f < 60 * 6; f++) viz.frame(audio[f], time(f)); // beats, pushes, wraps
    });
    recordUploads = true;
    expect(made).toBe(0);
    expect(sent.length).toBe(60 * 5 * 3); // per frame: two matrices and one instance upload
    expect(new Set(sent).size).toBe(3);
  });
});

