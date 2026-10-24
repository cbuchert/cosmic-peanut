// @ts-check
import { describe, expect, it } from "vitest";
import { createCamera } from "./lattice-camera.js";
import { createPulses } from "./lattice-pulses.js";
import {
  LENGTH,
  SWAY_MAX,
  SWELL_MAX,
  MATERIALS,
  REDUCED_SWAY,
  createMaterials,
  isTentacle,
  motionParams,
  TWIST_CAP,
  createSway,
  createSwell,
  createTwists,
  swellWeight,
  envelope,
  envelopeMax,
  handshake,
  handshakeReach,
  strutDistance,
  tentacleGeometry,
  tubeRadius,
} from "./tentacle-lattice.js";

describe("tentacleGeometry and the worst-case envelope", () => {
  it("reaches Tentacle length of the way to the neighbour, tapering from a flared root", () => {
    const g = tentacleGeometry(0.42);
    expect(g.reach).toBeCloseTo(0.42, 9);
    expect(g.root).toBeGreaterThan(g.tip * 2);
    expect(g.half).toBeGreaterThan(g.root); // the root sits inside the cube's face
    expect(tentacleGeometry(9).reach).toBe(LENGTH.max);
    expect(tentacleGeometry(0).reach).toBe(LENGTH.min);
    expect(LENGTH.max).toBeLessThan(0.5); // opposing tips nearly meet, never cross
  });

  it("keeps every tentacle, at full sway, and every swollen cube out of the camera's channels", () => {
    const g = tentacleGeometry(LENGTH.max);
    // The farthest any tentacle surface gets from its strut's axis, anywhere along it.
    let worst = 0;
    for (let s = 0; s <= 1; s += 0.01) worst = Math.max(worst, envelope(s, g, SWAY_MAX));
    expect(worst).toBeLessThan(0.25);
    // The tentacles stay well inside their own strut's domain (half a cell to the next line).
    expect(worst).toBeLessThan(0.5 - 0.15);
    const corner = Math.sqrt(3) * g.half * (1 + SWELL_MAX);
    for (const seed of [1, 7, 42]) {
      const cam = createCamera(seed);
      let clear = Infinity;
      for (let f = 0; f < 240 * 60; f++) {
        cam.update(1 / 240, 2);
        const [x, y, z] = cam.pos;
        const fx = x - Math.round(x);
        const fy = y - Math.round(y);
        const fz = z - Math.round(z);
        const strut = Math.min(Math.hypot(fy, fz), Math.hypot(fx, fz), Math.hypot(fx, fy)) - worst;
        const node = Math.hypot(fx, fy, fz) - corner;
        clear = Math.min(clear, strut, node);
      }
      // Room for the near plane (0.02) and then some.
      expect(clear).toBeGreaterThan(0.15);
    }
  });
});

describe("envelopeMax", () => {
  it("bounds the envelope along the whole tentacle, tightly", () => {
    const g = tentacleGeometry(0.42);
    for (const amp of [0, 0.03, 0.08, SWAY_MAX]) {
      let worst = 0;
      for (let s = 0; s <= 1; s += 0.001) worst = Math.max(worst, envelope(s, g, amp));
      expect(envelopeMax(g, amp)).toBeGreaterThanOrEqual(worst);
      expect(envelopeMax(g, amp)).toBeLessThan(worst * 1.01 + 1e-4);
    }
  });
});

describe("tubeRadius", () => {
  it("flares ×1.35 at the root (as Tentacube's) and tapers steadily to the tip radius", () => {
    const g = tentacleGeometry(0.42);
    expect(tubeRadius(0, g)).toBeCloseTo(g.root * 1.35, 6);
    expect(tubeRadius(1, g)).toBeCloseTo(g.tip, 4);
    for (let s = 0; s < 1; s += 0.01) expect(tubeRadius(s + 0.01, g)).toBeLessThan(tubeRadius(s, g));
    // The flare is gone a quarter of the way out.
    expect(tubeRadius(0.25, g)).toBeLessThan(1.03 * (g.root + (g.tip - g.root) * 0.25));
  });
});

