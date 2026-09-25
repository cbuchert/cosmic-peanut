// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHud } from "./hud.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const perf = { fps: 59.6, frameMsP50: 4.2, frameMsP99: 11.9, pluginMsP50: 1.3, renderScale: 0.9, dropped: 2 };
const stats = { hostCpu: 6.4, rssMb: 120, analysisMsP50: 0.4, captureToSendMsP95: 3, droppedFrames: 5, latencyMsP95: 31 };

describe("hud", () => {
  it("shows fps, frame p50/p99, plugin ms, latency, dropped audio frames and host CPU", () => {
    const el = document.createElement("div");
    const hud = createHud(el);
    hud.setVisible(true);
    hud.setPerf(perf);
    hud.setStats(stats);
    hud.setShellMs(0.08);
    vi.advanceTimersByTime(250);
    const text = el.textContent ?? "";
    expect(text).toContain("60 fps");
    expect(text).toContain("4.2 / 11.9 ms");
    expect(text).toContain("1.3 ms");
    expect(text).toContain("31 ms");
    expect(text).toContain("5");
    expect(text).toContain("6.4%");
    expect(text).toContain("0.08 ms");
    expect(el.hidden).toBe(false);
  });

  it("does not touch the DOM while hidden, and updates at most 4 times per second", () => {
    const el = document.createElement("div");
    const hud = createHud(el);
    expect(el.hidden).toBe(true);
    const spy = vi.fn();
    new MutationObserver(spy).observe(el, { subtree: true, characterData: true, childList: true });
    hud.setPerf(perf);
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
    hud.setVisible(true);
    let writes = 0;
    const orig = hud.render;
    hud.render = () => {
      writes++;
      orig();
    };
    for (let i = 0; i < 100; i++) {
      hud.setPerf({ ...perf, fps: i });
      vi.advanceTimersByTime(10);
    }
    expect(writes).toBeLessThanOrEqual(4);
  });
});
