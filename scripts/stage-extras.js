import { L, mod } from "./constants.js";
import { pure, impl } from "./lib.js";
import { setting } from "./settings.js";
import { ContextMenu } from "./compat.js";
import { castMembers, memberByKey, castStats, castItems, toggleMirror, removeMember, giveItemTo, saveLayout, resetLayout } from "./cast.js";
import { broadcastFocus, broadcastRelease, broadcastRemove } from "./socket.js";
import { getRoot, liveState, scheduleDraw, isPlaying } from "./stage.js";
import { openCastConfig } from "./cast-config.js";
import { openSceneMedia } from "./scene-media.js";
import { openItemPalette, openNpcPalette } from "./palettes.js";
import { toggleQuickbar, refreshQuickbar } from "./quickbar.js";

/**
 * Live-stage extras drawn on top of StageDOM (which stays pure for the exported player):
 * cast card HUDs, speech bubbles, GM director mode (click = focus, right-click = menu),
 * the layout editor (drag / resize cast stands) and item drops onto PC stands.
 */

const BUBBLE_MAX = 160;
const { plainText } = pure;

let director = false;
let layoutEditing = false;
let layoutScope = "world"; // "world" | "scene"

/* -------------------------------------------- */
/*  Modes                                       */
/* -------------------------------------------- */

export const isDirector = () => director && game.user.isGM;
export const isLayoutEditing = () => layoutEditing && game.user.isGM;

/** GM: stands react to clicks (focus) and right-clicks (menu). Off by default so stands never block the canvas. */
export function setDirector(on) {
  director = !!on && game.user.isGM;
  redecorate();
  refreshQuickbar();
}
export const toggleDirector = () => setDirector(!director);

/** GM: drag cast stands to free positions and resize them. */
export function setLayoutEditing(on) {
  layoutEditing = !!on && game.user.isGM;
  redecorate();
  refreshQuickbar();
}
export const toggleLayoutEditing = () => setLayoutEditing(!layoutEditing);

function redecorate() {
  const root = getRoot();
  // During a log playback the stage shows the replay: no live decorations.
  if (root && !isPlaying()) decorate(root, liveState());
}

/* -------------------------------------------- */
/*  Decorations                                 */
/* -------------------------------------------- */

/** After every live render: HUDs, bubble, voice highlight, editor handles, mode classes. */
export function decorate(root, state) {
  if (!root || !state) return;
  root.classList.toggle("gvn-director", isDirector());
  root.classList.toggle("gvn-layout-edit", isLayoutEditing());
  const members = new Map(castMembers().map((m) => [m.key, m]));
  for (const [key, fig] of root._gvn.figures) {
    const m = members.get(key);
    if (m) fig.classList.toggle("gvn-cast-pc", m.group === "pc");
    renderHud(fig, m);
    renderHandles(fig, m);
  }
  renderBubble(root, state);
  renderLayoutBar(root);
}

/** Remove live-only decorations (entering playback). */
export function clearDecorations(root) {
  if (!root) return;
  root.querySelectorAll(".gvn-hud, .gvn-bubble, .gvn-stand-handle, .gvn-layout-bar").forEach((e) => e.remove());
  root.classList.remove("gvn-director", "gvn-layout-edit", "gvn-bubble-only");
  bubbleKey = null;
}

/* ---------- cast card HUD ---------- */

function hudAllowed(m) {
  if (!m) return false;
  if (m.group === "npc") return setting("npcHud") === "gm" && game.user.isGM;
  if (!setting("castHud")) return false;
  return game.user.isGM || m.actor.isOwner || game.user.character?.id === m.actor.id;
}

function renderHud(fig, m) {
  let hud = fig.querySelector(":scope > .gvn-hud");
  const stats = hudAllowed(m) ? castStats(m.actor) : [];
  const items = hudAllowed(m) ? castItems(m.actor) : [];
  if (!stats.length && !items.length) {
    hud?.remove();
    return;
  }
  if (!hud) {
    hud = document.createElement("div");
    hud.className = "gvn-hud";
    fig.append(hud);
  }
  hud.replaceChildren();
  for (const s of stats) {
    const row = document.createElement("div");
    row.className = "gvn-hud-stat";
    const label = document.createElement("span");
    label.className = "gvn-hud-label";
    label.textContent = s.label;
    const value = document.createElement("span");
    value.className = "gvn-hud-value";
    value.textContent = s.max ? `${s.value}/${s.max}` : String(s.value);
    row.append(label, value);
    if (s.max && Number.isFinite(Number(s.value))) {
      const bar = document.createElement("span");
      bar.className = "gvn-hud-bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(0, Math.min(100, (Number(s.value) / s.max) * 100))}%`;
      if (s.color) fill.style.background = s.color;
      bar.append(fill);
      row.append(bar);
    } else if (s.color) value.style.color = s.color;
    hud.append(row);
  }
  if (items.length) {
    const list = document.createElement("div");
    list.className = "gvn-hud-items";
    for (const it of items.slice(0, 12)) {
      const cell = document.createElement(it.img ? "img" : "span");
      cell.className = "gvn-hud-item";
      cell.dataset.tooltip = it.name;
      if (it.uuid) cell.dataset.uuid = it.uuid;
      if (it.img) {
        cell.src = it.img;
        cell.alt = it.name;
      } else cell.textContent = it.name;
      list.append(cell);
    }
    if (items.length > 12) {
      const more = document.createElement("span");
      more.className = "gvn-hud-more";
      more.textContent = `+${items.length - 12}`;
      list.append(more);
    }
    hud.append(list);
  }
}

