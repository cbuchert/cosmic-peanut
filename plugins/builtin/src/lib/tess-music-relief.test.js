// @ts-check
// The music that drives the carved relief (lib/tess-music.js): beat waves of lifting tiles,
// the spectrum's heave by ring, onset pops and the card-flip wave.
// @ts-expect-error -- a Node builtin (tests run in Node); the web tsconfig has no @types/node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BEAT_ACCENT,
  createBeat,
  createHeave,
  createInversion,
  createPops,
  createTessState,
  LIGHT_DEFAULT,
  LIGHT_ELEVATION,
  LIFT_VARY,
  lightDir,
  RELIEF_DEFAULT,
  REDUCED_FLASH_LIFT,
  reliefParam,
  flipAngle,
  flipHop,
  FLIP_HOP,
  INVERT_GAP,
  POP_FALL,
  POP_GAIN,
  POP_SLOTS,
  REDUCED_FLIP_HOP,
  createLiftWave,
  LIFT_BINS,
  LIFT_GAIN,
  HEAVE_GAIN,
  MIN_CROSS,
  REDUCED_LIFT,
  RISE,
  SPRING_ZETA,
  WAVE_BEATS,
  WAVE_SETTLE,
  wavePulse,
} from "./tess-music.js";
import { CARD_HALF, CARD_RISE, RELIEF_BEVEL, RELIEF_BLOCK, RELIEF_DOME } from "./tess.js";

const DT = 1 / 60;

describe("wave pulse (one tile's lift as a front passes it)", () => {
  it("is 0 until the front arrives, then eases up over RISE with a smoothstep to 1", () => {
    expect(wavePulse(-0.5)).toBe(0);
    expect(wavePulse(0)).toBe(0);
    expect(wavePulse(RISE / 2)).toBeCloseTo(0.5, 9);
    expect(wavePulse(RISE)).toBeCloseTo(1, 9);
    // Smoothstep starts flat: the first frame barely moves (no click).
    expect(wavePulse(DT)).toBeLessThan(0.35);
    expect(wavePulse(0.001)).toBeLessThan(0.001);
  });

  it("settles back like a released spring: a small dip under rest, at rest by WAVE_SETTLE", () => {
    const after = [];
    for (let t = RISE; t <= RISE + WAVE_SETTLE + 0.5; t += 0.001) after.push(wavePulse(t));
    const min = Math.min(...after);
    expect(min).toBeLessThan(-0.02); // it does overshoot (a spring, not a fade)…
    expect(min).toBeGreaterThan(-0.15); // …but only a little
    expect(SPRING_ZETA).toBeGreaterThan(0.4);
    expect(wavePulse(RISE + WAVE_SETTLE)).toBe(0);
    expect(wavePulse(RISE + WAVE_SETTLE + 1)).toBe(0);
    // Down to a tenth within half a second of the peak: it reads as a lift per beat, not a swell.
    expect(Math.abs(wavePulse(RISE + 0.5))).toBeLessThan(0.1);
  });

  it("is smooth everywhere: no step, and its slope never jumps (no snap at the peak or rest)", () => {
    const h = 1e-4;
    const slope = (/** @type {number} */ t) => (wavePulse(t + h) - wavePulse(t - h)) / (2 * h);
    for (const t of [0, RISE, RISE + WAVE_SETTLE]) {
      expect(Math.abs(wavePulse(t + 1e-6) - wavePulse(t - 1e-6))).toBeLessThan(1e-4);
      expect(Math.abs(slope(t + 2 * h) - slope(t - 2 * h))).toBeLessThan(0.5);
    }
    // At 60 fps no frame moves it by more than a third of the way.
    let worst = 0;
    for (let t = -0.1; t < 1.5; t += DT) worst = Math.max(worst, Math.abs(wavePulse(t + DT) - wavePulse(t)));
    expect(worst).toBeLessThan(0.35);
  });
});

