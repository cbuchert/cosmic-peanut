// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { dimensionBadge, renderLibrary } from "./library.js";

/** @param {Partial<import("./validate.js").VizInfo>} o @returns {import("./validate.js").VizInfo} */
const viz = (o) => ({
  key: "builtin/bars", repo: "builtin", id: "bars", name: "Bars", description: "", author: "",
  renderer: "2d", thumbnailUrl: null, params: [], values: {}, disabled: false, dev: false,
  entryUrl: "", pageUrl: "", ...o,
});

function setup() {
  const el = document.createElement("div");
  const actions = {
    select: vi.fn(), enable: vi.fn(), install: vi.fn(), addFolder: vi.fn(),
    update: vi.fn(), rollback: vi.fn(), remove: vi.fn(),
  };
  renderLibrary(el, {
    visualizers: [
      viz({}),
      viz({ key: "gh/orb", repo: "gh", id: "orb", name: "Orb <script>", renderer: "three", thumbnailUrl: "http://127.0.0.1:2/r/gh/t.png" }),
      viz({ key: "gh/hung", repo: "gh", id: "hung", name: "Hung", disabled: true }),
    ],
    repos: [
      { repo: "builtin", url: null, path: null, commit: null, previous: null, dev: false, builtin: true },
      { repo: "gh", url: "https://github.com/a/b", path: null, commit: "abc1234", previous: "def5678", dev: false, builtin: false },
    ],
    active: "gh/orb",
    updates: new Map([["gh", { commit: "fff0000", message: "New stuff" }]]),
  }, actions);
  return { el, actions };
}

describe("library", () => {
  it("badges three.js as 3D and everything else as 2D", () => {
    expect(dimensionBadge("three")).toBe("3D");
    expect(dimensionBadge("webgl2")).toBe("2D");
    expect(dimensionBadge("webgpu")).toBe("2D");
    expect(dimensionBadge("2d")).toBe("2D");
  });

  it("renders a card per visualizer with name, repo, badge, thumbnail as text-safe content", () => {
    const { el } = setup();
    const cards = el.querySelectorAll(".card");
    expect(cards).toHaveLength(3);
    expect(cards[1].querySelector(".card-name")?.textContent).toBe("Orb <script>");
    expect(el.querySelector("script")).toBeNull();
    expect(cards[1].querySelector(".badge")?.textContent).toBe("3D");
    expect(cards[0].querySelector(".badge")?.textContent).toBe("2D");
    expect(cards[1].querySelector(".card-repo")?.textContent).toBe("gh");
    expect(cards[1].querySelector("img")?.getAttribute("src")).toBe("http://127.0.0.1:2/r/gh/t.png");
    expect(cards[1].getAttribute("aria-current")).toBe("true");
  });

  it("selects on click; disabled visualizers offer Enable instead", () => {
    const { el, actions } = setup();
    const cards = el.querySelectorAll(".card");
    /** @type {HTMLButtonElement} */ (cards[0].querySelector("button.card-main")).click();
    expect(actions.select).toHaveBeenCalledWith("builtin/bars");
    const main = /** @type {HTMLButtonElement} */ (cards[2].querySelector("button.card-main"));
    expect(main.disabled).toBe(true);
    /** @type {HTMLButtonElement} */ (cards[2].querySelector("button.enable")).click();
    expect(actions.enable).toHaveBeenCalledWith("gh/hung");
  });

  it("add URL submits install; add folder sends addFolder", () => {
    const { el, actions } = setup();
    const input = /** @type {HTMLInputElement} */ (el.querySelector("input[type=url]"));
    input.value = " https://github.com/x/y ";
    /** @type {HTMLFormElement} */ (el.querySelector("form.add-url")).dispatchEvent(new Event("submit", { cancelable: true }));
    expect(actions.install).toHaveBeenCalledWith("https://github.com/x/y");
    /** @type {HTMLButtonElement} */ (el.querySelector("button.add-folder")).click();
    expect(actions.addFolder).toHaveBeenCalled();
  });

  it("repo rows offer update/rollback/remove for installed repos only", () => {
    const { el, actions } = setup();
    const rows = el.querySelectorAll(".repo");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll("button")).toHaveLength(0);
    expect(rows[1].textContent).toContain("New stuff");
    /** @type {HTMLButtonElement} */ (rows[1].querySelector("button.update")).click();
    /** @type {HTMLButtonElement} */ (rows[1].querySelector("button.rollback")).click();
    const remove = /** @type {HTMLButtonElement} */ (rows[1].querySelector("button.remove"));
    remove.click();
    expect(actions.remove).not.toHaveBeenCalled();
    expect(remove.textContent).toBe("Confirm remove");
    remove.click();
    expect(actions.update).toHaveBeenCalledWith("gh");
    expect(actions.rollback).toHaveBeenCalledWith("gh");
    expect(actions.remove).toHaveBeenCalledWith("gh");
  });
});
