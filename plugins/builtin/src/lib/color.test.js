// @ts-check
import { expect, it } from "vitest";
import { hexToRgb } from "./color.js";

it("parses #rrggbb into 0–1 floats in place", () => {
  const out = new Float32Array(3);
  expect(hexToRgb("#ff8000", out)).toBe(out);
  expect(out[0]).toBeCloseTo(1);
  expect(out[1]).toBeCloseTo(128 / 255);
  expect(out[2]).toBeCloseTo(0);
});

it("falls back to white for anything that isn't #rrggbb", () => {
  const out = new Float32Array(3);
  hexToRgb("red", out);
  expect(Array.from(out)).toEqual([1, 1, 1]);
});
