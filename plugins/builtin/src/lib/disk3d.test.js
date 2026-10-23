// @ts-check
import { describe, expect, it } from "vitest";
import {
  CAMERAS,
  CLEAR,
  COIN,
  coinDistance,
  createCoinMotion,
  createCounterSpin,
  createDirector,
  createDrive,
  createKicks,
  createWaveRim,
  MOVES,
  MUSIC_LEVEL,
  RIM_POINTS,
  rippleLift,
  SCENES,
  specLift,
  SPHERE_R,
  WALL_MARGIN,
} from "./disk3d.js";

const DT = 1 / 60;

/** Small seeded PRNG. @param {number} seed */
function rng(seed) {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 2048-sample tone: freq cycles per 2048 samples, starting at phase. */
function tone(/** @type {number} */ cycles, /** @type {number} */ phase, amp = 0.5) {
  return Float32Array.from({ length: 2048 }, (_, i) => amp * Math.sin((2 * Math.PI * cycles * i) / 2048 + phase));
}

describe("waveform rim", () => {
  it("closes without a seam: both ends ease to zero", () => {
    const rim = createWaveRim();
    const ring = rim.build(tone(37, 0.4), 1, 1);
    expect(ring.length).toBe(RIM_POINTS);
    expect(Math.abs(ring[0])).toBeLessThan(0.02);
    expect(Math.abs(ring[RIM_POINTS - 1])).toBeLessThan(0.02);
    // The middle carries the wave, normalized to about ±1.
    let peak = 0;
    for (const v of ring) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.7);
    expect(peak).toBeLessThanOrEqual(1);
    // Around the seam the steps stay small (no notch).
    const step = Math.abs(ring[0] - ring[RIM_POINTS - 1]);
    expect(step).toBeLessThan(0.05);
  });

  it("triggers on a rising zero crossing, so a steady tone stands still whatever its phase", () => {
    const a = Float32Array.from(createWaveRim().build(tone(37, 0.3), 1, 1));
    for (const ph of [1.1, 2.5, 4.0, 5.7]) {
      const b = createWaveRim().build(tone(37, ph), 1, 1);
      for (let i = 0; i < RIM_POINTS; i++) expect(b[i]).toBeCloseTo(a[i], 1);
    }
  });

  it("eases in time (no clicks), scales with Reactivity, and fills the same array", () => {
    const rim = createWaveRim();
    const ring = rim.build(new Float32Array(2048), DT, 1);
    expect(Array.from(ring).every((v) => v === 0)).toBe(true);
    const r1 = rim.build(tone(37, 0.4), DT, 1);
    expect(r1).toBe(ring);
    let peak = 0;
    for (const v of r1) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(0.6); // one frame in: part of the way
    for (let i = 0; i < 30; i++) rim.build(tone(37, 0.4), DT, 1);
    peak = 0;
    for (const v of ring) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.7);
    const zero = createWaveRim();
    for (let i = 0; i < 30; i++) zero.build(tone(37, 0.4), DT, 0);
    expect(Array.from(zero.ring).every((v) => v === 0)).toBe(true);
    const two = createWaveRim();
    for (let i = 0; i < 30; i++) two.build(tone(37, 0.4), DT, 2);
    let p2 = 0;
    for (const v of two.ring) p2 = Math.max(p2, Math.abs(v));
    expect(p2).toBeGreaterThan(1.5 * peak);
    expect(p2).toBeLessThanOrEqual(2);
  });

  it("keeps the rim outside the printed face at full reactivity", () => {
    expect(COIN.face + COIN.bevel - 2 * COIN.waveAmp).toBeGreaterThan(COIN.face);
  });
});

