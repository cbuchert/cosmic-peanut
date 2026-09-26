# Cosmic Peanut visualizer PRD

> Snapshot of the Cosmic Peanut PRD (claude.ai doc, 2026-09-25). The reference prototype is
> [`reference/cosmic-peanut-prototype.html`](reference/cosmic-peanut-prototype.html) and is the
> source of truth for the look.

## Summary

Cosmic Peanut is a 3D Tidalviz visualizer. It turns each moment's waveform into a ring on an
invisible sphere, and the rings drift from the north pole to the south pole over a few seconds. It
ships as a built-in plugin with the `webgl2` renderer and follows the plugin contract in the
Tidalviz PRD.

It recreates a remembered visualization of the same name. A working browser prototype exists (see
Reference prototype) and is the source of truth for the look; this PRD turns it into a production
plugin.

Done means:

- It runs as a built-in Tidalviz plugin from `plugins/cosmic-peanut/`, with a valid
  `tidalviz.json` and the parameters listed below.
- Side by side with the prototype on the same audio, it's visually indistinguishable at default
  settings.
- It holds 60 fps at 2560×1440 on the reference M1 MacBook Air with the Dense ring setting, within
  the budgets below.
- The acceptance tests at the end of this doc pass.

## The look

The viewer should see a slowly turning, glowing sphere made only of jagged waveform rings, with no
surface ever drawn. New rings are born at the north pole, travel south, and fade out at the south
pole.

- **Rings are waveforms.** Each ring is one short slice of the audio wrapped around a line of
  latitude. The waveform displaces the ring outward and inward along the sphere's surface normal,
  not up and down.
- **Jagged, not smooth.** High-frequency detail should show as fine spikes and teeth on the rings.
  Never smooth or low-pass the waveform for display.
- **The sphere is implied.** It exists only in the rings' positions. The far side is dimmer than the
  near side, which gives the depth. With silence, nothing should be visible except flat circles for
  moments that actually had signal.
- **Continuous drift.** Rings glide smoothly between positions. There's no stepping, even at 120 Hz.
- **Self-orbiting camera.** The view turns slowly on its own and gently rises and falls, so both
  poles come into view over time.
- **Subtle bass pulse.** On kicks and bass notes, the whole form swells very slightly and brightens
  a touch, then eases back. It should read as breathing, not bouncing. The first prototype pulsed
  too hard, and the user explicitly asked for more subtlety: at defaults, the swell should be barely
  noticeable on its own and felt more than seen.

## Rendering spec

All geometry is computed on the GPU from a static vertex grid and a waveform history texture, so
the CPU work per display frame is a handful of uniforms and one draw call.

### Ring history

- Keep N rings alive (Sparse 120, Medium 240, Dense 400). Each ring has M = 512 points.
- Store the rings in an `R32F` texture of M × N, used as a circular buffer with a `head` row index.
  Writing a new ring is one `texSubImage2D` of one row.
- Initialize every texel to a sentinel (1e6). The shader treats sentinel rows as invisible, so no
  sphere of flat circles appears at startup or after a density change.
- Push new rings at a fixed rate of N ÷ travel time rings per second, driven by an accumulator on
  `dt`, not once per display frame. The leftover fraction (`frac`, 0 to 1) is passed to the shader
  so rings move continuously between pushes.

### Geometry

For ring i (0 = newest) and point j, with the waveform sample s from the history texture:

```
age = (i + frac) / (N − 1),   θ = π · age,   φ = 2πj / M
r = (R + A·s)(1 + 0.06·p),    x = r (sinθ cosφ, cosθ, sinθ sinφ)
```

Here R = 1 is the sphere radius, A is the Amplitude parameter, and p is the current pulse value
(0 to about 1.5). So at the highest pulse the form swells by 9%, and at typical default pulses by
1–3%.

- Draw every ring as a closed `LINE_STRIP` of M + 1 vertices (the last repeats point 0), all in one
  `drawElements` call, using primitive restart (`0xFFFFFFFF` with `UNSIGNED_INT` indices) between
  rings.
- The vertex attribute is just (j, i). Everything else comes from uniforms and the texture.

### Turning a waveform into a ring

1. **Window:** window length W = round(1024 − 832 × Detail) samples, so Detail 0 gives 1024 samples
   and Detail 1 gives 192.
