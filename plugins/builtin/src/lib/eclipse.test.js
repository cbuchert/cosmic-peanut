// @ts-check
import { describe, expect, it } from "vitest";
import {
  DISC,
  FLARES,
  SECTORS,
  TINTS,
  createCorona,
  createFlares,
  createGlare,
  createRing,
  cloudThreshold,
  createRipple,
  createFlow,
  createCloudBias,
  createPulses,
  createCloudLight,
  createBillows,
  BILLOWS,
  WATERS,
  createWater,
  RINGS,
  backgroundDrive,
  PULSES,
  DEFAULT_REACTIVITY,
  DEFAULT_ROTATION,
  effectiveMotion,
  fitEclipse,
  skyAlpha,
  tintGamma,
} from "./eclipse.js";

const DT = 1 / 60;
const SR = 48000;

/** Angle (rad, 0 = bottom, +π/2 = right) of sector i. @param {number} i */
const angleOf = (i) => ((i + 0.5) / SECTORS - 0.5) * 2 * Math.PI;

describe("createCorona", () => {
  it("a single loud bin lights the sectors at its log-frequency angle, mirrored left/right", () => {
    const corona = createCorona();
    const spec = new Float32Array(1024);
    spec[43] = 0.5; // 43 · 48000 / 2048 ≈ 1008 Hz
    for (let t = 0; t < 0.5; t += DT) corona.step(spec, SR, DT);
    const lv = corona.levels;
    let best = 0;
    for (let i = 0; i < SECTORS; i++) if (lv[i] > lv[best]) best = i;
    expect(lv[best]).toBeGreaterThan(0.9);
    expect(lv[SECTORS - 1 - best]).toBeCloseTo(lv[best], 5);
    const expected = (Math.log(1008 / 30) / Math.log(16000 / 30)) * Math.PI; // from the bottom
    expect(Math.abs(Math.abs(angleOf(best)) - expected)).toBeLessThan((2 * Math.PI) / SECTORS);
    // Far away from that angle (e.g. the bass at the bottom, the highs at the top) stays dark.
    expect(lv[SECTORS / 2]).toBe(0);
    expect(lv[0]).toBe(0);
  });

  it("a pure tone lights a small wedge (a few trees), falling off to either side", () => {
    const corona = createCorona();
    const spec = new Float32Array(1024);
    spec[43] = 0.5;
    for (let t = 0; t < 0.5; t += DT) corona.step(spec, SR, DT);
    const lv = corona.levels;
    let best = 0;
    for (let i = 0; i < SECTORS / 2; i++) if (lv[i] > lv[best]) best = i;
    for (const k of [-2, -1, 1, 2]) {
      expect(lv[best + k]).toBeGreaterThan(0.4);
      expect(lv[best + k]).toBeLessThan(lv[best]);
    }
    expect(lv[best + 6]).toBe(0);
  });

  it("levels grow with a fast-ish attack and recede with a slower release, bounded 0–1", () => {
    const corona = createCorona();
    const spec = new Float32Array(1024);
    const quiet = new Float32Array(1024);
    spec[43] = 0.5;
    const lv = corona.levels;
    let best = 0;
    corona.step(spec, SR, DT);
    for (let i = 0; i < SECTORS; i++) if (lv[i] > lv[best]) best = i;
    expect(lv[best]).toBeGreaterThan(0.1); // moving at once…
    expect(lv[best]).toBeLessThan(0.5); // …but not a jump
    for (let t = DT; t < 0.15; t += DT) corona.step(spec, SR, DT);
    expect(lv[best]).toBeGreaterThan(0.8); // attack ≈ 50 ms
    for (let t = 0; t < 0.15; t += DT) corona.step(quiet, SR, DT);
    expect(lv[best]).toBeGreaterThan(0.35); // release is slower than attack
    for (let t = 0.15; t < 1.5; t += DT) {
      corona.step(quiet, SR, DT);
      for (let i = 0; i < SECTORS; i++) expect(lv[i] >= 0 && lv[i] <= 1).toBe(true);
    }
    expect(lv[best]).toBeLessThan(0.05);
    // A huge dt (tab restored) can't overshoot.
    corona.step(spec, SR, 10);
    expect(lv[best]).toBeLessThanOrEqual(1);
  });
});

