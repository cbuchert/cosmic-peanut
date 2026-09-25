// Overlay auto-hide: idle after `timeoutMs` without pointer or keyboard activity, unless held
// (a panel or dialog is open).

/**
 * @param {Document} doc
 * @param {{ timeoutMs: number; onChange: (idle: boolean) => void; hold: () => boolean }} opts
 */
export function createIdle(doc, opts) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const state = {
    idle: false,
    /** Mark activity (also called by the app after programmatic UI changes). */
    poke,
  };

  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (opts.hold()) arm();
      else set(true);
    }, opts.timeoutMs);
  }

  /** @param {boolean} v */
  function set(v) {
    if (state.idle === v) return;
    state.idle = v;
    opts.onChange(v);
  }

  function poke() {
    set(false);
    arm();
  }

  for (const t of ["mousemove", "pointerdown", "keydown", "wheel", "focusin"]) {
    doc.addEventListener(t, poke, { passive: true });
  }
  arm();
  return state;
}
