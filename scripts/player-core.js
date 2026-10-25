/**
 * Log player core (PLAN §8.3): replays serialized chat messages (chat-tools archive JSON or an
 * exported log.json) on the novel stage, with play/pause, step, seek, speed and a message list.
 *
 * PURE MODULE: imports only the stage reducer and renderer; no Foundry globals (game, foundry, ui,
 * Hooks, CONFIG). The world player (log-player.js) and the exported player page share it; for the
 * page, archive-ext.js inlines these three files as classic scripts, so keep the imports exactly
 * `import * as StageState …` / `import * as StageDOM …`.
 */
import * as StageState from "./stage-state.js";
import * as StageDOM from "./stage-dom.js";

export const PLAYER_VERSION = 1;

const STYLE = { OTHER: 0, OOC: 1, IC: 2, EMOTE: 3 };
const SPEEDS = [0.5, 1, 1.5, 2, 3];
const SNAPSHOT_EVERY = 25;

/* -------------------------------------------- */
/*  Serialized message → stage entry            */
/* -------------------------------------------- */

/** Category of a serialized message: from `vn` when the visual-novel module recorded it, else derived. */
export function categoryOf(m) {
  if (m.vn?.category) return m.vn.category;
  if (m.chitchat) return "chitchat";
  if (m.isRoll) return "roll";
  if (m.style === STYLE.OOC) return "ooc";
  if (m.actor || m.token) return m.style === STYLE.EMOTE ? "emote" : "speech";
  return "narration";
}

/**
 * Reducer kind under the viewer's preferences.
 * @param {object} prefs  { oocMode: "gmNarration"|"narration"|"ignore", rollMode: "ignore"|"narration", isGM?(userId) }
 */
export function kindFor(m, category, prefs = {}) {
  switch (category) {
    case "speech":
    case "emote":
      return "speech";
    case "narration":
      return "narration";
    case "scene":
      return "scene";
    case "roll":
      return prefs.rollMode === "narration" ? "narration" : "ignore";
    case "ooc": {
      const mode = prefs.oocMode ?? "gmNarration";
      if (mode === "narration") return "narration";
      if (mode === "ignore") return "ignore";
      const gm = m.vn?.authorGM ?? prefs.isGM?.(m.userId);
      if (gm === undefined || gm === null) return m.vn?.kind === "narration" ? "narration" : "ignore";
      return gm ? "narration" : "ignore";
    }
    default:
      return "ignore";
  }
}

function plainText(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll(".dice-tooltip, script, style").forEach((e) => e.remove());
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
}