describe("createRing", () => {
  /** Settle the ring on a constant bass level. @param {number} bass */
  const settle = (bass, react = 1, thick = 1) => {
    const ring = createRing();
    for (let t = 0; t < 3; t += DT) ring.step(bass, DT, react, thick);
    return ring;
  };

  it("at rest: the black disc at DISC inside a white annulus; Ring thickness scales the annulus", () => {
    const r = settle(0);
    expect(r.disc).toBeCloseTo(DISC, 5);
    expect(r.outer).toBeGreaterThan(r.disc + 0.05);
    expect(r.swell).toBe(0);
    const thick = settle(0, 1, 2);
    expect(thick.outer - thick.disc).toBeCloseTo(2 * (r.outer - r.disc), 5);
  });

  it("bass swells the ring (thicker, brighter) and shrinks the disc a little, monotonic and bounded", () => {
    let prev = settle(0);
    for (const bass of [0.8, 1.2, 1.6, 2, 5, 1e9]) {
      const r = settle(bass);
      expect(r.disc).toBeLessThanOrEqual(prev.disc);
      expect(r.outer - r.disc).toBeGreaterThanOrEqual(prev.outer - prev.disc);
      expect(r.swell).toBeGreaterThanOrEqual(prev.swell);
      expect(r.disc).toBeGreaterThan(0.9 * DISC); // "slightly"
      expect(r.swell).toBeLessThanOrEqual(1);
      prev = r;
    }
    expect(prev.swell).toBeCloseTo(1, 6);
    for (const bad of [NaN, -3, -Infinity]) expect(settle(bad).disc).toBeCloseTo(DISC, 5);
    expect(settle(2, 0).swell).toBeCloseTo(0, 9); // Reactivity 0: a still eclipse
  });

  it("is smooth: a bass step moves it gradually, never in one jump", () => {
    const ring = createRing();
    ring.step(0, DT, 1, 1);
    let { disc, outer, swell } = ring;
    for (let t = 0; t < 1; t += DT) {
      ring.step(t < 0.5 ? 2 : 0, DT, 1, 1);
      expect(Math.abs(ring.disc - disc)).toBeLessThan(0.004);
      expect(Math.abs(ring.outer - outer)).toBeLessThan(0.004);
      expect(Math.abs(ring.swell - swell)).toBeLessThan(0.15);
      ({ disc, outer, swell } = ring);
    }
  });
});

describe("createFlares", () => {
  /** Live flares as [radius, amp] pairs. @param {ReturnType<typeof createFlares>} f */
  const live = (f) => {
    const out = [];
    for (let i = 0; i < FLARES; i++) if (f.data[2 * i + 1] > 0) out.push([f.data[2 * i], f.data[2 * i + 1]]);
    return out;
  };

  it("spawns a flare on an onset, which travels outward and fades away", () => {
    const f = createFlares();
    for (let t = 0; t < 0.5; t += DT) f.step(false, 0, DT, 1);
    expect(live(f)).toEqual([]);
    f.step(true, 0.8, DT, 1);
    let [[r, a]] = live(f);
    expect(a).toBeGreaterThan(0.5);
    for (let t = 0; t < 0.6; t += DT) {
      f.step(false, 0, DT, 1);
      const [[r2, a2]] = live(f);
      expect(r2).toBeGreaterThan(r);
      expect(a2).toBeLessThan(a);
      [r, a] = [r2, a2];
    }
    for (let t = 0; t < 4; t += DT) f.step(false, 0, DT, 1);
    expect(live(f)).toEqual([]);
  });

  it("stronger onsets flare brighter; Reactivity 0 flares nothing", () => {
    const weak = createFlares();
    const strong = createFlares();
    weak.step(true, 0.1, DT, 1);
    strong.step(true, 1, DT, 1);
    expect(live(strong)[0][1]).toBeGreaterThan(live(weak)[0][1]);
    expect(live(strong)[0][1]).toBeLessThanOrEqual(1);
    const off = createFlares();
    off.step(true, 1, DT, 0);
    expect(live(off)).toEqual([]);
  });

  it("never holds more than FLARES: a new onset replaces the oldest", () => {
    const f = createFlares();
    for (let i = 0; i < 3 * FLARES; i++) {
      f.step(true, 1, DT, 1);
      f.step(false, 0, DT, 1);
      expect(live(f).length).toBeLessThanOrEqual(FLARES);
    }
    expect(live(f).length).toBe(FLARES);
    const newest = Math.min(...live(f).map(([r]) => r));
    f.step(true, 1, DT, 1);
    const radii = live(f).map(([r]) => r);
    expect(Math.min(...radii)).toBeLessThan(newest); // a fresh flare at the ring…
    expect(radii.length).toBe(FLARES); // …in the oldest's slot
  });
});

