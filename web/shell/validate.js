// Validation of every untrusted message the shell receives (docs/protocols.md §4, §5).
// Parsers return a fresh, well-typed object containing only known fields, or null.
// Invalid list items (a visualizer, a param, a source) are dropped rather than failing the
// whole message, so one bad manifest entry can't blank the library.

/**
 * @typedef {"auto" | "high" | "balanced" | "battery"} QualityMode
 * @typedef {number | string | boolean} ParamValue
 * @typedef {Record<string, ParamValue>} ParamValues
 * @typedef {{ id: string; type: "number"; label: string; min: number; max: number; step?: number; default: number }
 *   | { id: string; type: "color"; label: string; default: string }
 *   | { id: string; type: "boolean"; label: string; default: boolean }
 *   | { id: string; type: "select"; label: string; options: string[]; default: string }} ParamSpec
 * @typedef {{ key: string; repo: string; id: string; name: string; description: string; author: string;
 *   renderer: string; thumbnailUrl: string | null; params: ParamSpec[]; values: ParamValues;
 *   disabled: boolean; dev: boolean; entryUrl: string; pageUrl: string }} VizInfo
 * @typedef {{ repo: string; url: string | null; path: string | null; commit: string | null;
 *   previous: string | null; dev: boolean; builtin: boolean }} RepoInfo
 * @typedef {{ id: string; name: string }} SourceInfo
 * @typedef {{ quality?: QualityMode; reduceFlashing?: boolean; autoCycleSeconds?: number;
 *   hudVisible?: boolean; photosensitivityNoticeSeen?: boolean }} Settings
 * @typedef {{ hostCpu: number; rssMb: number; analysisMsP50: number; captureToSendMsP95: number;
 *   droppedFrames: number; latencyMsP95?: number }} Stats
 *
 * @typedef {{ type: "hello"; version: number; pluginOrigin: string; visualizers: VizInfo[]; repos: RepoInfo[];
 *     settings: Settings; sources: SourceInfo[]; activeSource: string | null; active: string | null; dev: boolean }
 *   | { type: "visualizers"; visualizers: VizInfo[]; repos: RepoInfo[] }
 *   | { type: "reload"; key: string }
 *   | { type: "manifestError"; repo: string; errors: { path: string; message: string }[] }
 *   | { type: "sources"; sources: SourceInfo[]; active: string | null }
 *   | { type: "status"; level: "info" | "warn" | "error"; text: string; id?: string }
 *   | { type: "silence"; silent: boolean; seconds: number }
 *   | ({ type: "stats" } & Stats)
 *   | { type: "installPrompt"; id: string; url: string; commit: string; visualizers: { id: string; name: string }[] }
 *   | { type: "installResult"; id: string; ok: boolean; error?: string }
 *   | { type: "updates"; repos: { repo: string; commit: string; message: string }[] }
 *   | { type: "disabled"; key: string; reason: string }} HostMessage
 *
 * @typedef {{ fps: number; frameMsP50: number; frameMsP99: number; pluginMsP50: number;
 *   renderScale: number; dropped: number }} PluginPerf
 * @typedef {{ type: "ready" }
 *   | { type: "error"; message: string; file?: string; line?: number; fatal: boolean }
 *   | ({ type: "perf" } & PluginPerf)
 *   | { type: "onsetSeen"; frameIndex: number }
 *   | { type: "log"; text: string }
 *   | { type: "contextLost" }} PluginMessage
 */

/** @typedef {Record<string, unknown>} Obj */

/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === "string";
/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** @param {unknown} v @returns {v is boolean} */
const isBool = (v) => typeof v === "boolean";
/** @param {unknown} v @returns {v is Obj} */
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof ArrayBuffer);
/** @param {unknown} v @returns {v is string | null} */
const isStrOrNull = (v) => v === null || isStr(v);
/** @param {unknown} v @returns {v is number} */
const isCount = (v) => isNum(v) && v >= 0 && Number.isInteger(v);

const LEVELS = ["info", "warn", "error"];
const QUALITIES = ["auto", "high", "balanced", "battery"];
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * @template T
 * @param {unknown} v
 * @param {(item: unknown) => T | null} parse
 * @returns {T[] | null}
 */
function list(v, parse) {
  if (!Array.isArray(v)) return null;
  /** @type {T[]} */
  const out = [];
  for (const item of v) {
    const p = parse(item);
    if (p !== null) out.push(p);
  }
  return out;
}

