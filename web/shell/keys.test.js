import { describe, expect, it } from "vitest";
import { keyAction } from "./keys.js";

/** @param {Partial<KeyboardEvent> & { tag?: string; inputType?: string }} e */
const ev = (e) => ({ key: "", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: { tagName: e.tag ?? "BODY", type: e.inputType }, ...e });

describe("keyAction", () => {
  it("maps player keys", () => {
    expect(keyAction(ev({ key: "n" }))).toBe("next");
    expect(keyAction(ev({ key: "N", shiftKey: true }))).toBe("prev");
    expect(keyAction(ev({ key: "f" }))).toBe("fullscreen");
    expect(keyAction(ev({ key: "t" }))).toBe("floatOnTop");
    expect(keyAction(ev({ key: "h" }))).toBe("hideOverlays");
    expect(keyAction(ev({ key: "l" }))).toBe("library");
    expect(keyAction(ev({ key: "p" }))).toBe("hud");
    expect(keyAction(ev({ key: "Escape" }))).toBe("escape");
    expect(keyAction(ev({ key: "x" }))).toBeNull();
  });

  it("ignores modified keys and typing in text fields, but Escape still works there", () => {
    expect(keyAction(ev({ key: "n", metaKey: true }))).toBeNull();
    expect(keyAction(ev({ key: "f", ctrlKey: true }))).toBeNull();
    expect(keyAction(ev({ key: "n", tag: "INPUT" }))).toBeNull();
    expect(keyAction(ev({ key: "n", tag: "TEXTAREA" }))).toBeNull();
    expect(keyAction(ev({ key: "Escape", tag: "INPUT" }))).toBe("escape");
  });

  it("still works while a slider, checkbox or button has focus", () => {
    expect(keyAction(ev({ key: "n", tag: "INPUT", inputType: "range" }))).toBe("next");
    expect(keyAction(ev({ key: "l", tag: "INPUT", inputType: "checkbox" }))).toBe("library");
    expect(keyAction(ev({ key: "l", tag: "BUTTON" }))).toBe("library");
    expect(keyAction(ev({ key: "n", tag: "INPUT", inputType: "url" }))).toBeNull();
  });
});
