// @ts-check
/**
 * Tentacube tentacles: verlet chains on the CPU at a fixed timestep, the traveling ripple, and
 * rotation-minimizing frames for the tube shader. Everything works in preallocated Float32Arrays.
 */

/**
 * Fixed-timestep scheduler: accumulates frame time and hands out whole steps of `h`, so the
 * simulation is the same at any display rate. A long frame runs at most `maxSteps` and drops the
 * rest (no spiral of death).
 * @param {number} h step (s) @param {number} maxSteps cap per frame
 */
export function createStepper(h, maxSteps) {
  let acc = 0;
  return {
    /** @param {number} dt @returns {number} steps to run now */
    advance(dt) {
      acc += dt;
      let n = Math.floor(acc / h + 1e-6);
      if (n > maxSteps) {
        n = maxSteps;
        acc = 0;
      } else {
        acc -= n * h;
      }
      return n;
    },
  };
}

const RIPPLE_OMEGA = 2 * Math.PI * 1.5;
/** Wavelengths along a tentacle. */
const RIPPLE_WAVES = 1.25;

/**
 * The traveling ripple at node j (−1..1 times an envelope that is 0 at the root).
 * @param {number} j @param {number} nodes @param {number} t seconds
 */
export function rippleWave(j, nodes, t) {
  const u = j / (nodes - 1);
  return Math.pow(u, 0.8) * Math.sin(RIPPLE_OMEGA * t - RIPPLE_WAVES * 2 * Math.PI * u);
}

/**
 * Verlet chains, one per tentacle. Node 0 is pinned to its anchor (a point on the moving cube);
 * the rest integrate with damping and a pull toward the chain's rest pose (straight out along the
 * anchor normal, strongest near the root, so tentacles extend rather than collapse), then distance
 * constraints restore the segment lengths (a few relaxation passes, then a root→tip pass that makes
 * them exact). The root moves with the cube and everything else integrates, so the tentacles lag,
 * overshoot and whip.
 *
 * Tunables are plain fields: `segLen`, `stiffness` (s⁻², pull at the root), `damping` (s⁻¹),
 * `iterations`, `ftlDamp` (how much of the final pass's correction is taken out of the velocity),
 * `rippleAmp` / `rippleTime` (the traveling wave the pull target carries, see rippleWave).
 *
 * @param {number} count chains @param {number} nodes per chain (node 0 is the root)
 */
export function createChains(count, nodes) {
  const n3 = nodes * 3;
  const pos = new Float32Array(count * n3);
  const old = new Float32Array(count * n3);
  const root = new Float32Array(count * 3);
  const dir = new Float32Array(count * 3);
  const side = new Float32Array(count * 3);
  /** Pull profile along the chain (fraction of `stiffness`). */
  const pull = new Float32Array(nodes);
  for (let j = 0; j < nodes; j++) {
    const u = j / (nodes - 1);
    pull[j] = 0.12 + 0.88 * (1 - u) * (1 - u);
  }
  return {
    count,
    nodes,
    pos,
    old,
    root,
    dir,
    side,
    segLen: 0.1,
    stiffness: 60,
    damping: 2,
    iterations: 4,
    ftlDamp: 0.9,
    rippleAmp: 0,
    rippleTime: 0,
    /**
     * @param {number} i @param {number} px @param {number} py @param {number} pz root
     * @param {number} nx @param {number} ny @param {number} nz outward unit normal
     * @param {number} ux @param {number} uy @param {number} uz a unit vector ⟂ normal (ripple plane)
     */
    anchor(i, px, py, pz, nx, ny, nz, ux, uy, uz) {
      const o = i * 3;
      root[o] = px;
      root[o + 1] = py;
      root[o + 2] = pz;
      dir[o] = nx;
      dir[o + 1] = ny;
      dir[o + 2] = nz;
      side[o] = ux;
      side[o + 1] = uy;
      side[o + 2] = uz;
    },
    /** Lay every chain straight out along its normal, at rest. */
    reset() {
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < nodes; j++) {
          const o = i * n3 + j * 3;
          for (let k = 0; k < 3; k++) pos[o + k] = old[o + k] = root[i * 3 + k] + dir[i * 3 + k] * this.segLen * j;
        }
      }
    },
    /** One fixed step. @param {number} h */
    step(h) {
      const L = this.segLen;
      const keep = Math.exp(-this.damping * h);
      const kh2 = this.stiffness * h * h;
      for (let i = 0; i < count; i++) {
        const base = i * n3;
        const rx = root[i * 3], ry = root[i * 3 + 1], rz = root[i * 3 + 2];
        const nx = dir[i * 3], ny = dir[i * 3 + 1], nz = dir[i * 3 + 2];
        const ux = side[i * 3], uy = side[i * 3 + 1], uz = side[i * 3 + 2];
        // w = n × u: the second ripple axis (a quarter phase behind: a lazy corkscrew).
        const wx = ny * uz - nz * uy, wy = nz * ux - nx * uz, wz = nx * uy - ny * ux;
        const amp = this.rippleAmp;
        const t = this.rippleTime + i * 0.37; // each tentacle a little out of step
        pos[base] = old[base] = rx;
        pos[base + 1] = old[base + 1] = ry;
        pos[base + 2] = old[base + 2] = rz;
        // Integrate.
        for (let j = 1; j < nodes; j++) {
          const o = base + j * 3;
          const d = L * j;
          const g = kh2 * pull[j];
          const a = amp === 0 ? 0 : amp * rippleWave(j, nodes, t);
          const b = amp === 0 ? 0 : 0.5 * amp * rippleWave(j, nodes, t - 0.25 / 1.5);
          for (let k = 0; k < 3; k++) {
            const p = pos[o + k];
            const target =
              k === 0 ? rx + nx * d + ux * a + wx * b
              : k === 1 ? ry + ny * d + uy * a + wy * b
              : rz + nz * d + uz * a + wz * b;
            pos[o + k] = p + (p - old[o + k]) * keep + (target - p) * g;
            old[o + k] = p;
          }
        }
        // Relax the distance constraints (the root is pinned).
        for (let it = 0; it < this.iterations - 1; it++) {
          for (let j = 1; j < nodes; j++) {
            const a = base + (j - 1) * 3;
            const b = a + 3;
            const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
            const diff = (len - L) / len;
            if (j === 1) {
              pos[b] -= dx * diff;
              pos[b + 1] -= dy * diff;
              pos[b + 2] -= dz * diff;
            } else {
              const hd = diff * 0.5;
              pos[a] += dx * hd;
              pos[a + 1] += dy * hd;
              pos[a + 2] += dz * hd;
              pos[b] -= dx * hd;
              pos[b + 1] -= dy * hd;
              pos[b + 2] -= dz * hd;
            }
          }
        }
        // Final root→tip pass: exact lengths.
        for (let j = 1; j < nodes; j++) {
          const a = base + (j - 1) * 3;
          const b = a + 3;
          const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
          const f = L / len - 1;
          // Move the node onto the constraint, and its previous position with it (mostly), so the
          // correction doesn't pump energy into the chain the way a bare follow-the-leader does.
          pos[b] += dx * f;
          pos[b + 1] += dy * f;
          pos[b + 2] += dz * f;
          old[b] += dx * f * this.ftlDamp;
          old[b + 1] += dy * f * this.ftlDamp;
          old[b + 2] += dz * f * this.ftlDamp;
        }
      }
    },
  };
}

