// @ts-check
import { describe, expect, it } from "vitest";
import {
  centroidFamily,
  classColors,
  createBeat,
  createGlide,
  createInversion,
  createMorph,
  createRings,
  createTessState,
  featureWeights,
  inkWidth,
  INVERT_GAP,
  MIN_STEP_GAP,
  PHRASE_BEATS,
  QUALITIES,
  renderScale,
  RINGS,
  RISE,
  SYMMETRIES,
  symmetryName,
  tileFade,
} from "./tess-music.js";
import { blendBound, blendGradient, classColor, MAX_TILE_COLORS, PALETTES, paletteOf, WARP_LIMIT } from "./tess.js";

const DT = 1 / 60;

/** Audio-ish input with a steady 120 BPM tempo (beat every 0.5 s) or none. */
function audioAt(/** @type {number} */ t, tempo = true) {
  return { bpm: tempo ? 120 : 0, beatPhase: tempo ? (t * 2) % 1 : 0, onset: false, onsetStrength: 0 };
}

describe("beat envelope", () => {
  it("eases up over about 80 ms with a smoothstep, peaking at 1 on a tempo beat", () => {
    const b = createBeat();
    const env = [];
    let beatAt = -1;
    for (let i = 0; i < 90; i++) {
      b.step(audioAt(0.3 + i * DT), DT);
      if (b.beat && beatAt < 0) beatAt = i;
      env.push(b.env);
    }
    expect(RISE).toBeCloseTo(0.08, 6);
    expect(beatAt).toBeGreaterThan(0);
    // Peak about RISE after the beat.
    const peak = env.indexOf(Math.max(...env));
    expect((peak - beatAt) * DT).toBeGreaterThanOrEqual(RISE - DT);
    expect((peak - beatAt) * DT).toBeLessThanOrEqual(RISE + DT);
    expect(Math.max(...env)).toBeGreaterThan(0.98);
    // The first rise step is small (smoothstep starts flat): no click.
    expect(env[beatAt + 1] - env[beatAt]).toBeLessThan(0.35);
  });

  it("decays back to 0 by about 0.9 beat, smoothly, without a snap", () => {
    const b = createBeat();
    const env = [];
    for (let i = 0; i < 120; i++) {
      b.step(audioAt(0.3 + i * DT), DT);
      env.push(b.env);
    }
    for (let i = 1; i < env.length; i++) expect(Math.abs(env[i] - env[i - 1])).toBeLessThan(0.35);
    // Beat at t = 0.5 (frame 12); 0.9 beat later (0.45 s ≈ 27 frames) it has faded out.
    expect(env[12 + 28]).toBeLessThan(0.02);
    expect(env[12 + 15]).toBeGreaterThan(0.2); // still decaying in between
  });

  it("without a tempo, strong onsets are beats and weak ones are not", () => {
    const b = createBeat();
    b.step({ bpm: 0, beatPhase: 0, onset: true, onsetStrength: 0.3 }, DT);
    expect(b.beat).toBe(false);
    b.step({ bpm: 0, beatPhase: 0, onset: true, onsetStrength: 0.9 }, DT);
    expect(b.beat).toBe(true);
    b.step({ bpm: 0, beatPhase: 0, onset: true, onsetStrength: 0.9 }, DT); // refractory
    expect(b.beat).toBe(false);
  });
});

/** Drive a morph scheduler from a beat envelope for `seconds`; returns per-frame snapshots. */
function runMorph(/** @type {any} */ o) {
  const beat = createBeat();
  const morph = createMorph();
  const frames = [];
  const n = Math.round(o.seconds / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const a = o.audio ? o.audio(t, i) : audioAt(t, o.tempo ?? true);
    beat.step(a, DT);
    morph.step(DT, {
      beat: beat.beat,
      tempo: beat.tempo,
      period: beat.period,
      onset: a.onset,
      onsetStrength: a.onsetStrength,
      centroid: o.centroid ?? 0.15,
      morph: o.morph ?? 1,
      reduceMotion: o.reduceMotion ?? false,
    });
    frames.push({ t, beat: beat.beat, count: beat.count, stepped: morph.stepped, w: Array.from(morph.wA), theta: morph.thetaA, family: morph.family });
  }
  return frames;
}