describe("coin motion: mids spin it, bass tilts and wobbles it", () => {
  const input = (over = {}) => ({ midAtt: 1, bassAtt: 1, env: 0, reactivity: 1, reduceMotion: false, ...over });

  it("louder mids spin faster; the rate eases (no jumps)", () => {
    const quiet = createCoinMotion();
    const loud = createCoinMotion();
    let jump = 0;
    let last = loud.spinRate;
    for (let i = 0; i < 300; i++) {
      quiet.step(DT, input({ midAtt: 0.8 }));
      loud.step(DT, input({ midAtt: i < 150 ? 0.8 : 1.8 }));
      jump = Math.max(jump, Math.abs(loud.spinRate - last));
      last = loud.spinRate;
    }
    expect(loud.spinRate).toBeGreaterThan(1.5 * quiet.spinRate);
    expect(quiet.spinRate).toBeGreaterThan(0);
    expect(jump).toBeLessThan(0.02);
    expect(loud.spin).toBeGreaterThan(quiet.spin);
  });

  it("bass tilts it like a spinning plate (the tilt precesses), bounded and smooth", () => {
    const c = createCoinMotion();
    let most = 0;
    let jump = 0;
    let px = 0;
    let pz = 0;
    const seen = new Set();
    for (let i = 0; i < 600; i++) {
      c.step(DT, input({ bassAtt: 1.8, env: (i % 30) / 30 }));
      most = Math.max(most, c.tilt);
      jump = Math.max(jump, Math.hypot(c.tiltX - px, c.tiltZ - pz));
      px = c.tiltX;
      pz = c.tiltZ;
      seen.add(Math.sign(c.tiltX) * 2 + Math.sign(c.tiltZ));
      expect(Math.hypot(c.normal[0], c.normal[1], c.normal[2])).toBeCloseTo(1, 9);
    }
    expect(most).toBeGreaterThan(0.1);
    expect(most).toBeLessThanOrEqual(COIN.maxTilt);
    expect(jump).toBeLessThan(0.02);
    expect(seen.size).toBeGreaterThanOrEqual(4); // the tilt has gone round
  });

  it("Reactivity 0: a steady base spin and no tilt; Reduce motion is calmer", () => {
    const c = createCoinMotion();
    const r = createCoinMotion();
    const calm = createCoinMotion();
    for (let i = 0; i < 300; i++) {
      c.step(DT, input({ midAtt: 1.8, bassAtt: 1.8, reactivity: 0 }));
      r.step(DT, input({ midAtt: 1.8, bassAtt: 1.8 }));
      calm.step(DT, input({ midAtt: 1.8, bassAtt: 1.8, reduceMotion: true }));
    }
    expect(c.tilt).toBeCloseTo(0, 6);
    expect(c.spinRate).toBeGreaterThan(0);
    expect(calm.spinRate).toBeLessThan(0.5 * r.spinRate);
    expect(calm.tilt).toBeLessThan(0.5 * r.tilt);
  });
});

describe("coin motion: the drive paces it", () => {
  it("spins and wobbles at the drive's pace: calm in silence, quick with the music", () => {
    const silent = createCoinMotion();
    const music = createCoinMotion();
    for (let i = 0; i < 300; i++) {
      silent.step(DT, { midAtt: 1, bassAtt: 1, env: 0, reactivity: 1, reduceMotion: false, pace: 0.25 });
      music.step(DT, { midAtt: 1, bassAtt: 1, env: 0, reactivity: 1, reduceMotion: false, pace: 2 });
    }
    expect(silent.spinRate).toBeGreaterThan(0);
    expect(music.spinRate).toBeGreaterThan(6 * silent.spinRate);
  });
});

describe("the sphere's counter-spin", () => {
  it("turns the other way to the coin, scaled by Spin, eased", () => {
    const s = createCounterSpin();
    let jump = 0;
    let last = 0;
    let coin = 0;
    for (let i = 0; i < 600; i++) {
      const rate = i < 300 ? 0.3 : 0.9;
      coin += rate * DT;
      s.step(DT, rate, 1);
      jump = Math.max(jump, Math.abs(s.rate - last));
      last = s.rate;
    }
    expect(Math.sign(s.angle)).toBe(-Math.sign(coin));
    expect(s.rate).toBeLessThan(0);
    expect(jump).toBeLessThan(0.01);
    const off = createCounterSpin();
    const fast = createCounterSpin();
    for (let i = 0; i < 300; i++) {
      off.step(DT, 0.5, 0);
      fast.step(DT, 0.5, 2);
    }
    expect(off.angle).toBe(0);
    expect(fast.angle).toBeLessThan(0);
    expect(Math.abs(fast.rate)).toBeGreaterThan(Math.abs(s.rate) * 0.5);
  });
});

