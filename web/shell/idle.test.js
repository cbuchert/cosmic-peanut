// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdle } from "./idle.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createIdle", () => {
  it("goes idle after 3 s without pointer or key activity", () => {
    const onChange = vi.fn();
    const idle = createIdle(document, { timeoutMs: 3000, onChange, hold: () => false });
    expect(idle.idle).toBe(false);
    vi.advanceTimersByTime(2900);
    document.dispatchEvent(new Event("mousemove"));
    vi.advanceTimersByTime(2900);
    expect(idle.idle).toBe(false);
    vi.advanceTimersByTime(200);
    expect(idle.idle).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(true);
    document.dispatchEvent(new Event("keydown"));
    expect(idle.idle).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("stays awake while held (a panel is open)", () => {
    let held = true;
    const idle = createIdle(document, { timeoutMs: 3000, onChange() {}, hold: () => held });
    vi.advanceTimersByTime(10000);
    expect(idle.idle).toBe(false);
    held = false;
    vi.advanceTimersByTime(3000);
    expect(idle.idle).toBe(true);
  });
});
