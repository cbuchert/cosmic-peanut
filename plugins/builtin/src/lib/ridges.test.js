// @ts-check
import { describe, expect, it } from "vitest";
import { fakeContext } from "./fake-2d.test-helper.js";
import {
  advanceScroll,
  bandAt,
  buildLine,
  centralEnvelope,
  createRing,
  drawOrder,
  drawRidges,
  resizeRing,
  ridgeLayout,
  ringPush,
  ringRow,
  stepGain,
} from "./ridges.js";

const ramp = Float32Array.from({ length: 64 }, (_, i) => i / 63);

describe("centralEnvelope", () => {
  it("is 1 in the middle, 0 outside the central band, and symmetric", () => {
    const env = new Float32Array(161);
    centralEnvelope(env, 0.25);
    expect(env[80]).toBeCloseTo(1);
    expect(env[0]).toBe(0);
    expect(env[160]).toBe(0);
    expect(env[20]).toBe(0); // x = 0.125, outside 0.5 ± 0.25
    for (let i = 0; i < 161; i++) expect(env[i]).toBeCloseTo(env[160 - i]);
    expect(env[60]).toBeGreaterThan(0.2); // x = 0.375: inside, on the slope
    expect(env[60]).toBeLessThan(0.9);
  });
});

describe("bandAt", () => {
  it("interpolates linearly between neighbouring bands", () => {
    expect(bandAt(ramp, 20)).toBeCloseTo(20 / 63);
    expect(bandAt(ramp, 20.25)).toBeCloseTo(20.25 / 63);
  });

  it("clamps outside 0–63", () => {
    expect(bandAt(ramp, -3)).toBeCloseTo(0);
    expect(bandAt(ramp, 70)).toBeCloseTo(1);
  });
});

describe("advanceScroll", () => {
  /** Scroll position in lines (pushed + fraction) after each frame at `hz`. */
  function positions(/** @type {number} */ hz, /** @type {number} */ seconds, rate = 10) {
    const s = { frac: 0 };
    let pushed = 0;
    const out = [];
    for (let f = 0; f < Math.round(seconds * hz); f++) {
      pushed += advanceScroll(s, 1 / hz, rate, 1000);
      expect(s.frac).toBeGreaterThanOrEqual(0);
      expect(s.frac).toBeLessThan(1);
      out.push(pushed + s.frac);
    }
    return out;
  }

  it("pushes `rate` lines per second", () => {
    const p = positions(60, 3);
    expect(p[p.length - 1]).toBeCloseTo(30, 6);
  });

  it("moves the same distance every frame at 60 and at 120 Hz: continuous, no stepping", () => {
    for (const hz of [60, 120]) {
      const p = positions(hz, 2);
      for (let i = 1; i < p.length; i++) expect(p[i] - p[i - 1]).toBeCloseTo(10 / hz, 6);
    }
    expect(positions(120, 2)[239]).toBeCloseTo(positions(60, 2)[119], 6);
  });

  it("never pushes more than `max` lines in one step", () => {
    const s = { frac: 0 };
    expect(advanceScroll(s, 100, 10, 80)).toBe(80);
    expect(s.frac).toBeLessThan(1);
  });
});

describe("ring history", () => {
  /** Push rows whose every value is `v`. */
  function push(/** @type {ReturnType<typeof createRing>} */ r, /** @type {number} */ v) {
    const o = ringPush(r);
    r.data.fill(v, o, o + r.points);
  }

  it("starts as `lines` flat rows", () => {
    const r = createRing(4, 3);
    expect(r.data.length).toBe(12);
    for (let a = 0; a < 4; a++) expect(r.data[ringRow(r, a)]).toBe(0);
  });

  it("returns rows newest first and drops the oldest when full", () => {
    const r = createRing(3, 2);
    for (const v of [1, 2, 3, 4]) push(r, v);
    expect([0, 1, 2].map((a) => r.data[ringRow(r, a)])).toEqual([4, 3, 2]);
    expect(r.data[ringRow(r, 0) + 1]).toBe(4);
  });

  it("resizes keeping the newest rows in order, padding with flat rows", () => {
    const r = createRing(3, 2);
    for (const v of [1, 2, 3, 4]) push(r, v);
    const small = resizeRing(r, 2);
    expect([0, 1].map((a) => small.data[ringRow(small, a)])).toEqual([4, 3]);
    const big = resizeRing(r, 5);
    expect([0, 1, 2, 3, 4].map((a) => big.data[ringRow(big, a)])).toEqual([4, 3, 2, 0, 0]);
    push(big, 5);
    expect(big.data[ringRow(big, 0)]).toBe(5);
    expect(big.data[ringRow(big, 1)]).toBe(4);
  });
});

