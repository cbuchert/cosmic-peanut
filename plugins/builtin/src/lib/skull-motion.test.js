// @ts-check
import { describe, expect, it } from "vitest";
import { createSkullMotion, DEFAULTS, effectiveDrive, createSpring, JAW_LIMIT, JAW_MAX, NOD_LIMIT, PULSE_LIMIT, TILT_LIMIT, TURN_LIMIT } from "./skull-motion.js";

/** Run a spring for `seconds` at `hz`, target 1 from rest, and record its trajectory. */
/** @param {number} hz @param {number} seconds */
function stepResponse(hz, seconds, freq = 3, damping = 0.35) {
  const s = createSpring(freq, damping);
  const out = [];
  for (let f = 0; f < hz * seconds; f++) out.push(s.step(1, 1 / hz));
  return out;
}

describe("createSpring", () => {
  it("rises toward the target, overshoots once, then settles on it", () => {
    const y = stepResponse(60, 3);
    const peak = Math.max(...y);
    expect(y[1]).toBeGreaterThan(0);
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.6);
    expect(y[y.length - 1]).toBeCloseTo(1, 3);
  });
});

describe("createSpring at different frame rates", () => {
  it("follows the same trajectory at 60 Hz and 120 Hz", () => {
    const a = stepResponse(60, 2);
    const b = stepResponse(120, 2);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[2 * i + 1]), `frame ${i}`).toBeLessThan(1e-3);
  });

  it("an impulse (kick) swings out and returns to rest", () => {
    const s = createSpring(3, 0.35);
    s.kick(2);
    let peak = 0;
    for (let f = 0; f < 180; f++) peak = Math.max(peak, s.step(0, 1 / 60));
    expect(peak).toBeGreaterThan(0.05);
    expect(Math.abs(s.value)).toBeLessThan(1e-3);
  });
});

/** A mutable fake audio frame with just the fields the motion reads. */
function fakeAudio() {
  return { onset: false, onsetStrength: 0, bass: 1, bassAtt: 1, beatPhase: 0 };
}
const DRIVE = { jaw: 1, reactivity: 1, nod: 1 };

describe("createSkullMotion jaw", () => {
  it("chomps on a kick: opens fast, then closes again", () => {
    const m = createSkullMotion();
    const a = fakeAudio();
    const jaw = [];
    for (let f = 0; f < 90; f++) {
      a.onset = f === 0;
      a.onsetStrength = f === 0 ? 1 : 0;
      a.bass = f < 6 ? 2 : 1;
      m.step(a, 1 / 60, DRIVE);
      jaw.push(m.jaw);
    }
    const peakAt = jaw.indexOf(Math.max(...jaw));
    expect(Math.max(...jaw)).toBeGreaterThan(0.5 * JAW_MAX);
    expect(peakAt / 60).toBeLessThan(0.2);
    expect(jaw[89]).toBeLessThan(0.05 * JAW_MAX);
  });
});

/** Drive a motion with violent random audio at `hz` for `seconds`, calling `each` after steps. */
/**
 * @param {number} hz @param {number} seconds
 * @param {{ jaw: number, reactivity: number, nod: number }} drive
 * @param {(m: ReturnType<typeof createSkullMotion>) => void} each
 */
function violent(hz, seconds, drive, each) {
  const m = createSkullMotion();
  const a = fakeAudio();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let f = 0; f < hz * seconds; f++) {
    a.onset = rnd() < 0.3;
    a.onsetStrength = rnd() * 5;
    a.bass = rnd() * 6;
    a.bassAtt = rnd() * 6;
    a.beatPhase = rnd();
    m.step(a, 1 / hz, drive);
    each(m);
  }
}

describe("createSkullMotion bounds", () => {
  it("never opens the jaw past JAW_LIMIT or below closed, even at max params", () => {
    for (const hz of [60, 120]) {
      violent(hz, 10, { jaw: 2, reactivity: 2, nod: 1 }, (m) => {
        expect(m.jaw).toBeGreaterThanOrEqual(0);
        expect(m.jaw).toBeLessThanOrEqual(JAW_LIMIT);
      });
    }
  });
});

describe("createSkullMotion nod", () => {
  it("nods on a beat: the head dips, swings back and comes to rest", () => {
    const m = createSkullMotion();
    const a = fakeAudio();
    const pitch = [];
    for (let f = 0; f < 120; f++) {
      a.onset = f === 0;
      a.onsetStrength = f === 0 ? 1 : 0;
      m.step(a, 1 / 60, DRIVE);
      pitch.push(m.pitch);
    }
    expect(Math.max(...pitch)).toBeGreaterThan(0.4 * NOD_LIMIT);
    expect(Math.min(...pitch)).toBeLessThan(0); // overshoot back up
    expect(Math.abs(pitch[119])).toBeLessThan(0.05 * NOD_LIMIT);
  });
});