function stripTooltips(html) {
  if (!html || !/dice-tooltip/.test(html)) return html ?? "";
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll(".dice-tooltip").forEach((e) => e.remove());
  return div.innerHTML;
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Convert one serialized message into a reducer entry (plus `text`, `user`, `marker` for the UI).
 * Messages from archives made before the visual-novel module use the card portrait as their stand.
 */
export function entryFromSerialized(m, prefs = {}) {
  const vn = m.vn ?? null;
  const category = categoryOf(m);
  const kind = kindFor(m, category, prefs);
  const speech = category === "speech" || category === "emote";
  let html;
  if (category === "scene") html = "";
  else if (category === "roll") {
    const totals = (m.rolls ?? []).map((r) => `<strong class="gvn-roll-total">${escapeHtml(r.total)}</strong>`).join(" ");
    html = `${m.flavor ? `<span class="gvn-roll-flavor">${m.flavor}</span> ` : ""}${totals}`;
  } else html = stripTooltips(m.html || m.content || "");
  let name;
  if (category === "scene") name = null;
  else if (speech || category === "roll") name = vn?.name ?? m.alias ?? "";
  else if (vn) name = vn.name ?? null;
  else name = m.alias && m.alias !== m.user ? m.alias : null;
  const key = vn?.key ?? (m.actor ? `Actor.${m.actor}` : m.token ? `Token..${m.token}` : null);
  return {
    id: m.id,
    timestamp: m.timestamp,
    kind,
    category,
    key: speech ? key : null,
    name,
    stand: speech ? vn?.expression?.stand ?? (vn ? null : m.img ?? null) : null,
    face: speech ? vn?.expression?.face ?? m.img ?? null : null,
    emote: category === "emote",
    standStyle: vn?.standStyle ?? null,
    refs: Array.isArray(vn?.refs) ? vn.refs : [],
    html,
    text: plainText(html),
    user: m.user ?? "",
    marker: m.sessionMarker ?? null,
    // Editor-only fields (see player-editor.js): absent = unchanged.
    background: vn && "background" in vn ? vn.background ?? null : undefined,
    clearStands: !!vn?.clearStands,
  };
}

/** Entries that change the stage, in order. */
export function buildEntries(messages, prefs = {}) {
  return messages
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .map((m) => entryFromSerialized(m, prefs))
    .filter((e) => e.kind !== "ignore");
}

/* -------------------------------------------- */
/*  Player                                      */
/* -------------------------------------------- */

const DEFAULT_LABELS = {
  first: "First",
  prev: "Previous",
  play: "Play",
  pause: "Pause",
  next: "Next",
  last: "Last",
  speed: "Speed",
  list: "Messages",
  close: "Close",
  empty: "Nothing to play.",
  narration: "Narration",
  scene: "Scene",
  locked: "",
};

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Attach a player to a stage root built with StageDOM.buildStage.
 * @param {HTMLElement} root
 * @param {object[]} messages  Serialized messages (any order).
 * @param {object} [opts]
 * @param {object} [opts.prefs]          See kindFor.
 * @param {number} [opts.maxSlots=6]
 * @param {number[]} [opts.slotOrder]
 * @param {object} [opts.render]         Base StageDOM.render options (resolveUrl, canViewRef, onRefClick, layout, showRef, labels).
 * @param {number} [opts.typewriter=30]  ms per character at 1× (0 = instant).
 * @param {object} [opts.labels]
 * @param {string} [opts.title]
 * @param {boolean} [opts.keyboard=false]  Space / ← / → / Home / End.
 * @param {boolean} [opts.autoplay=false]
 * @param {number} [opts.start=0]
 * @param {Function} [opts.onClose]      Shows a close button when set.
 * @param {Function} [opts.formatTime]
 * @param {Function} [opts.onIndex]      Called with (index, entry) after every step.
 */
export function createPlayer(root, messages, opts = {}) {
  const doc = root.ownerDocument;
  const labels = { ...DEFAULT_LABELS, ...(opts.labels ?? {}) };
  const maxSlots = opts.maxSlots ?? StageState.MAX_SLOTS;
  const reducerOpts = { maxSlots, slotOrder: opts.slotOrder?.length ? opts.slotOrder : StageState.centerOutOrder(maxSlots) };
  let entries = buildEntries(messages, opts.prefs);
  const snapshots = new Map([[-1, StageState.createState(maxSlots)]]);
  const fmt = opts.formatTime ?? ((ts) => (ts ? new Date(ts).toLocaleString() : ""));
  const indexListeners = new Set();
  let index = -1;
  let playing = false;
  let speed = 1;
  let timer = null;
  let destroyed = false;

  /* ---------- state ---------- */

  function stateAt(i) {
    if (i < 0) return snapshots.get(-1);
    let from = -1;
    for (const k of snapshots.keys()) if (k <= i && k > from) from = k;
    let s = snapshots.get(from);
    for (let j = from + 1; j <= i; j++) {
      s = StageState.apply(s, entries[j], reducerOpts);
      if ((j + 1) % SNAPSHOT_EVERY === 0 && !snapshots.has(j)) snapshots.set(j, s);
    }
    return s;
  }

  function render(animate) {
    const tw = animate && opts.typewriter !== 0 ? (opts.typewriter ?? 30) / speed : 0;
    StageDOM.render(root, stateAt(index), {
      ...(opts.render ?? {}),
      animate,
      typewriter: tw,
      onAction: (action) => {
        if (action === "close") close();
      },
    });
    updateBar();
    opts.onIndex?.(index, entries[index] ?? null);
    for (const fn of indexListeners) fn(index, entries[index] ?? null);
  }

  /**
   * Replace the messages (log editor): entries and snapshots are rebuilt and the stage re-rendered at
   * the entry of `focusId`, or at the same position when that message is gone or not shown.
   */
  function reload(newMessages, { focusId = null, animate = false } = {}) {
    if (destroyed) return;
    const wasPlaying = playing;
    pause();
    entries = buildEntries(newMessages, opts.prefs);
    snapshots.clear();
    snapshots.set(-1, StageState.createState(maxSlots));
    slider.max = String(Math.max(0, entries.length - 1));
    list.innerHTML = "";
    if (!list.hidden) fillList();
    root.querySelector(".gvn-player-empty")?.remove();
    if (!entries.length) {
      index = -1;
      render(false);
      root.append(el(doc, "div", "gvn-player-empty", labels.empty));
      return;
    }
    let i = focusId != null ? entries.findIndex((e) => e.id === focusId) : -1;
    if (i < 0) i = Math.min(Math.max(0, index), entries.length - 1);
    go(i, animate);
    if (wasPlaying) play();
  }

  function holdMs(entry) {
    const len = entry?.text?.length ?? 0;
    const typing = opts.typewriter === 0 ? 0 : len * (opts.typewriter ?? 30);
    return (typing + Math.min(8000, Math.max(1600, 900 + len * 55))) / speed;
  }

  function schedule() {
    clearTimeout(timer);
    if (!playing || destroyed) return;
    if (index >= entries.length - 1) return pause();
    timer = setTimeout(() => {
      if (!playing || destroyed) return;
      go(index + 1, true);
      schedule();
    }, holdMs(entries[index]));
  }

  function go(i, animate = false) {
    if (!entries.length) return;
    index = Math.max(0, Math.min(entries.length - 1, i));
    render(animate);
  }

  /* ---------- controls ---------- */

  function play() {
    if (!entries.length) return;
    if (index >= entries.length - 1) go(0, true);
    playing = true;
    updateBar();
    schedule();
  }
  function pause() {
    playing = false;
    clearTimeout(timer);
    updateBar();
  }
  function toggle() {
    playing ? pause() : play();
  }
  function next() {
    if (StageDOM.isTyping(root)) return StageDOM.finishTyping(root);
    go(index + 1, true);
    if (playing) schedule();
  }
  function prev() {
    go(index - 1, false);
    if (playing) schedule();
  }
  function seek(i) {
    go(i, false);
    if (playing) schedule();
  }
  function setSpeed(v) {
    speed = Number(v) || 1;
    updateBar();
    if (playing) schedule();
  }

  /* ---------- UI ---------- */

  const bar = el(doc, "div", "gvn-player-bar");
  const btn = (cls, glyph, title, fn) => {
    const b = el(doc, "button", `gvn-pb gvn-pb-${cls}`, glyph);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      fn();
    });
    return b;
  };
  const title = el(doc, "span", "gvn-pb-title", opts.title ?? "");
  const bFirst = btn("first", "⏮", labels.first, () => seek(0));
  const bPrev = btn("prev", "◀", labels.prev, prev);
  const bPlay = btn("play", "▶", labels.play, toggle);
  const bNext = btn("next", "▶|", labels.next, next);
  const bLast = btn("last", "⏭", labels.last, () => seek(entries.length - 1));
  const slider = el(doc, "input", "gvn-pb-seek");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(Math.max(0, entries.length - 1));
  slider.step = "1";
  slider.addEventListener("input", () => seek(Number(slider.value)));
  const counter = el(doc, "span", "gvn-pb-count");
  const time = el(doc, "span", "gvn-pb-time");
  const speedSel = el(doc, "select", "gvn-pb-speed");
  speedSel.title = labels.speed;
  for (const s of SPEEDS) {
    const o = el(doc, "option", null, `${s}×`);
    o.value = String(s);
    o.selected = s === 1;
    speedSel.append(o);
  }
  speedSel.addEventListener("change", () => setSpeed(speedSel.value));
  const bList = btn("list", "☰", labels.list, () => toggleList());
  bar.append(title, bFirst, bPrev, bPlay, bNext, bLast, slider, counter, time, speedSel, bList);
  if (opts.onClose) bar.append(btn("close", "✕", labels.close, () => close()));
  for (const e of [bar, slider, speedSel]) {
    e.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    e.addEventListener("keydown", (ev) => ev.stopPropagation());
  }

  const list = el(doc, "ol", "gvn-player-list");
  list.hidden = true;
  list.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-index]");
    if (li) seek(Number(li.dataset.index));
  });

  function fillList() {
    list.innerHTML = "";
    entries.forEach((e, i) => {
      const li = el(doc, "li", `gvn-pl-item${e.marker ? " marker" : ""}`);
      li.dataset.index = String(i);
      const who = el(doc, "span", "gvn-pl-name", e.marker ? "⚑" : e.kind === "scene" ? labels.scene : e.name || labels.narration);
      const text = el(doc, "span", "gvn-pl-text", e.text.length > 80 ? `${e.text.slice(0, 80)}…` : e.text);
      li.append(who, text);
      list.append(li);
    });
    markList();
  }

  function markList() {
    if (list.hidden) return;
    list.querySelector(".current")?.classList.remove("current");
    const cur = list.querySelector(`li[data-index="${index}"]`);
    if (cur) {
      cur.classList.add("current");
      cur.scrollIntoView({ block: "nearest" });
    }
  }

  function toggleList(force) {
    list.hidden = force === undefined ? !list.hidden : !force;
    bList.classList.toggle("active", !list.hidden);
    if (!list.hidden && !list.childElementCount) fillList();
    markList();
  }

  function updateBar() {
    bPlay.textContent = playing ? "❚❚" : "▶";
    bPlay.title = playing ? labels.pause : labels.play;
    slider.value = String(Math.max(0, index));
    counter.textContent = entries.length ? `${index + 1} / ${entries.length}` : "0 / 0";
    time.textContent = fmt(entries[index]?.timestamp);
    for (const b of [bFirst, bPrev]) b.disabled = index <= 0;
    for (const b of [bNext, bLast]) b.disabled = index >= entries.length - 1;
    markList();
  }

  // Clicking the dialogue advances (the stage renderer itself finishes a line being typed).
  const onRootClick = (ev) => {
    if (!ev.target.closest(".gvn-text") || ev.target.closest("a")) return;
    if (StageDOM.isTyping(root)) return;
    ev.stopPropagation();
    next();
  };
  root.addEventListener("click", onRootClick, true);

  const onKey = (ev) => {
    if (ev.target?.closest?.("input, select, textarea, [contenteditable], .gvn-editor, .gvn-modal")) return;
    const map = { " ": toggle, ArrowRight: next, Enter: next, ArrowLeft: prev, Home: () => seek(0), End: () => seek(entries.length - 1) };
    const fn = map[ev.key];
    if (!fn) return;
    ev.preventDefault();
    fn();
  };
  if (opts.keyboard) doc.addEventListener("keydown", onKey);

  root.classList.add("gvn-playing");
  root.append(bar, list);

  if (!entries.length) {
    const empty = el(doc, "div", "gvn-player-empty", labels.empty);
    root.append(empty);
  }

  function close() {
    destroy();
    opts.onClose?.();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(timer);
    root.removeEventListener("click", onRootClick, true);
    if (opts.keyboard) doc.removeEventListener("keydown", onKey);
    bar.remove();
    list.remove();
    root.querySelector(".gvn-player-empty")?.remove();
    root.classList.remove("gvn-playing");
  }

  if (entries.length) {
    go(Math.min(opts.start ?? 0, entries.length - 1), false);
    if (opts.autoplay) play();
  } else updateBar();

  return {
    get index() {
      return index;
    },
    get length() {
      return entries.length;
    },
    get playing() {
      return playing;
    },
    get entries() {
      return entries;
    },
    root,
    bar,
    prefs: opts.prefs ?? {},
    stateAt,
    reload,
    /** Subscribe to position changes; returns an unsubscribe function. */
    onIndex(fn) {
      indexListeners.add(fn);
      return () => indexListeners.delete(fn);
    },
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    setSpeed,
    toggleList,
    close,
    destroy,
  };
}

