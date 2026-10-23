// @ts-check
import { describe, expect, it } from "vitest";
import { BEAT_STRENGTH, REFRACTORY, createBeat } from "./lattice-beat.js";

/** A reusable fake audio frame carrying only what the envelope reads. */
function frame(bpm = 0) {
  return { bpm, beatPhase: 0, onset: false, onsetStrength: 0, silent: false };
}

/**
 * Step a fresh envelope at `hz` for `seconds` of `bpm` (beatPhase ramps; a beat on each wrap),
 * calling `each(b, t)` after every step. Without a tempo, an onset of `strength` every 0.5 s.
 * @param {{ hz?: number, seconds: number, bpm?: number, strength?: number }} o
 * @param {(b: ReturnType<typeof createBeat>, t: number) => void} each
 */
function run(o, each) {
  const hz = o.hz ?? 240;
  const bpm = o.bpm ?? 0;
  const b = createBeat();
  const a = frame(bpm);
  for (let f = 0; f < hz * o.seconds; f++) {
    const t = f / hz;
    if (bpm > 0) {
      // Phase 0.999 on the frame before the first beat at t = 0.1, then wraps every beat.
      const p = (t - 0.1) * (bpm / 60);
      a.beatPhase = p < 0 ? 0.999 + p * 0.001 : p - Math.floor(p);
    } else {
      const k = Math.round((t - 0.1) / 0.5);
      a.onset = k >= 0 && Math.abs(t - 0.1 - k * 0.5) < 0.5 / hz;
      a.onsetStrength = a.onset ? (o.strength ?? 1) : 0;
    }
    b.step(a, 1 / hz);
    each(b, t);
  }
}

describe("createBeat", () => {
  it("eases up over about 80 ms with a smoothstep after a tempo beat", () => {
    /** @type {number[]} */
    const env = [];
    /** @type {number[]} */
    const times = [];
    run({ seconds: 0.3, bpm: 120 }, (b, t) => {
      env.push(b.env);
      times.push(t);
    });
    const at = (/** @type {number} */ s) => env[times.findIndex((t) => t >= 0.1 + s - 1e-9)];
    expect(at(0) ?? 0).toBeLessThan(0.05);
    // Halfway through the rise a smoothstep is at one half; it peaks at the beat's level by 80 ms.
    expect(at(0.04)).toBeGreaterThan(0.4);
    expect(at(0.04)).toBeLessThan(0.6);
    expect(at(0.085)).toBeGreaterThan(0.97);
  });

  it("decays back to 0 over about 0.9 beat, with no step bigger than the rise's", () => {
    // 120 BPM: a beat every 0.5 s, so back to 0 by 0.1 + 0.45 s and still clearly up before.
    let maxStep = 0;
    let prev = 0;
    /** @type {[number, number][]} */
    const trace = [];
    run({ seconds: 0.58, bpm: 120 }, (b, t) => {
      maxStep = Math.max(maxStep, Math.abs(b.env - prev));
      prev = b.env;
      trace.push([t, b.env]);
    });
    const at = (/** @type {number} */ s) => /** @type {[number, number]} */ (trace.find(([t]) => t >= s - 1e-9))[1];
    expect(at(0.3)).toBeGreaterThan(0.3);
    expect(at(0.3)).toBeLessThan(0.9);
    expect(at(0.54)).toBeLessThan(0.01);
    // 240 Hz: a smoothstep over 80 ms moves at most 1.5 / 19.2 per step.
    expect(maxStep).toBeLessThan(0.08);
  });

  it("without a tempo, strong onsets are beats at their strength; weak ones and fast repeats aren't", () => {
    let beats = 0;
    let peak = 0;
    run({ seconds: 1.2, strength: 0.8 }, (b) => {
      if (b.beat) beats++;
      peak = Math.max(peak, b.env);
    });
    expect(beats).toBe(3); // onsets at 0.1, 0.6, 1.1 s
    expect(peak).toBeCloseTo(0.8, 2);

    run({ seconds: 1.2, strength: BEAT_STRENGTH - 0.05 }, (b) => {
      expect(b.beat).toBe(false);
      expect(b.env).toBe(0);
    });

    const b = createBeat();
    const a = frame(0);
    let n = 0;
    for (let f = 0; f < 60; f++) {
      a.onset = f % 6 === 0; // every 0.1 s at 60 Hz
      a.onsetStrength = 1;
      b.step(a, 1 / 60);
      if (b.beat) n++;
    }
    // 1 s of onsets 0.1 s apart: one beat per refractory gap at most.
    expect(n).toBeLessThanOrEqual(Math.ceil(1 / REFRACTORY));
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