describe("beat kicks and the impact ripple", () => {
  const period = 0.5;

  it("the ripple reaches a tile after travelling, rises over ~80 ms, settles by ~0.9 beat, and stays local", () => {
    expect(rippleLift(0, 1, period)).toBe(0); // not there yet
    let peak = 0;
    let peakAt = 0;
    let last = 0;
    let jump = 0;
    for (let i = 0; i < 200; i++) {
      const age = i / 200;
      const v = rippleLift(age, 0, period);
      if (v > peak) [peak, peakAt] = [v, age];
      jump = Math.max(jump, Math.abs(v - last));
      last = v;
    }
    expect(peak).toBeCloseTo(1, 2);
    expect(peakAt).toBeGreaterThan(0.06);
    expect(peakAt).toBeLessThan(0.1);
    expect(rippleLift(0.9 * period + 0.01, 0, period)).toBe(0);
    expect(jump).toBeLessThan(0.1); // smooth at this sampling (smoothstep slope 1.5 / 80 ms)
    // Far tiles hardly move: it's a local lift.
    let far = 0;
    for (let i = 0; i < 400; i++) far = Math.max(far, rippleLift(i / 100, 4, period));
    expect(far).toBeLessThan(0.05);
  });

  it("kicks once per beat: an eased lurch along a new direction, then a glide out", () => {
    const k = createKicks();
    let env = 0;
    /** @type {number[]} */
    const dist = [];
    const dirs = [];
    for (let i = 0; i < 240; i++) {
      const t = i * DT;
      const ph = (t % 0.5) / 0.5;
      env = ph < 0.16 ? (ph / 0.16) ** 2 * (3 - 2 * ph / 0.16) : Math.max(0, 1 - (ph - 0.16) / 0.74);
      dist.push(k.step(DT, { env, reactivity: 1, period: 0.5 }));
      dirs.push(Math.atan2(k.dir[1], k.dir[0]));
    }
    expect(k.count).toBeGreaterThanOrEqual(7);
    expect(Math.max(...dist)).toBeGreaterThan(0.005);
    expect(Math.min(...dist)).toBeGreaterThanOrEqual(0);
    // Eased: the step grows and shrinks gradually.
    const most = Math.max(...dist);
    for (let i = 1; i < dist.length; i++) expect(Math.abs(dist[i] - dist[i - 1])).toBeLessThan(0.35 * most); // the envelope's 80 ms smoothstep: ≤ 1.5 × 1/5 a frame
    expect(new Set(dirs.map((d) => d.toFixed(1))).size).toBeGreaterThan(3);
    expect(Math.hypot(k.impact[0], k.impact[1])).toBeLessThan(0.75);
    // Reactivity 0: no kick.
    const z = createKicks();
    expect(z.step(DT, { env: 1, reactivity: 0, period: 0.5 })).toBe(0);
  });
});

describe("spectrum heave by hyperbolic ring", () => {
  it("maps the centre to the low bands and the rim to the high ones, interpolated", () => {
    const bands = Float32Array.from({ length: 16 }, (_, i) => i / 15);
    expect(specLift(bands, 0, 4)).toBeCloseTo(0, 6);
    expect(specLift(bands, 4, 4)).toBeCloseTo(1, 6);
    expect(specLift(bands, 2, 4)).toBeCloseTo(0.5, 1);
    let last = -1;
    for (let d = 0; d <= 5; d += 0.05) {
      const v = specLift(bands, d, 4);
      expect(v).toBeGreaterThanOrEqual(last - 1e-9);
      last = v;
    }
  });
});

