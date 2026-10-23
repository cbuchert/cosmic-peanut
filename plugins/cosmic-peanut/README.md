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

The pack's second visualizer, `mobius`: waveform slices on a closed Möbius band, by default
today's loop at full length. Shorten Length, or switch Track to the figure-8, and the ribbon
becomes a snake winding along the track. It is the same entry module; `src/lib/shapes.js` picks the vertex shader by `ctx.id`.
History, scheduler, pulse, `rings.frag` and the blit are shared with the sphere.

- **Snake** (`src/lib/snake.js`): the ribbon covers Length of the track and its head advances
  along it at Length ÷ Travel time of the track per second, so Travel time is a slice's trip from
  head to tail. Each pushed slice is placed where the head was when its push was due
  (`history.step` reports how long ago that was) and stays there: older slices trail behind,
  nothing slides, and the tail fades out over its own stretch (the age fades in `rings.frag`; the
  head fades in briefly). Places are stored as fractions of the track, so changing Track keeps
  them. On the beat the head surges by up to 30% × envelope × Beat, eased like the other beat
  effects; slices laid during a surge are just spaced a little further apart. The surge is capped
  at the room left on the track (envelope × (1 − Length) ÷ Length), so the ribbon never covers
  more than the whole track. At Length 1 there is no surge, and the band closes exactly as it did
  before the snake: newest and oldest slices meet at one place, hidden by the age fades.
- **Tracks** (`src/lib/track.js`): each track is a table sampled evenly in arc length (1024
  samples; `uTrack`, RGBA32F × 3 rows: centre, unit tangent, cross-section direction with the
  twist in it). It is built in JS on Track change, and the camera fit reads the same table. The
  frame is analytic: n = normalize(up × t) is horizontal and can't flip, because neither track's
  tangent is ever vertical; b = t × n; w = cos τ·n + sin τ·b.
  - `figure-8`: an "unfolded Klein bottle", a Möbius strip and its mirror image joined.
    The centre line c(φ) = (1.9 cos φ, 0.55 sin φ, 1.9 sin φ cos φ) is a lemniscate whose lobes
    tilt out of plane like a saddle, so its two passes through the crossing are 1.1 apart, both
    lying flat there. From the crossing, τ = π(1 − cos 2πq)/2 turns the cross-section half a turn
    one way over lobe A (right-handed) and back over lobe B (left-handed). It is 11.9 long, about
    1.9 laps of the loop's circle.
  - `loop` (default): the unit circle, two laps (4π), with τ = u/2. A cross-section comes back
    upside down after one lap and lined up after two. At Length 1 (the default) it's the closed
    band. Length 0.5 is one lap, so the head meets the fading tail: use less for a visible snake.
- **Mapping** (`shaders/mobius.vert`): a slice is an open line across the strip (v = −W…W as
  j = 0…M) at its place on the track: p = c + size·(v·w′ + amp·s·(t × w′)). Here w′ is w turned
  about t by the wring, and size is the scale the slice was laid at (below).
- **Framing** (`camera.js` `fitTrack`): the camera distance is solved per point. Every strip
  edge, ± amp along the normal, over every yaw and the sway's pitch range (0.12–0.72), must fit in
  75% of the shorter screen side and 90% of the longer. It is recomputed only when Track, Strip
  width, Amplitude or the aspect change. The depth fade uses the track's horizontal reach.
- **On the beat** (`src/lib/beat.js`): each beat gives a 0–1 envelope and bumps a beat counter.
  The envelope eases up with a smoothstep over 80 ms to the beat's level (1 on a tempo beat, the
  onset strength otherwise), then eases back down with another smoothstep, reaching 0 at 0.9 of a
  beat. Every join has zero slope, so nothing clicks; a beat landing mid-envelope rises from
  where it is. With a confident tempo (`bpm` > 0) beats are the `beatPhase` wraps and onsets only
  accent (× 0.2, no extra beats); otherwise onsets with `onsetStrength` ≥ 0.6 are beats, at least
  0.2 s apart. This is the same rule as Tie-Dye's `createFlow`, copied because packs can't import
  from each other. Everything that changes size or amplitude is baked into the slices laid during
  the beat, so nothing already on the strip grows:
  - **Stamp**: the rings pushed while the envelope is up are scaled by 1 + 0.8 × envelope × Beat
    (`history.step`'s `gain`, applied after the auto-gain and clamp, so the tracked peak never
    learns from it). Each beat rides along the strip as a band of louder slices.
  - **Breath and bass swell**: each slice is laid at size (1 + 0.07 × envelope × Beat) ×
    (1 + 0.06 × bass pulse), stored next to its place (`uPos.g`). It scales the width and the
    waveform about the centre line.
  - **Glow**: the newest slices (age < 0.18) brighten by up to 25% × envelope × Beat (`uGlow` in
    `rings.frag`). With Reduce flashing on it's a quarter of that and passes through `lib/flash.js`
    (a copy of the builtin pack's limiter): at most 3 rises per second.
  - **Wring**, the one frame-wide beat effect: the cross-section turns about the tangent by
    φ = 0.2 rad × envelope × Beat, alternating sides each beat (the signed envelope eases through
    the same rise). It's a roll, not a size change, but it moves the whole strip.
  - **Surge**: the head speeds up, as above.
- **Params**: all of Cosmic Peanut's, plus:
  - `width` (Strip width, 0.15–0.7, default 0.4): the half width W.
  - `beat` (Beat, 0–2, default 1): scales the wring, breath, glow, stamp and surge together.
    0 turns them off; 2 is about as strong as the first, too-strong cut.
  - `track` (Track: loop | figure-8, default loop).
  - `length` (Length, 0.2–1, default 1): the fraction of the track the ribbon covers. Below 1 it
    snakes.

  With Reduce motion on, Beat acts as 0.25 for the wring, breath, stamp and surge until you move
  it off its default (the glow isn't motion and keeps the Beat value). The bass pulse still
  brightens the whole strip a little (`uPulse` in `rings.frag`, as on the sphere). The sphere has
  no Beat, Track or Length param, and draws exactly as before.

`frame()` allocates nothing (the track table and camera fit are rebuilt only on param or size
changes). Tests: `cd web && npx vitest run ../plugins/cosmic-peanut`; `src/cosmic-peanut.test.js`
runs the entry itself on a recording fake WebGL2 context.