describe("handshake", () => {
  it("measures a strut by the L1 distance from the pulse's node to its midpoint", () => {
    const S = [0, 0, 0];
    expect(strutDistance(0, 0, 0, 0, S)).toBe(0.5); // x-strut from the source
    expect(strutDistance(-1, 0, 0, 0, S)).toBe(0.5); // and the one arriving at it
    expect(strutDistance(1, 0, 0, 0, S)).toBe(1.5);
    expect(strutDistance(1, 0, 0, 1, S)).toBe(1.5); // y-strut from (1, 0, 0)
    expect(strutDistance(2, -1, 3, 2, [1, 1, 1])).toBe(1 + 2 + 2.5);
  });

  it("shakes the struts at the front: not those it hasn't reached, nor those it left behind", () => {
    expect(handshake(-0.5)).toBe(0); // front still 0.5 short of the strut's midpoint
    expect(handshake(0.1)).toBeGreaterThan(0.9); // the front is at the strut
    expect(handshake(1.3)).toBe(0); // passed on
    // It reaches, holds a moment, then relaxes.
    expect(handshake(0.3)).toBeGreaterThan(0.9);
    expect(handshake(0.8)).toBeGreaterThan(0.05);
    expect(handshake(0.8)).toBeLessThan(0.9);
  });

  it("eases in and out (zero slope at both ends, no jumps) as a real pulse passes a strut", () => {
    const h = 1e-4;
    for (const lead of [-0.35, 1.2]) {
      expect(Math.abs(handshake(lead + h) - handshake(lead - h)) / (2 * h)).toBeLessThan(0.01);
    }
    // A pulse at 120 BPM passing a strut 1.5 cells out.
    const p = createPulses();
    const origin = new Float64Array(3);
    p.launch(origin, 1, false, 0.5);
    let prev = 0;
    let maxStep = 0;
    let peakAt = -1;
    let peak = 0;
    for (let f = 1; f <= 240 * 0.5; f++) {
      p.step(1 / 240, origin);
      const v = p.amp[0] * handshake(p.data[3] - 1.5);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
      if (v > peak) {
        peak = v;
        peakAt = f / 240;
      }
    }
    // The front (3 cells over 0.45 s) reaches 1.5 at 0.225 s; the shake peaks just after.
    expect(peakAt).toBeGreaterThan(0.2);
    expect(peakAt).toBeLessThan(0.3);
    expect(peak).toBeGreaterThan(0.3);
    expect(maxStep).toBeLessThan(0.1);
  });

  it("at full shake the opposing tentacles reach until their tips touch", () => {
    const g = tentacleGeometry(0.42);
    expect(handshakeReach(g, 0)).toBeCloseTo(0.42, 9);
    // Touching mid-strut: tip at 0.5 less its radius, so the two caps meet.
    expect(handshakeReach(g, 1) + g.tip).toBeCloseTo(0.5, 6);
    expect(handshakeReach(g, 0.5)).toBeGreaterThan(0.42);
  });
});