describe("stepGain", () => {
  /** Gain after `seconds` of a steady `level` at 60 Hz. */
  function settle(/** @type {number} */ level, seconds = 40, state = { level: 0.5 }) {
    let g = 0;
    for (let f = 0; f < seconds * 60; f++) g = stepGain(state, level, 1 / 60);
    return g;
  }

  it("brings quiet and loud tracks to the same peak height", () => {
    const quiet = 0.2 * settle(0.2);
    const loud = 0.9 * settle(0.9);
    expect(quiet).toBeCloseTo(loud, 2);
    expect(loud).toBeGreaterThan(0.5);
  });

  it("is slow: a sudden jump barely moves the gain within a frame", () => {
    const state = { level: 0.3 };
    const before = settle(0.3, 20, state);
    const after = stepGain(state, 1, 1 / 60);
    expect(after / before).toBeGreaterThan(0.9);
  });

  it("stays bounded in silence", () => {
    const g = settle(0, 60);
    expect(Number.isFinite(g)).toBe(true);
    expect(g).toBeLessThanOrEqual(6);
  });
});

describe("buildLine", () => {
  const P = 161;
  const env = new Float32Array(P);
  centralEnvelope(env, 0.25);
  const silentWave = new Float32Array(2048);
  const noise = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * 12.9898) * 0.4 + Math.sin(i * 0.05) * 0.2);
  const zero = new Float32Array(64);
  /** @param {number} lo @param {number} hi @param {number} v */
  const bandsWith = (lo, hi, v) => Float32Array.from({ length: 64 }, (_, i) => (i >= lo && i <= hi ? v : 0));
  const line = () => new Float32Array(P);
  const maxAbs = (/** @type {Float32Array} */ a, from = 0, to = a.length) => {
    let m = 0;
    for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]));
    return m;
  };

  it("is nearly flat in silence", () => {
    const out = line();
    const raw = buildLine(out, 0, env, zero, silentWave, 1, 7);
    expect(raw).toBe(0);
    expect(maxAbs(out)).toBeLessThan(0.01);
  });

  it("returns the raw (pre-gain) peak level of the enveloped bands", () => {
    expect(buildLine(line(), 0, env, bandsWith(0, 63, 0.5), silentWave, 3, 1)).toBeCloseTo(0.5, 2);
  });

  it("puts the bass in the middle and higher bands toward the bump's edges", () => {
    const bass = line();
    buildLine(bass, 0, env, bandsWith(0, 3, 1), silentWave, 1, 1);
    expect(bass[80]).toBeGreaterThan(0.3);
    expect(maxAbs(bass, 0, 65)).toBeLessThan(bass[80] * 0.2);

    const high = line();
    buildLine(high, 0, env, bandsWith(24, 36, 1), silentWave, 1, 1);
    expect(high[80]).toBeLessThan(0.02);
    const argmax = (/** @type {number} */ from, /** @type {number} */ to) => {
      let best = from;
      for (let i = from; i < to; i++) if (high[i] > high[best]) best = i;
      return best;
    };
    const left = argmax(0, 81);
    const right = argmax(80, P);
    expect(high[left]).toBeGreaterThan(0.05);
    expect(high[right]).toBeGreaterThan(0.05);
    expect(80 - left).toBeGreaterThan(10);
    expect(right - 80).toBeGreaterThan(10);
  });

  it("writes at the given offset and nowhere else", () => {
    const out = new Float32Array(P * 3).fill(9);
    buildLine(out, P, env, bandsWith(0, 63, 0.5), noise, 1, 1);
    expect(out[P - 1]).toBe(9);
    expect(out[2 * P]).toBe(9);
    expect(out[P + 80]).not.toBe(9);
  });

  it("jitter is deterministic given the same audio and seed", () => {
    const a = line();
    const b = line();
    buildLine(a, 0, env, bandsWith(0, 63, 0.6), noise, 1, 5);
    buildLine(b, 0, env, bandsWith(0, 63, 0.6), noise, 1, 5);
    expect(b).toEqual(a);
  });

  it("changes with the waveform and with the seed", () => {
    const a = line();
    const b = line();
    const c = line();
    const shifted = noise.map((v, i) => noise[(i + 300) % 2048]);
    buildLine(a, 0, env, bandsWith(0, 63, 0.6), noise, 1, 5);
    buildLine(b, 0, env, bandsWith(0, 63, 0.6), shifted, 1, 5);
    buildLine(c, 0, env, bandsWith(0, 63, 0.6), noise, 1, 6);
    const diff = (/** @type {Float32Array} */ x, /** @type {Float32Array} */ y) =>
      maxAbs(x.map((v, i) => v - y[i]));
    expect(diff(a, b)).toBeGreaterThan(0.05);
    expect(diff(a, c)).toBeGreaterThan(0.05);
  });

  it("is jagged and lopsided, not a mirrored spectrum", () => {
    const out = line();
    buildLine(out, 0, env, bandsWith(0, 63, 0.6), noise, 1, 3);
    let asym = 0;
    for (let i = 0; i < 80; i++) asym = Math.max(asym, Math.abs(out[i] - out[P - 1 - i]));
    expect(asym).toBeGreaterThan(0.1);
    // Several local maxima inside the bump, like the cover's multiple peaks.
    let peaks = 0;
    for (let i = 41; i < 120; i++) if (out[i] > out[i - 1] && out[i] > out[i + 1] && out[i] > 0.1) peaks++;
    expect(peaks).toBeGreaterThanOrEqual(3);
  });

  it("never dips more than a wiggle below the baseline", () => {
    const out = line();
    for (let seed = 0; seed < 50; seed++) {
      buildLine(out, 0, env, bandsWith(0, 63, 1), noise, 2, seed);
      expect(Math.min(...out)).toBeGreaterThan(-0.02);
    }
  });

  it("wiggles a little in the tails with the waveform, but stays low there", () => {
    const out = line();
    buildLine(out, 0, env, bandsWith(0, 63, 1), noise, 2, 3);
    const tail = maxAbs(out, 0, 30);
    expect(tail).toBeGreaterThan(0.006);
    expect(tail).toBeLessThan(0.04);
  });
});

