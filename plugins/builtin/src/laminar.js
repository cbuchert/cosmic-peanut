// @ts-check
/**
 * Laminar — liquid lines stream past a chrome sphere, after Tame Impala's *Currents* cover: a
 * real 2D incompressible fluid simulation on the GPU, for the `webgl2` renderer.
 *
 * The sim (stable fluids) runs at a fraction of the canvas (Detail) in the flow's own frame:
 * uniform inflow along +x from the left edge, open outflow at the right, and the sphere as a
 * moving circular obstacle. The composite rotates that frame onto the screen so the stream runs
 * diagonally, top-left → bottom-right (FLOW_ANGLE). Per fixed 60 Hz step (dt accumulator, at most
 * three steps a frame, so 60 and 120 Hz behave the same):
 *   curl       vorticity, for confinement
 *   advect ×2  MacCormack: forward and backward semi-Lagrangian passes over velocity and scalars
 *   correct    MacCormack correction + min/max limiter (the line coordinate takes half of it:
 *              the full correction saw-tooths strongly sheared lines), inflow change, vorticity
 *              confinement (in the wake only), beat kicks, trail dye injection and ageing, inflow
 *              edge, sphere (fluid inside moves with it)
 *   viscous    implicit viscosity (a few Jacobi iterations) when the Reynolds number is low
 *   divergence, JACOBI × pressure, project   (the sphere and inflow are closed, outflow open)
 * The scalars are ψ = φ − y, the displacement of the "line coordinate" φ (re-injected fresh and
 * straight at the inflow), and the trail dye and its age. The lines are the anti-aliased contours
 * of φ, drawn at full resolution from the cubic-filtered field (composite.frag).
 *
 * Music: loudness sets the Reynolds number, inflow speed and vorticity confinement (quiet = calm,
 * gently rippling wake; loud = churning), beats kick a vortex pair into the wake and nudge the
 * sphere through the stream on a spring, the bass swells it (and the fluid it displaces), and a
 * small flash-limited brightness lift marks each beat. Pure logic in lib/laminar.js + lib/flow.js.
 *
 * Sim targets are RGBA16F (velocity, scalars) and R16F (pressure), which need
 * EXT_color_buffer_float or EXT_color_buffer_half_float. Without either (an RGBA8-only GPU) there
 * is no sim: the composite draws the lines as the streamlines of ideal (potential) flow around the
 * sphere — they part around it and close behind it, with no wake or trail.
 */
import { createProgram } from "./lib/gl.js";
import { createSimClock, simGrid } from "./lib/flow.js";
import {
  createDrift,
  createGlow,
  createKicks,
  createLoudness,
  createPulse,
  flowDrive,
  gapOpacity,
  motion,
  palette,
  TRAIL_OLD,
} from "./lib/laminar.js";

const FLOW_ANGLE = -0.62; // stream direction on screen, rad (≈ 35° below horizontal, to the right)
const BALL_R = 0.085; // sphere radius at Size 1, screen heights
const BALL_DRAW = 1.07; // drawn radius / obstacle radius: covers the thin no-slip layer at the surface
const HOME_ALONG = -0.15; // sphere home relative to the screen centre, along the stream (heights)
const HOME_ACROSS = 0.02;
const JACOBI = 24; // pressure iterations per step (even: the warm start stays in pres[0])
const VISC_ITERS = 4;
const KICK_SPEED = 0.35; // cross-stream speed a full kick adds behind the sphere, heights/s
const VORT = 6; // confinement scale at vort = 1
const DYE_LIFE = 30; // s

