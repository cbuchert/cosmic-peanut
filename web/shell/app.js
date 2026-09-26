// The shell controller: owns UI state, reacts to host messages and plugin events, and builds
// the player UI. Everything with side effects is injected so it runs under happy-dom.

import { h } from "./dom.js";
import { createHud } from "./hud.js";
import { createIdle } from "./idle.js";
import { keyAction } from "./keys.js";
import { renderLibrary } from "./library.js";
import { renderParams, resolveValues } from "./params.js";
import { createPluginHost, formatError } from "./pluginHost.js";
import { qualityProfile } from "./quality.js";

/**
 * @typedef {import("./validate.js").HostMessage} HostMessage
 * @typedef {import("./validate.js").VizInfo} VizInfo
 * @typedef {import("./validate.js").RepoInfo} RepoInfo
 * @typedef {import("./validate.js").SourceInfo} SourceInfo
 * @typedef {import("./validate.js").Settings} Settings
 * @typedef {import("./validate.js").ParamValues} ParamValues
 * @typedef {import("./validate.js").QualityMode} QualityMode
 * @typedef {import("./pluginHost.js").PluginEvent} PluginEvent
 * @typedef {ReturnType<typeof createPluginHost>} PluginHost
 * @typedef {"library" | "params" | "settings"} PanelName
 *
 * @typedef {object} AppDeps
 * @property {HTMLElement} root
 * @property {(msg: object) => boolean} send
 * @property {(deps: import("./pluginHost.js").PluginHostDeps) => PluginHost} [createPluginHost]
 * @property {number} [dpr]
 */

const IDLE_MS = 3000;
const LOG_LINES = 200;
const AUTO_CYCLE_CHOICES = [0, 15, 30, 60, 120, 300];
const QUALITY_LABELS = /** @type {const} */ ([
  ["auto", "Auto"],
  ["high", "High"],
  ["balanced", "Balanced"],
  ["battery", "Battery"],
]);
const CONNECTING = "Connecting to Tidalviz…";

/** @param {number} s */
const cycleLabel = (s) => (s === 0 ? "Off" : s < 60 ? `Every ${s} s` : `Every ${s / 60} min`);

