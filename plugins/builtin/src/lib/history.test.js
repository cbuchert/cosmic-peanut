// @ts-check
import { describe, expect, it } from "vitest";
import { createSlitHistory, texRow } from "./history.js";

describe("createSlitHistory", () => {
  const W = 8;
  const fill = (/** @type {Float32Array} */ row) => row.fill(1);

  it("pushes rows at a fixed rate from a dt accumulator, the same at 60 and 120 Hz, uploading each", () => {
    for (const hz of [60, 120]) {
      let uploads = 0;
      const h = createSlitHistory(W, 64, () => uploads++);
      let pushed = 0;
      for (let f = 0; f < hz * 3; f++) pushed += h.step(1 / hz, 50, fill);
      expect(pushed, `${hz} Hz`).toBeGreaterThanOrEqual(149);
      expect(pushed, `${hz} Hz`).toBeLessThanOrEqual(150);
      expect(uploads).toBe(pushed);
    }
  });

  it("advances pushes + frac by exactly rate × dt every frame, even as the rate surges", () => {
    for (const hz of [60, 120]) {
      const h = createSlitHistory(W, 64, () => {});
      let prev = 0;
      for (let f = 0; f < hz * 2; f++) {
        const rate = 40 + 30 * Math.sin(f * 0.1);
        const n = h.step(1 / hz, rate, fill);
        expect(h.frac).toBeGreaterThanOrEqual(0);
        expect(h.frac).toBeLessThan(1);
        expect(n + h.frac - prev).toBeCloseTo(rate / hz, 9);
        prev = h.frac;
      }
    }
  });

  it("wraps the head around the ring and never uploads more than N rows in one step", () => {
    /** @type {number[]} */
    const rows = [];
    const h = createSlitHistory(W, 4, (r) => rows.push(r));
    h.step(1, 3, fill);
    h.step(1, 3, fill);
    expect(rows).toEqual([1, 2, 3, 0, 1, 2]);
    rows.length = 0;
    const n = h.step(1, 1000, fill);
    expect(n).toBe(1000);
    expect(rows.length).toBe(4);
    expect(h.head).toBe((2 + 1000) % 4);
    expect(rows).toEqual([3, 2, 1, 0].map((back) => (h.head - back + 4) % 4)); // the newest 4, in order
  });

  it("resizes the ring only when the row count changes, restarting it", () => {
    const h = createSlitHistory(W, 64, () => {});
    h.step(1, 10.5, fill);
    expect(h.resize(64)).toBe(false);
    expect(h.head).toBe(10);
    expect(h.resize(128)).toBe(true);
    expect([h.N, h.head, h.frac]).toEqual([128, 0, 0]);
  });
});

describe("texRow", () => {
  it("maps a row age (0 = newest, fractional) to the texture's v coordinate at that row's centre", () => {
    const N = 8;
    expect(texRow(5, 0, N)).toBeCloseTo(5.5 / 8, 9);
    expect(texRow(5, 1, N)).toBeCloseTo(4.5 / 8, 9);
    expect(texRow(5, 0.5, N)).toBeCloseTo(5 / 8, 9); // halfway between rows 5 and 4
    expect(texRow(1, 3, N)).toBeCloseTo(6.5 / 8, 9); // wraps below row 0
    expect(texRow(5, N, N)).toBeCloseTo(texRow(5, 0, N), 9);
    for (let a = 0; a < 20; a += 0.37) {
      expect(texRow(3, a, N)).toBeGreaterThanOrEqual(0);
      expect(texRow(3, a, N)).toBeLessThan(1);
    }
  });
});
