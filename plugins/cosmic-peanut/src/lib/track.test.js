// @ts-check
import { describe, expect, it } from "vitest";
import { TRACKS, TRACK_SAMPLES as K, buildTrack, trackIndex } from "./track.js";

/** Row r (0 centre, 1 tangent, 2 cross-section direction) of sample k. */
function vec(/** @type {Float32Array} */ d, /** @type {number} */ r, /** @type {number} */ k) {
  const o = (r * K + k) * 4;
  return [d[o], d[o + 1], d[o + 2]];
}
const dot = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (/** @type {number[]} */ a) => Math.hypot(a[0], a[1], a[2]);

describe("trackIndex", () => {
  it("maps the Track select, figure-8 for anything unknown", () => {
    expect(TRACKS).toEqual(["figure-8", "loop"]);
    expect(trackIndex("figure-8")).toBe(0);
    expect(trackIndex("loop")).toBe(1);
    expect(trackIndex("?")).toBe(0);
  });
});

describe("buildTrack", () => {
  for (const name of TRACKS) {
    it(`${name}: samples are evenly spaced in arc length, closing on itself`, () => {
      const t = buildTrack(name);
      expect(t.data.length).toBe(K * 3 * 4);
      for (let k = 0; k < K; k++) {
        const step = len(sub(vec(t.data, 0, (k + 1) % K), vec(t.data, 0, k)));
        expect(step / (t.length / K), `sample ${k}`).toBeCloseTo(1, 2);
      }
    });

    it(`${name}: a unit frame (tangent ⟂ cross-section) with no flips anywhere, wrap included`, () => {
      const { data } = buildTrack(name);
      let worst = 1;
      for (let k = 0; k < K; k++) {
        const t = vec(data, 1, k);
        const w = vec(data, 2, k);
        expect(len(t)).toBeCloseTo(1, 5);
        expect(len(w)).toBeCloseTo(1, 5);
        expect(Math.abs(dot(t, w))).toBeLessThan(1e-5);
        const k1 = (k + 1) % K;
        worst = Math.min(worst, dot(w, vec(data, 2, k1)), dot(t, vec(data, 1, k1)));
      }
      expect(worst).toBeGreaterThan(Math.cos(0.05)); // < 3° between neighbours: no pops
    });
  }

  it("loop: two laps of today's unit circle, the cross-section turning by u/2", () => {
    const { data, length } = buildTrack("loop");
    expect(length).toBeCloseTo(4 * Math.PI, 3);
    for (const k of [0, 100, 333, 512, 777]) {
      const u = (4 * Math.PI * k) / K;
      const c = vec(data, 0, k);
      const w = vec(data, 2, k);
      const want = [Math.cos(u / 2) * Math.cos(u), Math.sin(u / 2), Math.cos(u / 2) * Math.sin(u)];
      for (let i = 0; i < 3; i++) {
        expect(c[i]).toBeCloseTo([Math.cos(u), 0, Math.sin(u)][i], 4);
        expect(w[i]).toBeCloseTo(want[i], 4);
      }
    }
  });

  it("figure-8: about twice a loop lap long", () => {
    const { length } = buildTrack("figure-8");
    expect(length / (2 * Math.PI)).toBeGreaterThan(1.8);
    expect(length / (2 * Math.PI)).toBeLessThan(2.2);
  });

  it("figure-8: the two passes through the crossing are well apart, both lying flat", () => {
    const { data } = buildTrack("figure-8");
    const a = vec(data, 0, 0);
    const b = vec(data, 0, K / 2);
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeLessThan(1e-3); // same spot from above
    expect(Math.abs(a[1] - b[1])).toBeGreaterThanOrEqual(1); // stacked ≥ 1 apart (strip ±0.4)
    expect(Math.abs(vec(data, 2, 0)[1])).toBeLessThan(1e-4); // horizontal cross-sections
    expect(Math.abs(vec(data, 2, K / 2)[1])).toBeLessThan(1e-4);
  });

  it("figure-8: lobe A turns the cross-section half a turn one way, lobe B back the other way", () => {
    const { data } = buildTrack("figure-8");
    // Measure the turn about the tangent relative to the horizontal frame n = up × t.
    const twist = (/** @type {number} */ k) => {
      const t = vec(data, 1, k);
      const n = [t[2], 0, -t[0]];
      const nl = len(n);
      const nn = [n[0] / nl, 0, n[2] / nl];
      const b = [t[1] * nn[2] - t[2] * nn[1], t[2] * nn[0] - t[0] * nn[2], t[0] * nn[1] - t[1] * nn[0]];
      const w = vec(data, 2, k);
      return Math.atan2(dot(w, b), dot(w, nn));
    };
    let unwrapped = 0;
    let prev = twist(0);
    /** @type {number[]} */
    const tw = [0];
    for (let k = 1; k <= K; k++) {
      const cur = twist(k % K);
      let d = cur - prev;
      d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      unwrapped += d;
      tw.push(unwrapped);
      prev = cur;
    }
    expect(tw[K / 2]).toBeCloseTo(Math.PI, 2); // + half twist over lobe A
    expect(tw[K]).toBeCloseTo(0, 2); // − half twist over lobe B (its mirror image)
    for (let k = 1; k < K / 2; k++) expect(tw[k] - tw[k - 1]).toBeGreaterThanOrEqual(-1e-6);
    for (let k = K / 2 + 1; k <= K; k++) expect(tw[k] - tw[k - 1]).toBeLessThanOrEqual(1e-6);
  });

  it("reports its bounds: the farthest horizontal reach and height of the strip edges", () => {
    const loop = buildTrack("loop");
    expect(loop.reach(0.4)).toBeCloseTo(1.4, 3);
    expect(loop.height(0.4)).toBeCloseTo(0.4, 3);
    const f8 = buildTrack("figure-8");
    expect(f8.reach(0.4)).toBeGreaterThan(f8.reach(0));
    expect(f8.height(0)).toBeGreaterThan(0.5);
  });
});
