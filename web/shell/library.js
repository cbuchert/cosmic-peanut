// Library panel: visualizer grid plus install / dev folder / repo management.

import { h } from "./dom.js";

/** @typedef {import("./validate.js").VizInfo} VizInfo */
/** @typedef {import("./validate.js").RepoInfo} RepoInfo */
/**
 * @typedef {object} LibraryActions
 * @property {(key: string) => void} select
 * @property {(key: string) => void} enable
 * @property {(url: string) => void} install
 * @property {() => void} addFolder
 * @property {(repo: string) => void} update
 * @property {(repo: string) => void} rollback
 * @property {(repo: string) => void} remove
 */
/**
 * @typedef {{ visualizers: VizInfo[]; repos: RepoInfo[]; active: string | null;
 *   updates: Map<string, { commit: string; message: string }> }} LibraryModel
 */

/** @param {string} renderer */
export const dimensionBadge = (renderer) => (renderer === "three" ? "3D" : "2D");

/** @param {string | null} c */
const short = (c) => (c ? c.slice(0, 7) : "");

/** @param {VizInfo} v @param {boolean} active @param {LibraryActions} actions */
function card(v, active, actions) {
  const thumb = v.thumbnailUrl
    ? h("img", { class: "thumb", src: v.thumbnailUrl, alt: "", loading: "lazy", draggable: "false" })
    : h("div", { class: "thumb thumb-empty", "aria-hidden": "true" }, v.name.slice(0, 1).toUpperCase());
  const main = h(
    "button",
    {
      type: "button",
      class: "card-main",
      disabled: v.disabled,
      title: v.description || undefined,
      onclick: () => actions.select(v.key),
    },
    thumb,
    h(
      "span",
      { class: "card-meta" },
      h("span", { class: "card-name" }, v.name),
      h("span", { class: "card-repo" }, v.repo),
    ),
    h("span", { class: "badges" }, h("span", { class: "badge" }, dimensionBadge(v.renderer)), v.dev && h("span", { class: "badge badge-dev" }, "Dev")),
  );
  return h(
    "li",
    { class: `card${v.disabled ? " is-disabled" : ""}`, "aria-current": active ? "true" : undefined },
    main,
    v.disabled &&
      h(
        "div",
        { class: "card-disabled" },
        h("span", {}, "Disabled"),
        h("button", { type: "button", class: "enable", onclick: () => actions.enable(v.key) }, "Enable"),
      ),
  );
}

/** @param {RepoInfo} r @param {{ commit: string; message: string } | undefined} upd @param {LibraryActions} actions */
function repoRow(r, upd, actions) {
  const where = r.url ?? r.path ?? (r.builtin ? "Built in" : "");
  /** @type {HTMLElement[]} */
  const buttons = [];
  if (!r.builtin) {
    if (!r.dev) {
      buttons.push(h("button", { type: "button", class: "update", onclick: () => actions.update(r.repo) }, upd ? "Update" : "Check for update"));
      if (r.previous) buttons.push(h("button", { type: "button", class: "rollback", onclick: () => actions.rollback(r.repo) }, "Roll back"));
    }
    const remove = h("button", { type: "button", class: "remove danger" }, "Remove");
    let armed = false;
    remove.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        remove.textContent = "Confirm remove";
        return;
      }
      actions.remove(r.repo);
    });
    remove.addEventListener("blur", () => {
      armed = false;
      remove.textContent = "Remove";
    });
    buttons.push(remove);
  }
  return h(
    "li",
    { class: "repo" },
    h(
      "div",
      { class: "repo-info" },
      h("span", { class: "repo-name" }, r.repo, r.dev && " (dev folder)"),
      h("span", { class: "repo-where muted" }, where, r.commit && ` @ ${short(r.commit)}`),
      upd && h("span", { class: "repo-update" }, `Update available: ${short(upd.commit)} ${upd.message}`),
    ),
    h("div", { class: "repo-actions" }, buttons),
  );
}

/**
 * @param {HTMLElement} el
 * @param {LibraryModel} model
 * @param {LibraryActions} actions
 */
export function renderLibrary(el, model, actions) {
  const url = /** @type {HTMLInputElement} */ (
    h("input", { type: "url", id: "add-url", placeholder: "https://github.com/user/visualizers", autocomplete: "off", spellcheck: "false" })
  );
  const form = h(
    "form",
    { class: "add-url" },
    h("label", { for: "add-url", class: "sr-only" }, "Add visualizers from a git URL"),
    url,
    h("button", { type: "submit" }, "Add from URL"),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = url.value.trim();
    if (v) actions.install(v);
    url.value = "";
  });

  el.replaceChildren(
    h(
      "div",
      { class: "library-tools" },
      form,
      h("button", { type: "button", class: "add-folder", onclick: () => actions.addFolder() }, "Add dev folder…"),
    ),
    h("ul", { class: "grid", "aria-label": "Visualizers" }, model.visualizers.map((v) => card(v, v.key === model.active, actions))),
    h("h3", { class: "section-title" }, "Sources"),
    h("ul", { class: "repos" }, model.repos.map((r) => repoRow(r, model.updates.get(r.repo), actions))),
  );
}