/** Drive createBeat + createLiftWave; `audio(i)` gives the frame's beat input. */
function runWave(/** @type {any} */ o) {
  const beat = createBeat();
  const w = createLiftWave();
  const frames = [];
  for (let i = 0; i < Math.round(o.seconds / DT); i++) {
    const a = o.audio ? o.audio(i) : { bpm: 120, beatPhase: (0.3 + i * DT * 2) % 1, onset: false, onsetStrength: 0 };
    beat.step(a, DT);
    w.step(DT, {
      beat: beat.beat,
      tempo: beat.tempo,
      accent: beat.tempo ? beat.count % 4 === 1 : true,
      period: beat.period,
      strength: a.onsetStrength,
      reactivity: o.reactivity ?? 1,
      reduceMotion: o.reduceMotion ?? false,
    });
    frames.push({ beat: beat.beat, count: beat.count, front: w.front, lift: Float32Array.from(w.lift), same: w.lift });
  }
  return frames;
}
const ringOf = (/** @type {number} */ bin) => bin / (LIFT_BINS - 1);
/** Frame of the largest lift of a bin within [from, to). */
const peakAt = (/** @type {any[]} */ f, /** @type {number} */ bin, from = 0, to = f.length) => {
  let best = from;
  for (let i = from; i < to; i++) if (f[i].lift[bin] > f[best].lift[bin]) best = i;
  return best;
};

describe("beat wave (tiles lift as a front spreads out from the ring origin)", () => {
  it("each tempo beat sends a front from ring 0 to ring 1 over WAVE_BEATS beats; tiles lift as it passes", () => {
    const f = runWave({ seconds: 3 });
    const b0 = f.findIndex((x) => x.beat);
    expect(b0).toBeGreaterThan(0);
    const cross = Math.max(MIN_CROSS, WAVE_BEATS * 0.5);
    for (const bin of [0, 8, 16, 31]) {
      const want = (b0 + (RISE + ringOf(bin) * cross) / DT);
      expect(Math.abs(peakAt(f, bin, b0, b0 + 50) - want)).toBeLessThanOrEqual(1.5);
    }
    // Before the beat nothing is lifted; just after it only the inner rings are.
    expect(Math.max(...f[b0 - 1].lift)).toBe(0);
    const early = f[b0 + 8].lift;
    expect(early[0]).toBeGreaterThan(0.5 * Math.max(...early));
    expect(early[LIFT_BINS - 1]).toBe(0);
    // The front reported for pops runs out with it.
    expect(f[b0 + 3].front).toBeLessThan(f[b0 + 20].front);
    expect(f.every((x) => x.same === f[0].same)).toBe(true); // filled in place
  });

  it("a bar's first beat lifts the most; the other beats by BEAT_ACCENT of it", () => {
    const f = runWave({ seconds: 5 });
    const peaks = [];
    for (let i = 0; i < f.length - 30; i++) if (f[i].beat) peaks.push({ count: f[i].count, h: f[peakAt(f, 0, i, i + 20)].lift[0] });
    const accent = peaks.filter((p) => p.count % 4 === 1);
    const other = peaks.filter((p) => p.count % 4 !== 1);
    expect(accent.length).toBeGreaterThan(0);
    for (const p of accent) expect(p.h).toBeCloseTo(LIFT_GAIN, 2);
    for (const p of other) expect(p.h).toBeCloseTo(LIFT_GAIN * BEAT_ACCENT, 2);
  });

  it("without a tempo, strong onsets send waves, scaled by their strength", () => {
    const f = runWave({ seconds: 2, audio: (/** @type {number} */ i) => ({ bpm: 0, beatPhase: 0, onset: i === 30, onsetStrength: 0.7 }) });
    expect(f[peakAt(f, 0)].lift[0]).toBeCloseTo(0.7 * LIFT_GAIN, 2);
    const weak = runWave({ seconds: 2, audio: (/** @type {number} */ i) => ({ bpm: 0, beatPhase: 0, onset: i === 30, onsetStrength: 0.3 }) });
    expect(Math.max(...weak.map((x) => x.lift[0]))).toBe(0);
  });

  it("waves overlap smoothly; past its slots a wave is dropped, never cut short (no snap)", () => {
    // Huge onsets at 5 Hz with no tempo: more waves than slots.
    const f = runWave({ seconds: 6, audio: (/** @type {number} */ i) => ({ bpm: 0, beatPhase: 0, onset: i % 12 === 0, onsetStrength: 1 }) });
    let worst = 0;
    for (let i = 1; i < f.length; i++) for (let b = 0; b < LIFT_BINS; b++) worst = Math.max(worst, Math.abs(f[i].lift[b] - f[i - 1].lift[b]));
    expect(worst).toBeLessThan(0.4 * LIFT_GAIN);
    for (const x of f) for (const v of x.lift) expect(v).toBeLessThanOrEqual(1.5 * LIFT_GAIN + 1e-6);
  });

  it("Reactivity scales it (0 is still, 2 is twice 1); Reduce motion lifts less and spreads slower", () => {
    const peak = (/** @type {any} */ o) => Math.max(...runWave({ seconds: 3, ...o }).map((x) => x.lift[0]));
    expect(peak({ reactivity: 0 })).toBe(0);
    expect(peak({ reactivity: 2 })).toBeCloseTo(2 * peak({ reactivity: 1 }), 5);
    expect(peak({ reduceMotion: true })).toBeCloseTo(REDUCED_LIFT * peak({}), 5);
    expect(REDUCED_LIFT).toBeLessThanOrEqual(0.5);
    const f = runWave({ seconds: 3 });
    const g = runWave({ seconds: 3, reduceMotion: true });
    const b0 = f.findIndex((x) => x.beat);
    expect(peakAt(g, LIFT_BINS - 1, b0, b0 + 120) - b0).toBeGreaterThan(1.5 * (peakAt(f, LIFT_BINS - 1, b0, b0 + 120) - b0));
  });

  it("is clearly visible at the defaults: a beat lifts a tile by more than its own block height", () => {
    expect(LIFT_GAIN * BEAT_ACCENT).toBeGreaterThan(RELIEF_BLOCK);
  });
});

