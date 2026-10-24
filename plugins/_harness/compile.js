// @ts-check
/**
 * Compile and link every program in shader-programs.js in this page's WebGL2 context, each unique
 * shader source and each unique vertex/fragment pair once, and publish `window.__result`:
 * `{ setup, inHarness, programs, shaders, linked, failures, ms }`. A failure names the visualizer,
 * the variant and its files, quotes the log, and points each logged line back at the file it came
 * from. Driven by tests/test_shader_compile.py; open it by hand to see the same report.
 */
import { IN_HARNESS, shaderPrograms } from "./shader-programs.js";

const w = /** @type {any} */ (window);
const t0 = performance.now();
/** @type {Map<string, string>} */
const texts = new Map();
/** @param {string} p */
async function read(p) {
  const r = await fetch("/plugins/" + p);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  const t = await r.text();
  texts.set(p, t);
  return t;
}

/** Log lines past this many are summarised as a count (a preprocessor slip cascades). */
const MAX_LOG = 8;
/** Preprocessor errors come first: a stray #endif or #else shows up as a heap of type errors. */
const PREPROCESSOR = /'#?(?:if|ifdef|ifndef|else|elif|endif|define|undef|version|extension)'|#(?:if|else|elif|endif)\b|preprocessor|macro/i;

/**
 * Where an assembled line came from. Spliced files (and the main file, when nothing was spliced
 * into it) appear verbatim in the source, so the innermost verbatim file holding the line names
 * it exactly; any other line belongs to the main file, around that line of the assembly.
 * @param {number} n 1-based line of `src` @param {string} src @param {string[]} files
 */
function origin(n, src, files) {
  let best = null;
  for (const f of files) {
    const t = texts.get(f);
    const i = t ? src.indexOf(t) : -1;
    if (!t || i < 0) continue;
    const first = src.slice(0, i).split("\n").length;
    const last = first + t.split("\n").length - 1;
    if (n >= first && n <= last && (!best || last - first < best.last - best.first)) best = { f, first, last };
  }
  return best ? `${best.f}:${n - best.first + 1}` : `${files[0]}, near line ${n} of the assembled source`;
}

/**
 * The log, preprocessor errors first, each line followed by its source line and file.
 * @param {string} log @param {string} src @param {string[]} files
 */
function explain(log, src, files) {
  const lines = src.split("\n");
  const entries = log.split("\n").filter((l) => l.trim());
  entries.sort((a, b) => Number(!PREPROCESSOR.test(a)) - Number(!PREPROCESSOR.test(b)));
  const out = entries.slice(0, MAX_LOG).map((l) => {
    const m = /^(?:ERROR|WARNING): \d+:(\d+):/.exec(l);
    if (!m) return "  " + l;
    const n = Number(m[1]);
    return `  ${l}\n      at ${origin(n, src, files)}: ${(lines[n - 1] ?? "").trim()}`;
  });
  if (entries.length > MAX_LOG) out.push(`  … ${entries.length - MAX_LOG} more`);
  return out.join("\n");
}

async function main() {
  const gl = /** @type {HTMLCanvasElement} */ (document.getElementById("c")).getContext("webgl2");
  if (!gl) {
    w.__result = { setup: "no WebGL2 context in this browser", inHarness: Object.keys(IN_HARNESS), programs: 0, shaders: 0, linked: 0, failures: [], ms: 0 };
    return;
  }
  const programs = await shaderPrograms(read);
  /** @type {Map<string, WebGLShader>} */
  const shaders = new Map();
  const shaderOf = (/** @type {number} */ type, /** @type {string} */ src) => {
    const key = type + "\0" + src;
    let s = shaders.get(key);
    if (!s) {
      s = /** @type {WebGLShader} */ (gl.createShader(type));
      gl.shaderSource(s, src);
      gl.compileShader(s);
      shaders.set(key, s);
    }
    return s;
  };
  /** @type {Map<string, { prog: WebGLProgram, p: import('./shader-programs.js').Program, vs: WebGLShader, fs: WebGLShader }>} */
  const linked = new Map();
  // Queue every compile and link first (the driver may work on them in parallel), then read back.
  for (const p of programs) {
    const key = p.vs + "\0" + p.fs;
    if (linked.has(key)) continue;
    const vs = shaderOf(gl.VERTEX_SHADER, p.vs);
    const fs = shaderOf(gl.FRAGMENT_SHADER, p.fs);
    const prog = /** @type {WebGLProgram} */ (gl.createProgram());
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    linked.set(key, { prog, p, vs, fs });
  }
  /** @type {string[]} */
  const failures = [];
  for (const { prog, p, vs, fs } of linked.values()) {
    const name = `${p.viz} — ${p.variant}`;
    const files = `files: ${p.files.join(", ")}`;
    const bad = [];
    for (const [s, kind, src, fl] of /** @type {[WebGLShader, string, string, string[]][]} */ ([[vs, "vertex", p.vs, [p.files[0]]], [fs, "fragment", p.fs, p.files.slice(1)]])) {
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = (gl.getShaderInfoLog(s) ?? "").trim();
        bad.push(`  ${kind} shader ${fl[0]} failed to compile:\n${explain(log, src, fl)}`);
      }
    }
    if (!bad.length && !gl.getProgramParameter(prog, gl.LINK_STATUS)) bad.push(`  link failed:\n${(gl.getProgramInfoLog(prog) ?? "").trim()}`);
    if (bad.length) failures.push(`${name}\n  ${files}\n${bad.join("\n")}`);
  }
  if (gl.isContextLost()) failures.push("the WebGL2 context was lost while compiling");
  w.__result = {
    setup: null,
    inHarness: Object.keys(IN_HARNESS),
    programs: programs.length,
    shaders: shaders.size,
    linked: linked.size,
    failures,
    ms: Math.round(performance.now() - t0),
  };
}

main().catch((e) => w.__errors.push(String(e && e.stack ? e.stack : e)));