describe("createGlare", () => {
  /** Flashes (rises ≥ 0.05 after a fall) per second of the glare under a 10 Hz strobe. @param {boolean} limit */
  const strobe = (limit) => {
    const flares = createFlares();
    const glare = createGlare();
    let rises = 0;
    let lo = 0;
    let rising = false;
    let prev = 0;
    const frames = 4 * 60;
    for (let i = 0; i < frames; i++) {
      flares.step(i % 6 === 0, 1, DT, 1);
      const swell = i % 6 < 3 ? 1 : 0; // the bass strobes too
      glare.step(swell, flares.data, DT, limit);
      const v = glare.level;
      expect(glare.scale).toBeGreaterThanOrEqual(0);
      expect(glare.scale).toBeLessThanOrEqual(1);
      if (!rising && v - lo >= 0.05) {
        rises++;
        rising = true;
      } else if (rising && v < prev) {
        rising = false;
        lo = v;
      } else if (!rising) lo = Math.min(lo, v);
      prev = v;
    }
    return rises / (frames / 60);
  };

  it("limits full-frame brightness rises (ring swell + flares) to ≤ 3/s when Reduce flashing is on", () => {
    expect(strobe(false)).toBeGreaterThan(6);
    expect(strobe(true)).toBeLessThanOrEqual(3);
  });

  it("also limits the background's brightening (clouds, rim light, rays) passed as `extra`", () => {
    const count = (/** @type {boolean} */ limit) => {
      const glare = createGlare();
      const none = createFlares().data;
      let rises = 0;
      let prev = 0;
      let lo = 0;
      let rising = false;
      for (let i = 0; i < 240; i++) {
        glare.step(0, none, DT, limit, i % 6 < 3 ? 1 : 0);
        const v = glare.level;
        if (!rising && v - lo >= 0.05) {
          rises++;
          rising = true;
        } else if (rising && v < prev) {
          rising = false;
          lo = v;
        } else if (!rising) lo = Math.min(lo, v);
        prev = v;
      }
      return rises / 4;
    };
    expect(count(false)).toBeGreaterThan(6);
    expect(count(true)).toBeLessThanOrEqual(3);
  });

  it("passes slow swells and a lone flare straight through", () => {
    const flares = createFlares();
    const glare = createGlare();
    flares.step(true, 1, DT, 1);
    glare.step(0.5, flares.data, DT, true);
    expect(glare.scale).toBe(1);
    expect(glare.level).toBeGreaterThan(0.5);
  });
});

describe("tint and sky", () => {
  it("each tint is a per-channel gamma on the grey value: black stays black, white stays white", () => {
    expect(TINTS).toEqual(["monochrome", "silver", "sepia", "cold blue"]);
    const g = new Float32Array(3);
    expect([...tintGamma("monochrome", g)]).toEqual([1, 1, 1]);
    const seen = new Set();
    for (const name of TINTS) {
      tintGamma(name, g);
      for (const c of g) expect(c).toBeGreaterThan(0.5);
      seen.add(g.join());
    }
    expect(seen.size).toBe(TINTS.length);
    tintGamma("sepia", g);
    expect(0.5 ** g[0]).toBeGreaterThan(0.5 ** g[2]); // warm mid-greys: more red than blue
    tintGamma("cold blue", g);
    expect(0.5 ** g[2]).toBeGreaterThan(0.5 ** g[0]);
    expect([...tintGamma("nonsense", g)]).toEqual([1, 1, 1]);
  });

  it("sky black is opaque; none makes black transparent; unknown → black", () => {
    expect(skyAlpha("black")).toBe(1);
    expect(skyAlpha("none")).toBe(0);
    expect(skyAlpha(undefined)).toBe(1);
  });
});

