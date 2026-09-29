// @ts-check
import { describe, expect, it } from "vitest";
import { computeFrames, createChains, createStepper, rippleWave } from "./tentacle.js";

describe("createStepper", () => {
  it("runs the same number of fixed steps per second at 60, 120 and 144 Hz", () => {
    for (const hz of [60, 120, 144]) {
      const st = createStepper(1 / 240, 8);
      let n = 0;
      for (let f = 0; f < hz * 2; f++) n += st.advance(1 / hz);
      expect(Math.abs(n - 480), `${hz} Hz`).toBeLessThanOrEqual(1);
    }
  });

  it("caps substeps on a long frame and drops the backlog instead of spiralling", () => {
    const st = createStepper(1 / 240, 8);
    expect(st.advance(0.1)).toBe(8);
    expect(st.advance(1 / 60)).toBe(4);
  });
});

/** Segment lengths of chain i. @param {ReturnType<typeof createChains>} c @param {number} i */
function lengths(c, i) {
  const out = [];
  for (let j = 1; j < c.nodes; j++) {
    const a = (i * c.nodes + j - 1) * 3;
    const b = a + 3;
    out.push(Math.hypot(c.pos[b] - c.pos[a], c.pos[b + 1] - c.pos[a + 1], c.pos[b + 2] - c.pos[a + 2]));
  }
  return out;
}

/** Position of node j of chain i. @param {ReturnType<typeof createChains>} c @param {number} i @param {number} j */
function node(c, i, j) {
  const o = (i * c.nodes + j) * 3;
  return [c.pos[o], c.pos[o + 1], c.pos[o + 2]];
}

