import { MODULE_ID, CHAT_TOOLS_ID, L, mod } from "./constants.js";
import { debounce } from "./lib.js";
import { setting } from "./settings.js";
import { getPresets, applyPreset, openSceneMedia } from "./scene-media.js";
import { openCastConfig } from "./cast-config.js";
import { openItemPalette, openNpcPalette } from "./palettes.js";
import { isDirector, toggleDirector, isLayoutEditing, toggleLayoutEditing, openRemoveStands } from "./stage-extras.js";
import { broadcastRelease } from "./socket.js";

/**
 * Scene quickbar (GM): a small floating, draggable and resizable panel with the viewed scene's location presets
 * (one click applies) and launchers for the GM tools. Placement is stored per client; default top centre.
 */

const DEFAULT_WIDTH = 520;
let panel = null;
let resizeObserver = null;

/** gatos-chat-tools panels (notes / whispers) when that version exposes them. */
function chatToolsPanel(name) {
  const fn = game.modules.get(CHAT_TOOLS_ID)?.api?.panels?.[name];
  return typeof fn === "function" ? fn : null;
}

const TOOLS = [
  { id: "cast", icon: "fa-solid fa-users", label: "Cast.Title", run: () => openCastConfig() },
  { id: "media", icon: "fa-solid fa-panorama", label: "Media.Title", run: () => openSceneMedia() },
  { id: "items", icon: "fa-solid fa-suitcase", label: "Palette.ItemTitle", run: () => openItemPalette() },
  { id: "npcs", icon: "fa-solid fa-user-plus", label: "Palette.NpcTitle", run: () => openNpcPalette() },
  { id: "director", icon: "fa-solid fa-hand-pointer", label: "Quickbar.Director", run: () => toggleDirector(), active: () => isDirector() },
  { id: "layout", icon: "fa-solid fa-up-down-left-right", label: "Layout.Title", run: () => toggleLayoutEditing(), active: () => isLayoutEditing() },
  { id: "release", icon: "fa-solid fa-hand", label: "Focus.ReleaseAll", run: () => broadcastRelease() },
  { id: "remove", icon: "fa-solid fa-person-walking-arrow-right", label: "Stage.RemoveTitle", run: () => openRemoveStands() },
  { id: "notes", icon: "fa-solid fa-note-sticky", label: "Quickbar.Notes", run: () => chatToolsPanel("notes")?.(), visible: () => !!chatToolsPanel("notes") },
  { id: "whispers", icon: "fa-solid fa-user-secret", label: "Quickbar.Whispers", run: () => chatToolsPanel("whispers")?.(), visible: () => !!chatToolsPanel("whispers") },
];

export const isQuickbarShown = () => game.user.isGM && !!setting("showQuickbar");

/** GM: show / hide the quickbar (client setting). */
export async function toggleQuickbar(force) {
  if (!game.user.isGM) return mod.notify.warn("Stage.GMOnly");
  const next = force === undefined ? !setting("showQuickbar") : !!force;
  await game.settings.set(MODULE_ID, "showQuickbar", next);
}

/** Build, refill or remove the panel according to the setting. */
export function renderQuickbar() {
  if (!isQuickbarShown()) {
    resizeObserver?.disconnect();
    panel?.remove();
    panel = null;
    return;
  }
  if (!panel?.isConnected) build();
  fill();
}

/** Refill an open panel (presets / tool states changed). */
export function refreshQuickbar() {
  if (panel?.isConnected) fill();
}

/* -------------------------------------------- */
/*  Placement                                   */
/* -------------------------------------------- */

function placement() {
  const p = setting("quickbarPlacement");
  return p && typeof p === "object" ? p : {};
}

const savePlacement = debounce(() => {
  if (!panel?.isConnected) return;
  const r = panel.getBoundingClientRect();
  const value = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), collapsed: panel.classList.contains("collapsed") };
  if (!panel.classList.contains("collapsed")) value.height = Math.round(r.height);
  else if (Number.isFinite(placement().height)) value.height = placement().height;
  if (!foundry.utils.equals(value, placement())) game.settings.set(MODULE_ID, "quickbarPlacement", value);
}, 400);

/** Keep the panel inside the window. */
function clampIntoView() {
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - Math.min(r.width, window.innerWidth)));
  const top = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - 32));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function applyPlacement() {
  const p = placement();
  const width = Number.isFinite(p.width) ? Math.max(260, p.width) : Math.min(DEFAULT_WIDTH, window.innerWidth - 32);
  panel.style.width = `${width}px`;
  if (Number.isFinite(p.height) && !p.collapsed) panel.style.height = `${Math.max(64, p.height)}px`;
  panel.style.left = `${Number.isFinite(p.left) ? p.left : Math.round((window.innerWidth - width) / 2)}px`;
  panel.style.top = `${Number.isFinite(p.top) ? p.top : 8}px`;
  panel.classList.toggle("collapsed", !!p.collapsed);
  clampIntoView();
}

