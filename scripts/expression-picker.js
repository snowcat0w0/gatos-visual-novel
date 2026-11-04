import { DEFAULT_EXPRESSION, L, chatTools } from "./constants.js";
import { esc } from "./lib.js";
import { setting } from "./settings.js";
import { getExpressions, getCurrentExpression, setCurrentExpression, resolveImages } from "./expressions.js";
import { openExpressionConfig } from "./expression-config.js";

const STRIP_CLASS = "gvn-expr-strip";
const BADGE_CLASS = "gvn-expr-badge";

/** pickerMode "popup": no row below the bar; the bar's portrait opens the expression menu. */
const popupMode = () => setting("pickerMode") === "popup";

/** The image an expression row / menu entry shows (the default entry falls back like a chat card). */
function thumbOf(actor, e, token = null) {
  return e.face || e.stand || (e.id === DEFAULT_EXPRESSION ? resolveImages({ actor, token }).face : "");
}

/* -------------------------------------------- */
/*  Expression menu (pickerMode "popup")        */
/* -------------------------------------------- */

let menu = null;
let menuCleanup = null;

function closeMenu() {
  menuCleanup?.();
  menuCleanup = null;
  menu?.remove();
  menu = null;
}

/** Open the expression menu above the speaker bar's portrait (or close it). */
function openMenu(actor, anchor, token = null) {
  if (menu) return closeMenu();
  const current = getCurrentExpression(actor.id);
  const items = getExpressions(actor)
    .map((e) => {
      const thumb = thumbOf(actor, e, token);
      const img = thumb ? `<img src="${esc(thumb)}" alt="">` : `<span class="gvn-em-noimg"><i class="fa-solid fa-image"></i></span>`;
      return `<button type="button" class="gvn-em-item${e.id === current ? " active" : ""}" data-id="${esc(e.id)}">${img}<span>${esc(e.name)}</span></button>`;
    })
    .join("");
  const edit = game.user.isGM || actor.isOwner ? `<button type="button" class="gvn-em-edit"><i class="fa-solid fa-masks-theater"></i> ${esc(L("Config.Open"))}</button>` : "";
  menu = document.createElement("div");
  menu.className = "gvn-em-menu";
  menu.innerHTML = `<div class="gvn-em-head">${esc(actor.name)}</div>
    <div class="gvn-em-grid">${items}</div>
    <div class="gvn-em-foot">${edit}<button type="button" class="gvn-em-sheet"><i class="fa-solid fa-id-card"></i> ${esc(L("Picker.OpenSheet"))}</button></div>`;
  menu.addEventListener("click", (ev) => {
    const item = ev.target.closest(".gvn-em-item");
    if (item) {
      closeMenu();
      return void setCurrentExpression(actor.id, item.dataset.id);
    }
    if (ev.target.closest(".gvn-em-edit")) {
      closeMenu();
      return void openExpressionConfig(actor);
    }
    if (ev.target.closest(".gvn-em-sheet")) {
      closeMenu();
      actor.sheet?.render(true);
    }
  });
  document.body.append(menu);

  // Above the portrait, kept inside the viewport.
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;

  const onDown = (ev) => {
    if (menu?.contains(ev.target) || ev.target === anchor) return;
    closeMenu();
  };
  // Escape closes only the menu (Foundry's own Escape would open the main menu).
  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closeMenu();
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  menuCleanup = () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

/** gctSpeakerBarPortraitClick: in popup mode the portrait opens the expression menu instead of the sheet. */
export function onPortraitClick(info, portrait) {
  if (!popupMode() || !info?.actor) return;
  openMenu(info.actor, portrait, info.token ?? null);
  return false;
}

/** Strip element that belongs to a speaker bar (inserted right after it). */
function stripOf(bar) {
  const next = bar?.nextElementSibling;
  return next?.classList.contains(STRIP_CLASS) ? next : null;
}

/** gctSpeakerBarMounted: create the strip below the chat-tools speaker bar. */
export function onSpeakerBarMounted(bar) {
  document.querySelectorAll(`.${STRIP_CLASS}`).forEach((s) => s.remove());
  const strip = document.createElement("div");
  strip.className = STRIP_CLASS;
  strip.hidden = true;
  strip.addEventListener("click", (ev) => {
    const gear = ev.target.closest(".gvn-expr-config");
    const actor = game.actors.get(strip.dataset.actorId);
    if (gear) {
      ev.preventDefault();
      return void openExpressionConfig(actor);
    }
    const item = ev.target.closest(".gvn-expr-item");
    if (!item || !actor) return;
    ev.preventDefault();
    setCurrentExpression(actor.id, item.dataset.id);
  });
  strip.addEventListener("change", (ev) => {
    const select = ev.target.closest("select.gvn-expr-select");
    if (select && strip.dataset.actorId) setCurrentExpression(strip.dataset.actorId, select.value);
  });
  bar.after(strip);
}

/** gctSpeakerBarResolve: show the current expression's face as the bar portrait. */
export function onSpeakerBarResolve(info) {
  if (!info?.actor) return;
  const r = resolveImages({ actor: info.actor, token: info.token ?? null, expressionId: getCurrentExpression(info.actor.id) });
  if (r.face) info.img = r.face;
}

/** gctSpeakerBarUpdated: rebuild the strip for the current speaker. */
export function onSpeakerBarUpdated(bar, info) {
  const strip = stripOf(bar);
  if (!strip) return;
  const actor = info?.actor ?? null;
  const mode = setting("pickerMode");
  strip.innerHTML = "";
  strip.dataset.actorId = actor?.id ?? "";
  strip.className = `${STRIP_CLASS} mode-${mode}`;
  updatePopupBar(bar, actor);
  if (!actor || mode === "popup") {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  const current = getCurrentExpression(actor.id);
  const list = getExpressions(actor);

  if (mode === "dropdown") {
    const select = document.createElement("select");
    select.className = "gvn-expr-select";
    for (const e of list) {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.name;
      opt.selected = e.id === current;
      select.append(opt);
    }
    strip.append(select);
  } else {
    for (const e of list) {
      const a = document.createElement("a");
      a.className = `gvn-expr-item${e.id === current ? " active" : ""}${e.id === DEFAULT_EXPRESSION ? " default" : ""}`;
      a.dataset.id = e.id;
      a.dataset.tooltip = e.name;
      const thumb = thumbOf(actor, e, info.token ?? null);
      if (mode === "thumbnails" && thumb) {
        const img = document.createElement("img");
        img.src = thumb;
        img.alt = e.name;
        a.append(img);
      } else {
        a.classList.add("chip");
        a.textContent = e.name;
      }
      strip.append(a);
    }
  }

  if (game.user.isGM || actor.isOwner) {
    const gear = document.createElement("a");
    gear.className = "gvn-expr-config";
    gear.dataset.tooltip = L("Config.Open");
    gear.innerHTML = '<i class="fa-solid fa-gear"></i>';
    strip.append(gear);
  }
}

/**
 * Popup mode on the bar itself: the current expression's name after the speaker's name (not for the default) and
 * a portrait tooltip saying a click picks the expression. Cleared in the other modes.
 */
function updatePopupBar(bar, actor) {
  bar.querySelector(`:scope > .${BADGE_CLASS}`)?.remove();
  const portrait = bar.querySelector(".gct-sb-portrait");
  const on = popupMode() && !!actor;
  bar.classList.toggle("gvn-expr-popup", on);
  if (!on) {
    if (portrait) delete portrait.dataset.tooltip;
    return;
  }
  const current = getExpressions(actor).find((e) => e.id === getCurrentExpression(actor.id));
  if (portrait) portrait.dataset.tooltip = L("Picker.PortraitTooltip", { name: current?.name ?? L("Expression.Default") });
  if (!current || current.id === DEFAULT_EXPRESSION) return;
  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.textContent = current.name;
  bar.querySelector(".gct-sb-name")?.after(badge);
}

/** Re-run the chat-tools bar update (which re-renders the strips). */
export function refreshPickers() {
  chatTools()?.updateSpeakerBar?.();
}

export function registerPickerHooks() {
  Hooks.on("gctSpeakerBarMounted", onSpeakerBarMounted);
  Hooks.on("gctSpeakerBarResolve", onSpeakerBarResolve);
  Hooks.on("gctSpeakerBarUpdated", onSpeakerBarUpdated);
  Hooks.on("gctSpeakerBarPortraitClick", onPortraitClick);
  // chat-tools already refreshes the bar on updateUser / updateActor (current expression, edited entries).
}
