import { describe, expect, it } from "vitest";
import { qualityProfile } from "./quality.js";

describe("qualityProfile", () => {
  it("maps each mode to DPR and fps caps (fpsCap 0 = uncapped)", () => {
    expect(qualityProfile("high", 2)).toEqual({ maxDpr: 2, fpsCap: 0, renderScaleMax: 1 });
    expect(qualityProfile("auto", 2)).toEqual({ maxDpr: 2, fpsCap: 0, renderScaleMax: 1 });
    expect(qualityProfile("balanced", 2)).toEqual({ maxDpr: 1.5, fpsCap: 0, renderScaleMax: 1 });
    expect(qualityProfile("balanced", 1)).toEqual({ maxDpr: 1, fpsCap: 0, renderScaleMax: 1 });
    expect(qualityProfile("battery", 2)).toEqual({ maxDpr: 1, fpsCap: 30, renderScaleMax: 1 });
  });
});
