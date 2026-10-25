import { DEFAULT_EXPRESSION, L, chatTools } from "./constants.js";
import { setting } from "./settings.js";
import { getExpressions, getCurrentExpression, setCurrentExpression, resolveImages } from "./expressions.js";
import { openExpressionConfig } from "./expression-config.js";

const STRIP_CLASS = "gvn-expr-strip";

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
  if (!actor) {
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
      const thumb = e.face || e.stand || (e.id === DEFAULT_EXPRESSION ? resolveImages({ actor, token: info.token ?? null }).face : "");
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

/** Re-run the chat-tools bar update (which re-renders the strips). */
export function refreshPickers() {
  chatTools()?.updateSpeakerBar?.();
}

export function registerPickerHooks() {
  Hooks.on("gctSpeakerBarMounted", onSpeakerBarMounted);
  Hooks.on("gctSpeakerBarResolve", onSpeakerBarResolve);
  Hooks.on("gctSpeakerBarUpdated", onSpeakerBarUpdated);
  // chat-tools already refreshes the bar on updateUser / updateActor (current expression, edited entries).
}