describe("ridgeLayout", () => {
  const lay = () => ({ left: 0, width: 0, top: 0, bottom: 0, spacing: 0, amp: 0 });

  it("centres a plot narrower than it is tall in a landscape window, with margins", () => {
    const l = ridgeLayout(2560, 1440, 80, 1, lay());
    expect(l.left + l.width / 2).toBeCloseTo(1280);
    expect(l.width).toBeLessThan(1440);
    expect(l.width).toBeGreaterThan(700);
    expect(l.top).toBeGreaterThan(1440 * 0.05);
    expect(l.bottom).toBeLessThan(1440 * 0.95);
    expect(l.bottom).toBeGreaterThan(1440 * 0.85);
  });

  it("fits the width of a narrow portrait window, keeping side margins", () => {
    const l = ridgeLayout(600, 1600, 80, 1, lay());
    expect(l.left).toBeGreaterThan(20);
    expect(l.left + l.width).toBeLessThan(580);
  });

  it("spaces lines evenly from the top baseline to the bottom one, with headroom for peaks", () => {
    const l = ridgeLayout(2560, 1440, 80, 1, lay());
    expect(l.spacing * 79).toBeCloseTo(l.bottom - l.top);
    expect(l.amp).toBeGreaterThan(l.spacing * 6); // peaks overlap many lines, like the cover
    expect(l.top - l.amp * 0.6).toBeGreaterThan(0);
  });

  it("scales peak height with the Height param without moving the lines", () => {
    const a = ridgeLayout(2560, 1440, 80, 1, lay());
    const b = ridgeLayout(2560, 1440, 80, 2, lay());
    expect(b.amp).toBeCloseTo(a.amp * 2);
    expect(b.top).toBe(a.top);
    expect(b.spacing).toBe(a.spacing);
  });
});

