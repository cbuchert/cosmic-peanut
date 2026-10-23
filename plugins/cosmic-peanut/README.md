# Cosmic Peanut

A slowly turning, glowing sphere made only of jagged waveform rings. Each ring is one short slice
of the audio wrapped around a line of latitude; new rings are born at the north pole, drift south
over a few seconds and fade out at the south pole. No surface is ever drawn: the sphere is implied
by the rings, with the far side dimmer than the near side. On kicks the whole form swells very
slightly and brightens a touch. Built-in `webgl2` visualizer; spec in
[`docs/cosmic-peanut-prd.md`](../../docs/cosmic-peanut-prd.md).

## Parameters

| id | Label | Default | Range | Effect |
| --- | --- | --- | --- | --- |
| `travel` | Travel time | 7 | 2–20 s | Seconds for a ring to go pole to pole |
| `amp` | Amplitude | 0.22 | 0–0.6 | How far the waveform pushes along the surface normal |
| `detail` | Detail | 0.7 | 0–1 | Window length (1024 → 192 samples). Higher is more jagged |
| `pulse` | Bass pulse | 0.35 | 0–1 | Strength of the bass swell (6% × p) and brightening |
| `orbit` | Orbit speed | 0.12 | −0.6–0.6 rad/s | Camera yaw speed; negative reverses |
| `bright` | Brightness | 1 | 0.2–2 | Overall gain |
| `density` | Rings | medium | sparse 120 / medium 240 / dense 400 | Rings alive at once (reallocates the history) |
| `palette` | Palette | nebula | nebula / ember / phosphor | Color ramp by age |
| `lines` | Lines | soft | soft / fine | Soft: 1× multisampled buffer upscaled (slight glow). Fine: native resolution, gain × 1.35 |
| `antialias` | Antialias soft lines | on | on / off | 2× MSAA for soft lines, matching the prototype's smoothness. Off saves ~7.5 MB of GPU memory at 1440p (total ~6 MB vs ~13.5 MB) |

Drag to orbit (0.006 rad/px); letting go resumes the self-orbit from there. With macOS Reduce
motion on, Orbit speed and Bass pulse act as 0 and 0.1 until you move them off their defaults.

## How it works

- **Rings** (`src/lib/ring.js`): when a ring is due, take a window of `audio.waveform` starting
  at the first rising zero crossing (sub-sample accurate, so a steady tone gives identical rings),
  point-sample it to 512 points with linear interpolation (no averaging), divide by a slowly
  decaying tracked peak (× 0.992 per ring, floor 0.02, clamp ±1.5) and taper 8% at each end so
  the ring closes without a seam.
- **History** (`history.js`, `scheduler.js`): rings go into an M × N `R32F` texture used as a
  circular buffer, one `texSubImage2D` row per ring. Rings are pushed at a fixed N ÷ travel per
  second from a `dt` accumulator; the leftover fraction moves every ring continuously between
  pushes. Unwritten rows hold a sentinel (1e6) and are invisible.
- **Geometry** (`geometry.js`, `shaders/rings.vert`): a static grid of (j, i) vertices drawn as
  one `LINE_STRIP` `drawElements` call with primitive restart; the vertex shader places point j of
  ring i at latitude π·age, radius (1 + amp·s)(1 + 0.06·p).
- **Color** (`shaders/rings.frag`): additive blending, cosine palette by age, depth cue from view
  depth, newest brightest, gain × √(240 ÷ N).
- **Transparency**: the canvas is transparent and premultiplied. Each fragment outputs
  (c, max(c)) and blends ONE, ONE onto a 0,0,0,0 clear, so summed alpha always covers summed
  colour; the 2× MSAA resolve and the soft blit carry that RGBA through. Over black it's the same
  image as before; over the desktop the rings read as light, with no dark box.
- **Pulse** (`pulse.js`): target clamp((bass − 1) × 1.2, 0, 1.5), approached at 18/s rising and
  4/s falling, × Pulse. Falls back to a 140 Hz low-passed RMS of the waveform when there's no
  `audio.bass`.
- **Camera** (`camera.js`): yaw += orbit·dt, pitch sways ±0.3 rad around 0.42, framed to fit the
  sphere at full swell (also in portrait). Matrices are written into preallocated arrays.

## Möbius

The pack's second visualizer, `mobius`: the same rings on a Möbius strip. It is the same entry
module; `src/lib/shapes.js` picks the vertex shader and the scene's extent (camera fit and depth
fade radius) by `ctx.id`. History, scheduler, pulse, camera, `rings.frag` and the blit are shared.

- **Mapping** (`shaders/mobius.vert`): each ring is an open slice across the strip's width
  (v = −W…W as j = 0…M) and travels along it. Age 0…1 maps to u = 4π·age, and
  p(u, v) = ((R + v·cos(u/2))·cos u, v·sin(u/2), (R + v·cos(u/2))·sin u) with R = 1: the strip
  lies flat in the horizontal plane and twists out of it. The waveform pushes along the analytic
  surface normal; the bass pulse swells the whole strip by up to 6%, as on the sphere.
- **Two laps**: the half twist brings a slice back upside down after one lap (the normal has
  flipped, so the waveform now pushes the other way) and lined up after two. Rings are born and
  fade out at the same place (u = 0 ≡ 4π), where the age fades hide the overlap.
- **Params**: all of Cosmic Peanut's, plus `width` (Strip width, 0.15–0.7, default 0.4), the half
  width W. Travel time covers both laps. The camera fits R + W + amp with the sphere's 1.32 margin.

`frame()` allocates nothing. Tests: `cd web && npx vitest run ../plugins/cosmic-peanut`.
