// @ts-check
/** Bass pulse (PRD "Pulse"). */

/** Highest smoothed pulse. */
export const PULSE_MAX = 1.5;

/**
 * Where the pulse heads for a given bass level (1.0 = this song's recent average).
 * @param {number} bass
 */
export function pulseTarget(bass) {
  const t = (bass - 1) * 1.2;
  return t < 0 ? 0 : t > PULSE_MAX ? PULSE_MAX : t;
}

/** Approach rates toward the target, per second: soft attack, gentle release. */
export const RISE = 18;
export const FALL = 4;

/**
 * Smoothed bass pulse, 0 to {@link PULSE_MAX}. Multiply by the Pulse param to get `p`.
 */
export function createPulse() {
  let avg = 0.05;
  const pulse = {
    value: 0,
    /**
     * @param {{ bass?: unknown, waveform: ArrayLike<number>, sampleRate: number }} audio
     * @param {number} dt seconds
     */
    step(audio, dt) {
      let bass = audio.bass;
      if (typeof bass !== "number") {
        // No host bass level: low-passed RMS relative to its own slow running average.
        const b = lowRms(audio.waveform, audio.sampleRate || 48000);
        avg += (b - avg) * Math.min(1, dt * 0.6);
        bass = b / Math.max(avg, 1e-4);
      }
      const target = pulseTarget(/** @type {number} */ (bass));
      // Exponential approach, exact for any dt, so 60 Hz and 120 Hz displays pulse alike.
      const k = 1 - Math.exp(-dt * (target > pulse.value ? RISE : FALL));
      pulse.value += (target - pulse.value) * k;
      return pulse.value;
    },
  };
  return pulse;
}

/** Radius swell per unit of `p` (6%: barely noticeable at defaults, felt more than seen). */
export const SWELL = 0.06;
/** Brightness lift per unit of `p`. */
export const LIFT = 0.12;

/**
 * Radius multiplier for pulse `p` (smoothed × Pulse param). Mirrors the vertex shader.
 * @param {number} p
 */
export function swell(p) {
  return 1 + SWELL * p;
}

/**
 * RMS of the newest (up to) 2048 samples after a one-pole low-pass at about 140 Hz: the fallback
 * bass level when the host gives none.
 * @param {ArrayLike<number>} wave
 * @param {number} sampleRate Hz
 */
export function lowRms(wave, sampleRate) {
  const a = 1 - Math.exp((-2 * Math.PI * 140) / sampleRate);
  const n = Math.min(wave.length, 2048);
  let y = 0;
  let sum = 0;
  for (let i = wave.length - n; i < wave.length; i++) {
    y += a * (wave[i] - y);
    sum += y * y;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}
