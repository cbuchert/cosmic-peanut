// @ts-check
import { describe, expect, it } from "vitest";
import { createBeat } from "./beat.js";
import { createHistory } from "./history.js";
import { SURGE, createSnake, headSpeed } from "./snake.js";

const WAVE = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * 0.3) * 0.5);

/** Track distance from b forward to a, as a fraction 0–1. @param {number} a @param {number} b */
const ahead = (a, b) => (((a - b) % 1) + 1) % 1;

describe("headSpeed", () => {
  it("covers Length of the track in one Travel time (fractions of the track per second)", () => {
    expect(headSpeed(0.5, 7, 0, 1)).toBeCloseTo(0.5 / 7, 12);
    expect(headSpeed(1, 2, 0, 1)).toBeCloseTo(0.5, 12);
  });

  it("surges by up to SURGE × Beat on the beat envelope, gently", () => {
    expect(SURGE).toBeGreaterThan(0);
    expect(SURGE).toBeLessThanOrEqual(0.4);
    expect(headSpeed(0.5, 7, 1, 1)).toBeCloseTo((0.5 / 7) * (1 + SURGE), 12);
    expect(headSpeed(0.5, 7, 0.5, 2)).toBeCloseTo((0.5 / 7) * (1 + SURGE), 12);
    expect(headSpeed(0.5, 7, 1, 0)).toBeCloseTo(0.5 / 7, 12);
  });
});

describe("createSnake", () => {
  it("advances the head and wraps it to 0–1", () => {
    const s = createSnake(240);
    expect(s.head).toBe(0);
    for (let f = 0; f < 60; f++) s.step(1 / 60, 0.3);
    expect(s.head).toBeCloseTo(0.3, 9);
    for (let f = 0; f < 240; f++) s.step(1 / 60, 0.3);
    expect(s.head).toBeCloseTo(0.5, 9); // 1.5 wraps to 0.5
  });

  it("places a pushed slice where the head was when its push was due", () => {
    const s = createSnake(8);
    for (let f = 0; f < 30; f++) s.step(1 / 60, 0.2);
    s.place(3, 0.25, 0.2);
    expect(s.pos[3]).toBeCloseTo(0.1 - 0.05, 6); // float32 places
    s.place(4, 0.75, 0.2); // before the start: wraps
    expect(s.pos[4]).toBeCloseTo(0.95, 6);
  });

  it("lays slices that stay put, newest at the head, Length of the track from head to tail", () => {
    const N = 240;
    const snake = createSnake(N);
    const beat = createBeat();
    const a = { bpm: 120, beatPhase: 0, onset: false, onsetStrength: 0 };
    let speed = headSpeed(0.5, 4, 0, 1);
    const h = createHistory(512, N, (row, _, ago) => snake.place(row, ago, speed));
    /** @type {Float32Array} */
    let before = new Float32Array(0);
    for (let f = 0; f < 60 * 10; f++) {
      a.beatPhase = ((f / 60) * 2) % 1;
      beat.step(a, 1 / 60);
      speed = headSpeed(0.5, 4, 0, 1); // no surge here: an exact Length
      snake.step(1 / 60, speed);
      if (f === 60 * 9) before = snake.pos.slice();
      h.step(WAVE, 1 / 60, 4, 0.7);
    }
    // Rows written before the last second hold the same place (no sliding).
    let still = 0;
    for (let r = 0; r < N; r++) {
      const age = (h.head - r + N) % N;
      if (age > 70) {
        expect(snake.pos[r]).toBe(before[r]);
        still++;
      }
    }
    expect(still).toBeGreaterThan(100);
    const newest = snake.pos[h.head];
    const oldest = snake.pos[(h.head + 1) % N];
    const lag = ahead(snake.head, newest);
    expect(Math.min(lag, 1 - lag)).toBeLessThan(0.5 / N + 1e-6); // newest right at the head (float32)
    expect(ahead(newest, oldest)).toBeCloseTo(0.5 * (N - 1) / N, 2); // spans Length
  });

  it("restarts at a new density", () => {
    const s = createSnake(120);
    s.step(1, 0.3);
    s.resize(400);
    expect(s.pos.length).toBe(400);
    expect(s.head).toBeCloseTo(0.3, 9); // the head keeps its place
  });
});