2. **Trigger:** start the window at the first rising zero crossing, oscilloscope-style, so
   consecutive rings line up. If fewer than 2W samples are available, start at 0.
3. **Resample:** point-sample W samples into M points with linear interpolation. No averaging or
   filtering, which would lose the jaggedness.
4. **Auto-gain:** track the peak with a slow decay (× 0.992 per ring, floor 0.02), divide by it,
   and clamp to ±1.5.
5. **Close the seam:** taper the first and last 8% of points to zero with a raised-cosine ramp, so
   the ring closes without a visible jump.

### Color and depth

- Additive blending (`ONE, ONE`) with no depth test, so overlapping rings glow.
- Fade in over the first 3.5% of age and out over the last 12%.
- Depth cue: brightness falls from 1.0 on the near side to 0.16 on the far side, computed from
  view-space depth against the camera distance and radius.
- Newest rings are brightest: brightness goes from 1.5 at age 0 to 0.35 at age 1.
- Color comes from a cosine palette indexed by age. Nebula, Ember and Phosphor are specified in the
  prototype's fragment shader. Spikes add `0.35 × |s|` of white, and the pulse adds `0.12 × p`.
- Overall gain scales with √(240 ÷ N), so density changes don't change total brightness.

### Line softness

WebGL lines are always 1 device pixel wide. "Soft lines" renders the rings into an offscreen
framebuffer at 1× scale and upscales it to the canvas with linear filtering, which gives a slight
glow. "Fine lines" renders at native DPR, with gain × 1.35 to compensate for the thinner lines. The
plugin does this itself, rather than relying on the host's DPR.

## Audio inputs and pulse

The plugin reads only two things from each frame: the waveform (for the rings) and `bass` (for the
pulse).

### Host dependency: longer waveform — DONE

The frame contract now carries the newest 2,048 samples per channel, overlapping between frames
(docs/protocols.md §1). If a shorter waveform arrives, the plugin still works: it skips the trigger
and uses what it has.

### Pulse

1. **Input:** `audio.bass`, which follows MilkDrop's convention where 1.0 is the song's recent
   average. If the host doesn't provide it, compute a stand-in the way the prototype does: low-pass
   the waveform at about 140 Hz, take the RMS, and divide by a slow running average.
2. **Target:** `clamp((bass − 1.0) × 1.2, 0, 1.5)`, so only above-average bass moves anything.
3. **Smoothing:** rise toward the target at rate 18/s and fall back at 4/s. This gives a soft attack
   with no hard snap, and a gentle release.
4. **Output:** `p = smoothed × Pulse`, where Pulse is the parameter (default 0.35). `p` drives the
   6% radius swell and the 0.12 brightness lift in the rendering spec.

This replaces the prototype's first-pass values (14% swell, 0.25 brightness, 30/s attack, default
0.7), which the user found too strong.

## Manifest and parameters

Nine parameters; the host generates their controls from the manifest. Density is the only one that
reallocates anything; every other change applies on the next frame.

| id | Type | Label | Default | Range or options | Effect |
| --- | --- | --- | --- | --- | --- |
| `travel` | number | Travel time | 7 | 2–20 s, step 0.5 | Seconds for a ring to go pole to pole |
| `amp` | number | Amplitude | 0.22 | 0–0.6 | How far the waveform pushes along the normal |
| `detail` | number | Detail | 0.7 | 0–1 | Window length. Higher is shorter and more jagged |
| `pulse` | number | Bass pulse | 0.35 | 0–1 | Strength of the bass swell and brightening |
| `orbit` | number | Orbit speed | 0.12 | −0.6 to 0.6 rad/s | Camera yaw speed. Negative reverses |
| `bright` | number | Brightness | 1 | 0.2–2 | Overall gain |
| `density` | select | Rings | medium | sparse (120), medium (240), dense (400) | Rings alive at once. Reallocates the history |
| `palette` | select | Palette | nebula | nebula, ember, phosphor | Color ramp by age |
| `lines` | select | Lines | soft | soft, fine | See Line softness |

The manifest entry is `id: "cosmic-peanut"`, `name: "Cosmic Peanut"`, `renderer: "webgl2"`,
`entry: "src/cosmic-peanut.js"`, with no `libs`. Include a thumbnail captured from the plugin at
defaults.

## Camera and motion