/** @param {unknown} v @returns {ParamSpec | null} */
export function parseParamSpec(v) {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.label)) return null;
  const { id, label } = v;
  switch (v.type) {
    case "number": {
      if (!isNum(v.min) || !isNum(v.max) || !isNum(v.default) || v.min > v.max) return null;
      /** @type {ParamSpec} */
      const p = { id, type: "number", label, min: v.min, max: v.max, default: v.default };
      if (isNum(v.step) && v.step > 0) p.step = v.step;
      return p;
    }
    case "color":
      return isStr(v.default) && HEX.test(v.default) ? { id, type: "color", label, default: v.default } : null;
    case "boolean":
      return isBool(v.default) ? { id, type: "boolean", label, default: v.default } : null;
    case "select": {
      const opts = v.options;
      if (!Array.isArray(opts) || opts.length === 0 || !opts.every(isStr)) return null;
      if (!isStr(v.default) || !opts.includes(v.default)) return null;
      return { id, type: "select", label, options: [...opts], default: v.default };
    }
    default:
      return null;
  }
}

/** @param {unknown} v @returns {ParamValues} */
function parseValues(v) {
  /** @type {ParamValues} */
  const out = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (isStr(val) || isNum(val) || isBool(val)) out[k] = val;
  }
  return out;
}

/** @param {unknown} v @returns {VizInfo | null} */
function parseViz(v) {
  if (!isObj(v)) return null;
  for (const f of ["key", "repo", "id", "name", "renderer", "entryUrl", "pageUrl"]) {
    if (!isStr(v[f])) return null;
  }
  if (!isStrOrNull(v.thumbnailUrl ?? null)) return null;
  const params = list(v.params ?? [], parseParamSpec);
  if (!params) return null;
  return {
    key: /** @type {string} */ (v.key),
    repo: /** @type {string} */ (v.repo),
    id: /** @type {string} */ (v.id),
    name: /** @type {string} */ (v.name),
    description: isStr(v.description) ? v.description : "",
    author: isStr(v.author) ? v.author : "",
    renderer: /** @type {string} */ (v.renderer),
    thumbnailUrl: /** @type {string | null} */ (v.thumbnailUrl ?? null),
    params,
    values: parseValues(v.values),
    disabled: v.disabled === true,
    dev: v.dev === true,
    entryUrl: /** @type {string} */ (v.entryUrl),
    pageUrl: /** @type {string} */ (v.pageUrl),
  };
}

/** @param {unknown} v @returns {RepoInfo | null} */
function parseRepo(v) {
  if (!isObj(v) || !isStr(v.repo)) return null;
  const n = (/** @type {unknown} */ x) => (isStr(x) ? x : null);
  return {
    repo: v.repo,
    url: n(v.url),
    path: n(v.path),
    commit: n(v.commit),
    previous: n(v.previous),
    dev: v.dev === true,
    builtin: v.builtin === true,
  };
}

/** @param {unknown} v @returns {SourceInfo | null} */
function parseSource(v) {
  return isObj(v) && isStr(v.id) && isStr(v.name) ? { id: v.id, name: v.name } : null;
}

/** @param {unknown} v @returns {Settings} */
export function parseSettings(v) {
  /** @type {Settings} */
  const out = {};
  if (!isObj(v)) return out;
  if (isStr(v.quality) && QUALITIES.includes(v.quality)) out.quality = /** @type {QualityMode} */ (v.quality);
  if (isBool(v.reduceFlashing)) out.reduceFlashing = v.reduceFlashing;
  if (isNum(v.autoCycleSeconds) && v.autoCycleSeconds >= 0) out.autoCycleSeconds = v.autoCycleSeconds;
  if (isBool(v.hudVisible)) out.hudVisible = v.hudVisible;
  if (isBool(v.photosensitivityNoticeSeen)) out.photosensitivityNoticeSeen = v.photosensitivityNoticeSeen;
  return out;
}