describe("fitEclipse", () => {
  it("centres the composition and fits its unit radius inside min(width, height) with a margin", () => {
    const out = { cx: 0, cy: 0, radius: 0 };
    for (const [w, h] of [
      [2560, 1440],
      [1440, 2560],
      [1000, 1000],
      [3440, 1440],
      [800, 3000],
    ]) {
      fitEclipse(w, h, out);
      expect([out.cx, out.cy]).toEqual([w / 2, h / 2]);
      const m = Math.min(w, h);
      expect(out.radius).toBeLessThan(m / 2 - 0.02 * m);
      expect(out.radius).toBeGreaterThan(0.4 * m);
    }
    fitEclipse(0, 0, out);
    expect(out.radius).toBeGreaterThan(0); // never divides by zero
  });

  it("with water, a waterline (px from the bottom) and the eclipse lifted above it, ring clear", () => {
    expect(WATERS).toEqual(["off", "low", "mid"]);
    const out = { cx: 0, cy: 0, radius: 0, horizon: -1 };
    fitEclipse(2560, 1440, out, "off");
    expect(out.horizon).toBe(0);
    expect(out.cy).toBe(720);
    let prev = 0;
    for (const water of ["low", "mid"]) {
      for (const [w, h] of [
        [2560, 1440],
        [1440, 2560],
        [3440, 1440],
      ]) {
        fitEclipse(w, h, out, water);
        expect(out.cx).toBe(w / 2);
        expect(out.horizon).toBeGreaterThan(0.15 * h);
        expect(out.horizon).toBeLessThan(0.45 * h);
        expect(out.cy - (DISC + 0.25) * out.radius).toBeGreaterThan(out.horizon); // ring clears it
        expect(out.cy + out.radius).toBeLessThanOrEqual(h); // the corona's reach fits above
        expect(out.radius).toBeLessThanOrEqual(w / 2);
        expect(out.radius).toBeGreaterThan(0.25 * Math.min(w, h));
      }
      fitEclipse(2560, 1440, out, water);
      expect(out.horizon).toBeGreaterThan(prev); // mid sits higher than low
      prev = out.horizon;
    }
    fitEclipse(2560, 1440, out, "bogus");
    const low = { cx: 0, cy: 0, radius: 0, horizon: 0 };
    fitEclipse(2560, 1440, low, "low");
    expect(out).toEqual(low); // unknown → the default, low
  });
});

describe("effectiveMotion", () => {
  it("passes the params through normally", () => {
    const m = { rotation: 0, reactivity: 0, drift: 0 };
    effectiveMotion(0.2, 1.5, false, m);
    expect(m).toEqual({ rotation: 0.2, reactivity: 1.5, drift: 1 });
  });

  it("Reduce motion: calmer defaults (slower rotation and drift, gentler reactivity), user picks respected", () => {
    const m = { rotation: 0, reactivity: 0, drift: 0 };
    effectiveMotion(DEFAULT_ROTATION, DEFAULT_REACTIVITY, true, m);
    expect(Math.abs(m.rotation)).toBeLessThan(0.5 * DEFAULT_ROTATION);
    expect(m.reactivity).toBeLessThan(DEFAULT_REACTIVITY);
    expect(m.reactivity).toBeGreaterThan(0);
    expect(m.drift).toBeLessThan(1);
    effectiveMotion(0.2, 1.5, true, m);
    expect([m.rotation, m.reactivity]).toEqual([0.2, 1.5]);
    expect(m.drift).toBeLessThan(1);
  });
});

describe("createRipple", () => {
  it("wraps the waveform around the ring, mirrored left/right, smooth in angle and time, any length", () => {
    for (const len of [2048, 1024, 0]) {
      const ripple = createRipple();
      const wave = new Float32Array(len);
      for (let i = 0; i < len; i++) wave[i] = Math.sin((i / len) * 2 * Math.PI * 3);
      ripple.step(wave, DT);
      const first = ripple.out.slice();
      for (let t = 0; t < 0.5; t += DT) ripple.step(wave, DT);
      const r = ripple.out;
      for (let i = 0; i < SECTORS; i++) {
        expect(r[i]).toBeCloseTo(r[SECTORS - 1 - i], 5);
        expect(Math.abs(r[i])).toBeLessThanOrEqual(1);
        expect(Math.abs(r[i] - first[i])).toBeLessThanOrEqual(Math.abs(r[i]) * 0.9 + 1e-6); // eased in
        if (i > 0) expect(Math.abs(r[i] - r[i - 1])).toBeLessThan(0.15); // no jaggies
      }
      const peak = Math.max(...r);
      if (len) expect(peak).toBeGreaterThan(0.5);
      else expect(peak).toBe(0);
    }
  });
});