describe("createChains", () => {
  it("keeps the first segment rigid along the face normal (the tentacle leaves its face square)", () => {
    const c = createChains(1, 12);
    c.segLen = 0.1;
    c.anchor(0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
    c.reset();
    for (let s = 0; s < 120; s++) {
      c.anchor(0, 0, Math.sin(s / 10), 0, 0.6, 0.8, 0, 0, 0, 1);
      c.step(1 / 240);
      expect(c.pos[3]).toBeCloseTo(0.06, 6);
      expect(c.pos[4] - Math.sin(s / 10)).toBeCloseTo(0.08, 6);
    }
  });

  const h = 1 / 240;

  it("keeps every segment at its rest length while the root is shaken hard", () => {
    const c = createChains(2, 24);
    c.segLen = 0.1;
    c.anchor(0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
    c.anchor(1, 0, 0, 0, 0, 1, 0, 1, 0, 0);
    c.reset();
    for (let s = 0; s < 240 * 3; s++) {
      const x = Math.sin(s * h * 9) * 0.8;
      c.anchor(0, x, 0, 0, 1, 0, 0, 0, 1, 0);
      c.anchor(1, 0, x, x, 0, 1, 0, 1, 0, 0);
      c.step(h);
      for (let i = 0; i < 2; i++) for (const l of lengths(c, i)) expect(Math.abs(l - 0.1)).toBeLessThan(0.002);
    }
  });

  it("stays bounded under violent shaking and loses energy once the root stops", () => {
    const c = createChains(6, 24);
    c.segLen = 0.1;
    c.anchor(0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
    c.reset();
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let s = 0; s < 240 * 5; s++) {
      for (let i = 0; i < 6; i++) c.anchor(i, rnd() * 0.3, rnd() * 0.3, rnd() * 0.3, 1, 0, 0, 0, 1, 0);
      c.step(h);
    }
    for (const v of c.pos) expect(Math.abs(v)).toBeLessThan(2.3 + 0.4);
    const speed = () => {
      let e = 0;
      for (let k = 0; k < c.pos.length; k++) e += (c.pos[k] - c.old[k]) ** 2;
      return e;
    };
    for (let i = 0; i < 6; i++) c.anchor(i, 0, 0, 0, 1, 0, 0, 0, 1, 0);
    c.step(h);
    const e0 = speed();
    for (let s = 0; s < 240 * 4; s++) c.step(h);
    expect(speed()).toBeLessThan(e0 * 0.01);
  });

  it("behaves identically at 60 and 120 Hz display rates (fixed timestep)", () => {
    const sim = (/** @type {number} */ hz) => {
      const c = createChains(1, 24);
      const st = createStepper(h, 8);
      c.anchor(0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
      c.reset();
      let t = 0;
      for (let f = 0; f < hz * 3; f++) {
        const n = st.advance(1 / hz);
        for (let s = 0; s < n; s++) {
          t += h;
          c.anchor(0, 0, Math.sin(t * 5), 0, 1, 0, 0, 0, 1, 0);
          c.step(h);
        }
      }
      return Array.from(c.pos);
    };
    expect(sim(120)).toEqual(sim(60));
  });

  it("drags behind a moving root (inertia), then settles back out along the face normal", () => {
    const c = createChains(1, 24);
    c.segLen = 0.1;
    c.anchor(0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
    c.reset();
    // Sweep the root 1 unit along +y over 0.25 s, then hold.
    let tipLag = 0;
    for (let s = 0; s < 60; s++) {
      c.anchor(0, 0, (s + 1) / 60, 0, 1, 0, 0, 0, 1, 0);
      c.step(h);
    }
    tipLag = 1 - node(c, 0, 23)[1];
    expect(tipLag).toBeGreaterThan(0.3); // the tip is well behind the root
    let overshoot = 0;
    for (let s = 0; s < 240 * 6; s++) {
      c.step(h);
      overshoot = Math.max(overshoot, node(c, 0, 23)[1] - 1);
    }
    expect(overshoot).toBeGreaterThan(0.02); // it whips past
    const tip = node(c, 0, 23);
    expect(tip[0]).toBeGreaterThan(2.1); // extended outward (23 × 0.1 = 2.3 at full length)
    expect(Math.abs(tip[1] - 1)).toBeLessThan(0.05); // settled
  });
});

describe("ripple", () => {
  it("rippleWave travels root → tip: each node peaks later than the one before it", () => {
    /** First time after 1 s at which node j peaks. @param {number} j */
    const peakTime = (j) => {
      let best = -Infinity;
      let at = 0;
      for (let t = 1; t < 1 + 1 / 1.5; t += 1 / 2000) {
        const v = rippleWave(j, 24, t);
        if (v > best) {
          best = v;
          at = t;
        }
      }
      return at;
    };
    expect(rippleWave(0, 24, 0.3)).toBe(0); // the root doesn't move
    const period = 1 / 1.5;
    /** How long after node a node b peaks (mod the period). @param {number} a @param {number} b */
    const delay = (a, b) => (((peakTime(b) - peakTime(a)) % period) + period) % period;
    const d1 = delay(4, 8);
    const d2 = delay(8, 12);
    expect(d1).toBeGreaterThan(0.02);
    expect(d1).toBeLessThan(period / 2); // later, not earlier (unambiguous direction)
    expect(d2).toBeCloseTo(d1, 2); // a constant speed
  });

  it("drives a sideways wave through a chain with a still root; zero amplitude keeps it straight", () => {
    const c = createChains(1, 24);
    c.anchor(0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
    c.reset();
    let maxSide = 0;
    for (let s = 0; s < 240 * 2; s++) {
      c.rippleAmp = 0;
      c.rippleTime = s / 240;
      c.step(1 / 240);
    }
    for (let j = 0; j < 24; j++) expect(Math.abs(c.pos[j * 3 + 1])).toBeLessThan(1e-6);
    for (let s = 0; s < 240 * 2; s++) {
      c.rippleAmp = 0.3;
      c.rippleTime = s / 240;
      c.step(1 / 240);
      maxSide = Math.max(maxSide, Math.abs(c.pos[16 * 3 + 1]));
    }
    expect(maxSide).toBeGreaterThan(0.05);
  });
});

describe("computeFrames", () => {
  /** A chain laid on a curve. @param {(u: number) => number[]} f */
  const chainOn = (f) => {
    const c = createChains(1, 24);
    for (let j = 0; j < 24; j++) c.pos.set(f(j / 23), j * 3);
    c.anchor(0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    return c;
  };
  const dot = (/** @type {ArrayLike<number>} */ a, /** @type {number} */ i, /** @type {ArrayLike<number>} */ b, /** @type {number} */ k) =>
    a[i] * b[k] + a[i + 1] * b[k + 1] + a[i + 2] * b[k + 2];

  it("gives orthonormal frames ⟂ the tangent with no flips along a helix", () => {
    const c = chainOn((u) => [u * 2, Math.cos(u * 9) * 0.4, Math.sin(u * 9) * 0.4]);
    const fr = new Float32Array(24 * 6);
    const tan = new Float32Array(24 * 3);
    computeFrames(c, fr, tan);
    for (let j = 0; j < 24; j++) {
      const n = j * 6;
      expect(dot(fr, n, fr, n)).toBeCloseTo(1, 4);
      expect(dot(fr, n + 3, fr, n + 3)).toBeCloseTo(1, 4);
      expect(dot(fr, n, fr, n + 3)).toBeCloseTo(0, 4);
      expect(dot(fr, n, tan, j * 3)).toBeCloseTo(0, 4);
      expect(dot(tan, j * 3, tan, j * 3)).toBeCloseTo(1, 4);
      if (j > 0) expect(dot(fr, n, fr, n - 6)).toBeGreaterThan(0.8);
    }
  });

  it("starts from the chain's side vector and doesn't twist along a planar curve", () => {
    // A curve in the x-y plane; side = +z is the plane normal, so the frame's normal stays +z.
    const c = chainOn((u) => [Math.sin(u * 2.5), 1 - Math.cos(u * 2.5), 0]);
    const fr = new Float32Array(24 * 6);
    const tan = new Float32Array(24 * 3);
    computeFrames(c, fr, tan);
    for (let j = 0; j < 24; j++) expect(fr[j * 6 + 2]).toBeCloseTo(1, 4);
  });
});