describe("spectrum heave (every ring of tiles rides its share of the spectrum)", () => {
  /** Run createHeave on `bands(i)` for `seconds`; returns per-frame copies. */
  function runHeave(/** @type {(i: number) => Float32Array} */ bands, seconds = 2, reactivity = 1) {
    const h = createHeave();
    const out = [];
    for (let i = 0; i < Math.round(seconds / DT); i++) out.push(Float32Array.from(h.step(bands(i), DT, reactivity)));
    return out;
  }
  const only = (/** @type {number} */ lo, /** @type {number} */ hi, v = 0.6) => {
    const b = new Float32Array(64);
    for (let i = lo; i < hi; i++) b[i] = v;
    return b;
  };

  it("bass lifts the inner rings, treble the outer", () => {
    const bass = runHeave(() => only(0, 8)).at(-1) ?? new Float32Array(0);
    const treble = runHeave(() => only(56, 64, 0.1)).at(-1) ?? new Float32Array(0);
    expect(bass.length).toBe(LIFT_BINS);
    expect(bass[0]).toBeGreaterThan(0.6 * HEAVE_GAIN);
    expect(bass[LIFT_BINS - 1]).toBeLessThan(0.01 * HEAVE_GAIN);
    expect(treble[LIFT_BINS - 1]).toBeGreaterThan(0.6 * HEAVE_GAIN); // quiet treble still shows
    expect(treble[0]).toBeLessThan(0.01 * HEAVE_GAIN);
  });

  it("is smoothed in time (no jitter) and across rings (no lone tile)", () => {
    // Every band flickering between 0.2 and 0.6 each frame.
    const f = runHeave((i) => new Float32Array(64).fill(i % 2 ? 0.6 : 0.2), 3);
    let ripple = 0;
    for (let i = 120; i < f.length; i++) ripple = Math.max(ripple, Math.abs(f[i][10] - f[i - 1][10]));
    expect(ripple).toBeLessThan(0.06 * HEAVE_GAIN);
    // One band alone spreads to its neighbours, never a spike.
    const one = runHeave(() => only(20, 22)).at(-1) ?? new Float32Array(0);
    expect(one[9]).toBeGreaterThan(0.2 * one[10]);
    expect(one[11]).toBeGreaterThan(0.2 * one[10]);
  });

  it("rises within a beat and falls back more slowly, without steps", () => {
    const f = runHeave((i) => (i < 60 ? only(0, 64) : new Float32Array(64)), 2.5);
    const top = f[59][16];
    expect(f[15][16]).toBeGreaterThan(0.7 * top); // 0.25 s in
    expect(f[60 + 6][16]).toBeGreaterThan(0.5 * top); // 0.1 s after it stops: still easing down
    expect(f.at(-1)?.[16]).toBeLessThan(0.02 * HEAVE_GAIN);
    let worst = 0;
    for (let i = 1; i < f.length; i++) worst = Math.max(worst, Math.abs(f[i][16] - f[i - 1][16]));
    expect(worst).toBeLessThan(0.25 * HEAVE_GAIN);
  });

  it("silence and Reactivity 0 leave it flat; Reactivity 2 is twice 1", () => {
    expect(Math.max(...(runHeave(() => new Float32Array(64)).at(-1) ?? []))).toBe(0);
    expect(Math.max(...(runHeave(() => only(0, 64), 2, 0).at(-1) ?? []))).toBe(0);
    const one = runHeave(() => only(0, 64), 2, 1).at(-1)?.[5] ?? 0;
    const two = runHeave(() => only(0, 64), 2, 2).at(-1)?.[5] ?? 0;
    expect(two).toBeCloseTo(2 * one, 5);
  });
});

