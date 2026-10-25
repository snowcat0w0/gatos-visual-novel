import { MODULE_ID, L, mod } from "./constants.js";
import { addChatControl, debounce, onChatUiRender } from "./lib.js";
import { setting, display } from "./settings.js";
import { mountPoint, ContextMenu } from "./compat.js";
import * as StageState from "./stage-state.js";
import * as StageDOM from "./stage-dom.js";
import { createPlayer } from "./player-core.js";
import { describe, toEntry, dialogueHtml } from "./entries.js";
import { canViewRef, openRef } from "./links.js";
import { broadcastStage, broadcastRemove, clearAll } from "./socket.js";
import { openKeywordManager } from "./keyword-manager.js";
import { openLogPlayer } from "./log-player.js";

let root = null;
let state = StageState.createState(StageState.MAX_SLOTS);
let queue = Promise.resolve();
let resizeObserver = null;
let idleTimer = null;
let ready = false;

const maxSlots = () => setting("maxSlots");
const reducerOpts = () => ({ maxSlots: maxSlots(), slotOrder: StageState.centerOutOrder(maxSlots()) });

/** Run stage updates strictly in order (message HTML is rendered asynchronously). */
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => mod.error("stage update failed", err));
  return queue;
}

/* -------------------------------------------- */
/*  Mounting & layout                           */
/* -------------------------------------------- */

function measure() {
  if (!root?.isConnected) return;
  const host = root.parentElement.getBoundingClientRect();
  const sidebar = document.getElementById("sidebar")?.getBoundingClientRect();
  const hotbar = document.getElementById("hotbar")?.getBoundingClientRect();
  const right = sidebar?.width ? Math.max(0, host.right - sidebar.left) : 0;
  const bottom = hotbar?.height ? Math.max(0, host.bottom - hotbar.top) : 0;
  root.style.setProperty("--gvn-inset-right", `${Math.round(right)}px`);
  root.style.setProperty("--gvn-inset-bottom", `${Math.round(bottom)}px`);
}

function observeLayout() {
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => measure());
  for (const id of ["sidebar", "hotbar", "interface"]) {
    const el = document.getElementById(id);
    if (el) resizeObserver.observe(el);
  }
  measure();
}