describe("createTwists", () => {
  const origin = new Float64Array([10, 0, -4]);
  /** Run a twist kicked at t = 0 for `seconds`; returns [t, angle] for slot 0. */
  const run = (/** @type {number} */ twitch, /** @type {boolean} */ reduce, seconds = 3) => {
    const tw = createTwists(3);
    tw.kick(new Float64Array([12.4, 1.6, -3.5]), twitch, reduce);
    /** @type {[number, number][]} */
    const trace = [];
    for (let f = 1; f <= 240 * seconds; f++) {
      tw.step(1 / 240, origin);
      trace.push([f / 240, tw.data[3]]);
    }
    return { tw, trace };
  };

  it("twists only the node it was kicked at, about one of its axes", () => {
    const tw = createTwists(3);
    tw.kick(new Float64Array([12.4, 1.6, -3.5]), 1, false);
    tw.step(0.1, origin);
    // Node (12, 2, -3) relative to the origin; the other slots idle.
    expect(Array.from(tw.data.subarray(0, 3))).toEqual([2, 2, 1]);
    expect(tw.data[3]).toBeGreaterThan(0);
    expect([0, 1, 2]).toContain(tw.axis[0]);
    for (let i = 1; i < TWIST_CAP; i++) expect(tw.data[i * 4 + 3]).toBe(0);
  });

  it("eases into a quarter turn, overshoots, settles, then frees its slot", () => {
    const { trace } = run(1, false);
    const quarter = Math.PI / 2;
    expect(trace[4][1]).toBeLessThan(0.01 * quarter); // ~17 ms in: barely moving
    const max = Math.max(...trace.map(([, a]) => a));
    expect(max).toBeGreaterThan(1.1 * quarter);
    expect(max).toBeLessThan(1.45 * quarter);
    let maxStep = 0;
    for (let i = 1; i < trace.length; i++) {
      const d = Math.abs(trace[i][1] - trace[i - 1][1]);
      // The release back to 0 is a whole quarter turn: the cube looks the same, so skip it.
      if (Math.abs(d - quarter) > 0.05) maxStep = Math.max(maxStep, d);
    }
    expect(maxStep).toBeLessThan(0.06);
    expect(trace[trace.length - 1][1]).toBe(0); // settled and released
  });

  it("Twitch 0 never twists; Reduce motion turns slowly with no overshoot", () => {
    expect(Math.max(...run(0, false).trace.map(([, a]) => a))).toBe(0);
    const calm = run(1, true, 4).trace;
    const quarter = Math.PI / 2;
    expect(Math.max(...calm.map(([, a]) => a))).toBeLessThanOrEqual(quarter * 1.01);
    const t90 = (/** @type {[number, number][]} */ tr) => /** @type {[number, number]} */ (tr.find(([, a]) => a > 0.9 * quarter))[0];
    expect(t90(calm)).toBeGreaterThan(2 * t90(run(1, false).trace));
  });

  it("keeps TWIST_CAP twists, recycling the oldest", () => {
    const tw = createTwists(3);
    for (let k = 0; k <= TWIST_CAP; k++) tw.kick(new Float64Array([k, 0, 0]), 1, false);
    tw.step(0.05, new Float64Array(3));
    const xs = Array.from({ length: TWIST_CAP }, (_, i) => tw.data[i * 4]).sort((a, b) => a - b);
    expect(xs).toEqual(Array.from({ length: TWIST_CAP }, (_, i) => i + 1));
  });
});

describe("createSway", () => {
  /** Bands with mids and highs at `v`, bass silent. */
  const upper = (/** @type {number} */ v) => {
    const b = new Float32Array(64);
    for (let i = 16; i < 64; i++) b[i] = v;
    return b;
  };

  it("never sways past SWAY_MAX, whatever Sway, Reactivity and the music do", () => {
    for (const sway of [0, 0.5, 1, 2, 5]) {
      for (const react of [0, 1, 2]) {
        const s = createSway();
        for (let f = 0; f < 240; f++) {
          s.step(upper(f % 20 < 10 ? 1 : 0), 1 / 60, sway, react, false);
          expect(s.amp).toBeLessThanOrEqual(SWAY_MAX + 1e-9);
          expect(s.amp).toBeGreaterThanOrEqual(0);
        }
      }
    }
    const still = createSway();
    still.step(upper(1), 1 / 60, 0, 1, false);
    expect(still.amp).toBe(0);
  });

  it("ripples harder and faster with the mids and highs, eased in", () => {
    const s = createSway();
    const quiet = createSway();
    /** @type {number[]} */
    const rip = [];
    for (let f = 0; f < 90; f++) {
      s.step(upper(0.8), 1 / 60, 1, 1, false);
      quiet.step(upper(0), 1 / 60, 1, 1, false);
      rip.push(s.ripple);
    }
    expect(rip[0]).toBeLessThan(0.15 * rip[89]);
    for (let f = 1; f < 90; f++) expect(rip[f] - rip[f - 1]).toBeLessThan(0.1);
    expect(s.amp).toBeGreaterThan(quiet.amp);
    expect(s.clock).toBeGreaterThan(quiet.clock);
  });

  it("is damped a lot under Reduce motion", () => {
    const s = createSway();
    const r = createSway();
    for (let f = 0; f < 120; f++) {
      s.step(upper(0.8), 1 / 60, 1, 1, false);
      r.step(upper(0.8), 1 / 60, 1, 1, true);
    }
    expect(r.amp).toBeLessThanOrEqual(REDUCED_SWAY * s.amp + 1e-9);
    expect(REDUCED_SWAY).toBeLessThanOrEqual(0.35);
    expect(r.clock).toBeLessThan(0.5 * s.clock);
  });
});