describe("camera director", () => {
  const opts = (over = {}) => ({ stepped: false, speed: 1, reduceMotion: false, camera: "auto", normal: [0, 1, 0], ...over });

  it("lists its moves, cameras and scenes", () => {
    expect(MOVES).toEqual(["orbit", "swoop", "skim", "pullback"]);
    expect(CAMERAS).toEqual(["auto", "still"]);
    expect(SCENES).toEqual(["flat", "sphere"]);
  });

  it("never clips the coin or leaves the sphere, through every move and tilt", () => {
    const d = createDirector();
    const r = rng(4);
    const n = [0, 1, 0];
    let minD = Infinity;
    let maxR = 0;
    const seen = new Set();
    for (let i = 0; i < 60 * 600; i++) {
      // A wobbling coin at its largest tilt.
      const a = i * 0.013;
      n[0] = Math.sin(COIN.maxTilt) * Math.cos(a);
      n[2] = Math.sin(COIN.maxTilt) * Math.sin(a);
      n[1] = Math.cos(COIN.maxTilt);
      d.step(DT, opts({ stepped: i % 120 === 0, speed: 0.5 + 2 * r(), normal: n }));
      seen.add(d.move);
      minD = Math.min(minD, coinDistance(d.eye, n, COIN.face + COIN.bevel + 2 * COIN.waveAmp));
      maxR = Math.max(maxR, Math.hypot(d.eye[0], d.eye[1], d.eye[2]));
    }
    expect(seen.size).toBe(4);
    expect(minD).toBeGreaterThanOrEqual(CLEAR - 1e-9);
    expect(maxR).toBeLessThanOrEqual(SPHERE_R - WALL_MARGIN + 1e-9);
  });

  it("changes move only on phrase changes (8 bars) and eases across, never jumping", () => {
    const d = createDirector();
    let changes = 0;
    let move = d.move;
    let jump = 0;
    const e = Float64Array.from(d.eye);
    for (let i = 0; i < 60 * 120; i++) {
      d.step(DT, opts({ stepped: i % 120 === 0 && i > 0 }));
      if (d.move !== move) {
        changes++;
        move = d.move;
      }
      jump = Math.max(jump, Math.hypot(d.eye[0] - e[0], d.eye[1] - e[1], d.eye[2] - e[2]));
      e.set(d.eye);
    }
    // 59 bar steps → 7 phrases; the dwell may skip one.
    expect(changes).toBeGreaterThanOrEqual(4);
    expect(changes).toBeLessThanOrEqual(7);
    expect(jump).toBeLessThan(0.08);
  });

  it("bass speed carries it further; Reduce motion is slow, calm and stays off the face", () => {
    const slow = createDirector();
    const fast = createDirector();
    const calm = createDirector();
    let ps = 0;
    let pf = 0;
    let pc = 0;
    const a = Float64Array.from(slow.eye);
    const b = Float64Array.from(fast.eye);
    const c = Float64Array.from(calm.eye);
    for (let i = 0; i < 600; i++) {
      slow.step(DT, opts({ speed: 1 }));
      fast.step(DT, opts({ speed: 2 }));
      calm.step(DT, opts({ speed: 1, reduceMotion: true, stepped: i % 60 === 0 }));
      ps += Math.hypot(slow.eye[0] - a[0], slow.eye[1] - a[1], slow.eye[2] - a[2]);
      pf += Math.hypot(fast.eye[0] - b[0], fast.eye[1] - b[1], fast.eye[2] - b[2]);
      pc += Math.hypot(calm.eye[0] - c[0], calm.eye[1] - c[1], calm.eye[2] - c[2]);
      a.set(slow.eye);
      b.set(fast.eye);
      c.set(calm.eye);
      expect(["orbit", "pullback"]).toContain(calm.move);
    }
    expect(pf).toBeGreaterThan(1.5 * ps);
    expect(pc).toBeLessThan(0.5 * ps);
  });

  it("the music's intensity widens every move, eased (the eye never jumps on a beat)", () => {
    for (const m of [0, 1, 2, 3]) {
      const span = (/** @type {(i: number) => number} */ k) => {
        const d = createDirector();
        d.force(m);
        let lo = Infinity;
        let hi = -Infinity;
        let jump = 0;
        const e = Float64Array.from(d.eye);
        for (let i = 0; i < 60 * 40; i++) {
          d.step(DT, opts({ intensity: k(i) }));
          if (i > 60 * 6) {
            const r = Math.hypot(d.eye[0], d.eye[1], d.eye[2]);
            lo = Math.min(lo, d.eye[1] / r);
            hi = Math.max(hi, d.eye[1] / r);
            jump = Math.max(jump, Math.hypot(d.eye[0] - e[0], d.eye[1] - e[1], d.eye[2] - e[2]));
          }
          e.set(d.eye);
        }
        return { range: hi - lo, jump };
      };
      const calm = span(() => 0);
      const beat = span((i) => {
        const a = (i % 30) / 30;
        return a < 0.16 ? (a / 0.16) ** 2 * (3 - (2 * a) / 0.16) : Math.max(0, 1 - (a - 0.16) / 0.74);
      });
      expect(beat.range, MOVES[m]).toBeGreaterThan(1.3 * calm.range + 0.01);
      expect(beat.jump, MOVES[m]).toBeLessThan(0.08);
    }
  });

  it("a drag takes over and eases back; Camera still holds a fixed view", () => {
    const d = createDirector();
    for (let i = 0; i < 60; i++) d.step(DT, opts());
    const before = Float64Array.from(d.eye);
    d.pointer({ kind: "down", x: 100, y: 100, dx: 0, dy: 0 });
    d.pointer({ kind: "move", x: 300, y: 100, dx: 200, dy: 0 });
    d.step(DT, opts({ speed: 0 }));
    const moved = Math.hypot(d.eye[0] - before[0], d.eye[2] - before[2]);
    expect(moved).toBeGreaterThan(0.5);
    d.pointer({ kind: "up", x: 300, y: 100, dx: 0, dy: 0 });
    for (let i = 0; i < 300; i++) d.step(DT, opts({ speed: 0 }));
    expect(Math.hypot(d.eye[0] - before[0], d.eye[1] - before[1], d.eye[2] - before[2])).toBeLessThan(0.05);
    const still = createDirector();
    still.step(DT, opts({ camera: "still" }));
    const s0 = Float64Array.from(still.eye);
    for (let i = 0; i < 300; i++) still.step(DT, opts({ camera: "still", stepped: i % 30 === 0, speed: 2 }));
    expect(Math.hypot(still.eye[0] - s0[0], still.eye[1] - s0[1], still.eye[2] - s0[2])).toBeLessThan(1e-9);
  });
});

