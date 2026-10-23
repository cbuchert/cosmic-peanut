// @ts-check
import { describe, expect, it } from "vitest";
import { BEAT_STRENGTH, GLOW, REFRACTORY, STAMP, WRING, breath, createBeat, createGlow, stamp, wring } from "./beat.js";

/** A reusable fake audio frame carrying only what the beat envelope reads. */
function frame(bpm = 0) {
  return { bpm, beatPhase: 0, onset: false, onsetStrength: 0 };
}

/**
 * Run `seconds` of 120 BPM (or none, bpm 0) at `hz`, calling `each(beat, t)` after every step.
 * With a tempo, beatPhase ramps 0..1 every 0.5 s; onsets land on each beat at `strength`.
 * @param {number} hz @param {number} seconds @param {{ bpm?: number, strength?: number, onsets?: boolean }} o
 * @param {(b: ReturnType<typeof createBeat>, t: number) => void} each
 */
function run(hz, seconds, o, each) {
  const b = createBeat();
  const a = frame(o.bpm ?? 0);
  let lastBeat = -1;
  for (let f = 0; f < hz * seconds; f++) {
    const t = f / hz;
    const k = Math.floor(t * 2);
    a.beatPhase = a.bpm > 0 ? (t * 2) % 1 : 0;
    a.onset = (o.onsets ?? true) && k !== lastBeat;
    a.onsetStrength = a.onset ? (o.strength ?? 0.9) : 0;
    lastBeat = k;
    b.step(a, 1 / hz);
    each(b, t);
  }
  return b;
}

