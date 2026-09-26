// @ts-check
import { describe, expect, it } from "vitest";
import { fakeContext } from "./lib/fake-2d.test-helper.js";
import create from "./pulsar.js";

const DEFAULTS = { lines: "80", speed: 10, height: 1, color: "#ffffff", lineWidth: 1.5 };

/** @param {Partial<typeof DEFAULTS>} [params] @param {{ reduceMotion?: boolean, dpr?: number }} [opts] */
function setup(params = {}, opts = {}) {
  const fake = fakeContext();
  const ctx = /** @type {import('../tidalviz').VisualizerContext} */ (
    /** @type {unknown} */ ({
      ctx2d: fake.ctx,
      params: { ...DEFAULTS, ...params },
      size: { width: 2560, height: 1440, cssWidth: 1280, cssHeight: 720, dpr: opts.dpr ?? 2 },
      reduceMotion: opts.reduceMotion ?? false,
      reduceFlashing: true,
    })
  );
  const viz = /** @type {import('../tidalviz').Visualizer} */ (create(ctx));
  return { ...fake, ctx, viz };
}

/** @param {boolean} loud */
function audioFrame(loud) {
  return /** @type {import('../tidalviz').AudioFrame} */ (
    /** @type {unknown} */ ({
      bands: new Float32Array(64).fill(loud ? 0.7 : 0),
      waveform: Float32Array.from({ length: 2048 }, (_, i) => (loud ? Math.sin(i * 12.9898) * 0.4 : 0)),
      silent: !loud,
    })
  );
}

/** Run `frames` frames at 60 Hz; returns the log of the last one. */
function run(/** @type {ReturnType<typeof setup>} */ s, /** @type {number} */ frames, loud = true) {
  const audio = audioFrame(loud);
  for (let f = 0; f < frames; f++) {
    s.log.length = 0;
    s.viz.frame(audio, { now: f / 60, dt: 1 / 60, frame: f });
  }
  return s.log;
}

/** Per stroke (back to front): how far its highest point rises above its left end, in px. */
function rises(/** @type {ReturnType<typeof fakeContext>["log"]} */ log) {
  const out = [];
  let ys = [];
  for (const e of log) {
    if (e.op === "begin") ys = [];
    else if (e.op === "move" || e.op === "line") ys.push(/** @type {number} */ (e.y));
    else if (e.op === "stroke") out.push(ys[0] - Math.min(...ys));
  }
  return out;
}

/** Lines (of the stroke list) that have a real peak. */
const peaked = (/** @type {ReturnType<typeof fakeContext>["log"]} */ log) => rises(log).filter((r) => r > 20).length;

describe("pulsar", () => {
  it("clears the (transparent) canvas, then draws one erase + stroke per line", () => {
    const s = setup();
    const log = run(s, 1);
    expect(log[0]).toEqual({ op: "clear", x: 0, y: 0, w: 2560, h: 1440 });
    expect(log.filter((e) => e.op === "stroke").length).toBe(80);
    expect(log.filter((e) => e.op === "fill").length).toBe(80);
  });

  it("starts flat and builds a ridge from the audio at Speed lines per second", () => {
    const s = setup();
    expect(peaked(run(s, 1))).toBe(0);
    const log = run(s, 60);
    expect(peaked(log)).toBeGreaterThanOrEqual(9);
    expect(peaked(log)).toBeLessThanOrEqual(11);
    // The new ridges are the front (last-drawn) lines.
    expect(rises(log).slice(-5).every((r) => r > 20)).toBe(true);
    expect(rises(log).slice(0, 60).every((r) => r < 20)).toBe(true);
  });

  it("with Reduce motion, slows the default speed but honours a speed the user chose", () => {
    const slow = peaked(run(setup({}, { reduceMotion: true }), 120));
    expect(slow).toBeGreaterThanOrEqual(7);
    expect(slow).toBeLessThanOrEqual(9);
    const chosen = peaked(run(setup({ speed: 5 }, { reduceMotion: true }), 120));
    expect(chosen).toBeGreaterThanOrEqual(9);
    expect(chosen).toBeLessThanOrEqual(11);
  });

  it("applies param changes on the next frame; a new line count keeps the recent ridges", () => {
    const s = setup({}, { dpr: 2 });
    run(s, 60);
    Object.assign(s.ctx.params, { lines: "40", color: "#ff8800", lineWidth: 2, height: 2 });
    const before = Math.max(...rises(run(s, 1)));
    s.viz.params?.({ lines: "40", color: "#ff8800", lineWidth: 2, height: 2 });
    const log = run(s, 1);
    const strokes = log.filter((e) => e.op === "stroke");
    expect(strokes.length).toBe(40);
    expect(peaked(log)).toBeGreaterThanOrEqual(9);
    expect(strokes.every((e) => e.style === "#ff8800" && e.width === 4)).toBe(true);
    expect(Math.max(...rises(log))).toBeGreaterThan(before * 1.5);
  });

  it("falls back to white for a malformed color", () => {
    const s = setup({ color: "red; x" });
    expect(run(s, 1).find((e) => e.op === "stroke")?.style).toBe("#ffffff");
  });
});