describe("morph scheduler", () => {
  it("steps once per bar (every fourth tempo beat)", () => {
    const f = runMorph({ seconds: 10.2 });
    const steps = f.filter((x) => x.stepped);
    expect(steps.length).toBe(5); // 20 beats at 120 BPM
    for (const s of steps) {
      expect(s.beat).toBe(true);
      expect(s.count % 4).toBe(0);
    }
  });

  it("eases each change over more than a beat, never snapping", () => {
    const f = runMorph({ seconds: 6, centroid: 0.02 });
    const i0 = f.findIndex((x) => x.stepped);
    let maxStep = 0;
    for (let i = 1; i < f.length; i++) {
      const d = Math.max(...f[i].w.map((v, j) => Math.abs(v - f[i - 1].w[j])), Math.abs(f[i].theta - f[i - 1].theta));
      maxStep = Math.max(maxStep, d);
    }
    expect(maxStep).toBeLessThan(0.05);
    // Still under way a beat (0.5 s) after the step, settled within the bar.
    const target = f[i0 + 120].w;
    const mid = f[i0 + 30].w;
    expect(Math.max(...mid.map((v, j) => Math.abs(v - target[j])))).toBeGreaterThan(0.01);
    expect(Math.max(...f[i0 + 100].w.map((v, j) => Math.abs(v - target[j])))).toBeLessThan(1e-6);
  });

  it("the spectral centroid picks the family: dark → lobed, bright → hooked", () => {
    expect(centroidFamily(0.02)).toBe(0);
    expect(centroidFamily(0.5)).toBe(3);
    expect(centroidFamily(0.12)).toBeGreaterThan(0);
    expect(centroidFamily(0.12)).toBeLessThan(3);
    for (let c = 0; c < 0.5; c += 0.01) expect(centroidFamily(c + 0.01)).toBeGreaterThanOrEqual(centroidFamily(c));
    for (const [c, fam] of [
      [0.02, 0],
      [0.5, 3],
    ]) {
      const f = runMorph({ seconds: 12, centroid: c });
      const w = f[f.length - 1].w;
      expect(w.indexOf(Math.max(...w))).toBe(fam);
      expect(f.filter((x) => x.stepped).every((x) => x.family === fam)).toBe(true);
    }
  });

  it("without a tempo, strong onsets step it (not weak ones, not too often)", () => {
    const onsets = new Map([
      [30, 0.4], // weak
      [60, 0.95], // steps
      [80, 0.95], // too soon after
      [60 + Math.ceil((MIN_STEP_GAP + 0.1) / DT), 0.9], // steps
    ]);
    const f = runMorph({
      seconds: 5,
      audio: (/** @type {number} */ _t, /** @type {number} */ i) => ({
        bpm: 0,
        beatPhase: 0,
        onset: onsets.has(i),
        onsetStrength: onsets.get(i) ?? 0,
      }),
    });
    const steps = f.map((x, i) => (x.stepped ? i : -1)).filter((i) => i >= 0);
    expect(steps).toEqual([60, 60 + Math.ceil((MIN_STEP_GAP + 0.1) / DT)]);
  });

  it("Morph 0 keeps the shapes where they are", () => {
    const f = runMorph({ seconds: 6, morph: 0, centroid: 0.5 });
    expect(f[f.length - 1].w).toEqual(f[0].w);
  });

  it("Reduce motion steps every other bar and eases four times as long", () => {
    const f = runMorph({ seconds: 10.2, reduceMotion: true, centroid: 0.02 });
    const steps = f.filter((x) => x.stepped);
    expect(steps.length).toBe(2);
    expect(steps.every((s) => s.count % 8 === 0)).toBe(true);
    const i0 = f.findIndex((x) => x.stepped);
    const target = f[f.length - 1].w;
    // Halfway through a normal ease it has moved much less than halfway.
    const moved = Math.max(...f[i0 + 45].w.map((v, j) => Math.abs(v - f[i0].w[j])));
    const total = Math.max(...target.map((v, j) => Math.abs(v - f[i0].w[j])));
    expect(moved).toBeLessThan(0.25 * total);
  });
});

