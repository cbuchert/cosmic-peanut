// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { defaultValues, renderParams } from "./params.js";

/** @type {import("./validate.js").ParamSpec[]} */
const specs = [
  { id: "speed", type: "number", label: "Speed", min: 0, max: 2, step: 0.1, default: 1 },
  { id: "tint", type: "color", label: "Tint <i>", default: "#ff0000" },
  { id: "mirror", type: "boolean", label: "Mirror", default: false },
  { id: "mode", type: "select", label: "Mode", options: ["a", "b"], default: "a" },
];

function setup(values = {}) {
  const el = document.createElement("div");
  const onChange = vi.fn();
  renderParams(el, specs, { ...defaultValues(specs), ...values }, onChange);
  return { el, onChange };
}

describe("params panel", () => {
  it("renders one labelled control per spec with current values", () => {
    const { el } = setup({ speed: 1.5, mode: "b" });
    const inputs = el.querySelectorAll("input, select");
    expect(inputs).toHaveLength(4);
    const speed = /** @type {HTMLInputElement} */ (el.querySelector("#param-speed"));
    expect(speed.type).toBe("range");
    expect(speed.min).toBe("0");
    expect(speed.max).toBe("2");
    expect(speed.step).toBe("0.1");
    expect(speed.value).toBe("1.5");
    expect(/** @type {HTMLInputElement} */ (el.querySelector("#param-tint")).type).toBe("color");
    expect(/** @type {HTMLInputElement} */ (el.querySelector("#param-mirror")).type).toBe("checkbox");
    expect(/** @type {HTMLSelectElement} */ (el.querySelector("#param-mode")).value).toBe("b");
    const label = /** @type {HTMLLabelElement} */ (el.querySelector('label[for="param-tint"]'));
    expect(label.textContent).toContain("Tint <i>");
    expect(el.querySelector("i")).toBeNull();
  });

  it("sends the full value set on each change, with the changed keys", () => {
    const { el, onChange } = setup();
    const speed = /** @type {HTMLInputElement} */ (el.querySelector("#param-speed"));
    speed.value = "0.5";
    speed.dispatchEvent(new Event("input"));
    expect(onChange).toHaveBeenLastCalledWith({ speed: 0.5, tint: "#ff0000", mirror: false, mode: "a" }, { speed: 0.5 });
    const mirror = /** @type {HTMLInputElement} */ (el.querySelector("#param-mirror"));
    mirror.checked = true;
    mirror.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith({ speed: 0.5, tint: "#ff0000", mirror: true, mode: "a" }, { mirror: true });
    const mode = /** @type {HTMLSelectElement} */ (el.querySelector("#param-mode"));
    mode.value = "b";
    mode.dispatchEvent(new Event("change"));
    expect(onChange.mock.lastCall?.[0].mode).toBe("b");
  });

  it("reset restores defaults and updates the controls", () => {
    const { el, onChange } = setup({ speed: 2, mirror: true });
    const reset = /** @type {HTMLButtonElement} */ (el.querySelector("button.reset"));
    reset.click();
    expect(onChange).toHaveBeenLastCalledWith({ speed: 1, tint: "#ff0000", mirror: false, mode: "a" }, { speed: 1, mirror: false });
    expect(/** @type {HTMLInputElement} */ (el.querySelector("#param-speed")).value).toBe("1");
    expect(/** @type {HTMLInputElement} */ (el.querySelector("#param-mirror")).checked).toBe(false);
  });

  it("ignores stored values of the wrong type", () => {
    const { el } = setup({ speed: "fast", mode: "zzz" });
    expect(/** @type {HTMLInputElement} */ (el.querySelector("#param-speed")).value).toBe("1");
    expect(/** @type {HTMLSelectElement} */ (el.querySelector("#param-mode")).value).toBe("a");
  });

  it("says so when there are no parameters", () => {
    const el = document.createElement("div");
    renderParams(el, [], {}, () => {});
    expect(el.textContent).toContain("No parameters");
  });
});
