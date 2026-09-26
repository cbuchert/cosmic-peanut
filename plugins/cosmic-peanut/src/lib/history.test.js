// @ts-check
import { describe, expect, it } from "vitest";
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
});
