// @ts-check
import { describe, expect, it } from "vitest";
import {
  bandProfile,
  CLUTTER_MAX,
  CLUTTER_R,
  clutterProfile,
  ATTACK_MIN,
  CONTACT_LIFE,
  createContacts,
  createDecay,
  fitScope,
  MARGIN,
  PALETTES,
  phosphorPalette,
  createSweep,
  DEFAULT_SPEED,
  GATE,
  inWedge,
  R_INNER,
  R_OUTER,
  radiusOfBand,
  REDUCED_SPEED,
  sweptWedge,
  F_MIN,
  radiusOfFreq,
  freqAtRadius,
  spectrumColumn,
  createLevel,
} from "./radar.js";

/** @param {Partial<import('./radar.js').SweepInput>} o */
const input = (o = {}) => ({ sync: "off", speed: 0.3, bpm: 0, beatPhase: 0, reduceMotion: false, ...o });

describe("createSweep", () => {
  it("free-runs at `speed` rotations per second at any frame rate", () => {
    for (const hz of [60, 120]) {
      const s = createSweep();
      for (let f = 0; f < hz * 4; f++) s.step(1 / hz, input({ speed: 0.5 }));
      expect(s.turns, `${hz} Hz`).toBeCloseTo(2, 6);
    }
  });

  /** Run `seconds` at `hz` with a steady tempo; return the mean rate (turns/s) over the last 2 s. */
  function lockedRate(/** @type {string} */ sync, /** @type {number} */ bpm, hz = 60, seconds = 12) {
    const s = createSweep();
    const n = Math.round(seconds * hz);
    let mark = 0;
    for (let f = 0; f < n; f++) {
      const t = (f + 1) / hz;
      s.step(1 / hz, input({ sync, bpm, beatPhase: ((t * bpm) / 60) % 1 }));
      if (f === n - 2 * hz - 1) mark = s.turns;
    }
    return (s.turns - mark) / 2;
  }

  it("locks one rotation per bar (4 beats) or per beat to the tempo", () => {
    for (const hz of [60, 120]) {
      expect(lockedRate("bar", 120, hz), `bar ${hz}`).toBeCloseTo(0.5, 2);
      expect(lockedRate("beat", 120, hz), `beat ${hz}`).toBeCloseTo(2, 2);
      expect(lockedRate("bar", 90, hz), `bar 90 ${hz}`).toBeCloseTo(90 / 60 / 4, 2);
    }
  });

  it("uses `speed` when sync is off or the tempo is unknown", () => {
    expect(lockedRate("off", 120)).toBeCloseTo(0.3, 6);
    const s = createSweep();
    for (let f = 0; f < 120; f++) s.step(1 / 60, input({ sync: "bar", bpm: 0, speed: 0.25 }));
    expect(s.turns).toBeCloseTo(0.5, 6);
  });

  it("phase-aligns smoothly: beats land on the quarter bearings (bar) without jumps or reversals", () => {
    for (const sync of ["bar", "beat"]) {
      const bpt = sync === "bar" ? 4 : 1;
      const s = createSweep();
      const dt = 1 / 120;
      for (let f = 0; f < 45; f++) s.step(dt, input({ speed: 0.3 })); // free-running, arbitrary phase
      let prevRate = s.rate;
      for (let f = 0; f < 120 * 10; f++) {
        const t = f * dt + 0.123;
        const before = s.turns;
        s.step(dt, input({ sync, bpm: 128, beatPhase: ((t * 128) / 60) % 1 }));
        const rate = (s.turns - before) / dt;
        expect(rate, sync).toBeGreaterThan(0);
        expect(Math.abs(rate - prevRate), sync).toBeLessThan(0.05 / bpt + 0.02); // turns/s per frame
        prevRate = rate;
      }
      const t = 120 * 10 * dt + 0.123 - dt;
      const beats = s.turns * bpt;
      let err = ((t * 128) / 60) % 1 - (beats - Math.floor(beats));
      err -= Math.round(err);
      expect(Math.abs(err), sync).toBeLessThan(0.01);
    }
  });

  it("with Reduce motion, slows the sweep when speed/sync are at their defaults, respects user choices", () => {
    const run = (/** @type {Partial<import('./radar.js').SweepInput>} */ o) => {
      const s = createSweep();
      for (let f = 0; f < 600; f++) {
        const t = (f + 1) / 60;
        s.step(1 / 60, input({ ...o, beatPhase: o.bpm ? ((t * o.bpm) / 60) % 1 : 0 }));
      }
      return s.turns / 10;
    };
    expect(REDUCED_SPEED).toBeLessThan(DEFAULT_SPEED);
    expect(run({ speed: DEFAULT_SPEED, reduceMotion: true })).toBeCloseTo(REDUCED_SPEED, 6);
    expect(run({ speed: DEFAULT_SPEED, reduceMotion: false })).toBeCloseTo(DEFAULT_SPEED, 6);
    expect(run({ speed: 0.8, reduceMotion: true })).toBeCloseTo(0.8, 6);
    // Default sync (bar): one rotation per two bars instead of one.
    expect(run({ sync: "bar", bpm: 120, reduceMotion: true })).toBeCloseTo(0.25, 1);
    expect(run({ sync: "beat", bpm: 120, reduceMotion: true })).toBeCloseTo(2, 1);
  });
});