describe("drawRidges", () => {
  const P = 5;
  const lay = { left: 100, width: 400, top: 50, bottom: 350, spacing: 100, amp: 200 };
  const ALL = Int16Array.from([0, 1, 2, 3, 4]);
  /** Four lines; the row pushed k-th (k = 1…4) has the value k/10 at every point. */
  function ring4() {
    const r = createRing(4, P);
    for (let k = 1; k <= 4; k++) {
      const o = ringPush(r);
      r.data.fill(k / 10, o, o + P);
    }
    return r;
  }
  /** Split the log into per-draw-call segments: the path ops before each fill/stroke. */
  function draws(/** @type {ReturnType<typeof fakeContext>["log"]} */ log) {
    const out = [];
    /** @type {typeof log} */
    let path = [];
    let pathId = 0;
    for (const e of log) {
      if (e.op === "begin") {
        path = [];
        pathId++;
      } else if (e.op === "fill" || e.op === "stroke") out.push({ ...e, path: path.slice(), pathId });
      else path.push(e);
    }
    return out;
  }

  it("erases under each line (destination-out) and then strokes it (source-over)", () => {
    const { log, ctx } = fakeContext();
    drawRidges(ctx, ring4(), ALL, lay, 0, "#ffffff", 3, 400);
    const d = draws(log);
    expect(d.map((e) => `${e.op}:${e.gco}`)).toEqual(
      Array(4).fill(["fill:destination-out", "stroke:source-over"]).flat(),
    );
    for (const s of d.filter((e) => e.op === "stroke")) {
      expect(s.style).toBe("#ffffff");
      expect(s.width).toBe(3);
    }
  });

  it("draws back to front: oldest (top) line first, newest (bottom) last", () => {
    const { log, ctx } = fakeContext();
    drawRidges(ctx, ring4(), ALL, lay, 0, "#fff", 1, 400);
    const strokes = draws(log).filter((e) => e.op === "stroke");
    // Baselines 50, 150, 250, 350 minus value × amp (oldest row holds 0.1).
    expect(strokes.map((s) => s.path[0].y)).toEqual([50 - 20, 150 - 40, 250 - 60, 350 - 80].map((v) => expect.closeTo(v, 4)));
  });

  it("draws only the points listed in `idx`, at their own x", () => {
    const { log, ctx } = fakeContext();
    drawRidges(ctx, ring4(), Int16Array.from([0, 2, 4]), lay, 0, "#fff", 1, 400);
    const d = draws(log);
    const front = d[d.length - 1];
    expect(front.path.map((p) => p.x)).toEqual([100, 300, 500]);
    expect(d[0].path.slice(0, 3).map((p) => p.x)).toEqual([100, 300, 500]);
  });

  it("clips to the plot's width for the whole draw", () => {
    const { log, ctx } = fakeContext();
    drawRidges(ctx, ring4(), ALL, lay, 0, "#fff", 1, 400);
    const ops = log.map((e) => e.op);
    expect(ops.slice(0, 4)).toEqual(["save", "begin", "rect", "clip"]);
    expect(log[2]).toMatchObject({ x: 100, w: 400 });
    expect(ops.at(-1)).toBe("restore");
  });

  it("front two lines stroke only their curve; back lines stroke the path they erased with, whose closing edges stay hidden", () => {
    const { log, ctx } = fakeContext();
    drawRidges(ctx, ring4(), ALL, lay, 0, "#fff", 2, 400);
    const d = draws(log);
    const strokes = d.filter((e) => e.op === "stroke");
    for (const s of strokes.slice(-2)) {
      expect(s.path.map((p) => p.op)).toEqual(["move", "line", "line", "line", "line"]);
      expect(s.path.map((p) => p.x)).toEqual([100, 200, 300, 400, 500]);
    }
    const lowest = (/** @type {typeof d[number]} */ f) =>
      Math.max(...f.path.filter((p) => p.y !== undefined).map((p) => /** @type {number} */ (p.y)));
    for (let k = 0; k < 2; k++) {
      const [fill, stroke, nextFill] = [d[2 * k], d[2 * k + 1], d[2 * k + 2]];
      expect(stroke.pathId).toBe(fill.pathId); // one trace, no beginPath in between
      const nextBase = 50 + (k + 1) * 100;
      expect(fill.path.at(-1)?.op).toBe("close");
      // The closing edges: from the curve's last point round to its first (closePath).
      const pts = [...fill.path.slice(P - 1, -1), fill.path[0]];
      let crossing = 0;
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = /** @type {{ x: number, y: number }[]} */ ([pts[i - 1], pts[i]]);
        // A segment entering the plot's interior is visible unless buried: below the next
        // line's baseline and inside the region the next line erases, with stroke margin.
        if (Math.max(a.x, b.x) <= 100.5 || Math.min(a.x, b.x) >= 499.5) continue;
        crossing++;
        for (const y of [a.y, b.y]) {
          expect(y).toBeGreaterThan(nextBase + 2);
          expect(y).toBeLessThan(lowest(nextFill) - 2);
        }
      }
      expect(crossing).toBe(1); // just the bottom edge
    }
  });

  it("every erase reaches below its own baseline by more than a line spacing", () => {
    const { log, ctx } = fakeContext();
    drawRidges(ctx, ring4(), ALL, lay, 0, "#fff", 2, 400);
    const fills = draws(log).filter((e) => e.op === "fill");
    fills.forEach((f, k) => {
      const lowest = Math.max(...f.path.filter((p) => p.y !== undefined).map((p) => /** @type {number} */ (p.y)));
      expect(lowest).toBeGreaterThan(50 + k * 100 + 100);
    });
  });

  it("offsets every line up by the scroll fraction and fades the oldest out, the newest in", () => {
    const { g, log, ctx } = fakeContext();
    drawRidges(ctx, ring4(), ALL, lay, 0.25, "#fff", 1, 400);
    const strokes = draws(log).filter((e) => e.op === "stroke");
    expect(strokes[3].path[0].y).toBeCloseTo(350 - 25 - 80);
    expect(strokes.map((s) => s.alpha)).toEqual([0.75, 1, 1, 0.25]);
    const fills = draws(log).filter((e) => e.op === "fill");
    expect(fills.map((s) => s.alpha)).toEqual([0.75, 1, 1, 0.25]);
    expect(g.globalAlpha).toBe(1);
    expect(g.globalCompositeOperation).toBe("source-over");
  });
});

describe("drawOrder", () => {
  it("keeps every point of the bump, thins the flat tails, and always keeps both ends", () => {
    const env = new Float32Array(97);
    centralEnvelope(env, 0.25);
    const idx = drawOrder(env, 4);
    const list = Array.from(idx);
    expect(list[0]).toBe(0);
    expect(list.at(-1)).toBe(96);
    for (let i = 1; i < list.length; i++) expect(list[i]).toBeGreaterThan(list[i - 1]);
    for (let i = 0; i < 97; i++) if (env[i] > 0) expect(list).toContain(i);
    const tail = list.filter((i) => env[i] === 0).length;
    const tailTotal = env.filter((v) => v === 0).length;
    expect(tail).toBeLessThan(tailTotal / 3);
  });
});
