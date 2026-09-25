// Tiny element builder. Strings are always inserted as text nodes: plugin- and host-supplied
// strings can never become markup.

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), /** @type {EventListener} */ (v));
    } else if (k === "class") {
      el.className = String(v);
    } else if (k === "value" || k === "checked") {
      /** @type {any} */ (el)[k] = v;
    } else {
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

/** @param {Element} el @param {(Child | Child[])[]} children */
function append(el, children) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(typeof c === "number" ? String(c) : c);
  }
}