describe("sweptWedge", () => {
  it("paints every bearing once per rotation, no gaps or repeats, at 60/120 Hz and high speeds", () => {
    const COLS = 2048; // phosphor texels around the scope
    const w = new Float32Array(2);
    for (const hz of [60, 120]) {
      for (const speed of [0.05, 0.25, 2, 13]) {
        const s = createSweep();
        const hits = new Uint16Array(COLS);
        let prev = s.turns;
        for (let f = 0; f < hz * 3; f++) {
          const now = s.step(1 / hz, input({ speed }));
          sweptWedge(prev, now, w);
          for (let c = 0; c < COLS; c++) if (inWedge((c + 0.5) / COLS, w[0], w[1])) hits[c]++;
          prev = now;
        }
        const total = s.turns;
        for (let c = 0; c < COLS; c++) {
          const expected = Math.floor(total - (c + 0.5) / COLS) + 1; // crossings of this bearing
          expect(hits[c], `${hz} Hz speed ${speed} col ${c}`).toBe(Math.max(0, expected));
        }
      }
    }
  });

  it("caps the span at one full turn and wraps the start into 0–1", () => {
    const w = new Float32Array(2);
    sweptWedge(0.9, 3.4, w);
    expect(w[1]).toBe(1);
    sweptWedge(2.75, 3.05, w);
    expect(w[0]).toBeCloseTo(0.75, 6);
    expect(w[1]).toBeCloseTo(0.3, 6);
    expect(inWedge(0.02, w[0], w[1])).toBe(true);
    expect(inWedge(0.06, w[0], w[1])).toBe(false);
  });
});

describe("radiusOfFreq", () => {
  it("maps frequency on a log scale: lowest at the inner radius, maxFreq at the rim, monotonic", () => {
    for (const max of [4000, 8000, 16000]) {
      expect(radiusOfFreq(F_MIN, max)).toBeCloseTo(R_INNER, 6);
      expect(radiusOfFreq(max, max)).toBeCloseTo(R_OUTER, 6);
      // Every octave takes the same radial distance.
      const oct = radiusOfFreq(2 * F_MIN, max) - radiusOfFreq(F_MIN, max);
      expect(radiusOfFreq(1000, max) - radiusOfFreq(500, max)).toBeCloseTo(oct, 6);
      let prev = -Infinity;
      for (let f = F_MIN; f <= max; f *= 1.05) {
        const r = radiusOfFreq(f, max);
        expect(r).toBeGreaterThan(prev);
        expect(freqAtRadius(r, max)).toBeCloseTo(f, 3);
        prev = r;
      }
    }
  });
});