describe("onset pops (single tiles near the front hop briefly)", () => {
  /** Drive createPops; `o.events(i)` gives { onset, strength, beat, front }. */
  function runPops(/** @type {any} */ o) {
    const p = createPops();
    const out = [];
    for (let i = 0; i < Math.round(o.seconds / DT); i++) {
      const e = { onset: false, strength: 0, beat: false, front: -1, ...(o.events?.(i) ?? {}) };
      p.step(DT, { ...e, reactivity: o.reactivity ?? 1, reduceMotion: o.reduceMotion ?? false });
      out.push(Float32Array.from(p.pops));
    }
    return out;
  }

  it("an onset pops tiles at the wave's front: a small eased hop, gone by RISE + POP_FALL", () => {
    const f = runPops({ seconds: 1, events: (/** @type {number} */ i) => (i === 10 ? { onset: true, strength: 0.8, front: 0.4 } : {}) });
    expect(f[0].length).toBe(POP_SLOTS * 4);
    const slot = [0, 1, 2].find((k) => f[12][k * 4] > 0) ?? -1;
    expect(slot).toBeGreaterThanOrEqual(0);
    const v = f.map((x) => x[slot * 4]);
    expect(f[12][slot * 4 + 1]).toBeCloseTo(0.4, 6); // at the front's ring
    expect(Math.max(...v)).toBeCloseTo(0.8 * POP_GAIN, 3);
    expect(v[11]).toBeLessThan(0.35 * POP_GAIN); // eased in, not jumped
    expect(v[10 + Math.ceil((RISE + POP_FALL) / DT) + 1]).toBe(0);
    expect(POP_GAIN).toBeLessThan(0.5 * LIFT_GAIN); // small next to a beat
  });

  it("beats and weak onsets don't pop; each pop picks other tiles; a full set drops onsets", () => {
    expect(Math.max(...runPops({ seconds: 1, events: () => ({ onset: true, strength: 1, beat: true }) }).flatMap((x) => Array.from(x)))).toBe(0);
    expect(Math.max(...runPops({ seconds: 1, events: () => ({ onset: true, strength: 0.1 }) }).flatMap((x) => Array.from(x)))).toBe(0);
    const f = runPops({ seconds: 2, events: (/** @type {number} */ i) => ({ onset: i % 3 === 0, strength: 1, front: 0.5 }) });
    const seeds = new Set();
    let worst = 0;
    for (let i = 1; i < f.length; i++)
      for (let k = 0; k < POP_SLOTS; k++) {
        if (f[i][k * 4] > 0) seeds.add(f[i][k * 4 + 2]);
        worst = Math.max(worst, Math.abs(f[i][k * 4] - f[i - 1][k * 4]));
      }
    expect(seeds.size).toBeGreaterThan(3);
    expect(worst).toBeLessThan(0.35 * POP_GAIN);
  });

  it("Reactivity 0 never pops; Reduce motion pops lower", () => {
    const ev = (/** @type {number} */ i) => (i === 5 ? { onset: true, strength: 1, front: 0.2 } : {});
    expect(Math.max(...runPops({ seconds: 1, events: ev, reactivity: 0 }).flatMap((x) => Array.from(x)))).toBe(0);
    const a = Math.max(...runPops({ seconds: 1, events: ev }).map((x) => Math.max(x[0], x[4], x[8])));
    const b = Math.max(...runPops({ seconds: 1, events: ev, reduceMotion: true }).map((x) => Math.max(x[0], x[4], x[8])));
    expect(b).toBeLessThan(0.5 * a);
  });
});