describe("cloudThreshold", () => {
  it("more Clouds and louder mids lower the density threshold (denser ink), bounded and smooth", () => {
    expect(cloudThreshold(0.5, 1)).toBeLessThan(cloudThreshold(0.5, 0));
    expect(cloudThreshold(1, 0)).toBeLessThan(cloudThreshold(0.2, 0));
    for (const [c, m] of [
      [0, 0],
      [1, 1],
      [5, 9],
      [NaN, NaN],
      [-1, -1],
    ]) {
      const th = cloudThreshold(c, m);
      expect(th).toBeGreaterThanOrEqual(-0.2);
      expect(th).toBeLessThanOrEqual(0.2);
    }
    expect(Math.abs(cloudThreshold(0.5, 0.51) - cloudThreshold(0.5, 0.5))).toBeLessThan(0.002);
  });

  it("loud passages spread more ink (energy lowers the edge); quiet ones leave the sky starker", () => {
    expect(cloudThreshold(0.45, 0.3, 0) - cloudThreshold(0.45, 0.3, 1)).toBeGreaterThanOrEqual(0.08);
    expect(cloudThreshold(1, 1, 1)).toBeGreaterThanOrEqual(-0.2);
  });

    it("the mids erode and spread the ink strongly: full mids shift the edge by ≥ 0.1", () => {
    expect(cloudThreshold(0.45, 0) - cloudThreshold(0.45, 1)).toBeGreaterThanOrEqual(0.1);
  });
});

/** Run `step` for `secs` at `dt`. @param {(dt: number, i: number) => void} step @param {number} secs @param {number} [dt] */
const run = (step, secs, dt = DT) => {
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) step(dt, i);
};

describe("createFlow", () => {
  it("the clouds' orbit speeds up with the music's energy: loud ≫ quiet, a slow drift in silence", () => {
    const speed = (/** @type {number} */ rms, /** @type {number} */ bassAtt) => {
      const f = createFlow();
      run((dt) => f.step(rms, bassAtt, false, 0, dt, 1), 3);
      return f.speed;
    };
    const silent = speed(0, 0);
    const quiet = speed(0.03, 1);
    const loud = speed(0.3, 1.6);
    expect(silent).toBeGreaterThan(0);
    expect(quiet).toBeGreaterThan(silent);
    expect(loud).toBeGreaterThan(4 * quiet);
    expect(loud).toBeLessThan(1); // rad/s: bounded
  });

  it("a beat surges the orbit: it rises smoothly within ~0.2 s, then settles back; bounded", () => {
    const f = createFlow();
    run((dt) => f.step(0.3, 1, false, 0, dt, 1), 3);
    const base = f.speed;
    let peak = base;
    let prev = base;
    let maxStep = 0;
    run((dt, i) => {
      f.step(0.3, 1, i === 0, 0.9, dt, 1);
      peak = Math.max(peak, f.speed);
      maxStep = Math.max(maxStep, Math.abs(f.speed - prev));
      prev = f.speed;
    }, 0.25);
    expect(peak).toBeGreaterThan(base + 0.15);
    expect(maxStep).toBeLessThan(0.4 * (peak - base)); // no one-frame jump
    run((dt) => f.step(0.3, 1, false, 0, dt, 1), 2);
    expect(f.speed).toBeCloseTo(base, 2);
    // A drum roll can't run away.
    run((dt) => f.step(0.3, 2, true, 1, dt, 2), 3);
    expect(f.speed).toBeLessThan(1.5);
  });

  it("beats in a quiet passage barely stir the orbit; in a loud one they surge it", () => {
    const avg = (/** @type {number} */ rms) => {
      const f = createFlow();
      let sum = 0;
      run((dt, i) => {
        f.step(rms, 1.2, i % 30 === 0, 0.9, dt, 1);
        if (i >= 120) sum += f.speed;
      }, 4);
      return sum / 120;
    };
    expect(avg(0.3)).toBeGreaterThan(4 * avg(0.03));
  });

    it("is frame-rate independent (60 vs 120 Hz), and Reactivity 0 leaves only the idle drift", () => {
    const drive = (/** @type {number} */ dt, /** @type {number} */ react) => {
      const f = createFlow();
      const per = Math.round(0.5 / dt); // a beat every 0.5 s
      run((d, i) => f.step(0.15 + 0.1 * Math.sin(i * d * 3), 1.2, i % per === 0, 0.9, d, react), 4, dt);
      return f;
    };
    const a = drive(1 / 60, 1);
    const b = drive(1 / 120, 1);
    expect(Math.abs(a.angle - b.angle)).toBeLessThan(0.02);
    expect(Math.abs(a.evolve - b.evolve)).toBeLessThan(0.02);
    const still = drive(1 / 60, 0);
    expect(still.speed).toBeCloseTo(drive(1 / 60, 0).speed, 9);
    expect(still.speed).toBeLessThan(0.02);
  });

  it("the clouds' formation clock (births and deaths) runs faster with energy", () => {
    const rate = (/** @type {number} */ rms) => {
      const f = createFlow();
      run((dt) => f.step(rms, 1, false, 0, dt, 1), 2);
      const e0 = f.evolve;
      run((dt) => f.step(rms, 1, false, 0, dt, 1), 1);
      return f.evolve - e0;
    };
    expect(rate(0)).toBeGreaterThan(0);
    expect(rate(0.3)).toBeGreaterThan(4 * rate(0));
  });

  it("Reduce motion's drift factor slows the orbit and the formation clock alike", () => {
    const f = createFlow();
    const g = createFlow();
    run((dt, i) => {
      f.step(0.2, 1.2, i % 30 === 0, 0.9, dt, 1);
      g.step(0.2, 1.2, i % 30 === 0, 0.9, dt, 1, 0.4);
    }, 2);
    expect(g.speed).toBeCloseTo(0.4 * f.speed, 6);
    expect(g.evolve).toBeCloseTo(0.4 * f.evolve, 6);
  });
});