describe("spectrumColumn", () => {
  const SR = 48000;
  const N = 512;

  it("puts a single strong bin at its frequency's radius at full strength, for any spectrum length", () => {
    for (const len of [1024, 512, 2048]) {
      const binHz = SR / 2 / len;
      const spec = new Float32Array(len);
      const out = new Float32Array(N);
      // Low bins (wider than a texel) to high ones (many bins per texel).
      for (const hz of [60, 110, 440, 1000, 3100, 9000, 14000]) {
        const i = Math.round(hz / binHz);
        spec.fill(0);
        spec[i] = 0.8;
        spectrumColumn(spec, SR, 16000, out);
        const k = Math.floor(radiusOfFreq(i * binHz, 16000) * N);
        expect(Math.max(out[k - 1], out[k], out[k + 1]), `${len} ${hz} Hz`).toBeCloseTo(0.8, 6);
        const peak = out.indexOf(Math.max(...out));
        expect(Math.abs(peak - k), `${len} ${hz} Hz`).toBeLessThanOrEqual(1);
        // Far from the partial the column is dark.
        for (let j = 0; j < N; j++) {
          const f = freqAtRadius((j + 0.5) / N, 16000);
          if (Math.abs(f - i * binHz) > 3 * binHz + f * 0.05) expect(out[j], `${len} ${hz} Hz texel ${j}`).toBe(0);
        }
      }
    }
  });

  it("interpolates smoothly where a texel is narrower than a bin", () => {
    const spec = new Float32Array(1024);
    spec[3] = 0.2;
    spec[4] = 0.6;
    const out = spectrumColumn(spec, SR, 16000, new Float32Array(N));
    const binHz = SR / 2048;
    const k = Math.floor(radiusOfFreq(3.5 * binHz, 16000) * N);
    expect(out[k]).toBeGreaterThan(0.3);
    expect(out[k]).toBeLessThan(0.5);
  });

  it("is black inside the lowest frequency and past maxFreq", () => {
    const out = spectrumColumn(new Float32Array(1024).fill(0.5), SR, 4000, new Float32Array(N).fill(9));
    for (let k = 0; k < N; k++) {
      const r = (k + 1) / N;
      const r0 = k / N;
      if (r <= R_INNER || r0 >= R_OUTER) expect(out[k], `texel ${k}`).toBe(0);
      else expect(out[k], `texel ${k}`).toBeCloseTo(0.5, 6);
    }
  });
});

describe("createLevel", () => {
  const N = 64;
  /** Run `seconds` of a steady column at `hz`; return the last output. */
  const settle = (/** @type {Float32Array} */ col, floor = -60, seconds = 10, hz = 60, lvl = createLevel()) => {
    const out = new Float32Array(col.length);
    for (let f = 0; f < seconds * hz; f++) lvl.step(col, 1 / hz, floor, 1, out);
    return out;
  };

  it("maps magnitude to brightness in dB: silence → 0, full scale → ~1, monotonic in between", () => {
    const lvl = createLevel();
    const out = new Float32Array(N);
    const col = new Float32Array(N);
    for (let f = 0; f < 600; f++) lvl.step(col, 1 / 60, -60, 1, out);
    expect(Math.max(...out)).toBe(0);
    // A ramp from −90 dB to 0 dB.
    for (let k = 0; k < N; k++) col[k] = Math.pow(10, (-90 + (90 * k) / (N - 1)) / 20);
    const v = settle(col);
    expect(v[N - 1]).toBeGreaterThan(0.95);
    expect(v[0]).toBe(0);
    for (let k = 1; k < N; k++) expect(v[k]).toBeGreaterThanOrEqual(v[k - 1]);
    // Linear in dB above the floor: −30 dB is about halfway with a −60 dB floor.
    const at30 = v[Math.round(((90 - 30) / 90) * (N - 1))];
    expect(at30).toBeGreaterThan(0.4);
    expect(at30).toBeLessThan(0.6);
  });

  it("auto-gains slowly: a quiet track still shows, a loud one doesn't saturate, silence holds", () => {
    const col = new Float32Array(N);
    const db = (/** @type {number} */ d) => Math.pow(10, d / 20);
    // Quiet track: peak at −45 dB, a partial at −60 dB. Adapted, the peak is near full brightness
    // and the partial is still visible.
    col[10] = db(-45);
    col[20] = db(-60);
    const quiet = settle(col, -60, 30);
    expect(quiet[10]).toBeGreaterThan(0.9);
    expect(quiet[20]).toBeGreaterThan(0.5);
    // Loud track: its peak is full and a −20 dB partial is clearly below it.
    col[10] = 1;
    col[20] = db(-20);
    const loud = settle(col);
    expect(loud[10]).toBeGreaterThan(0.95);
    expect(loud[20]).toBeLessThan(0.8);
    // The gain moves slowly: one frame of a loud hit after the quiet track barely changes it.
    const lvl = createLevel();
    col[10] = db(-45);
    col[20] = 0;
    settle(col, -60, 10, 60, lvl);
    const ref = lvl.ref;
    col[10] = 1;
    lvl.step(col, 1 / 60, -60, 1, new Float32Array(N));
    expect(Math.abs(lvl.ref - ref)).toBeLessThan(3);
    // A pause doesn't blow the gain up: after a loud passage and 10 s of silence, a −70 dB hiss
    // stays black.
    col[10] = 1;
    settle(col, -60, 10, 60, lvl);
    col.fill(0);
    settle(col, -60, 10, 60, lvl);
    col[5] = db(-70);
    lvl.step(col, 1 / 60, -60, 1, (quiet.fill(0), quiet));
    expect(quiet[5]).toBe(0);
    // Frame-rate independent.
    col.fill(0);
    col[10] = db(-30);
    const a = createLevel();
    const b = createLevel();
    settle(col, -60, 3, 60, a);
    settle(col, -60, 3, 120, b);
    expect(a.ref).toBeCloseTo(b.ref, 3);
  });
});