The camera orbits the origin on its own: a steady yaw at the Orbit speed, plus a slow pitch sway,
so the poles drift in and out of view. Dragging overrides it, and letting go resumes the orbit from
wherever the user left it.

- **Yaw:** increases by `orbit × dt`.
- **Pitch:** `basePitch + 0.3 × sin(0.09 × t)`, clamped to ±1.3 rad. Here t advances only while
  orbiting, scaled by `|orbit| ÷ 0.12`, so stopping the orbit also stops the sway. The default
  `basePitch` is 0.42 rad, slightly above the equator.
- **Framing:** 38° vertical field of view. The camera distance fits the sphere at maximum swell with
  a 1.32 margin, `(R + amp) × 1.32 ÷ tan(fov ÷ 2)`, divided by the aspect ratio when the window is
  taller than it is wide, so nothing clips in portrait or when the bass hits.
- **Dragging:** horizontal drag changes yaw and vertical drag changes pitch, at 0.006 rad per pixel.
  On release, `basePitch` is recalculated so the sway continues without a jump. (Host support:
  the plugin API's `pointer(e)` hook.)
- **Reduced motion:** when the host reports reduced motion (`ctx.reduceMotion`, from macOS's Reduce
  motion setting), Orbit speed defaults to 0 and Bass pulse to 0.1. Users can still raise either.
- **Pause:** when the host pauses, rings stop pushing and drifting, and the pulse holds its value.
  The camera stops too, but the user can still drag. (The host has no pause yet; hidden windows
  stop the render loop.)

## Performance

Cosmic Peanut is cheap by design. At Dense it draws about 205,000 line vertices in a single call.
It must stay well inside the Tidalviz budgets, so it can run next to crossfades and on battery.

| Metric | Budget, Dense, 2560×1440, M1 Air |
| --- | --- |
| Frame rate | 60 fps, fewer than 1% dropped frames over 10 min |
| Plugin CPU per frame | Under 0.5 ms, including ring building |
| GPU time per frame | Under 4 ms |
| Allocations per frame | Zero after warm-up |
| Memory | Under 10 MB of GPU buffers and textures |

Implementation rules:

- Build the vertex and index buffers once per density change, never per frame.
- Reuse typed arrays for the ring, the projection matrix and the view matrix. The prototype
  allocates new matrices each frame; fix this.
- Upload at most the rows pushed since the last frame, one row each. At 7 s travel time and Dense
  density that's about 57 rows per second.
- Trigger search, resampling and gain run only when a ring is pushed, not every display frame.
- Skip the offscreen pass entirely in Fine lines mode.
- Handle `webglcontextlost` through the SDK. Rebuilding from scratch is fine; the ring history may
  start over.

## Acceptance tests

Each test runs with the host's synthetic or file source, so results are repeatable.

- **Silence:** at startup with silence, nothing is visible. After 10 s of silence following music,
  only faded circles from the earlier signal remain, then nothing.
- **Sine wave:** a 440 Hz sine produces rings that are the same from one ring to the next (the
  trigger works), with no seam where each ring closes.
- **Jaggedness:** white noise at Detail 1 produces visibly spiky rings. Regression check: the
  displayed ring must contain every interpolated sample, with no averaging.
- **Travel time:** a single click at t = 0 produces a ring that reaches the south-pole fade within
  ±2% of the Travel time setting, at both 60 Hz and 120 Hz.
- **Pulse:** with a 120 BPM kick track at defaults, peak radius swell is 1–4% and the swell returns
  to within 0.5% of rest before the next kick. At Pulse 0, the radius never changes.
- **Orbit:** at defaults, the camera completes a full turn in about 52 s, and pitch stays within
  ±1.3 rad. After a drag and release, the next frame shows no jump.
- **Density change:** switching to Dense mid-song clears the history without a flash of flat
  circles.
- **Performance:** benchmark mode meets every budget above.

## Reference prototype

The prototype's `createCosmicPeanut(ctx)` function is already in the plugin shape; the rest of the
file is a stand-in host (demo signal, microphone, file input, controls) that Tidalviz replaces.

The production plugin differs from the prototype in these ways:

- Pulse values follow this PRD (6% swell, 0.12 brightness, 18/s attack, 4/s release, default 0.35).
- Soft lines use an offscreen framebuffer, not a lower canvas DPR.
- No per-frame allocations.
- Parameters come from the manifest, and reduced motion comes from the host.