/* ---------- speech bubble ---------- */

let bubbleKey = null;
let bubbleTimer = null;

function removeBubbles(root, except = null) {
  root.querySelectorAll(".gvn-bubble").forEach((b) => b !== except && b.remove());
}

/**
 * bubbleMode "both": a bubble over the speaker's stand for a while, the dialogue box as usual.
 * "bubble": the bubble replaces the dialogue box for speech lines whose speaker stands on the stage.
 * Only speech lines (rolls and narration have no speaker key); messages this client cannot see never get here.
 */
function renderBubble(root, state) {
  const mode = setting("bubbleMode");
  const d = state.dialogue;
  const fig = mode !== "off" && d?.key ? root._gvn.figures.get(d.key) : null;
  const text = fig ? truncate(plainText(d.html ?? "")) : "";
  const show = !!fig && !!text && !fig.classList.contains("leaving");
  root.classList.toggle("gvn-bubble-only", mode === "bubble" && show);
  if (!show) {
    clearTimeout(bubbleTimer);
    removeBubbles(root);
    bubbleKey = null;
    return;
  }
  const id = `${d.messageId}\u0000${d.html}`;
  let bubble = fig.querySelector(":scope > .gvn-bubble");
  if (bubbleKey === id && bubble) return;
  bubbleKey = id;
  removeBubbles(root, bubble);
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "gvn-bubble";
    fig.append(bubble);
  }
  bubble.textContent = text;
  // Open towards the middle of the stage: cast columns know their side (unless moved freely); others go by position.
  const r = root.getBoundingClientRect();
  const f = fig.getBoundingClientRect();
  const free = fig.classList.contains("gvn-pos");
  const leftHalf = (!free && fig.classList.contains("gvn-cast-left"))
    || ((free || !fig.classList.contains("gvn-cast-right")) && f.left + f.width / 2 <= r.left + r.width / 2);
  bubble.classList.toggle("to-right", leftHalf);
  bubble.classList.toggle("to-left", !leftHalf);
  bubble.classList.toggle("emote", !!d.emote);
  clearTimeout(bubbleTimer);
  if (mode === "both") {
    const ms = Math.min(12000, Math.max(3000, 1500 + text.length * 70));
    bubbleTimer = setTimeout(() => {
      if (bubbleKey === id) bubble.classList.add("fading");
      setTimeout(() => bubble.remove(), 400);
    }, ms);
  }
}

const truncate = (s) => (s.length > BUBBLE_MAX ? `${s.slice(0, BUBBLE_MAX - 1)}…` : s);

/* -------------------------------------------- */
/*  Director: focus and stand menu              */
/* -------------------------------------------- */

/** Stand clicked (StageDOM onStandClick): GM in director mode toggles the focus for everyone. */
export function onStandClick(key, event) {
  if (!isDirector() || isLayoutEditing() || !key) return;
  event?.preventDefault();
  broadcastFocus(liveState().focusKey === key ? null : key);
}

/** Actor shown by a stand key. */
function actorOfKey(key) {
  const [type, a, b] = String(key ?? "").split(".");
  if (type === "Actor") return game.actors.get(a) ?? null;
  if (type === "Token") return game.scenes.get(a)?.tokens.get(b)?.actor ?? null;
  return null;
}

const STAND_MENU_SELECTOR = "body:not(.gvn-alt) #gvn-stage.gvn-director:not(.gvn-layout-edit) .gvn-stand";