describe("flip wave (figure/ground as cards turning over)", () => {
  /** An inversion under 120 BPM; per frame the turn of tiles at rings 0…1. */
  function runFlip(/** @type {any} */ o) {
    const beat = createBeat();
    const inv = createInversion();
    const out = [];
    for (let i = 0; i < Math.round(o.seconds / DT); i++) {
      const a = o.audio ? o.audio(i) : { bpm: 120, beatPhase: (i * DT * 2) % 1, onset: false, onsetStrength: 0 };
      beat.step(a, DT);
      inv.step(DT, { beat: beat.beat, tempo: beat.tempo, onset: a.onset, onsetStrength: a.onsetStrength, reactivity: 1, reduceFlashing: o.reduceFlashing ?? false });
      out.push({ started: inv.started, shift: inv.shift, th: [0, 0.25, 0.5, 0.75, 1].map((r) => flipAngle(inv.front, inv.width, r)) });
    }
    return out;
  }

  it("each tile turns 0 → π, easing in and out, the inner rings first; the shift lands as they finish", () => {
    const f = runFlip({ seconds: 22 });
    const s = f.findIndex((x) => x.started);
    expect(s).toBeGreaterThan(0);
    const done = f.findIndex((x) => x.shift === 1);
    for (let k = 0; k < 5; k++) {
      const th = f.slice(s, done).map((x) => x.th[k]);
      expect(th[0]).toBeCloseTo(0, 3);
      expect(th.at(-1)).toBeCloseTo(Math.PI, 3);
      for (let i = 1; i < th.length; i++) expect(th[i]).toBeGreaterThanOrEqual(th[i - 1] - 1e-9);
    }
    const half = (/** @type {number} */ k) => f.findIndex((x, i) => i >= s && x.th[k] >= Math.PI / 2);
    expect(half(0)).toBeLessThan(half(2));
    expect(half(2)).toBeLessThan(half(4));
    // After the shift the cards are flat again (their back is the new front).
    expect(f[done].th.every((t) => t < 0.01)).toBe(true);
  });

  it("is flash-limited: no card turns fast, flips start at least INVERT_GAP apart", () => {
    const strobe = (/** @type {number} */ i) => ({ bpm: 0, beatPhase: 0, onset: i % 6 === 0, onsetStrength: 1 });
    const f = runFlip({ seconds: 30, audio: strobe });
    const starts = f.map((x, i) => (x.started ? i * DT : -1)).filter((t) => t >= 0);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(INVERT_GAP - 1e-9);
    let worst = 0;
    for (let i = 1; i < f.length; i++) if (f[i].shift === f[i - 1].shift) for (let k = 0; k < 5; k++) worst = Math.max(worst, Math.abs(f[i].th[k] - f[i - 1].th[k]));
    expect(worst).toBeLessThan(0.15); // under 9° a frame
  });

  it("Reduce flashing: much slower, and the cards hop less", () => {
    const strobe = (/** @type {number} */ i) => ({ bpm: 0, beatPhase: 0, onset: i % 6 === 0, onsetStrength: 1 });
    const rate = (/** @type {any[]} */ f) => {
      let w = 0;
      for (let i = 1; i < f.length; i++) if (f[i].shift === f[i - 1].shift) for (let k = 0; k < 5; k++) w = Math.max(w, Math.abs(f[i].th[k] - f[i - 1].th[k]));
      return w;
    };
    expect(rate(runFlip({ seconds: 40, audio: strobe, reduceFlashing: true }))).toBeLessThan(0.34 * rate(runFlip({ seconds: 40, audio: strobe })));
    expect(flipHop(false)).toBe(FLIP_HOP);
    expect(flipHop(true)).toBe(REDUCED_FLIP_HOP);
    expect(REDUCED_FLIP_HOP).toBeLessThan(0.5 * FLIP_HOP);
  });
});