describe("createSkullMotion turn, tilt and pulse", () => {
  it("turns the head side to side, one sway per two beats, following beatPhase", () => {
    const m = createSkullMotion();
    const a = fakeAudio();
    const yaw = [];
    // 120 BPM: beatPhase ramps 0→1 twice a second.
    for (let f = 0; f < 60 * 6; f++) {
      a.beatPhase = ((f / 60) * 2) % 1;
      m.step(a, 1 / 60, DRIVE);
      if (f >= 60 * 4) yaw.push(m.yaw);
    }
    const hi = Math.max(...yaw);
    const lo = Math.min(...yaw);
    expect(hi).toBeGreaterThan(0.5 * TURN_LIMIT);
    expect(lo).toBeLessThan(-0.5 * TURN_LIMIT);
    // Period 1 s (two beats): the sway a full period later is where it was.
    expect(Math.abs(yaw[60] - yaw[0])).toBeLessThan(0.1 * TURN_LIMIT);
    expect(Math.abs(yaw[30] - yaw[0])).toBeGreaterThan(0.5 * TURN_LIMIT);
  });
});

describe("createSkullMotion tilt and pulse", () => {
  it("tilts to alternate sides on successive beats", () => {
    const m = createSkullMotion();
    const a = fakeAudio();
    const roll = [];
    for (let f = 0; f < 60; f++) {
      a.onset = f === 0 || f === 30;
      a.onsetStrength = 1;
      m.step(a, 1 / 60, DRIVE);
      roll.push(m.roll);
    }
    const first = roll.slice(0, 30);
    const second = roll.slice(30);
    const extreme = (/** @type {number[]} */ r) => r.reduce((x, y) => (Math.abs(y) > Math.abs(x) ? y : x), 0);
    expect(Math.abs(extreme(first))).toBeGreaterThan(0.3 * TILT_LIMIT);
    expect(Math.sign(extreme(second))).toBe(-Math.sign(extreme(first)));
  });

  it("swells with bassAtt and relaxes to 1 on average bass", () => {
    const m = createSkullMotion();
    const a = fakeAudio();
    a.bassAtt = 2;
    for (let f = 0; f < 120; f++) m.step(a, 1 / 60, DRIVE);
    expect(m.scale).toBeGreaterThan(1 + 0.5 * PULSE_LIMIT);
    a.bassAtt = 1;
    for (let f = 0; f < 180; f++) m.step(a, 1 / 60, DRIVE);
    expect(m.scale).toBeCloseTo(1, 3);
  });
});

describe("createSkullMotion smoothness", () => {
  it("keeps every motion bounded and free of jumps, even on violent audio, at 60 and 120 Hz", () => {
    // Max speed per field (units/s): a jump would exceed these by far.
    const vmax = { jaw: 12, pitch: 6, roll: 4, yaw: 3, scale: 1 };
    const lim = { jaw: [0, JAW_LIMIT], pitch: [-NOD_LIMIT, NOD_LIMIT], roll: [-TILT_LIMIT, TILT_LIMIT], yaw: [-TURN_LIMIT, TURN_LIMIT], scale: [0.95, 1 + PULSE_LIMIT] };
    for (const hz of [60, 120]) {
      /** @type {Record<string, number> | null} */
      let prev = null;
      violent(hz, 10, { jaw: 2, reactivity: 2, nod: 1 }, (m) => {
        for (const k of /** @type {(keyof typeof vmax)[]} */ (Object.keys(vmax))) {
          expect(m[k], k).toBeGreaterThanOrEqual(lim[k][0]);
          expect(m[k], k).toBeLessThanOrEqual(lim[k][1]);
          if (prev) expect(Math.abs(m[k] - prev[k]) * hz, `${k} @${hz}`).toBeLessThanOrEqual(vmax[k]);
        }
        prev = { jaw: m.jaw, pitch: m.pitch, roll: m.roll, yaw: m.yaw, scale: m.scale };
      });
    }
  });
});

describe("effectiveDrive", () => {
  const out = { speed: 0, warp: 0, nod: 0, ripple: 0, jaw: 0, reactivity: 0 };

  it("passes params straight through without Reduce motion", () => {
    effectiveDrive({ ...DEFAULTS, speed: 1.5, jaw: 0.5 }, false, out);
    expect(out).toEqual({ speed: 1.5, warp: DEFAULTS.warp, nod: 1, ripple: 1, jaw: 0.5, reactivity: DEFAULTS.reactivity });
  });

  it("calms flow, warp, nods and ripples under Reduce motion while they're at their defaults", () => {
    effectiveDrive(DEFAULTS, true, out);
    expect(out.speed).toBeLessThan(0.5 * DEFAULTS.speed);
    expect(out.warp).toBeLessThan(DEFAULTS.warp);
    expect(out.nod).toBeLessThan(0.5);
    expect(out.ripple).toBeLessThan(0.5);
  });

  it("respects values the user chose even under Reduce motion", () => {
    effectiveDrive({ ...DEFAULTS, speed: 1.7, warp: 1.4, reactivity: 1.2 }, true, out);
    expect(out.speed).toBe(1.7);
    expect(out.warp).toBe(1.4);
    expect(out.nod).toBe(1);
    expect(out.ripple).toBe(1);
  });
});