function standMenuItems() {
  // v13 ContextMenuEntry shape: { name, icon (HTML), condition(li), callback(li) } (client/applications/ux/context-menu.mjs).
  const keyOf = (li) => li?.dataset?.key;
  const member = (li) => memberByKey(keyOf(li));
  return [
    { name: "GVN.Focus.Focus", icon: '<i class="fa-solid fa-bullseye"></i>', condition: (li) => liveState().focusKey !== keyOf(li), callback: (li) => broadcastFocus(keyOf(li)) },
    { name: "GVN.Focus.Unfocus", icon: '<i class="fa-regular fa-circle"></i>', condition: (li) => liveState().focusKey === keyOf(li), callback: () => broadcastFocus(null) },
    { name: "GVN.Cast.Mirror", icon: '<i class="fa-solid fa-left-right"></i>', condition: (li) => !!member(li), callback: (li) => toggleMirror(member(li)) },
    {
      name: "GVN.Cast.RemoveFromStage",
      icon: '<i class="fa-solid fa-person-walking-arrow-right"></i>',
      callback: (li) => {
        const m = member(li);
        if (m) return removeMember(m);
        broadcastRemove(keyOf(li));
      },
    },
    {
      name: "GVN.Cast.OpenSheet",
      icon: '<i class="fa-solid fa-id-card"></i>',
      condition: (li) => !!actorOfKey(keyOf(li)),
      callback: (li) => actorOfKey(keyOf(li))?.sheet?.render({ force: true }),
    },
  ];
}

/* -------------------------------------------- */
/*  Layout editor                               */
/* -------------------------------------------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function renderHandles(fig, m) {
  const editing = isLayoutEditing() && !!m;
  let handle = fig.querySelector(":scope > .gvn-stand-handle");
  if (!editing) {
    handle?.remove();
    return;
  }
  if (!handle) {
    handle = document.createElement("div");
    handle.className = "gvn-stand-handle";
    const label = document.createElement("span");
    label.className = "gvn-stand-label";
    const grip = document.createElement("span");
    grip.className = "gvn-stand-resize";
    grip.dataset.tooltip = L("Layout.Resize");
    grip.innerHTML = '<i class="fa-solid fa-up-down"></i>';
    handle.append(label, grip);
    fig.append(handle);
  }
  handle.querySelector(".gvn-stand-label").textContent = `${L(m.group === "pc" ? "Cast.PcSeat" : "Cast.NpcSeat", { n: m.index + 1 })} · ${m.actor.name}`;
}

function renderLayoutBar(root) {
  let bar = root.querySelector(":scope > .gvn-layout-bar");
  if (!isLayoutEditing()) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "gvn-layout-bar";
    bar.innerHTML = `<span class="gvn-lb-title"><i class="fa-solid fa-up-down-left-right"></i> </span>
      <select class="gvn-lb-scope"><option value="world"></option><option value="scene"></option></select>
      <button type="button" class="gvn-lb-reset"><i class="fa-solid fa-rotate-left"></i> </button>
      <button type="button" class="gvn-lb-done"><i class="fa-solid fa-check"></i> </button>`;
    bar.querySelector(".gvn-lb-title").append(L("Layout.Title"));
    const [w, sc] = bar.querySelectorAll("option");
    w.textContent = L("Layout.ScopeWorld");
    sc.textContent = L("Layout.ScopeScene");
    bar.querySelector(".gvn-lb-reset").append(L("Layout.Reset"));
    bar.querySelector(".gvn-lb-done").append(L("Layout.Done"));
    bar.querySelector(".gvn-lb-scope").addEventListener("change", (ev) => (layoutScope = ev.target.value === "scene" ? "scene" : "world"));
    bar.querySelector(".gvn-lb-reset").addEventListener("click", () => resetLayout({ scene: layoutScope === "scene" ? canvas?.scene : null }));
    bar.querySelector(".gvn-lb-done").addEventListener("click", () => setLayoutEditing(false));
    for (const t of ["pointerdown", "keydown"]) bar.addEventListener(t, (ev) => ev.stopPropagation());
    root.append(bar);
  }
  bar.querySelector(".gvn-lb-scope").value = layoutScope;
  bar.querySelector(".gvn-lb-scope option[value=scene]").disabled = !canvas?.scene;
}

function setPosVars(fig, p) {
  fig.classList.add("gvn-pos");
  fig.style.setProperty("--gvn-x", String(p.x));
  fig.style.setProperty("--gvn-y", String(p.y));
  fig.style.setProperty("--gvn-h", String(p.h));
  fig.style.setProperty("--gvn-pfit", "1");
}

/** Drag a cast stand (move) or its grip (resize); saved on release as % of the stage. */
function onLayoutPointerDown(ev) {
  if (!isLayoutEditing() || ev.button !== 0) return;
  const fig = ev.target.closest(".gvn-stand.gvn-cast");
  const slotId = fig?.dataset.slotId;
  if (!fig || !slotId) return;
  ev.preventDefault();
  ev.stopPropagation();
  const root = fig.closest(".gvn-stage");
  const rr = root.getBoundingClientRect();
  const fr = fig.getBoundingClientRect();
  if (!rr.width || !rr.height) return;
  const resize = !!ev.target.closest(".gvn-stand-resize");
  const start = {
    x: ((fr.left + fr.width / 2 - rr.left) / rr.width) * 100,
    y: ((rr.bottom - fr.bottom) / rr.height) * 100,
    h: (fr.height / rr.height) * 100,
  };
  const cur = { ...start, a: rr.width / rr.height };
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  fig.classList.add("gvn-dragging");
  setPosVars(fig, cur);
  try {
    fig.setPointerCapture(ev.pointerId);
  } catch {
    /* pointer already released */
  }
  const move = (e) => {
    const dx = ((e.clientX - x0) / rr.width) * 100;
    const dy = ((e.clientY - y0) / rr.height) * 100;
    if (resize) cur.h = clamp(start.h - dy, 10, 150);
    else {
      cur.x = clamp(start.x + dx, 0, 100);
      cur.y = clamp(start.y - dy, -50, 95);
    }
    setPosVars(fig, cur);
  };
  const end = async (e) => {
    fig.removeEventListener("pointermove", move);
    fig.removeEventListener("pointerup", end);
    fig.removeEventListener("pointercancel", end);
    fig.classList.remove("gvn-dragging");
    if (e.type === "pointercancel") return scheduleDraw();
    await saveLayout(slotId, cur, { scene: layoutScope === "scene" ? canvas?.scene ?? null : null });
  };
  fig.addEventListener("pointermove", move);
  fig.addEventListener("pointerup", end);
  fig.addEventListener("pointercancel", end);
}