/** @type {import('../tidalviz').CreateVisualizer} */
export default async function create(ctx) {
  const gl = /** @type {WebGL2RenderingContext} */ (ctx.gl);
  const dir = "shaders/laminar/";
  const names = ["fullscreen.vert", "common.glsl", "advect.frag", "correct.frag", "curl.frag", "viscous.frag"];
  names.push("divergence.frag", "pressure.frag", "project.frag", "resample.frag", "composite.frag");
  const [vs, common, advFs, corFs, curlFs, viscFs, divFs, presFs, projFs, resFs, compFs] = await Promise.all(
    names.map((f) => ctx.assets.text(dir + f)),
  );
  const inc = (/** @type {string} */ src) => src.replace("// #include common", common);
  const prog = (/** @type {string} */ fs, /** @type {string} */ name) => createProgram(gl, vs, inc(fs), dir + name);
  const advP = prog(advFs, "advect.frag");
  const corP = prog(corFs, "correct.frag");
  const curlP = prog(curlFs, "curl.frag");
  const viscP = prog(viscFs, "viscous.frag");
  const divP = prog(divFs, "divergence.frag");
  const presP = prog(presFs, "pressure.frag");
  const projP = prog(projFs, "project.frag");
  const resP = prog(resFs, "resample.frag");
  const compP = prog(compFs, "composite.frag");
  const programs = [advP, corP, curlP, viscP, divP, presP, projP, resP, compP];

  const half =
    Boolean(gl.getExtension("EXT_color_buffer_float")) || Boolean(gl.getExtension("EXT_color_buffer_half_float"));
  const vao = gl.createVertexArray();
  const DRAW2 = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];

  /** @typedef {{ tex: WebGLTexture, fbo: WebGLFramebuffer, one: boolean }} Target */
  /** @param {boolean} one R16F (else RGBA16F) @returns {Target} */
  function target(one) {
    const tex = /** @type {WebGLTexture} */ (gl.createTexture());
    const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const f = one ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, fbo, one };
  }
  const vel = [target(false), target(false)];
  const scal = [target(false), target(false)];
  const vf = target(false);
  const sf = target(false);
  const vb = target(false);
  const sb = target(false);
  const curl = target(true);
  const div = target(true);
  const pres = [target(true), target(true)];
  const singles = [...vel, ...scal, vf, sf, vb, sb, curl, div, ...pres];
  // Two-target framebuffers (velocity + scalars written together).
  const mrt = () => /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
  const fwdFbo = mrt();
  const bwdFbo = mrt();
  const newFbo = [mrt(), mrt()]; // [k] writes vel[1] (scratch) + scal[k]

  let sw = 0;
  let sh = 0;
  let lx = 1;
  let ly = 1;
  const vcur = 0; // the velocity state lives in vel[0]; vel[1] is scratch within a step
  let scur = 0; // scalar ping-pong
  let U = 0; // inflow speed the sim state currently has

  /** Allocate a target's storage and clear it. @param {Target} t @param {number} r */
  function alloc(t, r) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (t.one) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, sw, sh, 0, gl.RED, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, sw, sh, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.clearColor(r, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  /** @param {WebGLFramebuffer} fbo @param {Target} a @param {Target} b */
  function attach2(fbo, a, b) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a.tex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b.tex, 0);
    gl.drawBuffers(DRAW2);
  }

  // Resize: carry the flow over into the new grid (same place in screen heights).
  const keepV = target(false);
  const keepS = target(false);
  function resize() {
    if (!half) return;
    const g = simGrid(ctx.size.width, ctx.size.height, Number(ctx.params.detail), FLOW_ANGLE);
    if (g.width === sw && g.height === sh && Math.abs(g.width / g.cells - lx) < 1e-9) return;
    const oldW = sw;
    const oldLx = lx;
    const oldLy = ly;
    if (oldW > 0) {
      // Keep the current state alive by swapping it into keepV/keepS.
      swapTex(vel[vcur], keepV);
      swapTex(scal[scur], keepS);
    }
    sw = g.width;
    sh = g.height;
    lx = sw / g.cells;
    ly = sh / g.cells;
    for (const t of singles) alloc(t, 0);
    if (!U) U = 0.16;
    for (const t of vel) alloc(t, U);
    if (oldW > 0) {
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, sw, sh);
      gl.useProgram(resP.program);
      gl.uniform2f(resP.u.u_Lnew, lx, ly);
      gl.uniform2f(resP.u.u_Lold, oldLx, oldLy);
      gl.uniform1i(resP.u.u_old, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(resP.u.u_psi, 0);
      gl.bindTexture(gl.TEXTURE_2D, keepV.tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, vel[vcur].fbo);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.uniform1f(resP.u.u_psi, 1);
      gl.bindTexture(gl.TEXTURE_2D, keepS.tex);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scal[scur].fbo);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    attach2(fwdFbo, vf, sf);
    attach2(bwdFbo, vb, sb);
    attach2(newFbo[0], vel[1], scal[0]);
    attach2(newFbo[1], vel[1], scal[1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  /** Swap two targets' textures (and re-point their framebuffers). @param {Target} a @param {Target} b */
  function swapTex(a, b) {
    const t = a.tex;
    a.tex = b.tex;
    b.tex = t;
    for (const x of [a, b]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, x.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, x.tex, 0);
    }
  }

  const clock = createSimClock();
  const loud = createLoudness();
  const pulse = createPulse();
  const drift = createDrift();
  const kicks = createKicks();
  const glow = createGlow();
  const mo = { speed: 1, turbulence: 1, reactivity: 1 };
  const drive = { inflow: 0, re: 0, nu: 0, vort: 0 };
  let pal = palette(String(ctx.params.palette));

  resize();

  /** @param {number} unit @param {WebGLTexture} tex */
  function bind(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }
  /**
   * Use a sim program and set its common.glsl uniforms: grid, sphere (centre, radius, velocity,
   * growth rate), inflow speed.
   * @param {{ program: WebGLProgram, u: Record<string, WebGLUniformLocation | null> }} p
   * @param {number} bx @param {number} by @param {number} br
   * @param {number} bvx @param {number} bvy @param {number} bdr
   */
  function setCommon(p, bx, by, br, bvx, bvy, bdr) {
    gl.useProgram(p.program);
    gl.uniform2f(p.u.u_L, lx, ly);
    gl.uniform2f(p.u.u_texel, 1 / sw, 1 / sh);
    gl.uniform3f(p.u.u_ball, bx, by, br);
    gl.uniform3f(p.u.u_ballVel, bvx, bvy, bdr);
    gl.uniform1f(p.u.u_U, U);
  }

  return {
    frame(audio, time) {
      const p = ctx.params;
      const dt = time.dt;
      motion(p, ctx.reduceMotion, mo);
      const react = mo.reactivity;
      const size = Number(p.size);
      const trail = p.trail !== false;

      // 1. Music → motion (CPU, allocation-free).
      loud.step(audio, dt);
      pulse.step(audio.bassAtt, dt, react);
      // Beats push the sphere further when the music is loud.
      drift.step(audio.onset, audio.onsetStrength, dt, react * (0.35 + 0.65 * loud.value));
      kicks.trigger(audio.onset, audio.onsetStrength, react);
      glow.step(audio.onset, audio.onsetStrength, dt, ctx.reduceFlashing, react);
      const R = BALL_R * (size > 0 ? size : 1) * pulse.scale;
      const dR = BALL_R * (size > 0 ? size : 1) * pulse.rate;
      flowDrive(loud.value, react, mo.speed, mo.turbulence, 2 * R, drive);
      // Sphere in the sim frame (x downstream, y across).
      const bx = 0.5 * lx + HOME_ALONG + drift.x;
      const by = 0.5 * ly + HOME_ACROSS + drift.y;

      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // 2. The sim.
      const n = half ? clock.step(dt) : 0;
      const sdt = clock.dt;
      if (n > 0) gl.viewport(0, 0, sw, sh);
      for (let k = 0; k < n; k++) {
        const V0 = vel[vcur];
        const S0 = scal[scur];
        const dU = drive.inflow - U;
        U = drive.inflow;
        // Beats kick harder the louder the music.
        const kick = kicks.step(sdt) * KICK_SPEED * (0.25 + 0.75 * loud.value);
        const vort = drive.vort * VORT;

        if (vort > 0) {
          setCommon(curlP, bx, by, R, drift.vx, drift.vy, dR);
          gl.bindFramebuffer(gl.FRAMEBUFFER, curl.fbo);
          bind(0, V0.tex);
          gl.uniform1i(curlP.u.u_vel, 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        // MacCormack: forward, then backward from the forward result.
        setCommon(advP, bx, by, R, drift.vx, drift.vy, dR);
        gl.uniform1i(advP.u.u_vel, 0);
        gl.uniform1i(advP.u.u_fv, 1);
        gl.uniform1i(advP.u.u_fs, 2);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fwdFbo);
        bind(0, V0.tex);
        bind(1, V0.tex);
        bind(2, S0.tex);
        gl.uniform1f(advP.u.u_dt, sdt);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bwdFbo);
        bind(1, vf.tex);
        bind(2, sf.tex);
        gl.uniform1f(advP.u.u_dt, -sdt);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Correct + sources + boundaries → vel[1], scal[1 − scur].
        const c = corP.u;
        setCommon(corP, bx, by, R, drift.vx, drift.vy, dR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, newFbo[scur ^ 1]);
        bind(0, V0.tex);
        bind(1, S0.tex);
        bind(2, vf.tex);
        bind(3, sf.tex);
        bind(4, vb.tex);
        bind(5, sb.tex);
        bind(6, curl.tex);
        gl.uniform1i(c.u_v0, 0);
        gl.uniform1i(c.u_s0, 1);
        gl.uniform1i(c.u_vf, 2);
        gl.uniform1i(c.u_sf, 3);
        gl.uniform1i(c.u_vb, 4);
        gl.uniform1i(c.u_sb, 5);
        gl.uniform1i(c.u_curl, 6);
        gl.uniform1f(c.u_dt, sdt);
        gl.uniform1f(c.u_dU, dU);
        gl.uniform1f(c.u_vort, vort);
        gl.uniform1f(c.u_kick, kick);
        gl.uniform1f(c.u_trail, trail ? 1 : 0);
        gl.uniform1f(c.u_dyeLife, DYE_LIFE);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        scur ^= 1;
        let V = vel[1];

        // Viscosity (implicit, a few Jacobi iterations), only when it matters.
        const alpha = drive.nu * sdt * (sw / lx) * (sw / lx);
        if (alpha > 0.02) {
          setCommon(viscP, bx, by, R, drift.vx, drift.vy, dR);
          gl.uniform1f(viscP.u.u_alpha, alpha);
          gl.uniform1i(viscP.u.u_x, 0);
          gl.uniform1i(viscP.u.u_b, 1);
          bind(1, V.tex);
          let src = V;
          for (let j = 0; j < VISC_ITERS; j++) {
            const dst = j & 1 ? vf : vb;
            gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
            bind(0, src.tex);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            src = dst;
          }
          V = src;
        }

        // Projection.
        setCommon(divP, bx, by, R, drift.vx, drift.vy, dR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, div.fbo);
        bind(0, V.tex);
        gl.uniform1i(divP.u.u_vel, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        setCommon(presP, bx, by, R, drift.vx, drift.vy, dR);
        gl.uniform1i(presP.u.u_p, 0);
        gl.uniform1i(presP.u.u_div, 1);
        bind(1, div.tex);
        for (let j = 0; j < JACOBI; j++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, pres[(j + 1) & 1].fbo);
          bind(0, pres[j & 1].tex);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        setCommon(projP, bx, by, R, drift.vx, drift.vy, dR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, V0.fbo);
        bind(0, V.tex);
        bind(1, pres[JACOBI & 1].tex);
        gl.uniform1i(projP.u.u_vel, 0);
        gl.uniform1i(projP.u.u_p, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // The projected velocity is back in vel[0]; the scalars moved to scal[scur].
      }

      // 3. Composite onto the transparent canvas.
      const { width: cw, height: ch } = ctx.size;
      const aspect = cw / ch;
      const ca = Math.cos(FLOW_ANGLE);
      const sa = Math.sin(FLOW_ANGLE);
      // Sphere on screen: sim frame → screen (centred on the screen centre).
      const ox = bx - 0.5 * lx;
      const oy = by - 0.5 * ly;
      const sx = 0.5 * aspect + ox * ca - oy * sa;
      const sy = 0.5 + ox * sa + oy * ca;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(compP.program);
      bind(0, scal[scur].tex);
      const u = compP.u;
      gl.uniform1i(u.u_scal, 0);
      gl.uniform2f(u.u_simSize, sw || 1, sh || 1);
      gl.uniform2f(u.u_L, lx, ly);
      gl.uniform1f(u.u_aspect, aspect);
      gl.uniform2f(u.u_dir, ca, sa);
      gl.uniform3f(u.u_ball, sx, sy, R * BALL_DRAW);
      gl.uniform3f(u.u_ballSim, bx, by, R);
      gl.uniform1f(u.u_k, Number(p.density));
      gl.uniform1f(u.u_px, 1 / ch);
      gl.uniform3fv(u.u_line, pal.line);
      gl.uniform3fv(u.u_hi, pal.hi);
      gl.uniform3fv(u.u_shadow, pal.shadow);
      gl.uniform3fv(u.u_gap, pal.gap);
      gl.uniform3fv(u.u_hot, pal.hot);
      gl.uniform3fv(u.u_warm, pal.warm);
      gl.uniform3fv(u.u_old, pal.old);
      gl.uniform1f(u.u_gapA, gapOpacity(String(p.backdrop)));
      gl.uniform1f(u.u_trail, trail && half ? 1 : 0);
      gl.uniform1f(u.u_trailOld, TRAIL_OLD);
      gl.uniform1f(u.u_glow, glow.value);
      gl.uniform1f(u.u_analytic, half ? 0 : 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    resize,

    params(changed) {
      if ("palette" in changed) pal = palette(String(ctx.params.palette));
      if ("detail" in changed) resize();
    },

    dispose() {
      for (const t of [...singles, keepV, keepS]) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
      for (const f of [fwdFbo, bwdFbo, ...newFbo]) gl.deleteFramebuffer(f);
      gl.deleteVertexArray(vao);
      for (const pr of programs) gl.deleteProgram(pr.program);
    },
  };
}
