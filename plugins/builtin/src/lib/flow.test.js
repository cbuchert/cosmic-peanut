// @ts-check
import { describe, expect, it } from "vitest";
import { advectLines, createSimClock, LINE_DUTY, lineCoverage, MAX_STEPS, obstacleVelocity, SIM_RATE, simGrid } from "./flow.js";

describe("obstacleVelocity (mirrors the solid-boundary rule in shaders/laminar/*.frag)", () => {
  const out = new Float32Array(3);
  it("inside the sphere the fluid moves with the sphere; outside it is left alone", () => {
    // Sphere at (1, 0.5), radius 0.2, moving (0.1, -0.3), not growing.
    expect(obstacleVelocity(1.05, 0.45, 1, 0.5, 0.2, 0.1, -0.3, 0, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.1, 6);
    expect(out[1]).toBeCloseTo(-0.3, 6);
    expect(obstacleVelocity(1.3, 0.5, 1, 0.5, 0.2, 0.1, -0.3, 0, out)).toBe(false);
  });

  it("a growing sphere pushes the fluid inside it outward, proportionally to the distance from the centre", () => {
    // Radius growing at 0.5/s: the surface moves out at 0.5, half-way in at 0.25.
    expect(obstacleVelocity(1.1, 0.5, 1, 0.5, 0.2, 0, 0, 0.5, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.25, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(obstacleVelocity(1, 0.4, 1, 0.5, 0.2, 0.1, 0, -0.5, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.1, 6);
    expect(out[1]).toBeCloseTo(0.25, 6); // shrinking pulls it in
  });
});

describe("simGrid", () => {
  it("covers the canvas rotated into the flow frame with square cells, detail × canvas height per screen height", () => {
    const angle = 0.8;
    const g = simGrid(2560, 1440, 0.2, angle);
    const A = 2560 / 1440;
    const lx = A * Math.cos(angle) + Math.sin(angle);
    const ly = A * Math.sin(angle) + Math.cos(angle);
    expect(g.lx).toBeCloseTo(lx, 9);
    expect(g.ly).toBeCloseTo(ly, 9);
    expect(g.cells).toBeCloseTo(1440 * 0.2, 9); // cells per screen height
    expect(g.width).toBe(Math.ceil(lx * g.cells));
    expect(g.height).toBe(Math.ceil(ly * g.cells));
    expect(Number.isInteger(g.width) && Number.isInteger(g.height)).toBe(true);
  });

  it("grows with detail, clamps detail to 0.08–0.4, caps the grid at 1024 texels a side and keeps a 16-texel minimum", () => {
    expect(simGrid(1920, 1080, 0.3, 0.8).width).toBeGreaterThan(simGrid(1920, 1080, 0.15, 0.8).width);
    expect(simGrid(1920, 1080, 5, 0.8)).toEqual(simGrid(1920, 1080, 0.4, 0.8));
    expect(simGrid(1920, 1080, 0, 0.8)).toEqual(simGrid(1920, 1080, 0.08, 0.8));
    expect(simGrid(1920, 1080, Number.NaN, 0.8)).toEqual(simGrid(1920, 1080, 0.2, 0.8));
    const big = simGrid(7680, 4320, 0.4, 0.8);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(1024);
    expect(big.width / big.height).toBeCloseTo(big.lx / big.ly, 2);
    const tiny = simGrid(10, 10, 0.1, 0);
    expect(Math.min(tiny.width, tiny.height)).toBeGreaterThanOrEqual(16);
  });
});

describe("createSimClock", () => {
  it("runs the same number of fixed sim steps per second at 60 and 120 Hz, and caps a stall", () => {
    for (const hz of [60, 120, 144]) {
      const c = createSimClock();
      let n = 0;
      for (let f = 0; f < hz * 3; f++) {
        const k = c.step(1 / hz);
        expect(k).toBeLessThanOrEqual(MAX_STEPS);
        n += k;
      }
      expect(Math.abs(n - SIM_RATE * 3), `${hz} Hz`).toBeLessThanOrEqual(1);
    }
    const c = createSimClock();
    expect(c.step(0.1)).toBe(MAX_STEPS); // a stall is dropped, not caught up in a burst
    expect(c.step(1 / SIM_RATE)).toBe(1);
    expect(c.dt).toBeCloseTo(1 / SIM_RATE, 12);
  });
});

describe("lineCoverage (mirrors the contour in shaders/laminar/composite.frag)", () => {
  const k = 60; // lines per screen height

  it("draws crisp lines, LINE_DUTY of each period, centred on the half-integer contours of φ·k", () => {
    const w = 0.02; // filter width in periods (a sharp, well-resolved line)
    expect(lineCoverage(0.5 / k, k, w)).toBeCloseTo(1, 6); // line centre
    expect(lineCoverage(0 / k, k, w)).toBeCloseTo(0, 6); // gap centre
    expect(lineCoverage(3.5 / k, k, w)).toBeCloseTo(1, 6); // periodic
    let mean = 0;
    for (let i = 0; i < 1000; i++) mean += lineCoverage((i + 0.5) / 1000 / k, k, w) / 1000;
    expect(mean).toBeCloseTo(LINE_DUTY, 2);
  });

  it("anti-aliases each edge over the pixel footprint and averages sub-pixel lines to a flat LINE_DUTY", () => {
    const edge = (0.5 - LINE_DUTY / 2) / k;
    const w = 0.2;
    expect(lineCoverage(edge, k, w)).toBeCloseTo(0.5, 6);
    let prev = -1;
    for (let i = -10; i <= 10; i++) {
      const c = lineCoverage(edge + (i / 10) * (w / 2 / k), k, w);
      expect(c).toBeGreaterThanOrEqual(prev); // a monotone ramp, no ringing
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      prev = c;
    }
    expect(lineCoverage(edge - (w / k) * 0.51, k, w)).toBeCloseTo(0, 6);
    expect(lineCoverage(edge + (w / k) * 0.51, k, w)).toBeCloseTo(1, 6);
    // Lines finer than a pixel: flat grey at the duty, wherever you sample.
    for (let i = 0; i < 20; i++) expect(lineCoverage(i * 0.0137, k, 3)).toBeCloseTo(LINE_DUTY, 6);
  });
});

describe("advectLines (the line-coordinate step of shaders/laminar/advect.frag, on the CPU)", () => {
  const nx = 40;
  const ny = 20;
  const cells = 10; // per screen height
  const U = 0.5; // screen heights / s along +x

  it("keeps a uniform inflow's lines exactly straight and parallel (φ = y, displacement 0)", () => {
    let psi = new Float32Array(nx * ny);
    let next = new Float32Array(nx * ny);
    for (let s = 0; s < 120; s++) {
      advectLines(psi, next, nx, ny, cells, U, 0, 1 / 60);
      [psi, next] = [next, psi];
    }
    for (const v of psi) expect(v).toBe(0);
  });

  it("re-injects fresh straight lines at the inflow edge, flushing any disturbance downstream", () => {
    let psi = new Float32Array(nx * ny).map((_, i) => 0.05 * Math.sin(i));
    let next = new Float32Array(nx * ny);
    // Crossing the grid takes nx / cells / U = 8 s (plus the numerical spread of the tail).
    for (let s = 0; s < 60 * 12; s++) {
      advectLines(psi, next, nx, ny, cells, U, 0, 1 / 60);
      [psi, next] = [next, psi];
    }
    for (const v of psi) expect(Math.abs(v)).toBeLessThan(1e-4);
  });

  it("moves the lines with a cross-stream flow: φ is carried, so the displacement grows by −vy·t", () => {
    let psi = new Float32Array(nx * ny);
    let next = new Float32Array(nx * ny);
    for (let s = 0; s < 30; s++) {
      advectLines(psi, next, nx, ny, cells, 0, 0.1, 1 / 60);
      [psi, next] = [next, psi];
    }
    // Interior cell, 0.5 s of vy = 0.1: the line that was at y − 0.05 is here now.
    expect(psi[10 * nx + 20]).toBeCloseTo(-0.05, 5);
  });
});
