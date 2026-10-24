// @ts-check
// Tile Horizon's cinematic depth of field on a recording fake WebGL2: the gather pass runs between
// the print and the bloom, reads the print and writes its own target, which the composite reads;
// the focus follows the floor ahead and holds still under Reduce motion (no focus pulling).
import { describe, expect, it } from "vitest";
import { fakeGL } from "./lib/fake-gl.test-helper.js";
import { lookSamples } from "./lib/tess-look.js";
import create from "./tile-horizon.js";

/** @param {string} s */
const nodeImport = (s) => import(s);
const { readFileSync } = await nodeImport("node:fs");
const ROOT = new URL("../", import.meta.url); // plugins/builtin/
const read = (/** @type {string} */ p) => readFileSync(new URL(p, ROOT), "utf8");

/** @param {Record<string, unknown>} params @param {boolean} [reduceMotion] */
async function setup(params, reduceMotion = false) {
  const { gl, draws } = fakeGL();
  const ctx = /** @type {import('../tidalviz').VisualizerContext} */ (
    /** @type {unknown} */ ({
      gl,
      params: { symmetry: "p4", palette: "four-block", reactivity: 1, speed: 1, morph: 0.7, ink: 1, hatching: 0.6, relief: 0.6, light: 135, height: 0.4, tilt: 0.5, fog: 0.5, look: "classic", quality: "high", ...params },
      size: { width: 2560, height: 1440, cssWidth: 1280, cssHeight: 720, dpr: 2 },
      reduceMotion,
      reduceFlashing: false,
      log: () => {},
      assets: { text: async (/** @type {string} */ p) => read(p), json: async (/** @type {string} */ p) => JSON.parse(read(p)) },
    })
  );
  const viz = /** @type {import('../tidalviz').Visualizer} */ (await create(ctx));
  const audio = /** @type {any} */ ({ bands: new Float32Array(64).fill(0.3), bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0, centroid: 0.15, bassAtt: 1, silent: false });
  let f = 0;
  const run = (/** @type {number} */ n) => {
    for (let i = 0; i < n; i++, f++) {
      audio.beatPhase = (f / 30) % 1;
      audio.onset = f % 30 === 0;
      audio.onsetStrength = audio.onset ? 0.9 : 0;
      viz.frame(audio, /** @type {any} */ ({ now: f / 60, dt: 1 / 60, frame: f }));
    }
  };
  return { viz, draws, run, ctx };
}

const isCinematic = (/** @type {any} */ d) => d.program.fs.includes("#define TESS_CINEMATIC");
const isDof = (/** @type {any} */ d) => d.program.fs.includes("golden-angle");
const isPost = (/** @type {any} */ d) => d.program.fs.includes("uniform vec2 u_lightScr");

describe("Tile Horizon: cinematic depth of field", () => {
  it("classic has no gather pass", async () => {
    const { draws, run } = await setup({});
    run(3);
    expect(draws.some((d) => isDof(d) || isCinematic(d))).toBe(false);
  });

  it("gathers the print into its own target, which the composite reads; focus on the floor ahead", async () => {
    const { draws, run } = await setup({ look: "cinematic" });
    run(2);
    draws.length = 0;
    run(1);
    const i = draws.findIndex(isDof);
    expect(i).toBeGreaterThan(0);
    const print = draws[i - 1];
    expect(isCinematic(print)).toBe(true);
    const dof = draws[i];
    expect(print.targets).toContain(dof.samplers.u_src.tex);
    expect(dof.targets).not.toContain(dof.samplers.u_src.tex);
    expect(dof.values.get("u_taps")).toBe(lookSamples("high").dofTaps);
    const post = draws.at(-1);
    expect(isPost(post)).toBe(true);
    expect(dof.targets).toContain(post.samplers.u_print.tex);
    // A real aperture and cap (target px), and a focus a few camera heights out.
    const [focus, aperture, cap] = print.values.get("u_kFocus");
    expect(aperture).toBeGreaterThan(0);
    expect(cap).toBeGreaterThan(aperture);
    const [, , camH] = print.values.get("u_cam");
    expect(focus).toBeGreaterThan(2 * camH);
    expect(focus).toBeLessThan(8 * camH);
  });

  it("eases the focus when the subject moves, and holds it under Reduce motion", async () => {
    const focusAt = (/** @type {any[]} */ draws) => draws.filter(isCinematic).at(-1).values.get("u_kFocus")[0];
    for (const reduce of [false, true]) {
      const { draws, run, ctx } = await setup({ look: "cinematic" }, reduce);
      run(5);
      const before = focusAt(draws);
      ctx.params.height = 1; // the camera rises: the floor ahead moves away
      run(1);
      const one = focusAt(draws);
      run(120);
      const after = focusAt(draws);
      if (reduce) {
        expect(one).toBe(before);
        expect(after).toBe(before);
      } else {
        expect(Math.abs(one - before)).toBeLessThan(0.05 * Math.abs(after - before)); // eased, no jump
        expect(after).toBeGreaterThan(before * 1.5);
      }
    }
  });
});