/** @param {AppDeps} deps */
export function createApp(deps) {
  const { root, send } = deps;
  const doc = root.ownerDocument;
  const dpr = deps.dpr ?? 1;

  // ---- state -------------------------------------------------------------------------------
  /** @type {VizInfo[]} */ let visualizers = [];
  /** @type {RepoInfo[]} */ let repos = [];
  /** @type {SourceInfo[]} */ let sources = [];
  /** @type {string | null} */ let activeSource = null;
  /** @type {Map<string, { commit: string; message: string }>} */ const updates = new Map();
  /** @type {Map<string, ParamValues>} */ const values = new Map();
  /** @type {string | null} */ let selected = null;
  /** @type {string[]} */ const history = [];
  /** @type {Required<Pick<Settings, "quality" | "reduceFlashing" | "autoCycleSeconds" | "hudVisible">>} */
  const settings = { quality: "auto", reduceFlashing: true, autoCycleSeconds: 0, hudVisible: false };
  let dev = false;
  let overlaysHidden = false;
  /** @type {PanelName | null} */ let openPanel = null;
  /** @type {Element | null} */ let returnFocus = null;
  /** @type {string | null} */ let installId = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */ let cycleTimer;
  let connectionMessage = false;
  /** Visualizer whose error the overlay shows. @type {string | null} */ let errorKey = null;

  // ---- DOM -----------------------------------------------------------------------------------
  const stage = h("div", { id: "stage", class: "stage" });
  const empty = h("div", { class: "empty", hidden: true });
  const nowName = h("span", { class: "now-name" }, "");
  const nowRepo = h("span", { class: "now-repo" }, "");
  const sourceSel = /** @type {HTMLSelectElement} */ (h("select", { id: "source", "aria-label": "Audio source" }));
  /** @param {string} label @param {string} key @param {() => void} fn @param {string} [cls] */
  const btn = (label, key, fn, cls = "icon-btn") =>
    h("button", { type: "button", class: cls, title: key ? `${label} (${key})` : label, onclick: fn }, label);

  const libraryBody = h("div", { class: "panel-body" });
  const paramsBody = h("div", { class: "panel-body" });
  const settingsBody = h("div", { class: "panel-body" });
  /** @param {PanelName} name @param {string} title @param {HTMLElement} body @param {string} cls */
  const panel = (name, title, body, cls) =>
    h(
      "section",
      { id: name, class: `panel overlay ${cls}`, role: "dialog", "aria-label": title, hidden: true },
      h(
        "header",
        { class: "panel-head" },
        h("h2", {}, title),
        h("button", { type: "button", class: "close", "aria-label": `Close ${title}`, onclick: () => closePanels() }, "✕"),
      ),
      body,
    );
  const panels = {
    library: panel("library", "Library", libraryBody, "sheet"),
    params: panel("params", "Parameters", paramsBody, "drawer"),
    settings: panel("settings", "Settings", settingsBody, "drawer"),
  };

  const hudEl = h("div", { id: "hud", class: "hud", "aria-label": "Performance" });
  const hud = createHud(hudEl);
  const status = h("p", { id: "status", class: "status", role: "status", "aria-live": "polite" });
  const errorText = h("p", { class: "error-text" });
  const errorBox = h(
    "div",
    { id: "error", class: "toast toast-error", role: "alert", hidden: true },
    h("strong", {}, "Visualizer error"),
    errorText,
    h("button", { type: "button", onclick: () => (errorBox.hidden = true) }, "Dismiss"),
  );
  const permission = h(
    "div",
    { id: "permission", class: "toast", hidden: true },
    h("p", {}, "No sound is coming through — Tidalviz may need permission to capture audio."),
    h("button", { type: "button", class: "primary", onclick: () => send({ type: "openPermissions" }) }, "Open System Settings"),
  );
  const devlog = h("pre", { id: "devlog", class: "devlog", hidden: true, "aria-label": "Plugin console" });

  const noticeOk = h("button", { type: "button", class: "primary", onclick: () => dismissNotice() }, "Got it");
  const notice = h(
    "div",
    { id: "notice", class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "notice-title", hidden: true },
    h(
      "div",
      { class: "modal-card" },
      h("h2", { id: "notice-title" }, "Photosensitivity notice"),
      h(
        "p",
        {},
        "Some visualizers show flashing lights and fast-moving patterns that may trigger seizures in people with photosensitive epilepsy. ",
        "“Reduce flashing” is on, which limits full-screen brightness changes to three per second. You can change it in Settings.",
      ),
      h("div", { class: "modal-actions" }, noticeOk),
    ),
  );

  const installBody = h("div", {});
  const installOk = h("button", { type: "button", class: "primary", onclick: () => answerInstall(true) }, "Install");
  const install = h(
    "div",
    { id: "install", class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "install-title", hidden: true },
    h(
      "div",
      { class: "modal-card" },
      h("h2", { id: "install-title" }, "Install visualizers?"),
      installBody,
      h(
        "p",
        { class: "muted" },
        "Visualizers run in a sandbox: they can't access your files, the network, or other apps. They only receive audio analysis data.",
      ),
      h(
        "div",
        { class: "modal-actions" },
        h("button", { type: "button", class: "cancel", onclick: () => answerInstall(false) }, "Cancel"),
        installOk,
      ),
    ),
  );

  const topbar = h(
    "header",
    { class: "topbar overlay" },
    h("div", { class: "now" }, nowName, nowRepo),
    h(
      "div",
      { class: "controls" },
      h("label", { class: "source" }, h("span", { class: "sr-only" }, "Source"), sourceSel),
      btn("Library", "L", () => togglePanel("library")),
      btn("Parameters", "", () => togglePanel("params")),
      btn("Settings", "", () => togglePanel("settings")),
    ),
  );
  const bottombar = h(
    "footer",
    { class: "bottombar overlay" },
    h(
      "div",
      { class: "transport" },
      btn("Previous", "Shift+N", () => step(-1)),
      btn("Next", "N", () => step(1)),
    ),
    status,
    h(
      "div",
      { class: "transport" },
      btn("HUD", "P", () => toggleHud()),
      btn("Full screen", "F", () => send({ type: "window", action: "fullscreen" })),
    ),
  );

  root.classList.add("shell");
  root.replaceChildren(
    stage,
    empty,
    hudEl,
    topbar,
    bottombar,
    panels.library,
    panels.params,
    panels.settings,
    h("div", { class: "toasts overlay-keep" }, errorBox, permission),
    devlog,
    notice,
    install,
  );

  // ---- plugin host ---------------------------------------------------------------------------
  const pluginHost = (deps.createPluginHost ?? createPluginHost)({
    container: stage,
    settings: { quality: settings.quality, reduceFlashing: settings.reduceFlashing, ...qualityProfile(settings.quality, dpr) },
    visible: () => doc.visibilityState !== "hidden",
    onEvent,
  });

  // ---- pointer input: drags on the stage go to the active plugin -----------------------------
  /** @type {{ id: number, x: number, y: number } | null} */
  let drag = null;
  /** @param {PointerEvent} e @param {"down" | "move" | "up"} kind */
  const forward = (e, kind) => {
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const dx = kind === "move" && drag ? x - drag.x : 0, dy = kind === "move" && drag ? y - drag.y : 0;
    if (drag) (drag.x = x), (drag.y = y);
    pluginHost.pointer(kind, x, y, dx, dy);
  };
  stage.addEventListener("pointerdown", (e) => {
    drag = { id: e.pointerId, x: 0, y: 0 };
    stage.setPointerCapture?.(e.pointerId);
    forward(e, "down");
  });
  stage.addEventListener("pointermove", (e) => {
    if (drag && e.pointerId === drag.id) forward(e, "move");
  });
  for (const type of ["pointerup", "pointercancel"]) {
    stage.addEventListener(type, (e) => {
      const pe = /** @type {PointerEvent} */ (e);
      if (!drag || pe.pointerId !== drag.id) return;
      forward(pe, "up");
      drag = null;
    });
  }

  // ---- helpers -------------------------------------------------------------------------------
  /** @param {string} key */
  const find = (key) => visualizers.find((v) => v.key === key);
  const enabled = () => visualizers.filter((v) => !v.disabled);
  /** @param {VizInfo} v */
  const valuesFor = (v) => resolveValues(v.params, values.get(v.key) ?? v.values);

  /** @param {"info" | "warn" | "error"} level @param {string} text */
  function setStatus(level, text) {
    status.textContent = text;
    status.dataset.level = level;
    connectionMessage = false;
  }

  /** @param {string} line */
  function log(line) {
    devlog.append(line + "\n");
    while (devlog.childNodes.length > LOG_LINES) devlog.firstChild?.remove();
    devlog.scrollTop = devlog.scrollHeight;
    if (dev) devlog.hidden = false;
  }

  function renderNow() {
    const v = selected ? find(selected) : undefined;
    nowName.textContent = v ? v.name : "";
    nowRepo.textContent = v ? v.repo : "";
    empty.hidden = visualizers.length > 0;
    if (!empty.hidden) {
      empty.replaceChildren(
        h("h1", {}, "No visualizers yet"),
        h("p", {}, "Add visualizers from a git URL or a local folder."),
        h("button", { type: "button", class: "primary", onclick: () => togglePanel("library") }, "Open Library"),
      );
    }
  }

  function renderLib() {
    renderLibrary(libraryBody, { visualizers, repos, active: selected, updates }, {
      select: (key) => {
        select(key);
        closePanels();
      },
      enable: (key) => send({ type: "enable", key }),
      install: (url) => {
        send({ type: "install", url });
        setStatus("info", "Fetching visualizers…");
      },
      addFolder: () => send({ type: "addFolder" }),
      update: (repo) => send({ type: "update", repo }),
      rollback: (repo) => send({ type: "rollback", repo }),
      remove: (repo) => send({ type: "remove", repo }),
    });
  }

  function renderParamsPanel() {
    const v = selected ? find(selected) : undefined;
    if (!v) {
      paramsBody.replaceChildren(h("p", { class: "muted" }, "No visualizer selected."));
      return;
    }
    renderParams(paramsBody, v.params, valuesFor(v), (all, changed) => {
      values.set(v.key, all);
      send({ type: "params", key: v.key, values: all });
      if (pluginHost.activeKey === v.key || pluginHost.pendingKey === v.key) pluginHost.setParams(changed);
    });
  }

  function renderSources() {
    sourceSel.replaceChildren(...sources.map((s) => h("option", { value: s.id }, s.name)));
    if (activeSource) sourceSel.value = activeSource;
  }

  /** @param {string} id @param {string} label @param {HTMLElement} control */
  const field = (id, label, control) => h("div", { class: "field" }, h("label", { for: id }, label), control);

  function renderSettings() {
    const quality = /** @type {HTMLSelectElement} */ (
      h("select", { id: "quality" }, QUALITY_LABELS.map(([v, l]) => h("option", { value: v }, l)))
    );
    quality.value = settings.quality;
    quality.addEventListener("change", () => setQuality(/** @type {QualityMode} */ (quality.value)));
    const reduce = /** @type {HTMLInputElement} */ (h("input", { id: "reduce-flashing", type: "checkbox", checked: settings.reduceFlashing }));
    reduce.addEventListener("change", () => {
      settings.reduceFlashing = reduce.checked;
      send({ type: "settings", reduceFlashing: reduce.checked });
      pluginHost.setSettings({ reduceFlashing: reduce.checked });
    });
    const cycle = /** @type {HTMLSelectElement} */ (
      h("select", { id: "auto-cycle" }, AUTO_CYCLE_CHOICES.map((s) => h("option", { value: String(s) }, cycleLabel(s))))
    );
    if (!AUTO_CYCLE_CHOICES.includes(settings.autoCycleSeconds)) {
      cycle.append(h("option", { value: String(settings.autoCycleSeconds) }, cycleLabel(settings.autoCycleSeconds)));
    }
    cycle.value = String(settings.autoCycleSeconds);
    cycle.addEventListener("change", () => {
      settings.autoCycleSeconds = Number(cycle.value);
      send({ type: "settings", autoCycleSeconds: settings.autoCycleSeconds });
      armCycle();
    });
    settingsBody.replaceChildren(
      field("quality", "Quality", quality),
      h("p", { class: "hint muted" }, "Balanced caps resolution at 1.5×; Battery at 1× and 30 fps."),
      h("div", { class: "field field-inline" }, h("label", { for: "reduce-flashing" }, "Reduce flashing"), reduce),
      field("auto-cycle", "Auto-cycle", cycle),
      h("h3", { class: "section-title" }, "Window"),
      h(
        "div",
        { class: "button-row" },
        btn("Float on top", "T", () => send({ type: "window", action: "floatOnTop" }), "chip"),
        btn("Borderless", "", () => send({ type: "window", action: "borderless" }), "chip"),
        btn("Full screen", "F", () => send({ type: "window", action: "fullscreen" }), "chip"),
      ),
    );
  }

  /** @param {QualityMode} q */
  function setQuality(q) {
    settings.quality = q;
    send({ type: "settings", quality: q });
    pluginHost.setSettings({ quality: q, ...qualityProfile(q, dpr) });
  }

  function armCycle() {
    clearInterval(cycleTimer);
    cycleTimer = undefined;
    if (settings.autoCycleSeconds > 0) cycleTimer = setInterval(() => step(1), settings.autoCycleSeconds * 1000);
  }

  // ---- selection -----------------------------------------------------------------------------
  /** @param {string} key @param {{ persist?: boolean }} [opts] */
  function select(key, opts = {}) {
    const v = find(key);
    if (!v || v.disabled) return;
    if (key !== selected) {
      if (selected) {
        const i = history.indexOf(selected);
        if (i >= 0) history.splice(i, 1);
        history.push(selected);
      }
      selected = key;
      pluginHost.show(v, valuesFor(v));
      renderNow();
      renderLib();
      renderParamsPanel();
    }
    if (opts.persist !== false) send({ type: "select", key });
  }

  /** @param {number} dir */
  function step(dir) {
    const list = enabled();
    if (list.length === 0) return;
    const i = list.findIndex((v) => v.key === selected);
    const next = list[(i + dir + list.length) % list.length];
    select(next.key);
    armCycle(); // manual steps restart the cycle clock
  }

  /** Pick something to show after `failed` went away. @param {string | null} failed */
  function fallback(failed) {
    for (let i = history.length - 1; i >= 0; i--) {
      const v = find(history[i]);
      history.splice(i, 1);
      if (v && !v.disabled && v.key !== failed) {
        selected = null;
        select(v.key);
        return;
      }
    }
    const first = enabled().find((v) => v.key !== failed);
    selected = null;
    if (first) select(first.key);
    else {
      renderNow();
      renderLib();
      renderParamsPanel();
    }
  }

  // ---- plugin events -------------------------------------------------------------------------
  /** @param {PluginEvent} e */
  function onEvent(e) {
    switch (e.kind) {
      case "ready":
        if (e.key === errorKey) errorBox.hidden = true; // e.g. a hot reload fixed it
        break;
      case "error":
      case "fatal": {
        const { type: _t, ...err } = e.error;
        send({ type: "pluginError", key: e.key, ...err });
        const name = find(e.key)?.name ?? e.key;
        errorText.textContent = `${name} — ${formatError(e.error)}`;
        errorBox.hidden = false;
        errorKey = e.key;
        log(`[${e.key}] ${formatError(e.error)}`);
        if (e.kind === "fatal") {
          if (e.wasActive) fallback(e.key);
          else {
            selected = pluginHost.activeKey;
            if (selected) send({ type: "select", key: selected });
            renderNow();
            renderLib();
            renderParamsPanel();
          }
        }
        break;
      }
      case "perf": {
        const shell = pluginHost.shellStats();
        hud.setPerf(e.perf);
        hud.setShellMs(shell.p50);
        const p = e.perf;
        send({
          type: "perf",
          key: e.key,
          fps: p.fps,
          frameMsP50: p.frameMsP50,
          frameMsP99: p.frameMsP99,
          pluginMsP50: p.pluginMsP50,
          shellMs: shell.p50,
          renderScale: p.renderScale,
          dropped: p.dropped,
        });
        break;
      }
      case "onsetSeen":
        send({ type: "onsetSeen", frameIndex: e.frameIndex });
        break;
      case "log":
        log(`[${e.key}] ${e.text}`);
        break;
      case "contextLost":
        log(`[${e.key}] graphics context lost; restarting`);
        break;
    }
  }

  // ---- panels, dialogs, keys -----------------------------------------------------------------
  const modalOpen = () => !notice.hidden || !install.hidden;

  /** @param {PanelName} name */
  function togglePanel(name) {
    if (openPanel === name) {
      closePanels();
      return;
    }
    if (!openPanel) returnFocus = doc.activeElement;
    for (const [n, el] of Object.entries(panels)) el.hidden = n !== name;
    openPanel = name;
    root.classList.add("panel-open");
    idle.poke();
    const target = /** @type {HTMLElement | null} */ (panels[name].querySelector("input, select, button:not(.close)") ?? panels[name].querySelector("button"));
    target?.focus();
  }

  function closePanels() {
    const focused = doc.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".panel")) focused.blur();
    for (const el of Object.values(panels)) el.hidden = true;
    if (openPanel && returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    openPanel = null;
    returnFocus = null;
    root.classList.remove("panel-open");
  }

  function dismissNotice() {
    notice.hidden = true;
    send({ type: "settings", photosensitivityNoticeSeen: true });
  }

  /** @param {boolean} accept */
  function answerInstall(accept) {
    if (installId === null) return;
    send({ type: "installConfirm", id: installId, accept });
    installId = null;
    install.hidden = true;
  }

  function toggleHud() {
    settings.hudVisible = !hud.visible;
    hud.setVisible(settings.hudVisible);
    send({ type: "settings", hudVisible: settings.hudVisible });
  }

  function applyOverlayClasses() {
    root.classList.toggle("overlays-hidden", overlaysHidden);
  }

  /** @param {KeyboardEvent} ev */
  function onKey(ev) {
    const action = keyAction(ev);
    if (!action) return;
    if (action === "escape") {
      if (!install.hidden) answerInstall(false);
      else if (!notice.hidden) dismissNotice();
      else if (openPanel) closePanels();
      else if (overlaysHidden) {
        overlaysHidden = false;
        applyOverlayClasses();
      } else return;
      ev.preventDefault();
      return;
    }
    if (modalOpen() || ev.repeat) return;
    ev.preventDefault();
    switch (action) {
      case "next":
        step(1);
        break;
      case "prev":
        step(-1);
        break;
      case "fullscreen":
        send({ type: "window", action: "fullscreen" });
        break;
      case "floatOnTop":
        send({ type: "window", action: "floatOnTop" });
        break;
      case "hideOverlays":
        overlaysHidden = !overlaysHidden;
        if (overlaysHidden) closePanels();
        applyOverlayClasses();
        break;
      case "library":
        togglePanel("library");
        break;
      case "hud":
        toggleHud();
        break;
    }
  }

  doc.addEventListener("keydown", onKey);
  doc.addEventListener("visibilitychange", () => pluginHost.setVisible(doc.visibilityState !== "hidden"));
  sourceSel.addEventListener("change", () => {
    activeSource = sourceSel.value;
    send({ type: "setSource", id: sourceSel.value });
  });

  const idle = createIdle(doc, {
    timeoutMs: IDLE_MS,
    onChange: (v) => root.classList.toggle("idle", v),
    hold: () => openPanel !== null || modalOpen() || (doc.activeElement !== null && doc.activeElement !== doc.body && root.contains(doc.activeElement) && !stage.contains(doc.activeElement) && doc.activeElement.closest(".panel") !== null),
  });

  renderSettings();
  renderNow();
  renderParamsPanel();
  renderLib();

  // ---- host messages -------------------------------------------------------------------------
  /** @param {HostMessage} msg */
  function handle(msg) {
    switch (msg.type) {
      case "hello": {
        visualizers = msg.visualizers;
        repos = msg.repos;
        sources = msg.sources;
        activeSource = msg.activeSource;
        dev = msg.dev;
        for (const v of visualizers) if (!values.has(v.key)) values.set(v.key, v.values);
        Object.assign(settings, msg.settings);
        pluginHost.setSettings({ quality: settings.quality, reduceFlashing: settings.reduceFlashing, ...qualityProfile(settings.quality, dpr) });
        hud.setVisible(settings.hudVisible);
        renderSettings();
        renderSources();
        armCycle();
        if (msg.settings.photosensitivityNoticeSeen !== true) {
          notice.hidden = false;
          noticeOk.focus();
        }
        if (connectionMessage) setStatus("info", "");
        const want = msg.active ? find(msg.active) : undefined;
        if (selected && find(selected) && !find(selected)?.disabled) {
          renderNow();
          renderLib();
          renderParamsPanel();
        } else if (want && !want.disabled) select(want.key, { persist: false });
        else fallback(null);
        break;
      }
      case "visualizers": {
        visualizers = msg.visualizers;
        repos = msg.repos;
        for (const v of visualizers) if (!values.has(v.key)) values.set(v.key, v.values);
        const cur = selected ? find(selected) : undefined;
        if (selected && (!cur || cur.disabled)) fallback(selected);
        else if (!selected) fallback(null);
        else {
          renderNow();
          renderLib();
          renderParamsPanel();
        }
        break;
      }
      case "reload": {
        const v = find(msg.key);
        if (v && msg.key === selected) pluginHost.reload(v, valuesFor(v));
        break;
      }
      case "manifestError":
        setStatus("error", `${msg.repo}: invalid manifest — ${msg.errors.map((e) => `${e.path} ${e.message}`.trim()).join("; ")}`);
        for (const e of msg.errors) log(`[${msg.repo}] manifest ${e.path}: ${e.message}`);
        break;
      case "sources":
        sources = msg.sources;
        activeSource = msg.active;
        renderSources();
        break;
      case "status":
        setStatus(msg.level, msg.text);
        break;
      case "silence":
        permission.hidden = !msg.silent;
        break;
      case "stats":
        hud.setStats(msg);
        break;
      case "installPrompt":
        installId = msg.id;
        installBody.replaceChildren(
          h("dl", { class: "facts" }, h("dt", {}, "From"), h("dd", { class: "mono" }, msg.url), h("dt", {}, "Commit"), h("dd", { class: "mono" }, msg.commit.slice(0, 7))),
          msg.visualizers.length
            ? h("ul", { class: "install-list" }, msg.visualizers.map((v) => h("li", {}, v.name)))
            : h("p", { class: "muted" }, "No visualizers found in this repository."),
        );
        install.hidden = false;
        installOk.focus();
        break;
      case "installResult":
        if (msg.ok) setStatus("info", "Visualizers installed.");
        else setStatus("error", `Install failed: ${msg.error ?? "unknown error"}`);
        break;
      case "updates":
        updates.clear();
        for (const r of msg.repos) updates.set(r.repo, { commit: r.commit, message: r.message });
        renderLib();
        break;
      case "disabled": {
        const v = find(msg.key);
        visualizers = visualizers.map((x) => (x.key === msg.key ? { ...x, disabled: true } : x));
        const name = v?.name ?? msg.key;
        setStatus("warn", `${name} was disabled: ${msg.reason}`);
        if (msg.key === selected) fallback(msg.key);
        else renderLib();
        break;
      }
    }
  }

  return {
    handle,
    /** Hot path: a binary frame from the socket. @param {ArrayBuffer} buf */
    frame: (/** @type {ArrayBuffer} */ buf) => pluginHost.frame(buf),
    select,
    pluginHost,
    get selected() {
      return selected;
    },
    /** @param {import("./connection.js").ConnState} state */
    setConnection(state) {
      if (state === "open") {
        if (connectionMessage) setStatus("info", "");
      } else if (!status.textContent || connectionMessage) {
        setStatus("info", CONNECTING);
        connectionMessage = true;
      }
    },
  };
}
