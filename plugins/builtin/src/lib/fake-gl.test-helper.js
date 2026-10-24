// @ts-check
/**
 * Test-only helper (not imported by any visualizer): a WebGL2 stand-in that records state —
 * programs (with their fragment source), sampler uniforms' units, the texture bound on every unit,
 * the framebuffer's attachments, and a snapshot per draw — and the GLSL preprocessing it uses to
 * tell which uniforms a program really has.
 */
export const SAMPLER_2D = 0x8b5e;

/**
 * A WebGL2 stand-in that records state: programs (with their fragment source), sampler uniforms'
 * units, the texture bound on every unit, the framebuffer's attachments, and a snapshot per draw.
 */
export function fakeGL() {
  let ids = 0;
  const obj = (/** @type {string} */ kind, extra = {}) => ({ kind, id: ++ids, ...extra });
  /** @type {Map<number, any>} unit → texture */
  const units = new Map();
  let active = 0;
  /** @type {any} */
  let program = null;
  /** @type {any} */
  let fbo = null;
  /** @type {any[]} */
  const draws = [];
  const C = {
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    COLOR_ATTACHMENT1: 0x8ce1,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
  };
  /** @type {Record<string, any>} */
  const impl = {
    getExtension: () => ({}),
    isContextLost: () => false,
    createTexture: () => obj("texture"),
    createFramebuffer: () => obj("fbo", { attach: new Map() }),
    createVertexArray: () => obj("vao"),
    createShader: (/** @type {number} */ type) => obj("shader", { type, src: "" }),
    shaderSource: (/** @type {any} */ s, /** @type {string} */ src) => (s.src = src),
    getShaderParameter: () => true,
    createProgram: () => obj("program", { shaders: [], uniforms: [], values: new Map() }),
    attachShader: (/** @type {any} */ p, /** @type {any} */ s) => p.shaders.push(s),
    linkProgram(/** @type {any} */ p) {
      const fs = p.shaders.find((/** @type {any} */ s) => s.type === C.FRAGMENT_SHADER);
      p.fs = fs.src;
      // Active uniforms, as a compiler sees them: declared in the preprocessed source and used.
      const src = preprocess(fs.src);
      for (const m of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(\[[^\]]+\])?\s*;/gm)) {
        if ((src.match(new RegExp(`\\b${m[1]}\\b`, "g")) ?? []).length < 2) continue;
        const type = /^\s*uniform\s+sampler2D/.test(m[0]) ? SAMPLER_2D : 0;
        p.uniforms.push({ name: m[1] + (m[2] ? "[0]" : ""), type });
      }
    },
    getProgramParameter: (/** @type {any} */ p, /** @type {number} */ k) => (k === C.ACTIVE_UNIFORMS ? p.uniforms.length : true),
    getActiveUniform: (/** @type {any} */ p, /** @type {number} */ i) => p.uniforms[i],
    getUniformLocation: (/** @type {any} */ p, /** @type {string} */ name) => ({ p, name: name.replace(/\[0\]$/, "") }),
    useProgram: (/** @type {any} */ p) => (program = p),
    activeTexture: (/** @type {number} */ t) => (active = t - C.TEXTURE0),
    bindTexture: (/** @type {number} */ _, /** @type {any} */ t) => units.set(active, t),
    bindFramebuffer: (/** @type {number} */ _, /** @type {any} */ f) => (fbo = f),
    framebufferTexture2D: (/** @type {number} */ _, /** @type {number} */ at, /** @type {number} */ __, /** @type {any} */ t) => fbo.attach.set(at, t),
    drawArrays() {
      /** @type {Record<string, any>} */
      const samplers = {};
      for (const u of program.uniforms) {
        if (u.type !== SAMPLER_2D) continue;
        const unit = program.values.get(u.name) ?? 0;
        samplers[u.name] = { unit, tex: units.get(unit) ?? null };
      }
      draws.push({ program, fbo, targets: fbo ? [...fbo.attach.values()] : [], samplers, values: new Map(program.values) });
    },
  };
  for (const f of ["uniform1i", "uniform1f", "uniform2f", "uniform3f", "uniform4f", "uniform2i", "uniform4i", "uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv", "uniform4iv", "uniformMatrix2fv"]) {
    impl[f] = (/** @type {any} */ loc, /** @type {any[]} */ ...v) => {
      if (loc) loc.p.values.set(loc.name, f.startsWith("uniformMatrix") ? v[1] : v.length === 1 ? (ArrayBuffer.isView(v[0]) ? Array.from(/** @type {ArrayLike<number>} */ (/** @type {unknown} */ (v[0]))) : v[0]) : v);
    };
  }
  const gl = new Proxy(impl, {
    get(t, k) {
      if (typeof k !== "string") return undefined;
      if (k in C) return /** @type {any} */ (C)[k];
      if (k in t) return t[k];
      if (/^[A-Z0-9_]+$/.test(k)) return 0x1000 + k.length; // any other enum
      return () => {};
    },
  });
  return { gl, draws };
}

/** The lines a GLSL preprocessor keeps (#define, #ifdef/#ifndef, #if/#elif defined(…), #else). @param {string} src */
export function preprocess(src) {
  const defs = new Set();
  /** @type {{ on: boolean, taken: boolean }[]} */
  const stack = [];
  const on = () => stack.every((f) => f.on);
  // `defined(X)` terms joined by !, &&, || and parentheses (anything else counts as false).
  const test = (/** @type {string} */ c) => {
    const e = c.replace(/defined\s*\(?\s*(\w+)\s*\)?/g, (_, n) => (defs.has(n) ? "1" : "0"));
    return /^[01()!&|\s]+$/.test(e) ? Boolean(Function(`return ${e};`)()) : false;
  };
  /** @type {string[]} */
  const out = [];
  for (const line of src.split("\n")) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^#ifdef\s+(\w+)/))) stack.push({ on: defs.has(m[1]), taken: defs.has(m[1]) });
    else if ((m = t.match(/^#ifndef\s+(\w+)/))) stack.push({ on: !defs.has(m[1]), taken: !defs.has(m[1]) });
    else if ((m = t.match(/^#if\s+(.*)$/))) stack.push({ on: test(m[1].trim()), taken: test(m[1].trim()) });
    else if ((m = t.match(/^#elif\s+(.*)$/))) {
      const f = stack[stack.length - 1];
      f.on = !f.taken && test(m[1].trim());
      f.taken ||= f.on;
    } else if (t.startsWith("#else")) {
      const f = stack[stack.length - 1];
      f.on = !f.taken;
      f.taken = true;
    } else if (t.startsWith("#endif")) stack.pop();
    else if (on()) {
      if ((m = t.match(/^#define\s+(\w+)/))) defs.add(m[1]);
      out.push(line);
    }
  }
  return out.join("\n");
}