describe("glide", () => {
  /** Run a glide for `seconds` with a 120 BPM beat envelope; returns speeds. */
  function speeds(/** @type {any} */ o) {
    const beat = createBeat();
    const g = createGlide();
    const out = [];
    for (let i = 0; i < Math.round((o.seconds ?? 4) / DT); i++) {
      beat.step(audioAt(i * DT, o.beats ?? true), DT);
      g.step(DT, {
        bassAtt: o.bassAtt ?? 1,
        env: o.beats === false ? 0 : beat.env,
        reactivity: o.reactivity ?? 1,
        speed: o.speed ?? 1,
        reduceMotion: o.reduceMotion ?? false,
      });
      out.push(g.speed);
    }
    return out;
  }
  const last = (/** @type {number[]} */ a) => a[a.length - 1];
  const mean = (/** @type {number[]} */ a) => a.reduce((s, v) => s + v, 0) / a.length;

  it("heavier bass glides faster", () => {
    expect(last(speeds({ bassAtt: 1.6, beats: false }))).toBeGreaterThan(1.2 * last(speeds({ bassAtt: 1, beats: false })));
  });

  it("surges gently on beats: up and back, no jumps", () => {
    const v = speeds({ seconds: 3 });
    const flat = last(speeds({ seconds: 3, beats: false }));
    expect(Math.max(...v)).toBeGreaterThan(1.15 * flat);
    expect(Math.min(...v.slice(60))).toBeLessThan(1.05 * flat);
    for (let i = 1; i < v.length; i++) expect(Math.abs(v[i] - v[i - 1])).toBeLessThan(0.06 * flat);
  });

  it("Reactivity 0 ignores the music; 2 reacts more than 1", () => {
    const a = speeds({ reactivity: 0, bassAtt: 1.8 });
    const b = speeds({ reactivity: 0, bassAtt: 1 });
    expect(Math.max(...a)).toBeCloseTo(Math.min(...a), 9);
    expect(last(a)).toBeCloseTo(last(b), 9);
    const r1 = speeds({ reactivity: 1, bassAtt: 1.6 });
    const r2 = speeds({ reactivity: 2, bassAtt: 1.6 });
    expect(Math.max(...r2) - last(b)).toBeGreaterThan(1.5 * (Math.max(...r1) - last(b)));
  });

  it("Speed scales it, Reduce motion slows it a lot", () => {
    expect(mean(speeds({ speed: 2 }))).toBeCloseTo(2 * mean(speeds({ speed: 1 })), 6);
    expect(last(speeds({ speed: 0 }))).toBe(0);
    expect(mean(speeds({ reduceMotion: true }))).toBeLessThan(0.3 * mean(speeds({})));
  });
});

describe("figure/ground inversion", () => {
  /** Run with a 120 BPM beat (or onsets via `audio`); returns per-frame state. */
  function run(/** @type {any} */ o) {
    const beat = createBeat();
    const inv = createInversion();
    const out = [];
    for (let i = 0; i < Math.round(o.seconds / DT); i++) {
      const a = o.audio ? o.audio(i) : audioAt(i * DT, true);
      beat.step(a, DT);
      inv.step(DT, {
        beat: beat.beat,
        tempo: beat.tempo,
        onset: a.onset,
        onsetStrength: a.onsetStrength,
        reactivity: o.reactivity ?? 1,
        reduceFlashing: o.reduceFlashing ?? false,
      });
      out.push({ started: inv.started, shift: inv.shift, front: inv.front, width: inv.width, count: beat.count });
    }
    return out;
  }
  const rings = Array.from({ length: 21 }, (_, i) => i / 20);
  /** Largest per-frame change of any tile's fade (tiles at rings 0…1). */
  function maxFadeRate(/** @type {any[]} */ f) {
    let worst = 0;
    for (let i = 1; i < f.length; i++) {
      if (f[i].shift !== f[i - 1].shift) continue; // the fade completes into the new shift: no jump
      for (const r of rings) worst = Math.max(worst, Math.abs(tileFade(f[i].front, f[i].width, r) - tileFade(f[i - 1].front, f[i - 1].width, r)));
    }
    return worst;
  }

  it("starts on a phrase change (every 32 tempo beats) and completes into the next shift", () => {
    expect(PHRASE_BEATS).toBe(32);
    const f = run({ seconds: 34 }); // 68 beats → phrases at 32 and 64
    const starts = f.filter((x) => x.started);
    expect(starts.map((x) => x.count)).toEqual([32, 64]);
    expect(f[f.length - 1].shift).toBe(1); // the second is still under way
    const done = f.findIndex((x) => x.shift === 1);
    // Before the shift lands every tile has fully faded; after it nothing is mid-fade.
    expect(rings.every((r) => tileFade(f[done - 1].front, f[done - 1].width, r) > 0.99)).toBe(true);
    expect(rings.every((r) => tileFade(f[done].front, f[done].width, r) < 0.01)).toBe(true);
  });

  it("big onsets start one too, but never more than one per INVERT_GAP (flash limit)", () => {
    // A 10 Hz train of huge onsets with no tempo.
    const f = run({ seconds: 30, audio: (/** @type {number} */ i) => ({ bpm: 0, beatPhase: 0, onset: i % 6 === 0, onsetStrength: 1 }) });
    const starts = f.map((x, i) => (x.started ? i * DT : -1)).filter((t) => t >= 0);
    expect(starts.length).toBeGreaterThan(1);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(INVERT_GAP - 1e-9);
    expect(maxFadeRate(f)).toBeLessThan(0.05);
  });

  it("Reduce flashing makes it much slower and smaller", () => {
    const strobe = (/** @type {number} */ i) => ({ bpm: 0, beatPhase: 0, onset: i % 6 === 0, onsetStrength: 1 });
    const a = run({ seconds: 60, audio: strobe });
    const b = run({ seconds: 60, audio: strobe, reduceFlashing: true });
    expect(b.filter((x) => x.started).length).toBeLessThan(0.5 * a.filter((x) => x.started).length);
    expect(maxFadeRate(b)).toBeLessThan(0.34 * maxFadeRate(a));
    // Fewer tiles are changing at any moment.
    const busy = (/** @type {any[]} */ f) => Math.max(...f.map((x) => rings.filter((r) => { const v = tileFade(x.front, x.width, r); return v > 0.02 && v < 0.98; }).length));
    expect(busy(b)).toBeLessThan(busy(a));
  });

  it("Reactivity 0 never inverts", () => {
    const f = run({ seconds: 34, reactivity: 0 });
    expect(f.some((x) => x.started)).toBe(false);
  });
});

