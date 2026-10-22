// @ts-check
import { describe, expect, it } from "vitest";
import { createMotionMeter, parseZone } from "./motion.js";

describe("parseZone: ordered include (+) / exclude (-) rects in 0–1 frame coordinates", () => {
  it("starts empty for a leading + and full for a leading -, later rects win", () => {
    const a = parseZone("+0,0,0.5,1", 4, 2);
    expect([...a]).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
    const b = parseZone("-0,0,0.5,0.5", 4, 2);
    expect([...b]).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
    const c = parseZone("+0,0,1,1;-0.25,0,0.75,1", 4, 1);
    expect([...c]).toEqual([1, 0, 0, 1]);
  });
});

describe("createMotionMeter: mean absolute RGB change per masked pixel between frames", () => {
  it("is 0 on the first frame, then the mean |Δ| (0–255) over the zone only", () => {
    const m = createMotionMeter({ all: parseZone("+0,0,1,1", 2, 1), left: parseZone("+0,0,0.5,1", 2, 1) }, 2, 1);
    const f0 = new Uint8ClampedArray([10, 10, 10, 255, 0, 0, 0, 255]);
    const f1 = new Uint8ClampedArray([16, 16, 16, 255, 30, 30, 30, 255]);
    expect(m.step(f0)).toEqual({ all: 0, left: 0 });
    expect(m.step(f1)).toEqual({ all: 18, left: 6 });
  });
});