describe("bandProfile", () => {
  const N = 256;
  const at = (/** @type {Float32Array} */ p, /** @type {number} */ r) => p[Math.min(N - 1, Math.floor(r * N))];
  // Outer edge of the brightest run (band 0 fills the center as a plateau out to R_INNER).
  const peakRadius = (/** @type {Float32Array} */ p) => (p.lastIndexOf(Math.max(...p)) + 0.5) / N;

  it("puts bass near the center and highs toward the rim", () => {
    expect(radiusOfBand(0)).toBeCloseTo(R_INNER, 6);
    expect(radiusOfBand(63)).toBeCloseTo(R_OUTER, 6);
    const bands = new Float32Array(64);
    const out = new Float32Array(N);
    for (const i of [0, 10, 40, 63]) {
      bands.fill(0);
      bands[i] = 0.9;
      bandProfile(bands, 1, out);
      expect(Math.abs(peakRadius(out) - radiusOfBand(i)), `band ${i}`).toBeLessThan(1.5 / N);
    }
  });

  it("interpolates between neighbouring bands", () => {
    const bands = new Float32Array(64);
    bands[20] = 0.5;
    bands[21] = 0.9;
    const out = bandProfile(bands, 1, new Float32Array(4096));
    const mid = (radiusOfBand(20) + radiusOfBand(21)) / 2;
    const v = out[Math.floor(mid * 4096)];
    const lo = (0.5 - GATE) / (1 - GATE);
    const hi = (0.9 - GATE) / (1 - GATE);
    expect(v).toBeCloseTo((lo + hi) / 2, 2);
  });

  it("gates the noise floor to black and scales by gain", () => {
    const out = new Float32Array(N);
    bandProfile(new Float32Array(64).fill(GATE * 0.9), 2, out);
    expect(Math.max(...out)).toBe(0);
    const bands = new Float32Array(64).fill(0.5);
    const a = at(bandProfile(bands, 1, new Float32Array(N)), 0.5);
    const b = at(bandProfile(bands, 2, new Float32Array(N)), 0.5);
    expect(a).toBeGreaterThan(0.3);
    expect(b).toBeCloseTo(2 * a, 5);
    expect(at(out.fill(9) && bandProfile(bands, 1, out), 0.995)).toBe(0); // nothing past the outermost band
  });
});

