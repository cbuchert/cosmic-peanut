// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { h } from "./dom.js";

describe("h", () => {
  it("builds elements; strings become text, never HTML", () => {
    const click = vi.fn();
    const el = h("button", { class: "btn", type: "button", onclick: click, "aria-label": "Go", hidden: false }, "<b>x</b>", null, h("span", {}, "y"));
    expect(el.tagName).toBe("BUTTON");
    expect(el.className).toBe("btn");
    expect(el.getAttribute("aria-label")).toBe("Go");
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toBe("<b>x</b>y");
    el.click();
    expect(click).toHaveBeenCalled();
  });

  it("sets boolean attributes and properties like value/checked", () => {
    const i = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: true, disabled: true }));
    expect(i.checked).toBe(true);
    expect(i.disabled).toBe(true);
    const r = /** @type {HTMLInputElement} */ (h("input", { type: "range", min: 0, max: 10, value: 3 }));
    expect(r.value).toBe("3");
  });
});
