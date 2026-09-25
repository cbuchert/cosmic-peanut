import { describe, it, expect } from "vitest";
import { createPerfMeter, percentile } from "./perf.js";

describe("percentile (nearest rank)", () => {
  it("picks nearest-rank values from a sorted array", () => {
    const a = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(a, 100, 0.5)).toBe(50);
    expect(percentile(a, 100, 0.99)).toBe(99);
    expect(percentile(a, 1, 0.99)).toBe(1);
    expect(percentile(a, 0, 0.5)).toBe(0);
  });
});

describe("perf meter", () => {
  it("reports nothing until a second has passed", () => {
    const m = createPerfMeter({ expectedIntervalMs: 1000 / 60 });
    m.start(0);
    m.frame(16.7, 2, 0.1);
    expect(m.report(500)).toBeNull();
  });

  it("reports fps, p50/p99 frame time, plugin p50, sdk p50 and drops per second", () => {
    const m = createPerfMeter({ expectedIntervalMs: 1000 / 60 });
    m.start(0);
    for (let i = 0; i < 58; i++) m.frame(1000 / 60, 3, 0.2);
    m.frame(50, 3, 0.2); // a 50 ms frame at 60 Hz = 2 missed vsyncs
    const r = m.report(1000);
    expect(r).not.toBeNull();
    const p = /** @type {NonNullable<typeof r>} */ (r);
    expect(p.fps).toBeCloseTo(59);
    expect(p.frameMsP50).toBeCloseTo(16.67, 1);
    expect(p.frameMsP99).toBe(50);
    expect(p.pluginMsP50).toBe(3);
    expect(p.sdkMsP50).toBeCloseTo(0.2);
    expect(p.dropped).toBe(2);
  });

  it("starts a fresh window after each report", () => {
    const m = createPerfMeter({ expectedIntervalMs: 1000 / 60 });
    m.start(0);
    m.frame(50, 9, 1);
    m.report(1000);
    for (let i = 0; i < 30; i++) m.frame(1000 / 30, 1, 0.1);
    const p = /** @type {any} */ (m.report(2000));
    expect(p.fps).toBeCloseTo(30);
    expect(p.pluginMsP50).toBe(1);
    expect(p.dropped).toBe(30);
  });

  it("keeps only the newest samples when the ring overflows", () => {
    const m = createPerfMeter({ expectedIntervalMs: 1, capacity: 4 });
    m.start(0);
    for (const v of [100, 100, 100, 100, 1, 1, 1, 1]) m.frame(v, v, 0);
    const p = /** @type {any} */ (m.report(1000));
    expect(p.frameMsP99).toBe(1);
    expect(p.fps).toBeCloseTo(8);
  });
});