describe("clutterProfile", () => {
  const noise = (/** @type {number} */ n, /** @type {number} */ amp) => {
    let seed = 7;
    return Float32Array.from({ length: n }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * amp);
  };

  it("speckles only near the center, bounded, louder waveform → more clutter", () => {
    for (const len of [2048, 512]) {
      const loud = clutterProfile(noise(len, 1), new Float32Array(256));
      const soft = clutterProfile(noise(len, 0.1), new Float32Array(256));
      const sum = (/** @type {Float32Array} */ a) => a.reduce((x, y) => x + y, 0);
      expect(Math.max(...loud)).toBeLessThanOrEqual(CLUTTER_MAX);
      expect(sum(loud), `${len}`).toBeGreaterThan(sum(soft) * 2);
      expect(sum(soft)).toBeGreaterThan(0);
      for (let k = 0; k < 256; k++) if ((k + 0.5) / 256 >= CLUTTER_R) expect(loud[k]).toBe(0);
    }
  });

  it("is dark for silence", () => {
    const out = clutterProfile(new Float32Array(2048), new Float32Array(256).fill(1));
    expect(Math.max(...out)).toBe(0);
  });
});

describe("createDecay", () => {
  const run = (/** @type {number} */ hz, /** @type {number} */ seconds, rate = 0.5, persistence = 0.6) => {
    const d = createDecay();
    let v = 1;
    for (let f = 0; f < Math.round(seconds * hz); f++) v *= d.step(1 / hz, rate, persistence);
    return v;
  };

  it("fades the same at 60 and 120 Hz: one rotation later the trail is at exp(−1/persistence)", () => {
    expect(run(60, 2)).toBeCloseTo(Math.exp(-1 / 0.6), 6);
    expect(run(120, 2)).toBeCloseTo(run(60, 2), 9);
    expect(run(144, 2)).toBeCloseTo(run(60, 2), 2); // within one fixed step
  });

  it("holds longer with more persistence and still fades when the sweep stops", () => {
    expect(run(60, 2, 0.5, 1.5)).toBeGreaterThan(run(60, 2, 0.5, 0.6));
    expect(run(60, 60, 0, 0.6)).toBeLessThan(0.1);
  });
});