describe("createBeat", () => {
  it("starts at rest", () => {
    const b = createBeat();
    expect([b.env, b.swing, b.count, b.beat]).toEqual([0, 0, 0, false]);
  });

  it("with a confident tempo, counts a beat on each beatPhase wrap and peaks at 1 just after it", () => {
    for (const hz of [60, 120]) {
      let peak = 0;
      let beforeNext = 0;
      const b = run(hz, 4, { bpm: 120, onsets: false }, (b, t) => {
        const ph = (t * 2) % 1;
        if (t > 1 && ph < 0.3) peak = Math.max(peak, b.env);
        if (t > 1 && ph > 1 - 2 / hz) beforeNext = Math.max(beforeNext, b.env);
      });
      expect(b.count, `${hz} Hz`).toBe(7); // wraps at 0.5, 1.0 … 3.5 s
      expect(peak, `${hz} Hz peak`).toBeGreaterThan(0.98);
      expect(peak, `${hz} Hz peak`).toBeLessThanOrEqual(1);
      expect(beforeNext, `${hz} Hz tail`).toBeLessThan(0.02); // decays over about a beat
    }
  });

  it("eases in: no jump on the beat, peaks at 1 some 60–100 ms later", () => {
    for (const hz of [60, 120, 240]) {
      let t0 = -1;
      let peak = 0;
      let peakAt = 0;
      let maxStep = 0;
      let prev = 0;
      run(hz, 1.5, { bpm: 120, onsets: false }, (b, t) => {
        if (b.beat && t0 < 0 && t > 0.9) t0 = t;
        if (t0 >= 0 && t - t0 < 0.4) {
          if (b.env > peak) [peak, peakAt] = [b.env, t - t0];
          maxStep = Math.max(maxStep, (Math.abs(b.env - prev) * hz) / 60); // per 1/60 s
        }
        prev = b.env;
      });
      expect(peak, `${hz} Hz peak`).toBeGreaterThan(0.98);
      expect(peakAt, `${hz} Hz peak time`).toBeGreaterThanOrEqual(0.06 - 1 / hz);
      expect(peakAt, `${hz} Hz peak time`).toBeLessThanOrEqual(0.1 + 1 / hz);
      // An 80 ms smoothstep moves at most 1.5 × (1/60) / 0.08 = 0.31 per 1/60 s at its steepest;
      // a jump (the first cut's one-pole attack) moved ~0.67 in the first 1/60 s.
      expect(maxStep, `${hz} Hz steepest`).toBeLessThan(0.35);
    }
  });

  it("starts and ends its rise with zero slope (no click at either end)", () => {
    /** @type {number[]} */
    const v = [];
    let t0 = -1;
    run(240, 1.5, { bpm: 120, onsets: false }, (b, t) => {
      if (b.beat && t0 < 0 && t > 0.9) t0 = t;
      if (t0 >= 0) v.push(b.env);
    });
    // Second differences stay small everywhere: the velocity never jumps (a smoothstep's 6/RISE²
    // curvature is ~0.016 per (1/240 s)²; a jump in slope, as in a one-pole attack, is ~0.2).
    let maxJerk = 0;
    for (let k = 2; k < 100; k++) maxJerk = Math.max(maxJerk, Math.abs(v[k] - 2 * v[k - 1] + v[k - 2]));
    expect(maxJerk).toBeLessThan(0.03);
  });

  it("fades smoothly to nothing before the next beat", () => {
    let beforeNext = 1;
    run(120, 3, { bpm: 120, onsets: false }, (b, t) => {
      if (t > 1 && (t * 2) % 1 > 0.95) beforeNext = Math.min(beforeNext, 1 - b.env);
    });
    expect(1 - beforeNext).toBeLessThan(0.02);
  });

  it("flags `beat` on exactly the frame of each beat", () => {
    let flags = 0;
    run(60, 4, { bpm: 120, onsets: false }, (b) => {
      if (b.beat) flags++;
    });
    expect(flags).toBe(7);
  });

  it("swings to the opposite side on each beat, no more sharply than the attack itself", () => {
    let maxStep = 0;
    let maxEnvStep = 0;
    let prev = 0;
    let prevEnv = 0;
    /** @type {number[]} */
    const signs = [];
    run(120, 4, { bpm: 120, onsets: false }, (b, t) => {
      maxStep = Math.max(maxStep, Math.abs(b.swing - prev));
      prev = b.swing;
      maxEnvStep = Math.max(maxEnvStep, Math.abs(b.env - prevEnv));
      prevEnv = b.env;
      if (t > 0.6 && Math.abs((t * 2) % 1 - 0.15) < 1e-9) signs.push(Math.sign(b.swing));
    });
    expect(signs.length).toBeGreaterThan(4);
    for (let k = 1; k < signs.length; k++) expect(signs[k]).toBe(-signs[k - 1]);
    // The flip runs through the attack too: the swing moves at most the attack's step plus the
    // ~8% tail it starts from, never a full 2× jump from one side to the other.
    expect(maxStep).toBeLessThan(maxEnvStep * 1.2);
  });

  it("with a confident tempo, onsets only accent: no extra beats, no sign flips", () => {
    let flags = 0;
    // Onsets on every beat plus an off-beat one: the tempo still decides the count.
    const b = createBeat();
    const a = frame(120);
    for (let f = 0; f < 240; f++) {
      const t = f / 60;
      a.beatPhase = (t * 2) % 1;
      a.onset = f % 15 === 0;
      a.onsetStrength = a.onset ? 1 : 0;
      b.step(a, 1 / 60);
      if (b.beat) flags++;
    }
    expect(flags).toBe(7);
    expect(b.count).toBe(7);
  });

  it("without a tempo, beats come from strong onsets, with a refractory gap", () => {
    expect(BEAT_STRENGTH).toBeGreaterThan(0.3);
    expect(REFRACTORY).toBeGreaterThan(0.1);
    expect(REFRACTORY).toBeLessThan(0.3);
    let peak = 0;
    const b = run(60, 4, { strength: 0.9 }, (b) => (peak = Math.max(peak, b.env)));
    expect(b.count).toBe(8); // 0, 0.5 … 3.5 s
    expect(peak).toBeCloseTo(0.9, 2); // 0.9-strength onsets peak at their strength

    // Weak onsets are not beats.
    expect(run(60, 4, { strength: BEAT_STRENGTH * 0.8 }, () => {}).count).toBe(0);

    // Onsets closer than the refractory gap count once.
    const c = createBeat();
    const a = frame(0);
    for (let f = 0; f < 120; f++) {
      a.onset = f % 3 === 0; // 20 Hz
      a.onsetStrength = a.onset ? 1 : 0;
      c.step(a, 1 / 60);
    }
    expect(c.count).toBeLessThanOrEqual(Math.ceil(2 / REFRACTORY));
    expect(c.count).toBeGreaterThan(2);
  });

  it("is frame-rate independent: 60 Hz and 120 Hz rise and fall alike", () => {
    /** @type {number[][]} */
    const at = [[], []];
    [60, 120].forEach((hz, r) => {
      run(hz, 1.5, { bpm: 120, onsets: false }, (b, t) => {
        // Sample at instants on both grids: 1/30 s steps through the attack and the decay.
        const n = Math.round(t * 30);
        if (Math.abs(t * 30 - n) < 1e-9 && t > 1 && t < 1.5) at[r].push(b.env);
      });
    });
    expect(at[0].length).toBe(at[1].length);
    for (let k = 0; k < at[0].length; k++) expect(Math.abs(at[1][k] - at[0][k]), `sample ${k}`).toBeLessThan(0.025);
  });

  it("keeps an accent on the side the strip is already wringing to", () => {
    const b = createBeat();
    const a = frame(120);
    for (let f = 0; f < 120; f++) {
      const t = f / 60;
      a.beatPhase = (t * 2) % 1;
      a.onset = f === 112; // late in the 3rd beat (count 3: +), once the envelope has faded below the accent
      a.onsetStrength = a.onset ? 1 : 0;
      b.step(a, 1 / 60);
    }
    expect(b.count).toBe(3);
    expect(b.swing).toBeGreaterThan(0.1);
  });

  it("forgets the old tempo phase when the tempo drops out (no false beat when it returns)", () => {
    const b = createBeat();
    const a = frame(120);
    a.beatPhase = 0.9;
    b.step(a, 1 / 60);
    a.bpm = 0;
    a.beatPhase = 0;
    b.step(a, 1 / 60);
    a.bpm = 120;
    a.beatPhase = 0.2;
    b.step(a, 1 / 60);
    expect(b.count).toBe(0);
  });
});

