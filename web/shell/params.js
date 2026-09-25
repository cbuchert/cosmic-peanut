// Parameter panel generated from a visualizer's ParamSpec list (docs/plugin-api.md "Params").

import { h } from "./dom.js";

/** @typedef {import("./validate.js").ParamSpec} ParamSpec */
/** @typedef {import("./validate.js").ParamValues} ParamValues */
/** @typedef {import("./validate.js").ParamValue} ParamValue */

/** @param {ParamSpec[]} specs @returns {ParamValues} */
export function defaultValues(specs) {
  /** @type {ParamValues} */
  const out = {};
  for (const s of specs) out[s.id] = s.default;
  return out;
}

/** A valid value for `spec`: the stored one if it fits, else the default. @param {ParamSpec} spec @param {unknown} v */
export function coerce(spec, v) {
  switch (spec.type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.default;
    case "color":
      return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : spec.default;
    case "boolean":
      return typeof v === "boolean" ? v : spec.default;
    case "select":
      return typeof v === "string" && spec.options.includes(v) ? v : spec.default;
  }
}

/** @param {ParamSpec[]} specs @param {ParamValues} values @returns {ParamValues} */
export function resolveValues(specs, values) {
  /** @type {ParamValues} */
  const out = {};
  for (const s of specs) out[s.id] = coerce(s, values[s.id]);
  return out;
}

/** @param {number} n */
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ""));

/**
 * @param {HTMLElement} el
 * @param {ParamSpec[]} specs
 * @param {ParamValues} values
 * @param {(all: ParamValues, changed: ParamValues) => void} onChange
 */
export function renderParams(el, specs, values, onChange) {
  el.replaceChildren();
  if (specs.length === 0) {
    el.append(h("p", { class: "muted" }, "No parameters for this visualizer."));
    return;
  }
  const current = resolveValues(specs, values);
  /** @type {Map<string, (v: ParamValue) => void>} */
  const setters = new Map();

  /** @param {string} id @param {ParamValue} v */
  const change = (id, v) => {
    current[id] = v;
    onChange({ ...current }, { [id]: v });
  };

  for (const spec of specs) {
    const id = `param-${spec.id}`;
    const label = h("label", { for: id }, spec.label);
    /** @type {HTMLElement} */
    let row;
    if (spec.type === "number") {
      const out = h("output", { for: id, class: "param-value" }, fmt(/** @type {number} */ (current[spec.id])));
      const input = /** @type {HTMLInputElement} */ (
        h("input", { id, type: "range", min: spec.min, max: spec.max, step: spec.step ?? "any", value: String(current[spec.id]) })
      );
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        change(spec.id, v);
      });
      setters.set(spec.id, (v) => {
        input.value = String(v);
        out.textContent = fmt(/** @type {number} */ (v));
      });
      row = h("div", { class: "param param-number" }, h("div", { class: "param-head" }, label, out), input);
    } else if (spec.type === "color") {
      const input = /** @type {HTMLInputElement} */ (h("input", { id, type: "color", value: current[spec.id] }));
      input.addEventListener("input", () => change(spec.id, input.value));
      setters.set(spec.id, (v) => (input.value = String(v)));
      row = h("div", { class: "param param-inline" }, label, input);
    } else if (spec.type === "boolean") {
      const input = /** @type {HTMLInputElement} */ (h("input", { id, type: "checkbox", checked: current[spec.id] }));
      input.addEventListener("change", () => change(spec.id, input.checked));
      setters.set(spec.id, (v) => (input.checked = Boolean(v)));
      row = h("div", { class: "param param-inline" }, label, input);
    } else {
      const select = /** @type {HTMLSelectElement} */ (h("select", { id }, spec.options.map((o) => h("option", { value: o }, o))));
      select.value = String(current[spec.id]);
      select.addEventListener("change", () => change(spec.id, select.value));
      setters.set(spec.id, (v) => (select.value = String(v)));
      row = h("div", { class: "param param-inline" }, label, select);
    }
    el.append(row);
  }

  const reset = h("button", { type: "button", class: "reset" }, "Reset to defaults");
  reset.addEventListener("click", () => {
    /** @type {ParamValues} */
    const changed = {};
    for (const s of specs) {
      if (current[s.id] !== s.default) changed[s.id] = s.default;
      current[s.id] = s.default;
      setters.get(s.id)?.(s.default);
    }
    onChange({ ...current }, changed);
  });
  el.append(reset);
}
