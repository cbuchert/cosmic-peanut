// @ts-check
/**
 * `ctx.assets`: loaders scoped to the plugin's repo. The plugin server enforces the same rule;
 * rejecting here gives authors a clear error instead of a 404.
 */

/**
 * @param {unknown} path
 * @param {string} base absolute repo base URL, ending in "/"
 * @returns {string} absolute URL inside the repo
 */
function resolve(path, base) {
  const bad = (/** @type {string} */ why) => new Error(`asset path ${JSON.stringify(path)} rejected: ${why}`);
  if (typeof path !== "string" || path === "") throw bad("must be a non-empty repo-relative string");
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw bad("URLs and schemes are not allowed");
  if (path.startsWith("/")) throw bad("absolute paths are not allowed");
  if (path.includes("\\")) throw bad("backslashes are not allowed");
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw bad("invalid percent-encoding");
  }
  if (decoded.split(/[/\\]/).includes("..")) throw bad("'..' is not allowed");
  const url = new URL(path, base).href;
  if (!url.startsWith(base)) throw bad("escapes the repo");
  return url;
}

/**
 * @param {string} base absolute repo base URL, ending in "/"
 * @param {{ fetch: (url: string) => Promise<Response>, createImageBitmap?: (b: Blob) => Promise<ImageBitmap> }} deps
 * @returns {import("./tidalviz").Assets}
 */
export function createAssets(base, deps) {
  /** @param {string} path */
  async function get(path) {
    const url = resolve(path, base);
    const res = await deps.fetch(url);
    if (!res.ok) throw new Error(`asset ${path}: HTTP ${res.status}`);
    return res;
  }
  return {
    url: (path) => resolve(path, base),
    text: async (path) => (await get(path)).text(),
    json: async (path) => (await get(path)).json(),
    arrayBuffer: async (path) => (await get(path)).arrayBuffer(),
    image: async (path) => {
      const blob = await (await get(path)).blob();
      const decode = deps.createImageBitmap ?? globalThis.createImageBitmap;
      return decode(blob);
    },
  };
}
