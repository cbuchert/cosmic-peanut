// @ts-check
// Metamorphosis end to end on a recording fake WebGL2: which programs draw, with which uniforms,
// and which textures sit on which units at every draw. The shaders themselves are checked in the
// harness (stills, flash, timing); this pins the wiring: creatures carved in relief, and the relief
// height, the atlas and the print target never sharing a unit or sampling the target being drawn.
import { describe, expect, it } from "vitest";
import { atlasBlockMax, hintMax } from "./lib/atlas.js";
import { parseSpecies } from "./lib/bestiary.js";
import { RELIEF_BLOCK } from "./lib/tess.js";
import { ATLAS_ART_UNIT, ATLAS_FIELD_UNIT, HEIGHT_UNIT } from "./lib/tess-gl.js";
import create from "./metamorphosis.js";

/** @param {string} s */
const nodeImport = (s) => import(s);
const { readFileSync } = await nodeImport("node:fs");
const ROOT = new URL("../", import.meta.url); // plugins/builtin/
const read = (/** @type {string} */ p) => readFileSync(new URL(p, ROOT), "utf8");

const SAMPLER_2D = 0x8b5e;

/**
 * A WebGL2 stand-in that records state: programs (with their fragment source), sampler uniforms'
 * units, the texture bound on every unit, the framebuffer's attachments, and a snapshot per draw.
 */
function fakeGL() {
  let ids = 0;
  const obj = (/** @type {string} */ kind, extra = {}) => ({ kind, id: ++ids, ...extra });
  /** @type {Map<number, any>} unit → texture */
  const units = new Map();
  let active = 0;
  /** @type {any} */
  let program = null;
  /** @type {any} */
  let fbo = null;
  /** @type {any[]} */
  const draws = [];
  const C = {
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    COLOR_ATTACHMENT1: 0x8ce1,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
  };
  /** @type {Record<string, any>} */
  const impl = {
    getExtension: () => ({}),
    isContextLost: () => false,
    createTexture: () => obj("texture"),
    createFramebuffer: () => obj("fbo", { attach: new Map() }),
    createVertexArray: () => obj("vao"),
    createShader: (/** @type {number} */ type) => obj("shader", { type, src: "" }),
    shaderSource: (/** @type {any} */ s, /** @type {string} */ src) => (s.src = src),
    getShaderParameter: () => true,
    createProgram: () => obj("program", { shaders: [], uniforms: [], values: new Map() }),
    attachShader: (/** @type {any} */ p, /** @type {any} */ s) => p.shaders.push(s),
    linkProgram(/** @type {any} */ p) {
      const fs = p.shaders.find((/** @type {any} */ s) => s.type === C.FRAGMENT_SHADER);
      p.fs = fs.src;
      // Active uniforms, as a compiler sees them: declared in the preprocessed source and used.
      const src = preprocess(fs.src);
      for (const m of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(\[[^\]]+\])?\s*;/gm)) {
        if ((src.match(new RegExp(`\\b${m[1]}\\b`, "g")) ?? []).length < 2) continue;
        const type = /^\s*uniform\s+sampler2D/.test(m[0]) ? SAMPLER_2D : 0;
        p.uniforms.push({ name: m[1] + (m[2] ? "[0]" : ""), type });
      }
    },
    getProgramParameter: (/** @type {any} */ p, /** @type {number} */ k) => (k === C.ACTIVE_UNIFORMS ? p.uniforms.length : true),
    getActiveUniform: (/** @type {any} */ p, /** @type {number} */ i) => p.uniforms[i],
    getUniformLocation: (/** @type {any} */ p, /** @type {string} */ name) => ({ p, name: name.replace(/\[0\]$/, "") }),
    useProgram: (/** @type {any} */ p) => (program = p),
    activeTexture: (/** @type {number} */ t) => (active = t - C.TEXTURE0),
    bindTexture: (/** @type {number} */ _, /** @type {any} */ t) => units.set(active, t),
    bindFramebuffer: (/** @type {number} */ _, /** @type {any} */ f) => (fbo = f),
    framebufferTexture2D: (/** @type {number} */ _, /** @type {number} */ at, /** @type {number} */ __, /** @type {any} */ t) => fbo.attach.set(at, t),
    drawArrays() {
      /** @type {Record<string, any>} */
      const samplers = {};
      for (const u of program.uniforms) {
        if (u.type !== SAMPLER_2D) continue;
        const unit = program.values.get(u.name) ?? 0;
        samplers[u.name] = { unit, tex: units.get(unit) ?? null };
      }
      draws.push({ program, fbo, targets: fbo ? [...fbo.attach.values()] : [], samplers, values: new Map(program.values) });
    },
  };
  for (const f of ["uniform1i", "uniform1f", "uniform2f", "uniform3f", "uniform4f", "uniform2i", "uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv", "uniform4iv", "uniformMatrix2fv"]) {
    impl[f] = (/** @type {any} */ loc, /** @type {any[]} */ ...v) => {
      if (loc) loc.p.values.set(loc.name, f.startsWith("uniformMatrix") ? v[1] : v.length === 1 ? (ArrayBuffer.isView(v[0]) ? Array.from(/** @type {ArrayLike<number>} */ (/** @type {unknown} */ (v[0]))) : v[0]) : v);
    };
  }
  const gl = new Proxy(impl, {
    get(t, k) {
      if (typeof k !== "string") return undefined;
      if (k in C) return /** @type {any} */ (C)[k];
      if (k in t) return t[k];
      if (/^[A-Z0-9_]+$/.test(k)) return 0x1000 + k.length; // any other enum
      return () => {};
    },
  });
  return { gl, draws };
}

