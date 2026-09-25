// Keyboard shortcuts (PRD "Host UI → Keys").

/** @typedef {"next" | "prev" | "fullscreen" | "floatOnTop" | "hideOverlays" | "library" | "hud" | "escape"} KeyAction */

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** @type {Record<string, KeyAction>} */
const MAP = { n: "next", f: "fullscreen", t: "floatOnTop", h: "hideOverlays", l: "library", p: "hud" };

/**
 * @param {{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean;
 *   target: EventTarget | { tagName?: string } | null }} e
 * @returns {KeyAction | null}
 */
export function keyAction(e) {
  if (e.key === "Escape") return "escape";
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const tag = e.target && "tagName" in e.target ? e.target.tagName : "";
  if (tag && TEXT_TAGS.has(tag)) return null;
  const k = e.key.toLowerCase();
  if (k === "n" && e.shiftKey) return "prev";
  return MAP[k] ?? null;
}