describe("wring, breath and glow", () => {
  it("wrings gently at Beat 1 (0.15–0.25 rad) and about as hard as before at Beat 2", () => {
    expect(WRING).toBeGreaterThanOrEqual(0.15);
    expect(WRING).toBeLessThanOrEqual(0.25);
    expect(wring(1, 1)).toBeCloseTo(WRING, 12);
    expect(wring(-0.5, 2)).toBeCloseTo(-WRING, 12);
    expect(wring(1, 2)).toBeGreaterThan(0.33); // the first cut peaked at 0.45 × 0.8 = 0.36 rad
  });

  it("breathes the strip width by about 7% at Beat 1, about 14% at Beat 2", () => {
    expect(breath(1, 1)).toBeCloseTo(1.07, 12);
    expect(breath(1, 2)).toBeCloseTo(1.14, 12);
  });

  it("keeps the glow subtle at Beat 1", () => {
    expect(GLOW).toBeLessThanOrEqual(0.25);
    expect(2 * GLOW).toBeGreaterThan(0.45); // Beat 2 ≈ the first cut's 0.6 × 0.8
  });

  it("stamps rings pushed on the beat up to 1 + 0.8 × Beat louder", () => {
    expect(STAMP).toBeCloseTo(0.8, 12);
    expect(stamp(1, 1)).toBeCloseTo(1.8, 12);
    expect(stamp(0.5, 2)).toBeCloseTo(1.8, 12);
    expect(stamp(0, 1)).toBe(1);
  });

  it("does nothing at Beat 0, which is what the sphere gets (no beat param)", () => {
    expect(stamp(1, 0)).toBe(1);
    expect(wring(1, 0)).toBe(0);
    expect(breath(1, 0)).toBe(1);
    const g = createGlow();
    for (let f = 0; f < 60; f++) expect(g.step(f % 30 === 0 ? 1 : 0.5, 0, 1 / 60, false)).toBe(0);
  });

  it("glows with the envelope × Beat, much smaller under Reduce flashing", () => {
    expect(createGlow().step(0.8, 1, 1 / 60, false)).toBeCloseTo(0.8 * GLOW, 12);
    expect(createGlow().step(0.8, 2, 1 / 60, false)).toBeCloseTo(1.6 * GLOW, 12);
    const reduced = createGlow().step(0.8, 1, 1 / 60, true);
    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThanOrEqual(0.8 * GLOW * 0.3);
  });

  it("under Reduce flashing, starts at most 3 glows per second however fast the beats", () => {
    const g = createGlow();
    const b = createBeat();
    const a = frame(0);
    let rises = 0;
    let prev = 0;
    let rising = false;
    for (let f = 0; f < 600; f++) {
      a.onset = f % 6 === 0; // 10 Hz hits
      a.onsetStrength = a.onset ? 1 : 0;
      b.step(a, 1 / 60);
      const v = g.step(b.env, 1, 1 / 60, true);
      if (v > prev && !rising) rises++;
      rising = v > prev;
      prev = v;
    }
    expect(rises).toBeLessThanOrEqual(31);
  });
});