describe("spectrum rings", () => {
  it("averages the 64 bands into RINGS rings, smoothed, scaled by Reactivity", () => {
    const r = createRings();
    const bands = new Float32Array(64);
    for (let i = 0; i < 64; i++) bands[i] = i < 4 ? 1 : 0;
    const out = r.step(bands, 1 / 60, 1);
    expect(RINGS).toBe(16);
    expect(out.length).toBe(16);
    expect(out[0]).toBeGreaterThan(0); // moving towards 1…
    expect(out[0]).toBeLessThan(0.5); // …eased, not jumped
    for (let i = 0; i < 120; i++) r.step(bands, 1 / 60, 1);
    expect(out[0]).toBeCloseTo(1, 2);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(r.step(bands, 1 / 60, 1)).toBe(out); // the same array every frame
    const z = createRings();
    for (let i = 0; i < 120; i++) z.step(bands, 1 / 60, 0);
    expect(z.step(bands, 1 / 60, 0)[0]).toBe(0);
  });
});

describe("class colours", () => {
  it.each(PALETTES)("%s: neighbouring classes always differ, now and after the shift", (name) => {
    const pal = new Float32Array(6 + MAX_TILE_COLORS * 3);
    const n = paletteOf(name, pal);
    const now = new Float32Array(9);
    const next = new Float32Array(9);
    for (const classes of [2, 3]) {
      for (let shift = 0; shift < 7; shift++) {
        classColors(pal, n, classes, shift, now, next);
        for (let a = 0; a < classes; a++) {
          expect(Array.from(now.subarray(a * 3, a * 3 + 3))).toEqual(Array.from(pal.subarray(6 + classColor(a, shift, n) * 3, 9 + classColor(a, shift, n) * 3)));
          expect(Array.from(next.subarray(a * 3, a * 3 + 3))).toEqual(Array.from(pal.subarray(6 + classColor(a, shift + 1, n) * 3, 9 + classColor(a, shift + 1, n) * 3)));
          for (let b = a + 1; b < classes; b++) {
            for (const c of [now, next]) {
              const d = Math.hypot(c[a * 3] - c[b * 3], c[a * 3 + 1] - c[b * 3 + 1], c[a * 3 + 2] - c[b * 3 + 2]);
              expect(d).toBeGreaterThan(0.05);
            }
          }
        }
      }
    }
  });
});