/** Create the stage element (once) inside the main window's interface layer. */
export function mountStage() {
  if (root?.isConnected) {
    observeLayout();
    return root;
  }
  const { parent } = mountPoint();
  const tools = [];
  if (game.user.isGM) tools.push({ action: "clear", icon: "fa-solid fa-broom", title: L("Stage.ClearAll") });
  tools.push({ action: "close", icon: "fa-solid fa-xmark", title: L("Stage.Close") });
  root = StageDOM.buildStage(document, { id: "gvn-stage", tools, labels: { collapse: L("Stage.Collapse"), expand: L("Stage.Expand") } });
  // The dialogue shows a copy of the chat HTML without its listeners: route reference links through
  // our permission check before Foundry's body-level content-link handler sees the click.
  root.querySelector(".gvn-text").addEventListener(
    "click",
    (ev) => {
      const a = ev.target.closest("a.content-link[data-uuid]");
      // The state on screen: the live one, or the playback's.
      const ref = a && root._gvn?.state?.ref?.refs?.find((r) => r.uuid === a.dataset.uuid);
      if (!ref) return;
      ev.preventDefault();
      ev.stopPropagation();
      openRef(ref);
    },
    { capture: true }
  );
  parent.prepend(root);
  observeLayout();
  applyDisplaySettings();
  applyEnabled();
  return root;
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

const resolveUrl = (path) => path;

function onAction(action) {
  if (action === "close") {
    if (!canToggle()) return ui.notifications.warn(L("Stage.ToggleLocked"));
    return game.settings.set(MODULE_ID, "stageEnabled", false);
  }
  if (action === "clear") return clearAll();
}

function renderOpts(animate) {
  return {
    resolveUrl,
    typewriter: display("typewriterMs"),
    animate,
    layout: display("standLayout"),
    showRef: setting("showRefInStage"),
    canViewRef,
    onRefClick: (ref) => openRef(ref),
    onAction,
    onStandContext: (key) => {
      if (game.user.isGM && document.body.classList.contains("gvn-alt")) broadcastRemove(key);
    },
    labels: { locked: L("Link.Locked") },
  };
}

function draw({ animate = true } = {}) {
  // While a log is playing the stage shows the playback; the live state keeps updating underneath.
  if (!root || playback) return;
  StageDOM.render(root, state, renderOpts(animate && !root.hidden));
}

/* -------------------------------------------- */
/*  Playback mode (log player)                  */
/* -------------------------------------------- */

let playback = null;

export const isPlaying = () => !!playback;

/**
 * Switch the stage to replaying serialized messages. Shown even when the live stage is off.
 * @param {object[]} messages
 * @param {object} [opts]  createPlayer options (title, prefs, start, autoplay …)
 */
export function enterPlayback(messages, opts = {}) {
  mountStage();
  playback?.destroy();
  root.hidden = false;
  measure();
  playback = createPlayer(root, messages, {
    maxSlots: maxSlots(),
    typewriter: display("typewriterMs") || 30,
    labels: playerLabels(),
    formatTime: (ts) => (ts ? new Date(ts).toLocaleString(game.i18n.lang) : ""),
    render: { ...renderOpts(true), animate: undefined },
    ...opts,
    prefs: { oocMode: setting("oocMode"), rollMode: setting("rollMode"), isGM: (id) => game.users.get(id)?.isGM, ...(opts.prefs ?? {}) },
    onClose: () => exitPlayback(),
  });
  Hooks.callAll("gvnPlaybackStarted", playback);
  return playback;
}

/** Leave playback and show the live stage again. */
export function exitPlayback() {
  if (!playback) return;
  const p = playback;
  playback = null;
  p.destroy();
  draw({ animate: false });
  applyEnabled();
  Hooks.callAll("gvnPlaybackEnded", p);
}

export const getPlayback = () => playback;

function playerLabels() {
  const keys = ["First", "Prev", "Play", "Pause", "Next", "Last", "Speed", "List", "Close", "Empty", "Narration"];
  const out = Object.fromEntries(keys.map((k) => [k.charAt(0).toLowerCase() + k.slice(1), L(`Player.${k}`)]));
  out.locked = L("Link.Locked");
  return out;
}

/** Apply the CSS-level display preferences. */
export function applyDisplaySettings() {
  if (!root) return;
  root.style.setProperty("--gvn-stand-height", String(display("standHeight")));
  root.style.setProperty("--gvn-dialogue-opacity", String(display("dialogueOpacity")));
  root.style.setProperty("--gvn-font-size", `${display("dialogueFontSize")}px`);
  for (const s of ["grayscale", "darken", "none"]) root.classList.toggle(`gvn-dim-${s}`, display("dimStyle") === s);
  root.classList.toggle("gvn-no-toggle", !canToggle());
  draw({ animate: false });
}

/* -------------------------------------------- */
/*  Visibility                                  */
/* -------------------------------------------- */

export const canToggle = () => game.user.isGM || setting("playersCanToggle");
const combatHides = () => setting("hideInCombat") && !!game.combat?.started;

export function isShown() {
  return !!setting("stageEnabled") && !combatHides();
}

/** Show / hide the stage according to the settings; state keeps updating while hidden. */
export function applyEnabled() {
  refreshToggleButtons();
  if (!root) return;
  const show = isShown() || !!playback;
  const wasHidden = root.hidden;
  root.hidden = !show;
  if (show && wasHidden) {
    measure();
    draw({ animate: false });
  }
}

export async function enable() {
  await game.settings.set(MODULE_ID, "stageEnabled", true);
}
export async function disable() {
  await game.settings.set(MODULE_ID, "stageEnabled", false);
}
export async function toggle() {
  if (!canToggle()) return ui.notifications.warn(L("Stage.ToggleLocked"));
  await game.settings.set(MODULE_ID, "stageEnabled", !setting("stageEnabled"));
}

/* -------------------------------------------- */
/*  State changes                               */
/* -------------------------------------------- */

function commit(next, entry = null, { animate = true } = {}) {
  if (next === state) return;
  state = next;
  draw({ animate });
  Hooks.callAll("gvnStageChanged", state, entry);
}

/** Rebuild shortly (coalesces bursts such as chat-tools' message moves, which update two messages). gatos-lib debounce. */
const scheduleRebuild = debounce(() => rebuild(), 300);

/** Newest message timestamp the stage has applied (to spot messages inserted into the past). */
let lastTs = 0;

/** createChatMessage hook (every client). */
export function onCreateChatMessage(message, options) {
  if (!ready || !message.visible) return;
  // A message created into the past (chat-tools "duplicate") belongs earlier in the story: rebuild.
  // (A minute of slack: timestamps come from each author's clock, which may lag a little.)
  if (options?.gctDuplicate || message.timestamp < lastTs - 60000) return scheduleRebuild();
  lastTs = Math.max(lastTs, message.timestamp);
  enqueue(async () => {
    const entry = await toEntry(message);
    if (entry.kind === "ignore") return;
    commit(StageState.apply(state, entry, reducerOpts()), entry);
  });
}

/** updateChatMessage hook: keep the dialogue in sync with edits. */
export function onUpdateChatMessage(message, changes) {
  if (!ready) return;
  // chat-tools reorders messages by changing timestamps.
  if ("timestamp" in changes) return scheduleRebuild();
  if (state.dialogue?.messageId !== message.id) return;
  if (!("content" in changes) && !("speaker" in changes) && !("flavor" in changes)) return;
  enqueue(async () => {
    const entry = describe(message);
    const html = await dialogueHtml(message);
    const patch = { html };
    if (entry.name !== undefined) patch.name = entry.name;
    commit(StageState.patchDialogue(state, message.id, patch), null, { animate: false });
  });
}

/** deleteChatMessage hook. */
export function onDeleteChatMessage(message) {
  if (!ready) return;
  enqueue(() => commit(StageState.dropMessage(state, message.id), null, { animate: false }));
}

/**
 * Rebuild the stage from the recent chat log (after a reload, for late joiners, when settings change).
 * Messages older than the GM's last "clear all" are ignored.
 */
export function rebuild() {
  if (!ready) return Promise.resolve();
  return enqueue(async () => {
    const clearedAt = setting("stageClearedAt") || 0;
    const count = setting("rebuildCount");
    const sorted = game.messages.contents.filter((m) => m.timestamp > clearedAt).sort((a, b) => a.timestamp - b.timestamp);
    lastTs = Math.max(0, ...game.messages.contents.map((m) => m.timestamp));
    const messages = count > 0 ? sorted.slice(-count) : [];
    let next = StageState.createState(maxSlots());
    const opts = reducerOpts();
    for (const m of messages) next = StageState.apply(next, describe(m), opts);
    next = pruneIdle(next);
    const id = next.dialogue?.messageId;
    const msg = id ? game.messages.get(id) : null;
    if (msg) next = StageState.patchDialogue(next, id, { html: await dialogueHtml(msg) });
    state = next;
    draw({ animate: false });
    Hooks.callAll("gvnStageChanged", state, null);
  });
}

/** Empty this client's stage (GM "clear all" arrives through the stageClearedAt setting). */
export function clearLocal() {
  enqueue(() => commit(StageState.clear(state), null, { animate: true }));
}

/** Remove one stand on this client. */
export function removeStandLocal(key) {
  enqueue(() => commit(StageState.remove(state, key)));
}

export function setMaxSlots(n) {
  enqueue(() => commit(StageState.withMaxSlots(state, n)));
}

function pruneIdle(s) {
  const minutes = setting("idleMinutes");
  if (!minutes) return s;
  return StageState.removeIdle(s, Date.now() - minutes * 60000);
}

function startIdleTimer() {
  clearInterval(idleTimer);
  idleTimer = setInterval(() => enqueue(() => commit(pruneIdle(state))), 60000);
}

export const getState = () => foundry.utils.deepClone(state);

/* -------------------------------------------- */
/*  Chat controls button                        */
/* -------------------------------------------- */

export function refreshToggleButtons() {
  for (const btn of document.querySelectorAll(".gvn-toggle")) {
    btn.classList.toggle("active", !!setting("stageEnabled"));
    btn.hidden = !canToggle();
    btn.dataset.tooltip = L(setting("stageEnabled") ? "Stage.ToggleOff" : "Stage.ToggleOn");
  }
  root?.classList.toggle("gvn-no-toggle", !canToggle());
}

function menuItems() {
  const gm = () => game.user.isGM;
  return [
    { name: "GVN.Stage.MenuAllOn", icon: '<i class="fa-solid fa-eye"></i>', condition: gm, callback: () => broadcastStage(true) },
    { name: "GVN.Stage.MenuAllOff", icon: '<i class="fa-solid fa-eye-slash"></i>', condition: gm, callback: () => broadcastStage(false) },
    { name: "GVN.Stage.MenuClearAll", icon: '<i class="fa-solid fa-broom"></i>', condition: gm, callback: () => clearAll() },
    { name: "GVN.Stage.MenuRebuild", icon: '<i class="fa-solid fa-rotate"></i>', callback: () => rebuild() },
    { name: "GVN.Player.Open", icon: '<i class="fa-solid fa-film"></i>', callback: () => openLogPlayer() },
    { name: "GVN.Keywords.Title", icon: '<i class="fa-solid fa-link"></i>', callback: () => openKeywordManager() },
  ];
}

/** renderChatInput / renderChatLog: add the stage toggle next to the chat-tools archive button (gatos-lib addChatControl). */
export function injectToggleButton() {
  const controls = document.getElementById("chat-controls");
  if (!controls) return;
  addChatControl({ cls: "gvn-toggle", icon: "fa-solid fa-masks-theater", label: L("Stage.Toggle"), onClick: () => toggle(), controls });
  if (!controls.dataset.gvnMenu) {
    controls.dataset.gvnMenu = "1";
    new (ContextMenu())(controls, ".gvn-toggle", menuItems(), { jQuery: false, fixed: true });
  }
  refreshToggleButtons();
}

/* -------------------------------------------- */
/*  Startup                                     */
/* -------------------------------------------- */

function trackAltKey() {
  const set = (on) => document.body.classList.toggle("gvn-alt", on);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Alt") set(true);
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === "Alt") set(false);
  });
  window.addEventListener("blur", () => set(false));
}

export function registerStageHooks() {
  Hooks.on("createChatMessage", onCreateChatMessage);
  Hooks.on("updateChatMessage", onUpdateChatMessage);
  Hooks.on("deleteChatMessage", onDeleteChatMessage);
  // renderChatInput + renderChatLog (the latter also re-mounts a detached stage); collapseSidebar is handled below.
  onChatUiRender(({ hook }) => {
    injectToggleButton();
    if (hook === "renderChatLog" && !root?.isConnected && ready) mountStage();
  }, { deferCollapse: false });
  Hooks.on("collapseSidebar", () => setTimeout(measure, 350));
  for (const hook of ["combatStart", "updateCombat", "deleteCombat", "createCombat"]) Hooks.on(hook, () => applyEnabled());
}

/** ready hook: mount and rebuild from the chat log. */
export async function startStage() {
  ready = true;
  mountStage();
  trackAltKey();
  window.addEventListener("resize", () => measure());
  startIdleTimer();
  injectToggleButton();
  await rebuild();
}