describe("createCloudBias", () => {
  it("clouds billow out near loud angles and thin near quiet ones: bounded, broad, mirror-symmetric", () => {
    const bias = createCloudBias();
    const lv = new Float32Array(SECTORS);
    const loud = 40;
    for (let k = -4; k <= 4; k++) {
      lv[loud + k] = 1;
      lv[SECTORS - 1 - loud - k] = 1; // mirrored, like the corona
    }
    run((dt) => bias.step(lv, dt, 1), 1);
    const b = bias.out;
    expect(b[loud]).toBeGreaterThan(0.5);
    expect(b[SECTORS / 2]).toBeLessThan(-0.05); // a quiet angle thins
    expect(b[loud + 12]).toBeGreaterThan(0); // broad: neighbouring angles billow too
    for (let i = 0; i < SECTORS; i++) {
      expect(b[i]).toBeGreaterThanOrEqual(-1);
      expect(b[i]).toBeLessThanOrEqual(1);
      expect(b[i]).toBeCloseTo(b[SECTORS - 1 - i], 5);
    }
  });

  it("moves smoothly (no jumps when the spectrum switches) and Reactivity 0 leaves it flat", () => {
    const bias = createCloudBias();
    const lv = new Float32Array(SECTORS);
    for (let k = 30; k < 50; k++) lv[k] = lv[SECTORS - 1 - k] = 1;
    bias.step(lv, DT, 1);
    expect(bias.out[40]).toBeLessThan(0.25); // one frame moves only part-way
    const flat = createCloudBias();
    run((dt) => flat.step(lv, dt, 0), 1);
    expect(Math.max(...flat.out.map(Math.abs))).toBe(0);
  });
});

describe("createPulses", () => {
  it("each onset sends a pulse outward through the sky (rays, cloud shockwave) that fades", () => {
    const p = createPulses();
    p.step(true, 0.9, DT, 1);
    expect(p.data[1]).toBeGreaterThan(0.5);
    expect(p.data[1]).toBeLessThanOrEqual(1);
    let r = p.data[0];
    let a = p.data[1];
    run(() => {
      p.step(false, 0, DT, 1);
      if (p.data[1] > 0) {
        expect(p.data[0]).toBeGreaterThan(r);
        expect(p.data[1]).toBeLessThan(a);
        r = p.data[0];
        a = p.data[1];
      }
    }, 0.5);
    run(() => p.step(false, 0, DT, 1), 3);
    expect(p.data[1]).toBe(0); // gone
  });

  it("holds at most PULSES; Reactivity 0 sends none; amplitude scales with onset strength", () => {
    const p = createPulses();
    run((dt, i) => p.step(i % 5 === 0, 1, dt, 2), 2);
    expect(p.data.length).toBe(2 * PULSES);
    for (let i = 1; i < p.data.length; i += 2) expect(p.data[i]).toBeLessThanOrEqual(1);
    const none = createPulses();
    none.step(true, 1, DT, 0);
    expect(Math.max(...none.data)).toBe(0);
    const weak = createPulses();
    const strong = createPulses();
    weak.step(true, 0.2, DT, 1);
    strong.step(true, 1, DT, 1);
    expect(strong.data[1]).toBeGreaterThan(weak.data[1]);
  });

  it("an off-beat hat (strength 0.4) sends a much fainter pulse than a beat (0.9)", () => {
    const hat = createPulses();
    const beat = createPulses();
    hat.step(true, 0.4, DT, 1);
    beat.step(true, 0.9, DT, 1);
    expect(hat.data[1]).toBeLessThan(0.5 * beat.data[1]);
  });
});