describe("relief params", () => {
  it("Relief is 0–1 (default about 0.6); unknown values are off", () => {
    expect(RELIEF_DEFAULT).toBeCloseTo(0.6, 6);
    expect(reliefParam(0.6)).toBeCloseTo(0.6, 9);
    expect(reliefParam(-1)).toBe(0);
    expect(reliefParam(3)).toBe(1);
    expect(reliefParam("nope")).toBe(0);
  });

  it("Light is the raking light's direction round the view (degrees, 0 = from the right, counter-clockwise)", () => {
    const out = new Float32Array(3);
    for (const deg of [0, 90, 135, 200, 359]) {
      lightDir(deg, out);
      expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 6);
      expect(out[2]).toBeCloseTo(Math.sin(LIGHT_ELEVATION), 6);
      expect(Math.atan2(out[1], out[0])).toBeCloseTo(Math.atan2(Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)), 6);
    }
    // Raking: low, so the carving casts long shadows; the default comes from the upper left.
    expect(LIGHT_ELEVATION).toBeLessThan(0.7);
    expect(LIGHT_ELEVATION).toBeGreaterThan(0.3);
    expect(LIGHT_DEFAULT).toBe(135);
  });
});

describe("tess state with relief", () => {
  function frame(/** @type {number} */ t, over = {}) {
    return { bands: new Float32Array(64).fill(0.3), bpm: 120, beatPhase: (t * 2) % 1, onset: false, onsetStrength: 0, centroid: 0.15, bassAtt: 1.2, silent: false, ...over };
  }
  const opts = (over = {}) => ({ symmetry: "p4", palette: "four-block", reactivity: 1, speed: 1, morph: 0.7, ink: 1, hatching: 0.6, height: 1440, reduceMotion: false, reduceFlashing: false, ...over });
  /** The drums: a strong onset on every beat and the off-beats, bands pulsing with them. */
  const drums = (/** @type {number} */ i) => {
    const t = i * DT;
    const ph = (t * 4) % 1;
    const b = new Float32Array(64);
    for (let k = 0; k < 64; k++) b[k] = 0.2 + 0.4 * Math.exp(-ph * 6) * (k < 16 ? 1 : 0.4);
    return frame(t, { bands: b, onset: i % 15 === 0, onsetStrength: i % 30 === 0 ? 0.9 : 0.5 });
  };

  it("leaves everything the flat surfaces read exactly as without relief", () => {
    const a = createTessState();
    const b = createTessState();
    for (let i = 0; i < 1400; i++) {
      const sa = a.step(drums(i), DT, opts());
      const sb = b.step(drums(i), DT, opts({ relief: 0.6 }));
      for (const key of ["ab", "blend", "cls", "clsNext", "avg", "invert", "bands", "featA", "featB", "reg"]) {
        expect(Array.from(/** @type {any} */ (sb)[key])).toEqual(Array.from(/** @type {any} */ (sa)[key]));
      }
      expect([sb.env, sb.travel, sb.shift, sb.inkW]).toEqual([sa.env, sa.travel, sa.shift, sa.inkW]);
    }
  });

  it("fills lift (wave + heave), pops and the height bound in place, and the bound holds", () => {
    const st = createTessState();
    const s0 = st.step(drums(0), DT, opts({ relief: 0.6 }));
    const lift = s0.lift;
    const pops = s0.pops;
    let flipped = false;
    for (let i = 1; i < 2400; i++) {
      const s = st.step(drums(i), DT, opts({ relief: 0.6 }));
      expect(s.lift).toBe(lift);
      expect(s.pops).toBe(pops);
      expect(s.lift.length).toBe(LIFT_BINS);
      flipped ||= s.flipping;
      // Highest tile now: the largest lift with its per-tile variation, every pop on it, a card.
      let top = 0;
      for (const v of s.lift) top = Math.max(top, v);
      let pop = 0;
      for (let k = 0; k < POP_SLOTS; k++) pop += s.pops[k * 4];
      const h = s.relief * (RELIEF_BLOCK + top * 1.3 + pop) + (s.flipping ? CARD_RISE * (2 * CARD_HALF + s.flipHop) : 0);
      expect(s.reliefMax).toBeGreaterThanOrEqual(h - 1e-9);
    }
    expect(flipped).toBe(true);
    expect(st.step(drums(0), DT, opts({ relief: 0 })).reliefMax).toBe(0);
  });

  it("stronger defaults: at Relief and Reactivity's defaults a bar's beat lifts tiles a fifth of a tile", () => {
    const st = createTessState();
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      const s = st.step(frame(i * DT), DT, opts({ relief: RELIEF_DEFAULT }));
      peak = Math.max(peak, s.relief * s.lift[0]);
    }
    expect(peak).toBeGreaterThanOrEqual(0.1); // tiles are 0.5 across
  });

  it("Reduce flashing lowers the lifts (their shadows pulse the light less)", () => {
    const peak = (/** @type {boolean} */ rf) => {
      const st = createTessState();
      let m = 0;
      for (let i = 0; i < 240; i++) m = Math.max(m, st.step(drums(i), DT, opts({ relief: 0.6, reduceFlashing: rf })).lift[0]);
      return m;
    };
    expect(REDUCED_FLASH_LIFT).toBeLessThanOrEqual(0.5);
    expect(peak(true)).toBeCloseTo(REDUCED_FLASH_LIFT * peak(false), 5);
  });

  it("silence settles the relief flat", () => {
    const st = createTessState();
    let s = st.step(drums(0), DT, opts({ relief: 0.6 }));
    for (let i = 1; i < 300; i++) s = st.step(drums(i), DT, opts({ relief: 0.6 }));
    for (let i = 0; i < 180; i++) s = st.step({ ...drums(i), silent: true }, DT, opts({ relief: 0.6 }));
    expect(Math.max(...s.lift)).toBeLessThan(1e-3);
    for (let k = 0; k < POP_SLOTS; k++) expect(s.pops[k * 4]).toBe(0); // heights (the rest are ring, seed)
  });
});

