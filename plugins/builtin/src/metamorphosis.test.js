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
import { fakeGL } from "./lib/fake-gl.test-helper.js";
import { lookSamples } from "./lib/tess-look.js";
import create from "./metamorphosis.js";

/** @param {string} s */
const nodeImport = (s) => import(s);
const { readFileSync } = await nodeImport("node:fs");
const ROOT = new URL("../", import.meta.url); // plugins/builtin/
const read = (/** @type {string} */ p) => readFileSync(new URL(p, ROOT), "utf8");

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
  return { viz, draws, run, ctx };
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

const isCinematic = (/** @type {any} */ d) => d.program.fs.includes("#define TESS_CINEMATIC");
const isBloom = (/** @type {any} */ d) => d.program.fs.includes("u_texel") && d.program.fs.includes("13-tap");
const isPost = (/** @type {any} */ d) => d.program.fs.includes("uniform vec2 u_lightScr");
const isPaper = (/** @type {any} */ d) => d.program.fs.includes("uniform float u_grain") && !isPost(d);
/** Let the Look's asynchronous compile (asset reads) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Metamorphosis: the Look", () => {
  it("classic draws exactly the classic passes: nothing cinematic is compiled or drawn", async () => {
    const { draws, run } = await setup({ look: "classic" });
    run(4);
    expect(draws.some(isCinematic)).toBe(false);
    expect(draws.some((d) => isBloom(d) || isPost(d))).toBe(false);
    // Per frame: the height pass, the relief print, the paper composite.
    expect(draws.length).toBe(12);
    expect(isPaper(draws[11])).toBe(true);
  });

  it("cinematic: height pass, the cinematic print, the bloom chain, the composite to the canvas", async () => {
    const { draws, run } = await setup({ look: "cinematic" });
    draws.length = 0;
    run(1);
    expect(isHeight(draws[0])).toBe(true);
    expect(isCinematic(draws[1]) && isRelief(draws[1])).toBe(true);
    const bloom = draws.slice(2, -1);
    expect(bloom.length).toBeGreaterThan(2);
    expect(bloom.every(isBloom)).toBe(true);
    const post = draws.at(-1);
    expect(isPost(post)).toBe(true);
    expect(post.fbo).toBe(null);
    // The composite reads the print the cinematic pass wrote, and the bloom.
    expect(draws[1].targets).toContain(post.samplers.u_print.tex);
    expect(post.samplers.u_bloom.tex).not.toBe(post.samplers.u_print.tex);
    // No depth of field on the flat block (no aperture, no gather pass).
    expect(draws.some((d) => d.program.fs.includes("golden-angle"))).toBe(false);
    expect(draws[1].values.get("u_kFocus")[1]).toBe(0);
    // The Quality's sample counts reach the shader.
    const q = lookSamples("high");
    expect(draws[1].values.get("u_kSamples")).toEqual([q.aoDirs, q.aoSteps, q.shadow, 0]);
    // No draw samples the texture it writes.
    for (const d of draws) for (const s of Object.values(d.samplers)) expect(d.targets.includes(s.tex)).toBe(false);
  });

  it("carves the bestiary's animals in the cinematic look too", async () => {
    const { draws, run } = await setup({ look: "cinematic", creatures: "fish/koi" });
    run(30);
    const print = draws.filter((d) => isCinematic(d) && isRelief(d)).at(-1);
    expect(print.program.fs).toContain("#define TESS_ATLAS_RELIEF");
    expect(print.samplers.u_tHeight.unit).toBe(HEIGHT_UNIT);
    expect(print.samplers.u_aField.unit).toBe(ATLAS_FIELD_UNIT);
  });

  it("flips the Look both ways at runtime, and follows the Quality's samples", async () => {
    const { draws, run, viz, ctx } = await setup({ look: "classic" });
    const params = /** @type {Record<string, unknown>} */ (ctx.params);
    run(2);
    params.look = "cinematic";
    params.quality = "low";
    viz.params?.({ look: "cinematic", quality: "low" });
    await settle();
    draws.length = 0;
    run(1);
    const q = lookSamples("low");
    expect(draws.find(isCinematic)?.values.get("u_kSamples")).toEqual([q.aoDirs, q.aoSteps, q.shadow, 0]);
    expect(isPost(draws.at(-1))).toBe(true);
    params.look = "classic";
    viz.params?.({ look: "classic" });
    draws.length = 0;
    run(1);
    expect(draws.some(isCinematic)).toBe(false);
    expect(isPaper(draws.at(-1))).toBe(true);
  });
});

describe("Metamorphosis: exact cut sides while cards turn", () => {
  const isExact = (/** @type {any} */ d) => d.program.fs.includes("#define TESS_EXACT_SIDES");
  it("classic draws its resting frames with the relief program as before, the exact-sides variant while cards turn", async () => {
    const { draws, viz } = await setup({ look: "classic" });
    const audio = /** @type {any} */ ({ bands: new Float32Array(64).fill(0.3), bpm: 0, beatPhase: 0, onset: false, onsetStrength: 0, centroid: 0.15, bassAtt: 1, silent: false });
    const step = (/** @type {number} */ f) => viz.frame(audio, /** @type {any} */ ({ now: f / 60, dt: 1 / 60, frame: f }));
    for (let f = 0; f < 10; f++) step(f);
    expect(draws.filter(isRelief).every((d) => !isExact(d))).toBe(true);
    // A big onset starts the figure/ground front: the cards turn.
    audio.onset = true;
    audio.onsetStrength = 1;
    step(10);
    audio.onset = false;
    audio.onsetStrength = 0;
    draws.length = 0;
    for (let f = 11; f < 40; f++) step(f);
    const relief = draws.filter(isRelief);
    expect(relief.length).toBe(29);
    expect(relief.every(isExact)).toBe(true);
    // The height pass is the same either way.
    expect(draws.filter(isHeight).every((d) => !isExact(d))).toBe(true);
    // Once the front has passed (≤ 19.2 s), the resting program again.
    for (let f = 40; f < 60 * 25; f++) step(f);
    draws.length = 0;
    step(60 * 25);
    expect(draws.filter(isRelief).every((d) => !isExact(d))).toBe(true);
  });

  it("cinematic always has exact sides (its programs carry them), with no separate variant", async () => {
    const { draws, run } = await setup({ look: "cinematic" });
    run(3);
    const print = draws.filter((d) => isCinematic(d) && isRelief(d));
    expect(print.length).toBe(3);
    expect(print.every((d) => !isExact(d) && d.program.fs.includes("TESS_RAY_SOLID"))).toBe(true);
  });
});