/** @param {string} text @returns {HostMessage | null} */
export function parseHostMessage(text) {
  /** @type {unknown} */
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(m)) return null;
  switch (m.type) {
    case "hello": {
      const visualizers = list(m.visualizers, parseViz);
      const repos = list(m.repos ?? [], parseRepo);
      const sources = list(m.sources ?? [], parseSource);
      if (!visualizers || !repos || !sources || !isStr(m.pluginOrigin)) return null;
      return {
        type: "hello",
        version: isNum(m.version) ? m.version : 0,
        pluginOrigin: m.pluginOrigin,
        visualizers,
        repos,
        settings: parseSettings(m.settings),
        sources,
        activeSource: isStr(m.activeSource) ? m.activeSource : null,
        active: isStr(m.active) ? m.active : null,
        dev: m.dev === true,
      };
    }
    case "visualizers": {
      const visualizers = list(m.visualizers, parseViz);
      const repos = list(m.repos ?? [], parseRepo);
      return visualizers && repos ? { type: "visualizers", visualizers, repos } : null;
    }
    case "reload":
      return isStr(m.key) ? { type: "reload", key: m.key } : null;
    case "manifestError": {
      const errors = list(m.errors, (e) =>
        isObj(e) && isStr(e.message) ? { path: isStr(e.path) ? e.path : "", message: e.message } : null,
      );
      return isStr(m.repo) && errors ? { type: "manifestError", repo: m.repo, errors } : null;
    }
    case "sources": {
      const sources = list(m.sources, parseSource);
      return sources ? { type: "sources", sources, active: isStr(m.active) ? m.active : null } : null;
    }
    case "status": {
      if (!isStr(m.text) || !isStr(m.level) || !LEVELS.includes(m.level)) return null;
      const level = /** @type {"info" | "warn" | "error"} */ (m.level);
      return isStr(m.id) ? { type: "status", level, text: m.text, id: m.id } : { type: "status", level, text: m.text };
    }
    case "silence":
      return isBool(m.silent) && isNum(m.seconds) ? { type: "silence", silent: m.silent, seconds: m.seconds } : null;
    case "stats": {
      const { hostCpu, rssMb, analysisMsP50, captureToSendMsP95, droppedFrames, latencyMsP95 } = m;
      if (![hostCpu, rssMb, analysisMsP50, captureToSendMsP95, droppedFrames].every(isNum)) return null;
      /** @type {HostMessage} */
      const s = {
        type: "stats",
        hostCpu: /** @type {number} */ (hostCpu),
        rssMb: /** @type {number} */ (rssMb),
        analysisMsP50: /** @type {number} */ (analysisMsP50),
        captureToSendMsP95: /** @type {number} */ (captureToSendMsP95),
        droppedFrames: /** @type {number} */ (droppedFrames),
      };
      if (isNum(latencyMsP95)) s.latencyMsP95 = latencyMsP95;
      return s;
    }
    case "installPrompt": {
      const visualizers = list(m.visualizers, (v) =>
        isObj(v) && isStr(v.id) && isStr(v.name) ? { id: v.id, name: v.name } : null,
      );
      if (!isStr(m.id) || !isStr(m.url) || !isStr(m.commit) || !visualizers) return null;
      return { type: "installPrompt", id: m.id, url: m.url, commit: m.commit, visualizers };
    }
    case "installResult": {
      if (!isStr(m.id) || !isBool(m.ok)) return null;
      return isStr(m.error)
        ? { type: "installResult", id: m.id, ok: m.ok, error: m.error }
        : { type: "installResult", id: m.id, ok: m.ok };
    }
    case "updates": {
      const repos = list(m.repos, (r) =>
        isObj(r) && isStr(r.repo) && isStr(r.commit)
          ? { repo: r.repo, commit: r.commit, message: isStr(r.message) ? r.message : "" }
          : null,
      );
      return repos ? { type: "updates", repos } : null;
    }
    case "disabled":
      return isStr(m.key) && isStr(m.reason) ? { type: "disabled", key: m.key, reason: m.reason } : null;
    default:
      return null;
  }
}

/** @param {unknown} m @returns {PluginMessage | null} */
export function parsePluginMessage(m) {
  if (!isObj(m)) return null;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "contextLost":
      return { type: "contextLost" };
    case "error": {
      if (!isStr(m.message) || !isBool(m.fatal)) return null;
      /** @type {PluginMessage} */
      const e = { type: "error", message: m.message, fatal: m.fatal };
      if (isStr(m.file)) e.file = m.file;
      if (isCount(m.line)) e.line = m.line;
      return e;
    }
    case "perf": {
      const { fps, frameMsP50, frameMsP99, pluginMsP50, renderScale, dropped } = m;
      if (![fps, frameMsP50, frameMsP99, pluginMsP50, renderScale, dropped].every(isNum)) return null;
      return {
        type: "perf",
        fps: /** @type {number} */ (fps),
        frameMsP50: /** @type {number} */ (frameMsP50),
        frameMsP99: /** @type {number} */ (frameMsP99),
        pluginMsP50: /** @type {number} */ (pluginMsP50),
        renderScale: /** @type {number} */ (renderScale),
        dropped: /** @type {number} */ (dropped),
      };
    }
    case "onsetSeen":
      return isCount(m.frameIndex) ? { type: "onsetSeen", frameIndex: m.frameIndex } : null;
    case "log":
      return isStr(m.text) ? { type: "log", text: m.text } : null;
    default:
      return null;
  }
}