describe("params", () => {
  it("maps the selects, unknown values to the defaults", () => {
    expect(SYMMETRIES).toEqual(["p4", "p3"]);
    expect(QUALITIES).toEqual(["low", "medium", "high"]);
    expect(SYMMETRIES.map(symmetryName)).toEqual(["p4", "p3"]);
    expect(symmetryName("nope")).toBe("p4");
    expect(QUALITIES.map(renderScale)).toEqual([0.5, 0.75, 1]);
    expect(renderScale("nope")).toBe(1);
  });

  it("outline weight scales with the Ink param and the window height", () => {
    expect(inkWidth(1, 1440)).toBeCloseTo(2 * inkWidth(1, 720), 9);
    expect(inkWidth(2, 720)).toBeCloseTo(2 * inkWidth(1, 720), 9);
    expect(inkWidth(1, 1440)).toBeGreaterThan(2);
    expect(inkWidth(1, 1440)).toBeLessThan(6);
    expect(inkWidth(0, 1440)).toBe(0);
  });

  it("feature weights follow the family weights", () => {
    const out = new Float32Array(4);
    featureWeights([1, 0, 0, 0], out);
    const lobed = Array.from(out);
    featureWeights([0, 0, 0, 1], out);
    const hooked = Array.from(out);
    expect(lobed).not.toEqual(hooked);
    featureWeights([0.5, 0, 0, 0.5], out);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo((lobed[i] + hooked[i]) / 2, 6);
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("tess state (the seam a surface visualizer drives)", () => {
  /** A 120 BPM audio frame at time t. */
  function frame(/** @type {number} */ t, over = {}) {
    return {
      bands: new Float32Array(64).fill(0.3),
      bpm: 120,
      beatPhase: (t * 2) % 1,
      onset: false,
      onsetStrength: 0,
      centroid: 0.15,
      bassAtt: 1.2,
      silent: false,
      ...over,
    };
  }
  const opts = (over = {}) => ({
    symmetry: "p4",
    palette: "four-block",
    reactivity: 1,
    speed: 1,
    morph: 0.7,
    ink: 1,
    hatching: 0.6,
    height: 1440,
    reduceMotion: false,
    reduceFlashing: false,
    ...over,
  });

  it("fills every engine uniform array in place, every frame", () => {
    const st = createTessState();
    /** @type {unknown[]} */
    const frames = [];
    for (let i = 0; i < 300; i++) frames.push(st.step(frame(i * DT), DT, opts()));
    expect(frames.every((f) => f === frames[0])).toBe(true);
    const a = st.step(frame(5), DT, opts());
    for (const key of ["k", "ab", "blend", "paper", "ink", "cls", "clsNext", "avg", "invert", "reg", "bands", "featA", "featB"]) {
      expect(/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (a))[key]).toBeInstanceOf(Float32Array);
    }
    const ab = a.ab;
    st.step(frame(5.1), DT, opts());
    expect(st.step(frame(5.2), DT, opts()).ab).toBe(ab);
  });

  it("keeps the warp under the invertibility bound while it morphs", () => {
    const st = createTessState();
    for (let i = 0; i < 1200; i++) {
      const s = st.step(frame(i * DT, { centroid: i < 600 ? 0.02 : 0.4 }), DT, opts());
      const b = blendBound(s.group, s.ab, blendGradient({ kx: s.blend[0], ky: s.blend[1], phase: s.blend[2] }));
      expect(b).toBeLessThanOrEqual(WARP_LIMIT + 1e-6);
    }
  });

  it("switches symmetry and palette from the options", () => {
    const st = createTessState();
    const a = st.step(frame(0), DT, opts());
    expect(a.group.name).toBe("p4");
    expect(a.classes).toBe(2);
    const b = st.step(frame(0), DT, opts({ symmetry: "p3", palette: "ink" }));
    expect(b.group.name).toBe("p3");
    expect(b.classes).toBe(3);
    expect(b.nTerms).toBe(b.group.n);
    // Linear colours: the paper of "ink" is light, its ink dark.
    expect(b.paper[0]).toBeGreaterThan(0.6);
    expect(b.ink[0]).toBeLessThan(0.05);
  });

  it("silence calms it: no beats, no surges", () => {
    const st = createTessState();
    let maxEnv = 0;
    for (let i = 0; i < 300; i++) {
      st.step(frame(i * DT, { silent: true, bassAtt: 1.8, onset: i % 10 === 0, onsetStrength: 1 }), DT, opts());
      maxEnv = Math.max(maxEnv, st.env);
    }
    expect(maxEnv).toBe(0);
  });

  it("travel advances with the glide; the outline follows Ink and the height", () => {
    const st = createTessState();
    const s0 = st.step(frame(0), DT, opts()).travel;
    let s = st.step(frame(DT), DT, opts());
    for (let i = 2; i < 120; i++) s = st.step(frame(i * DT), DT, opts());
    expect(s.travel).toBeGreaterThan(s0);
    expect(st.step(frame(2), DT, opts({ ink: 2 })).inkW).toBeCloseTo(2 * st.step(frame(2), DT, opts({ ink: 1 })).inkW, 9);
  });
});
