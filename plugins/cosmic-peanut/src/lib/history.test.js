// @ts-check
import { describe, expect, it } from "vitest";
import { createBeat, stamp } from "./beat.js";
import { createHistory, SENTINEL } from "./history.js";

const WAVE = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * 0.3) * 0.5);

/** A history whose uploads are recorded. @param {number} N */
function recorded(N) {
  /** @type {number[]} */
  const rows = [];
  const h = createHistory(512, N, (row) => rows.push(row));
  return { h, rows };
}

describe("createHistory", () => {
  it("starts with every texel at the sentinel, so nothing is drawn at startup", () => {
    const { h } = recorded(240);
    expect(h.data.length).toBe(512 * 240);
    expect(h.data.every((v) => v === SENTINEL)).toBe(true);
    expect(SENTINEL).toBe(1e6);
  });

  it("uploads exactly the rows it pushes, advancing the head one row each, wrapping at N", () => {
    const { h, rows } = recorded(120);
    let pushed = 0;
    for (let f = 0; f < 60 * 3; f++) pushed += h.step(WAVE, 1 / 60, 2, 0.7);
    expect(pushed).toBeGreaterThanOrEqual(179);
    expect(rows.length).toBe(pushed);
    expect(rows.slice(0, 3)).toEqual([1, 2, 3]);
    expect(rows).toContain(0); // wrapped
    for (let k = 1; k < rows.length; k++) expect(rows[k]).toBe((rows[k - 1] + 1) % 120);
    expect(h.head).toBe(rows[rows.length - 1]);
  });

  it("reallocates and re-sentinels on a density change (no flash of flat circles)", () => {
    const { h, rows } = recorded(240);
    for (let f = 0; f < 90; f++) h.step(WAVE, 1 / 60, 7, 0.7);
    expect(h.setDensity(400)).toBe(true);
    expect(h.N).toBe(400);
    expect(h.head).toBe(0);
    expect(h.frac).toBe(0);
    expect(h.data.length).toBe(512 * 400);
    expect(h.data.every((v) => v === SENTINEL)).toBe(true);
    rows.length = 0;
    for (let f = 0; f < 60; f++) h.step(WAVE, 1 / 60, 7, 0.7);
    expect(rows[0]).toBe(1);
    expect(rows.length).toBe(Math.floor(400 / 7));
  });

  it("keeps everything when the density is unchanged", () => {
    const { h } = recorded(240);
    const data = h.data;
    h.step(WAVE, 0.1, 7, 0.7);
    const head = h.head;
    expect(h.setDensity(240)).toBe(false);
    expect(h.data).toBe(data);
    expect(h.head).toBe(head);
  });

  it("scales each pushed ring by the gain, after normalising, in place", () => {
    /** @type {Float32Array[]} */
    const plain = [];
    /** @type {Float32Array[]} */
    const loud = [];
    /** @type {Float32Array[]} */
    const seen = [];
    const a = createHistory(512, 120, (_, ring) => plain.push(ring.slice()));
    const b = createHistory(512, 120, (_, ring) => {
      seen.push(ring);
      loud.push(ring.slice());
    });
    for (let f = 0; f < 30; f++) {
      a.step(WAVE, 1 / 60, 2, 0.7);
      b.step(WAVE, 1 / 60, 2, 0.7, 1.8);
    }
    expect(loud.length).toBe(plain.length);
    for (let k = 0; k < plain.length; k++) {
      for (let j = 0; j < 512; j += 37) expect(loud[k][j]).toBeCloseTo(plain[k][j] * 1.8, 5);
    }
    expect(seen.every((r) => r === seen[0])).toBe(true); // the same reused array every push
  });

  it("doesn't let the auto-gain learn from the boost (it would cancel it)", () => {
    /** @type {Float32Array} */
    let last = new Float32Array(0);
    /** @type {Float32Array} */
    let ref = new Float32Array(0);
    const a = createHistory(512, 120, (_, ring) => (ref = ring.slice()));
    const b = createHistory(512, 120, (_, ring) => (last = ring.slice()));
    for (let f = 0; f < 240; f++) {
      a.step(WAVE, 1 / 60, 2, 0.7);
      b.step(WAVE, 1 / 60, 2, 0.7, f < 180 ? 1.8 : 1); // boosted for 3 s, then plain
    }
    for (let j = 0; j < 512; j += 17) expect(last[j]).toBeCloseTo(ref[j], 6);
  });

  it("stamps the beat into the history: rings pushed on a beat are louder than between beats", () => {
    const beat = createBeat();
    const a = { bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0 };
    let on = 0;
    let off = 0;
    let amp = 0;
    const h = createHistory(512, 240, (_, ring) => {
      amp = 0;
      for (let j = 0; j < 512; j++) amp = Math.max(amp, Math.abs(ring[j]));
    });
    for (let f = 0; f < 240; f++) {
      const t = f / 60;
      a.beatPhase = (t * 2) % 1;
      beat.step(a, 1 / 60);
      amp = 0;
      if (h.step(WAVE, 1 / 60, 7, 0.7, stamp(beat.env, 1)) === 0 || t < 1) continue;
      if (beat.env > 0.9) on = Math.max(on, amp);
      else if (beat.env < 0.05) off = Math.max(off, amp);
    }
    expect(off).toBeGreaterThan(0);
    expect(on / off).toBeGreaterThan(1.6);
  });
});