/** The lines a GLSL preprocessor keeps (#define, #ifdef/#ifndef, #if/#elif defined(…), #else). @param {string} src */
function preprocess(src) {
  const defs = new Set();
  /** @type {{ on: boolean, taken: boolean }[]} */
  const stack = [];
  const on = () => stack.every((f) => f.on);
  const test = (/** @type {string} */ c) => {
    const m = c.match(/^(!?)\s*defined\s*\(?\s*(\w+)\s*\)?$/);
    return m ? defs.has(m[2]) !== (m[1] === "!") : false;
  };
  /** @type {string[]} */
  const out = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^#ifdef\s+(\w+)/))) stack.push({ on: defs.has(m[1]), taken: defs.has(m[1]) });
    else if ((m = t.match(/^#ifndef\s+(\w+)/))) stack.push({ on: !defs.has(m[1]), taken: !defs.has(m[1]) });
    else if ((m = t.match(/^#if\s+(.*)$/))) stack.push({ on: test(m[1].trim()), taken: test(m[1].trim()) });
    else if ((m = t.match(/^#elif\s+(.*)$/))) {
      const f = stack[stack.length - 1];
      f.on = !f.taken && test(m[1].trim());
      f.taken ||= f.on;
    } else if (t.startsWith("#else")) {
      const f = stack[stack.length - 1];
      f.on = !f.taken;
      f.taken = true;
    } else if (t.startsWith("#endif")) stack.pop();
    else if (on()) {
      if ((m = t.match(/^#define\s+(\w+)/))) defs.add(m[1]);
      out.push(line);
    }
  }
  return out.join("\n");
}

/** @param {Record<string, unknown>} params */
async function setup(params) {
  const { gl, draws } = fakeGL();
  const ctx = /** @type {import('../tidalviz').VisualizerContext} */ (
    /** @type {unknown} */ ({
      gl,
      params: { symmetry: "p4", palette: "four-block", reactivity: 1, speed: 1, morph: 0.7, ink: 1, hatching: 0.6, relief: 0.6, light: 135, creatures: "abstract", quality: "high", ...params },
      size: { width: 2560, height: 1440, cssWidth: 1280, cssHeight: 720, dpr: 2 },
      reduceMotion: false,
      reduceFlashing: false,
      log: () => {},
      assets: { text: async (/** @type {string} */ p) => read(p), json: async (/** @type {string} */ p) => JSON.parse(read(p)) },
    })
  );
  const viz = /** @type {import('../tidalviz').Visualizer} */ (await create(ctx));
  const audio = /** @type {any} */ ({ bands: new Float32Array(64).fill(0.3), bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0, centroid: 0.15, bassAtt: 1, silent: false });
  const run = (/** @type {number} */ n) => {
    for (let f = 0; f < n; f++) {
      audio.beatPhase = (f / 30) % 1;
      audio.onset = f % 30 === 0;
      audio.onsetStrength = audio.onset ? 0.9 : 0;
      viz.frame(audio, /** @type {any} */ ({ now: f / 60, dt: 1 / 60, frame: f }));
    }
  };
  return { viz, draws, run };
}

const isRelief = (/** @type {any} */ d) => d.program.fs.includes("#define TESS_RELIEF") && !d.program.fs.includes("#define TESS_HEIGHT_PASS");
const isHeight = (/** @type {any} */ d) => d.program.fs.includes("#define TESS_HEIGHT_PASS");

describe("Metamorphosis: creatures in relief", () => {
  it("carves the bestiary's animals: Relief is no longer forced to 0 while they show", async () => {
    const { draws, run } = await setup({ creatures: "fish/koi" });
    run(30);
    const relief = draws.filter(isRelief);
    expect(relief.length).toBeGreaterThan(0);
    expect(draws.filter(isHeight).length).toBe(relief.length);
    const last = relief[relief.length - 1];
    expect(last.values.get("u_tMotif")).toBe(1);
    // The animals' own relief programs (the warp's stay exactly as they were).
    expect(last.program.fs).toContain("#define TESS_ATLAS_RELIEF");
    expect(draws.filter(isHeight).at(-1).program.fs).toContain("#define TESS_ATLAS_RELIEF");
    const [depth, , bound] = last.values.get("u_tRelief");
    expect(depth).toBeCloseTo(0.6, 6);
    // The march's bound covers the koi's raised parts on top of its domed body.
    const koi = parseSpecies(JSON.parse(read("tiles/fish/koi.json")), "tiles/fish/koi.json");
    expect(bound).toBeGreaterThanOrEqual(0.6 * RELIEF_BLOCK * atlasBlockMax(hintMax(koi)) - 1e-9);
  });

  it("Relief 0 with creatures is the flat print (the plain program, as before relief)", async () => {
    const { draws, run } = await setup({ creatures: "fish/koi", relief: 0 });
    run(10);
    expect(draws.some((d) => isRelief(d) || isHeight(d))).toBe(false);
  });

  it.each(["abstract", "fish/koi", "all"])("keeps the print target, the atlas and the relief height on separate units (%s)", async (creatures) => {
    const { draws, run } = await setup({ creatures });
    run(20);
    expect(draws.length).toBeGreaterThan(0);
    for (const d of draws) {
      for (const [name, s] of Object.entries(d.samplers)) {
        // No sampler reads the texture the draw writes (WebGL refuses such a draw: a black frame).
        expect(d.targets.includes(s.tex), `${name} (unit ${s.unit}) samples its own target in ${isHeight(d) ? "height" : isRelief(d) ? "relief" : d.program.fs.slice(0, 60)}`).toBe(false);
      }
      expect(d.program.fs.includes("#define TESS_ATLAS_RELIEF")).toBe(creatures !== "abstract" && (isRelief(d) || isHeight(d)));
      if (isRelief(d)) {
        expect(d.samplers.u_tHeight.unit).toBe(HEIGHT_UNIT);
        expect(d.samplers.u_tHeight.tex?.kind).toBe("texture");
        expect(d.samplers.u_aField.unit).toBe(ATLAS_FIELD_UNIT);
        expect(d.samplers.u_aArt.unit).toBe(ATLAS_ART_UNIT);
        // The height the relief pass reads is the one the height pass just wrote.
        const h = draws[draws.indexOf(d) - 1];
        expect(isHeight(h)).toBe(true);
        expect(h.targets).toContain(d.samplers.u_tHeight.tex);
        if (creatures !== "abstract") {
          expect(d.samplers.u_aField.tex).not.toBe(d.samplers.u_tHeight.tex);
          expect(d.samplers.u_aArt.tex).not.toBe(d.samplers.u_aField.tex);
          expect(d.samplers.u_aField.tex).not.toBeNull();
        }
      }
      if (isHeight(d) && creatures !== "abstract") {
        // The height pass carves the animals too, so it samples the atlas.
        expect(d.samplers.u_aField.unit).toBe(ATLAS_FIELD_UNIT);
        expect(d.samplers.u_aField.tex).not.toBeNull();
        expect(d.values.get("u_tMotif")).toBe(1);
      }
    }
  });
});