describe("createCloudLight", () => {
  it("the clouds brighten with the bass, smoothly and bounded; silence and Reactivity 0 leave them be", () => {
    const at = (/** @type {number} */ bassAtt, /** @type {number} */ react) => {
      const l = createCloudLight();
      let prev = 0;
      run((dt) => {
        l.step(bassAtt, 0.2, false, 0, dt, react);
        expect(Math.abs(l.bright - prev)).toBeLessThan(0.15);
        prev = l.bright;
      }, 2);
      return l.bright;
    };
    expect(at(0, 1)).toBe(0);
    expect(at(1.8, 1)).toBeGreaterThan(at(1, 1));
    expect(at(1.8, 1)).toBeGreaterThan(0.5);
    expect(at(2, 2)).toBeLessThanOrEqual(1);
    expect(at(1.8, 0)).toBe(0);
  });

  it("a beat pulses the ring's rim light on the clouds: eased in, then fading", () => {
    const l = createCloudLight();
    l.step(1, 0.2, true, 0.9, DT, 1);
    const first = l.rim;
    let peak = 0;
    run(() => {
      l.step(1, 0.2, false, 0, DT, 1);
      peak = Math.max(peak, l.rim);
    }, 0.3);
    expect(first).toBeLessThan(0.5 * peak);
    expect(peak).toBeGreaterThan(0.4);
    run(() => l.step(1, 0.2, false, 0, DT, 1), 2);
    expect(l.rim).toBeLessThan(0.02);
  });
});

describe("createBillows", () => {
  const levels = new Float32Array(SECTORS);
  for (let k = -3; k <= 3; k++) levels[60 + k] = levels[SECTORS - 1 - 60 - k] = 1;

  it("a strong beat spawns a billow of ink at the ring's edge, at the loudest angle, drifting outward", () => {
    const b = createBillows();
    b.step(true, 0.9, levels, DT, 1);
    const ang = b.data[0];
    expect(Math.abs(Math.abs(ang) - Math.abs(angleOf(60)))).toBeLessThan(0.05);
    expect(b.data[1]).toBeLessThan(0.1); // at the ring's edge
    expect(b.data[2]).toBeLessThan(0.2); // it grows in (no pop)…
    let peak = 0;
    let r = b.data[1];
    run(() => {
      b.step(false, 0, levels, DT, 1);
      peak = Math.max(peak, b.data[2]);
      expect(b.data[1]).toBeGreaterThanOrEqual(r); // …drifts outward…
      r = b.data[1];
    }, 1.5);
    expect(peak).toBeGreaterThan(0.5);
    expect(r).toBeGreaterThan(0.15);
    run(() => b.step(false, 0, levels, DT, 1), 8);
    expect(b.data[2]).toBe(0); // …and dissolves
  });

  it("alternates sides of the mirrored spectrum; weak onsets and Reactivity 0 spawn none; bounded", () => {
    const b = createBillows();
    b.step(true, 0.9, levels, DT, 1);
    run(() => b.step(false, 0, levels, DT, 1), 0.5);
    b.step(true, 0.9, levels, DT, 1);
    expect(Math.sign(b.data[0])).toBe(-Math.sign(b.data[4]));
    const weak = createBillows();
    weak.step(true, 0.3, levels, DT, 1);
    const off = createBillows();
    off.step(true, 1, levels, DT, 0);
    expect(Math.max(...weak.data, ...off.data)).toBe(0);
    const many = createBillows();
    run((dt, i) => many.step(i % 10 === 0, 1, levels, dt, 2), 4);
    expect(many.data.length).toBe(4 * BILLOWS);
    for (let i = 2; i < many.data.length; i += 4) expect(many.data[i]).toBeLessThanOrEqual(1);
  });
});

