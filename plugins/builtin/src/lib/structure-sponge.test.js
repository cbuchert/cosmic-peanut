// @ts-check
import { describe, expect, it } from "vitest";
import { createPulses } from "./lattice-pulses.js";
import { SPONGE_F, createPulseRebase, rebasePoint, spongeClearance, spongeDistance } from "./structure-sponge.js";

describe("spongeDistance (mirrors structure-sponge.glsl)", () => {
  it("measures the open tunnels and the solid between them", () => {
    // M = [0, 9]³: its central tunnels are 3 wide, so their axes are 1.5 from the walls.
    expect(spongeDistance([4.5, 4.5, 1.5])).toBeCloseTo(1.5, 9);
    expect(spongeDistance([4.5, 4.5, 4.5])).toBeCloseTo(1.5, 9);
    // The sub-cube (1, 0, 1)'s tunnels (1 wide) along z and along x.
    expect(spongeDistance([7.5, 4.5, 6.5])).toBeCloseTo(0.5, 9);
    expect(spongeDistance([6.5, 4.5, 7.5])).toBeCloseTo(0.5, 9);
    // M's corner and an edge cube are solid.
    expect(spongeDistance([1.5, 0.1, 0.1])).toBeLessThan(0);
  });

  it("is self-similar about the zoom centre: S(p) = F + (p − F)/3 shrinks every distance by 3", () => {
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const p = [Math.sin(i * 1.7) * 12 + 6, Math.cos(i * 2.3) * 12 + 4.5, Math.sin(i * 0.9 + 1) * 12 + 6];
      const s = p.map((x, c) => SPONGE_F[c] + (x - SPONGE_F[c]) / 3);
      worst = Math.max(worst, Math.abs(spongeDistance(s, 12) - spongeDistance(p, 11) / 3));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("is a distance bound: it never changes faster than the distance moved (Lipschitz 1)", () => {
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const p = [Math.sin(i * 1.3) * 10 + 5, Math.cos(i * 0.7) * 10 + 4.5, Math.sin(i * 2.1) * 10 + 5];
      const dir = [Math.sin(i), Math.cos(i * 1.9), Math.sin(i * 3.1 + 2)];
      const l = Math.hypot(dir[0], dir[1], dir[2]);
      const h = 0.01;
      const q = p.map((x, c) => x + (dir[c] / l) * h);
      worst = Math.max(worst, Math.abs(spongeDistance(q) - spongeDistance(p)) / h);
    }
    expect(worst).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe("rebasePoint", () => {
  it("maps a point into the next frame: F + 3^k (p − F)", () => {
    const out = new Float64Array(3);
    rebasePoint([7.5, 4.5, 6], 1, out);
    expect(Array.from(out)).toEqual([4.5, 4.5, 0]);
    rebasePoint([4.5, 4.5, 0], -1, out);
    expect(Array.from(out)).toEqual([7.5, 4.5, 6]);
  });
});

describe("spongeClearance", () => {
  it("is the distance less a margin: positive in the tunnels, negative in the solid", () => {
    expect(spongeClearance([4.5, 4.5, 1.5])).toBeGreaterThan(1.4);
    expect(spongeClearance([0, 0, 0])).toBeLessThan(0);
    expect(spongeClearance([0.5, 0.01, 0.02])).toBeLessThan(0);
  });
});

describe("createPulseRebase", () => {
  it("carries each pulse into the current frame, in the shader's local cells about F", () => {
    const pulses = createPulses((p, out) => {
      for (let c = 0; c < 3; c++) out[c] = p[c];
      return out;
    });
    const fix = createPulseRebase();
    const cam = { depth: 3, scale: 1.5 };
    const origin = new Float64Array([7, 4, 6]);
    pulses.launch([7.5, 4.5, 6.2], 1, false, 0.5);
    pulses.step(0.1, origin);
    fix.step(pulses, cam);
    const front = pulses.data[3];
    // Same frame: the source is where it was launched, as (p − F) / scale; the front is in local cells.
    fix.update(pulses, origin, cam);
    expect(Array.from(fix.data.slice(0, 3)).map((x) => +x.toFixed(5))).toEqual([-1, 0, -1.86667]);
    expect(fix.data[3]).toBeCloseTo(front, 5);
    // One rebase on (×3 about F), the camera now at scale 1.8 and a new origin.
    cam.depth = 4;
    cam.scale = 1.8;
    const o2 = new Float64Array([4, 4, 0]);
    pulses.step(0.01, o2);
    fix.step(pulses, cam);
    fix.update(pulses, o2, cam);
    const want = rebasePoint([7.5, 4.5, 6.2], 1, new Float64Array(3));
    for (let c = 0; c < 3; c++) expect(fix.data[c]).toBeCloseTo((want[c] - SPONGE_F[c]) / 1.8, 4);
    expect(fix.data[3]).toBeCloseTo((pulses.data[3] * 1.5 * 3) / 1.8, 5);
  });
});