/* -------------------------------------------- */
/*  Exported page bootstrap                     */
/* -------------------------------------------- */

/**
 * Start the player on a standalone page (exported bundle). Images and reference pages are bundle
 * relative, so they work from file:// as well.
 * @param {object} config  { log, labels, prefs, typewriter, layout, title, dimStyle, standHeight, dialogueOpacity, fontSize }
 */
export function startLocal(config) {
  const doc = document;
  const log = config.log ?? {};
  const header = log.vn ?? {};
  const root = StageDOM.buildStage(doc, { id: "gvn-stage", glyphs: true, labels: config.labels ?? {} });
  (doc.getElementById("gvn-app") ?? doc.body).append(root);
  root.classList.add(`gvn-dim-${config.dimStyle ?? "grayscale"}`);
  if (config.standHeight) root.style.setProperty("--gvn-stand-height", String(config.standHeight));
  if (config.dialogueOpacity) root.style.setProperty("--gvn-dialogue-opacity", String(config.dialogueOpacity));
  if (config.fontSize) root.style.setProperty("--gvn-font-size", `${config.fontSize}px`);
  // "player.html#12" opens at the 12th line; the hash follows the position so it can be bookmarked.
  const fromHash = parseInt(String(window.location.hash).slice(1), 10);
  return createPlayer(root, log.messages ?? [], {
    start: Number.isFinite(fromHash) && fromHash > 0 ? fromHash - 1 : 0,
    onIndex: (i) => {
      if (i < 0) return;
      try {
        history.replaceState(null, "", `#${i + 1}`);
      } catch {
        /* sandboxed / srcdoc documents refuse hash updates */
      }
    },
    prefs: config.prefs ?? {},
    maxSlots: header.maxSlots,
    slotOrder: header.slotOrder,
    typewriter: config.typewriter ?? 30,
    labels: config.labels,
    title: config.title ?? log.title ?? "",
    keyboard: true,
    render: {
      resolveUrl: (p) => p,
      layout: config.layout ?? "spread",
      showRef: true,
      canViewRef: () => true,
      onRefClick: (ref) => {
        if (ref.href) window.open(ref.href, "_blank", "noopener");
      },
      labels: { locked: config.labels?.locked ?? "" },
    },
  });
}