describe("createSwell and swellWeight", () => {
  it("swells with heavy bass, eased and bounded, and not at all in silence", () => {
    const s = createSwell();
    /** @type {number[]} */
    const xs = [];
    for (let f = 0; f < 120; f++) xs.push(s.step(1.8, 1 / 60, 2, false));
    expect(xs[0]).toBeLessThan(0.2 * xs[119]);
    expect(Math.max(...xs)).toBeLessThanOrEqual(SWELL_MAX);
    expect(xs[119]).toBeGreaterThan(0.5 * SWELL_MAX);
    const q = createSwell();
    for (let f = 0; f < 60; f++) q.step(1, 1 / 60, 1, false);
    expect(q.value).toBeCloseTo(0, 6);
    const r = createSwell();
    for (let f = 0; f < 120; f++) r.step(1.8, 1 / 60, 2, true);
    expect(r.value).toBeLessThan(0.4 * xs[119]);
  });

  it("is local: only the nodes nearest the camera swell", () => {
    expect(swellWeight(0.7)).toBeGreaterThan(0.6); // the nearest nodes (≥ 0.6 from the path)
    expect(swellWeight(1.6)).toBeLessThan(0.2);
    expect(swellWeight(3)).toBeLessThan(0.001);
    for (let d = 0; d < 4; d += 0.1) expect(swellWeight(d + 0.1)).toBeLessThan(swellWeight(d));
  });
});

describe("createMaterials", () => {
  it("offers auto and Tentacube's four materials", () => {
    expect(MATERIALS).toEqual(["auto", "chrome", "iridescent", "emissive", "obsidian"]);
  });

  it("auto moves chrome → iridescent every 16 bars with a slow, eased crossfade", () => {
    const m = createMaterials();
    /** @type {Float32Array[]} */
    const ws = [];
    for (let f = 0; f < 60 * 40; f++) ws.push(m.step(1 / 60, "auto", 0.1, 120).slice());
    expect(Array.from(ws[60])).toEqual([1, 0, 0, 0]);
    // 16 bars of 4/4 at 120 BPM = 32 s.
    expect(ws[60 * 31][0]).toBe(1);
    expect(ws[60 * 39][1]).toBe(1);
    let maxStep = 0;
    for (let f = 1; f < ws.length; f++) {
      const sum = ws[f].reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
      maxStep = Math.max(maxStep, Math.abs(ws[f][1] - ws[f - 1][1]));
    }
    expect(maxStep).toBeLessThan(0.02); // over a second or more, never a cut
  });

  it("a fixed material fades to it and stays; unknown names behave as auto", () => {
    const m = createMaterials();
    let w = m.step(1 / 60, "obsidian", 0.1, 120);
    for (let f = 0; f < 60 * 40; f++) w = m.step(1 / 60, "obsidian", 0.1, 120);
    expect(Array.from(w)).toEqual([0, 0, 0, 1]);
    const u = createMaterials();
    for (let f = 0; f < 60 * 40; f++) w = u.step(1 / 60, "plaid", 0.1, 120);
    expect(w[1]).toBe(1);
  });
});

describe("isTentacle and motionParams", () => {
  it("picks the variant by the visualizer id", () => {
    expect(isTentacle("tentacle-lattice")).toBe(true);
    expect(isTentacle("lattice")).toBe(false);
    expect(isTentacle("")).toBe(false);
  });

  it("passes Sway and Twitch through, clamped; Reduce motion calms Twitch at its default", () => {
    const out = { sway: 0, twitch: 0 };
    expect(motionParams({ sway: 1.5, twitch: 0.5 }, false, out)).toEqual({ sway: 1.5, twitch: 0.5 });
    expect(motionParams({ sway: 9, twitch: -1 }, false, out)).toEqual({ sway: 2, twitch: 0 });
    // Twitch 1 is the default: Reduce motion swaps in Tentacube's calmer 0.3; a chosen value stays.
    expect(motionParams({ sway: 1, twitch: 1 }, true, out).twitch).toBeCloseTo(0.3, 9);
    expect(motionParams({ sway: 1, twitch: 2 }, true, out).twitch).toBe(2);
    expect(motionParams({ sway: "x", twitch: undefined }, false, out)).toEqual({ sway: 1, twitch: 1 });
  });
});