/* -------------------------------------------- */
/*  DOM                                         */
/* -------------------------------------------- */

function iconButton(cls, icon, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.dataset.tooltip = title;
  b.setAttribute("aria-label", title);
  const i = document.createElement("i");
  i.className = icon;
  b.append(i);
  return b;
}

function build() {
  panel = document.createElement("section");
  panel.id = "gvn-quickbar";
  panel.className = "gvn-quickbar";

  const head = document.createElement("header");
  head.className = "gvn-qb-head";
  const title = document.createElement("span");
  title.className = "gvn-qb-title";
  title.innerHTML = '<i class="fa-solid fa-clapperboard"></i> ';
  title.append(L("Quickbar.Title"));
  const scene = document.createElement("span");
  scene.className = "gvn-qb-scene";
  const collapse = iconButton("gvn-qb-collapse", "fa-solid fa-chevron-up", L("Quickbar.Collapse"));
  const close = iconButton("gvn-qb-close", "fa-solid fa-xmark", L("Quickbar.Hide"));
  head.append(title, scene, collapse, close);

  const body = document.createElement("div");
  body.className = "gvn-qb-body";
  const presets = document.createElement("div");
  presets.className = "gvn-qb-presets";
  const tools = document.createElement("div");
  tools.className = "gvn-qb-tools";
  body.append(presets, tools);
  panel.append(head, body);
  document.body.append(panel);
  applyPlacement();

  collapse.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    panel.style.height = panel.classList.contains("collapsed") ? "" : Number.isFinite(placement().height) ? `${placement().height}px` : "";
    savePlacement();
  });
  close.addEventListener("click", () => toggleQuickbar(false));
  panel.addEventListener("click", onClick);
  head.addEventListener("pointerdown", onDragStart);
  resizeObserver = new ResizeObserver(() => savePlacement());
  resizeObserver.observe(panel);
}

function fill() {
  const scene = canvas?.scene ?? null;
  panel.querySelector(".gvn-qb-scene").textContent = scene?.name ?? "";

  const presets = panel.querySelector(".gvn-qb-presets");
  presets.replaceChildren();
  const list = scene ? getPresets(scene) : [];
  if (!list.length) {
    const hint = document.createElement("span");
    hint.className = "gvn-qb-hint";
    hint.textContent = L(scene ? "Quickbar.NoPresets" : "Media.NoScene");
    presets.append(hint);
  }
  for (const p of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gvn-qb-preset";
    b.dataset.preset = p.id;
    b.dataset.tooltip = L("Quickbar.ApplyPreset", { name: p.name });
    b.textContent = p.name;
    presets.append(b);
  }

  const tools = panel.querySelector(".gvn-qb-tools");
  tools.replaceChildren();
  for (const t of TOOLS) {
    if (t.visible && !t.visible()) continue;
    const b = iconButton(`gvn-qb-tool${t.active?.() ? " active" : ""}`, t.icon, L(t.label));
    b.dataset.tool = t.id;
    tools.append(b);
  }
}

function onClick(ev) {
  const preset = ev.target.closest("[data-preset]");
  if (preset && canvas?.scene) return void applyPreset(canvas.scene, preset.dataset.preset);
  const tool = TOOLS.find((t) => t.id === ev.target.closest("[data-tool]")?.dataset.tool);
  if (!tool) return;
  tool.run();
  fill();
}

function onDragStart(ev) {
  if (ev.button !== 0 || ev.target.closest("button")) return;
  ev.preventDefault();
  const r = panel.getBoundingClientRect();
  const dx = ev.clientX - r.left;
  const dy = ev.clientY - r.top;
  const move = (e) => {
    panel.style.left = `${Math.round(e.clientX - dx)}px`;
    panel.style.top = `${Math.round(e.clientY - dy)}px`;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    clampIntoView();
    savePlacement();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function registerQuickbarHooks() {
  Hooks.on(`${MODULE_ID}.quickbar`, () => renderQuickbar());
  Hooks.on(`${MODULE_ID}.presetsChanged`, () => refreshQuickbar());
  Hooks.on("canvasReady", () => refreshQuickbar());
  window.addEventListener("resize", debounce(() => clampIntoView(), 200));
}