/**
 * Rotation-minimizing frames along every chain (the double-reflection method, Wang et al. 2008),
 * starting from the chain's side vector at the root so the frame turns with the cube. Unit
 * tangents are central differences (one-sided at the ends).
 * @param {{ count: number, nodes: number, pos: Float32Array, side: Float32Array }} chains
 * @param {Float32Array} frames count × nodes × 6: normal xyz, binormal xyz
 * @param {Float32Array} tangents count × nodes × 3
 */
export function computeFrames(chains, frames, tangents) {
  const { count, nodes, pos, side } = chains;
  for (let i = 0; i < count; i++) {
    const b3 = i * nodes * 3;
    for (let j = 0; j < nodes; j++) {
      const a = b3 + Math.max(0, j - 1) * 3;
      const c = b3 + Math.min(nodes - 1, j + 1) * 3;
      const tx = pos[c] - pos[a], ty = pos[c + 1] - pos[a + 1], tz = pos[c + 2] - pos[a + 2];
      const l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      const o = b3 + j * 3;
      tangents[o] = tx / l;
      tangents[o + 1] = ty / l;
      tangents[o + 2] = tz / l;
    }
    // Root normal: the side vector made ⟂ the first tangent.
    let rx = side[i * 3], ry = side[i * 3 + 1], rz = side[i * 3 + 2];
    let tx = tangents[b3], ty = tangents[b3 + 1], tz = tangents[b3 + 2];
    let d = rx * tx + ry * ty + rz * tz;
    rx -= d * tx;
    ry -= d * ty;
    rz -= d * tz;
    let l = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (l < 1e-6) {
      // Side ∥ tangent: any perpendicular will do.
      rx = Math.abs(tx) < 0.9 ? 0 : -tz;
      ry = Math.abs(tx) < 0.9 ? -tz : 0;
      rz = Math.abs(tx) < 0.9 ? ty : tx;
      l = Math.sqrt(rx * rx + ry * ry + rz * rz);
    }
    rx /= l;
    ry /= l;
    rz /= l;
    for (let j = 0; j < nodes; j++) {
      const o = b3 + j * 3;
      if (j > 0) {
        // Reflect (r, t) in the bisector plane of the chord, then in the plane between the
        // reflected tangent and the new tangent.
        const p = o - 3;
        const v1x = pos[o] - pos[p], v1y = pos[o + 1] - pos[p + 1], v1z = pos[o + 2] - pos[p + 2];
        const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
        if (c1 > 1e-12) {
          d = (2 / c1) * (v1x * rx + v1y * ry + v1z * rz);
          rx -= d * v1x;
          ry -= d * v1y;
          rz -= d * v1z;
          d = (2 / c1) * (v1x * tx + v1y * ty + v1z * tz);
          tx -= d * v1x;
          ty -= d * v1y;
          tz -= d * v1z;
        }
        const v2x = tangents[o] - tx, v2y = tangents[o + 1] - ty, v2z = tangents[o + 2] - tz;
        const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
        if (c2 > 1e-12) {
          d = (2 / c2) * (v2x * rx + v2y * ry + v2z * rz);
          rx -= d * v2x;
          ry -= d * v2y;
          rz -= d * v2z;
        }
        tx = tangents[o];
        ty = tangents[o + 1];
        tz = tangents[o + 2];
        // Re-orthonormalise against float drift.
        d = rx * tx + ry * ty + rz * tz;
        rx -= d * tx;
        ry -= d * ty;
        rz -= d * tz;
        l = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
        rx /= l;
        ry /= l;
        rz /= l;
      }
      const f = (i * nodes + j) * 6;
      frames[f] = rx;
      frames[f + 1] = ry;
      frames[f + 2] = rz;
      frames[f + 3] = ty * rz - tz * ry;
      frames[f + 4] = tz * rx - tx * rz;
      frames[f + 5] = tx * ry - ty * rx;
    }
  }
}