describe("createWater", () => {
  /** A waveform of amplitude `a` (a 110 Hz sine). @param {number} a */
  const wave = (a) => Float32Array.from({ length: 2048 }, (_, i) => a * Math.sin((2 * Math.PI * 110 * i) / SR));

  it("the waveform keeps small ripples running: calm in silence, choppy when loud; smooth, bounded", () => {
    const chop = (/** @type {number} */ a) => {
      const w = createWater();
      const wf = wave(a);
      let prev = 0;
      run((dt, i) => {
        w.step(wf, 1, false, 0, dt, 1);
        if (i > 0) expect(Math.abs(w.chop - prev)).toBeLessThan(0.2);
        prev = w.chop;
      }, 1);
      return w.chop;
    };
    expect(chop(0)).toBeLessThan(0.15);
    expect(chop(0.05)).toBeGreaterThan(chop(0));
    expect(chop(0.5)).toBeGreaterThan(0.6);
    expect(chop(1)).toBeLessThanOrEqual(1);
  });

  it("bass swells long rolling waves (slowly) and stretches the sun's streak; frame-rate independent", () => {
    const at = (/** @type {number} */ bassAtt, /** @type {number} */ dt) => {
      const w = createWater();
      const wf = wave(0.2);
      run(() => w.step(wf, bassAtt, false, 0, dt, 1), 3, dt);
      return w;
    };
    const calm = at(0, DT);
    const big = at(1.8, DT);
    expect(calm.swell).toBeLessThan(0.05);
    expect(big.swell).toBeGreaterThan(0.6);
    expect(big.swell).toBeLessThanOrEqual(1);
    expect(big.roll).toBeGreaterThan(calm.roll); // the swells roll in faster
    expect(big.streak).toBeGreaterThan(calm.streak + 0.4);
    const b120 = at(1.8, 1 / 120);
    expect(b120.swell).toBeCloseTo(big.swell, 2);
    expect(b120.roll).toBeCloseTo(big.roll, 1);
    // Slow: a bass hit doesn't jump the swell in a frame.
    const w = createWater();
    w.step(wave(0.2), 2, false, 0, DT, 1);
    expect(w.swell).toBeLessThan(0.1);
  });

  it("beats send rings across the water: each spreads from a spot on the surface and fades", () => {
    const w = createWater();
    const wf = wave(0.2);
    w.step(wf, 1, true, 0.9, DT, 1);
    const [x, z, r0, a0] = w.rings.slice(0, 4);
    expect(Math.abs(x)).toBeLessThan(1); // near the sun's reflection…
    expect(z).toBeGreaterThan(1); // …out on the water (z = 1 at the bottom edge)
    expect(a0).toBeGreaterThan(0.5);
    run(() => w.step(wf, 1, false, 0, DT, 1), 1);
    expect(w.rings[2]).toBeGreaterThan(r0 + 0.2);
    expect(w.rings[3]).toBeLessThan(a0);
    expect(w.rings[0]).toBe(x); // the spot stays put
    run(() => w.step(wf, 1, false, 0, DT, 1), 6);
    expect(w.rings[3]).toBe(0);
    const many = createWater();
    run((dt, i) => many.step(wf, 1, i % 7 === 0, 1, dt, 2), 3);
    expect(many.rings.length).toBe(4 * RINGS);
    const off = createWater();
    off.step(wf, 1, true, 1, DT, 0);
    expect(off.rings[3]).toBe(0);
  });
});

describe("backgroundDrive", () => {
  it("the background's beat and bass responses scale with the energy: calm when quiet, × Reactivity", () => {
    expect(backgroundDrive(1, 1)).toBe(1);
    expect(backgroundDrive(1, 0)).toBeGreaterThan(0); // a quiet beat still stirs it, gently
    expect(backgroundDrive(1, 0)).toBeLessThan(0.35);
    expect(backgroundDrive(1, 0.5)).toBeGreaterThan(backgroundDrive(1, 0.2));
    expect(backgroundDrive(2, 1)).toBe(2);
    expect(backgroundDrive(0, 1)).toBe(0);
    expect(backgroundDrive(1, NaN)).toBe(backgroundDrive(1, 0));
  });
});