describe("tess.glsl relief section", () => {
  const glsl = readFileSync(new URL("../../shaders/tess/tess.glsl", import.meta.url), "utf8");

  it("uses the JS mirror's constants", () => {
    const def = (/** @type {string} */ name) => Number((glsl.match(new RegExp(`#define ${name} (\\S+)`)) ?? [])[1]);
    expect(def("RELIEF_BLOCK")).toBe(RELIEF_BLOCK);
    expect(def("RELIEF_BEVEL")).toBe(RELIEF_BEVEL);
    expect(def("RELIEF_DOME")).toBe(RELIEF_DOME);
    expect(def("CARD_HALF")).toBe(CARD_HALF);
    expect(def("CARD_RISE")).toBe(CARD_RISE);
    expect(def("LIFT_VARY")).toBe(LIFT_VARY);
    expect(def("TESS_LIFT_BINS")).toBe(LIFT_BINS);
    expect(def("TESS_POP_SLOTS")).toBe(POP_SLOTS);
  });

  it("is opt-in: everything after #ifdef TESS_RELIEF, so surfaces that don't define it compile as before", () => {
    const at = glsl.indexOf("#ifdef TESS_RELIEF");
    expect(at).toBeGreaterThan(glsl.lastIndexOf("vec4 tessShade(vec2 p, float px)"));
    for (const name of ["tessRelief(", "tessShadeRelief(", "u_tLift", "u_tPop", "u_tRelief"]) expect(glsl.indexOf(name)).toBeGreaterThan(at);
  });
});