describe("the music drive: what paces the camera, the spin and the drift", () => {
  const input = (over = {}) => ({ live: true, bassAtt: 1, env: 0, reactivity: 1, reduceMotion: false, ...over });
  /** A beat envelope at 120 BPM: 80 ms smoothstep rise, linear-ish fall over 0.9 beat. @param {number} t */
  const beatEnv = (t) => {
    const a = t % 0.5;
    if (a < 0.08) return smoothstep(a / 0.08);
    return Math.max(0, 1 - (a - 0.08) / 0.37);
  };
  /** @param {number} x */
  function smoothstep(x) {
    return x * x * (3 - 2 * x);
  }

  it("silence settles to a calm drift well under the music's pace, eased both ways", () => {
    const d = createDrive();
    let jump = 0;
    let last = d.level;
    let silent = 0;
    let loud = 0;
    for (let i = 0; i < 60 * 12; i++) {
      const live = i >= 60 * 6;
      d.step(DT, input({ live, bassAtt: live ? 1 + 0.5 * Math.sin(i * 0.1) : 1, env: live ? beatEnv(i * DT) : 0 }));
      jump = Math.max(jump, Math.abs(d.level - last));
      last = d.level;
      if (i === 60 * 6 - 1) silent = d.level;
      if (i >= 60 * 10) loud += d.level / (60 * 2);
    }
    expect(silent).toBeLessThan(0.35);
    expect(silent).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(3 * silent);
    expect(jump).toBeLessThan(0.6); // never a click: a beat's surge (~3) rises over several frames
  });

  it("each beat surges it: an eased rise, back down before the next beat", () => {
    const d = createDrive();
    for (let i = 0; i < 120; i++) d.step(DT, input());
    const rest = d.level;
    /** @type {number[]} */
    const lv = [];
    for (let i = 0; i < 60; i++) {
      d.step(DT, input({ env: i < 30 ? beatEnv(i * DT) : 0 }));
      lv.push(d.level);
    }
    const peak = Math.max(...lv);
    const at = lv.indexOf(peak);
    expect(peak).toBeGreaterThan(rest + 1);
    expect(at).toBeGreaterThan(3); // eased, not on the first frame
    expect(at).toBeLessThan(15); // but within a quarter second
    expect(lv[29]).toBeLessThan(rest + 0.35 * (peak - rest)); // gone by the next beat
    // Eased as the beat envelope is (an 80 ms smoothstep): no frame takes more than a third of it.
    for (let i = 1; i < lv.length; i++) expect(Math.abs(lv[i] - lv[i - 1])).toBeLessThan(0.33 * (peak - rest));
    expect(d.surge).toBeGreaterThanOrEqual(0);
  });

  it("bass raises it; Reactivity 0 keeps the plain pace; Reduce motion damps the surge", () => {
    const low = createDrive();
    const high = createDrive();
    const flat = createDrive();
    const calm = createDrive();
    let pc = 0;
    let pn = 0;
    const norm = createDrive();
    for (let i = 0; i < 300; i++) {
      low.step(DT, input({ bassAtt: 0.7 }));
      high.step(DT, input({ bassAtt: 1.6 }));
      flat.step(DT, input({ bassAtt: 1.6, env: beatEnv(i * DT), reactivity: 0 }));
      calm.step(DT, input({ env: beatEnv(i * DT), reduceMotion: true }));
      norm.step(DT, input({ env: beatEnv(i * DT) }));
      pc = Math.max(pc, calm.level);
      pn = Math.max(pn, norm.level);
    }
    expect(high.level).toBeGreaterThan(1.5 * low.level);
    expect(flat.level).toBeCloseTo(MUSIC_LEVEL, 6);
    expect(pc - MUSIC_LEVEL).toBeLessThan(0.5 * (pn - MUSIC_LEVEL));
  });
});