describe("createContacts", () => {
  const quiet = new Float32Array(64).fill(0.1);
  /** Bands with one band raised. @param {number} i @param {number} v */
  const hit = (i, v) => {
    const b = quiet.slice();
    b[i] = v;
    return b;
  };
  const packed = new Float32Array(4 * 32);

  it("spawns a bright contact on an onset at the sweep bearing and the firing band's radius", () => {
    const c = createContacts();
    c.step(0, 0.1, false, 0, quiet);
    c.step(0.1, 1.3, true, 0.8, hit(40, 0.6)); // band 40 jumped: it fired
    expect(c.pack(packed, 1.3)).toBe(1);
    expect(packed[0]).toBeCloseTo(0.3, 5); // bearing = the sweep, wrapped
    expect(packed[1]).toBeCloseTo(radiusOfBand(40), 5);
    expect(packed[2]).toBeGreaterThan(0.5); // flaring: the sweep is on it
  });

  it("spawns on a strong per-band attack without an onset, but not for steady loud bands", () => {
    const c = createContacts();
    const loud = new Float32Array(64).fill(0.9);
    for (let f = 0; f < 30; f++) c.step(f * 0.01, (f + 1) * 0.01, false, 0, loud);
    expect(c.pack(packed, 0.3)).toBe(0);
    c.step(0.3, 0.31, false, 0, quiet);
    c.step(0.31, 0.32, false, 0, hit(12, 0.1 + ATTACK_MIN * 1.5));
    expect(c.pack(packed, 0.32)).toBe(1);
    expect(packed[1]).toBeCloseTo(radiusOfBand(12), 5);
    c.step(0.32, 0.33, false, 0, hit(12, 0.1 + ATTACK_MIN * 1.5)); // held: no new attack
    expect(c.pack(packed, 0.33)).toBe(1);
  });

  it("caps the pool (preallocated), replacing the oldest contact when full", () => {
    const c = createContacts(32);
    const arrays = [c.bearing, c.radius, c.strength, c.born, c.swept];
    c.step(0, 0.001, false, 0, quiet);
    for (let k = 1; k <= 40; k++) c.step(k * 0.001, (k + 1) * 0.001, true, 0.5, hit(k % 64, 0.9));
    expect(c.pack(packed, 0.041)).toBe(32);
    expect([c.bearing, c.radius, c.strength, c.born, c.swept]).toEqual(arrays);
    expect(arrays.every((a, i) => a === [c.bearing, c.radius, c.strength, c.born, c.swept][i])).toBe(true);
    const bornMin = Math.min(...c.born);
    expect(bornMin).toBeCloseTo(0.01, 6); // the first 8 (born 0.002–0.009) were replaced
  });

  /** Step the sweep from `a` to `b` turns in 1/60-turn frames with quiet bands. */
  const sweep = (/** @type {ReturnType<typeof createContacts>} */ c, /** @type {number} */ a, /** @type {number} */ b) => {
    for (let t = a; t < b - 1e-9; t += 1 / 60) c.step(t, Math.min(b, t + 1 / 60), false, 0, quiet);
  };

  it("fades over CONTACT_LIFE rotations, then frees its slot", () => {
    const c = createContacts();
    c.step(0, 0.5, false, 0, quiet);
    c.step(0.5, 0.5, true, 1, hit(30, 0.9));
    const seen = [];
    for (let k = 1; k < CONTACT_LIFE; k++) {
      sweep(c, 0.5 + k - 1, 0.5 + k); // the sweep is back on it
      c.pack(packed, 0.5 + k);
      seen.push(packed[2]);
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k]).toBeLessThan(seen[k - 1]);
    sweep(c, 0.5 + CONTACT_LIFE - 1, 0.5 + CONTACT_LIFE + 0.05);
    expect(c.pack(packed, 0.5 + CONTACT_LIFE + 0.05)).toBe(0);
    expect(Math.max(...c.strength)).toBe(0);
  });

  it("flares when the sweep passes over it and dims between passes", () => {
    const c = createContacts();
    c.step(0, 0.5, false, 0, quiet);
    c.step(0.5, 0.5, true, 1, hit(30, 0.9));
    sweep(c, 0.5, 1.45);
    c.pack(packed, 1.45);
    const before = packed[2];
    sweep(c, 1.45, 1.52);
    c.pack(packed, 1.52);
    expect(packed[2]).toBeGreaterThan(2 * before);
  });
});

describe("fitScope", () => {
  it("centers the largest circle that fits with a margin, for any aspect ratio", () => {
    const out = { cx: 0, cy: 0, radius: 0 };
    for (const [w, h] of [[2560, 1440], [1440, 2560], [1000, 1000], [3440, 1440], [300, 2000], [1, 1]]) {
      fitScope(w, h, out);
      const m = Math.min(w, h);
      expect([out.cx, out.cy], `${w}x${h}`).toEqual([w / 2, h / 2]);
      expect(out.radius, `${w}x${h}`).toBeCloseTo((m / 2) * (1 - MARGIN * 2), 6);
      expect(out.radius).toBeGreaterThan(0);
    }
  });
});

describe("phosphorPalette", () => {
  it("has classic phosphors, green by default, with a hotter core than glow", () => {
    const p = new Float32Array(6);
    const dominant = (/** @type {Float32Array} */ c) => [0, 1, 2].reduce((a, b) => (c[b] > c[a] ? b : a));
    expect(PALETTES).toEqual(["green", "amber", "blue", "white"]);
    expect(dominant(phosphorPalette("green", p))).toBe(1);
    const green = p.slice();
    phosphorPalette("amber", p);
    expect(p[0] > p[1] && p[1] > p[2]).toBe(true);
    expect(dominant(phosphorPalette("blue", p))).toBe(2);
    phosphorPalette("white", p);
    expect(Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2])).toBeLessThan(0.1);
    expect(phosphorPalette("plaid", p)).toEqual(green);
    for (const name of PALETTES) {
      phosphorPalette(name, p);
      for (let i = 0; i < 3; i++) expect(p[3 + i], name).toBeGreaterThanOrEqual(p[i]);
    }
  });
});