/* -------------------------------------------- */
/*  Item drops onto PC stands                   */
/* -------------------------------------------- */

const dropTarget = (ev) => (game.user.isGM ? ev.target.closest?.(".gvn-stand.gvn-cast-pc") : null);

function onDragOver(ev) {
  const fig = dropTarget(ev);
  if (!fig) return;
  ev.preventDefault();
  fig.classList.add("gvn-drop-target");
}

function onDragLeave(ev) {
  const fig = ev.target.closest?.(".gvn-stand");
  if (fig && !fig.contains(ev.relatedTarget)) fig.classList.remove("gvn-drop-target");
}

async function onDrop(ev) {
  const fig = dropTarget(ev);
  if (!fig) return;
  ev.preventDefault();
  ev.stopPropagation();
  fig.classList.remove("gvn-drop-target");
  document.body.classList.remove("gvn-item-dragging");
  const data = impl.TextEditor().getDragEventData(ev);
  if (data?.type !== "Item" || !data.uuid) return;
  const member = memberByKey(fig.dataset.key);
  if (member?.group === "pc") await giveItemTo(member.actor, data.uuid);
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */

/** Once per stage element: stand menu, layout drags and item drops. */
export function setupStageInteractions(root) {
  if (!root || root.dataset.gvnInteractions) return;
  root.dataset.gvnInteractions = "1";
  const stands = root.querySelector(".gvn-stands");
  if (game.user.isGM) new (ContextMenu())(stands, STAND_MENU_SELECTOR, standMenuItems(), { jQuery: false, fixed: true });
  stands.addEventListener("pointerdown", onLayoutPointerDown);
  stands.addEventListener("dragover", onDragOver);
  stands.addEventListener("dragleave", onDragLeave);
  stands.addEventListener("drop", onDrop);
}

/** GM entries of the mask (가면) context menu (v13 ContextMenuEntry shape). */
export function gmToolMenuItems() {
  const gm = () => game.user.isGM;
  return [
    { name: "GVN.Tools.Quickbar", icon: '<i class="fa-solid fa-clapperboard"></i>', condition: gm, callback: () => toggleQuickbar() },
    { name: "GVN.Cast.Title", icon: '<i class="fa-solid fa-users"></i>', condition: gm, callback: () => openCastConfig() },
    { name: "GVN.Media.Title", icon: '<i class="fa-solid fa-panorama"></i>', condition: gm, callback: () => openSceneMedia() },
    { name: "GVN.Palette.ItemTitle", icon: '<i class="fa-solid fa-suitcase"></i>', condition: gm, callback: () => openItemPalette() },
    { name: "GVN.Palette.NpcTitle", icon: '<i class="fa-solid fa-user-plus"></i>', condition: gm, callback: () => openNpcPalette() },
  ];
}

/** Release everything (quickbar / API). */
export const releaseAll = () => broadcastRelease();
