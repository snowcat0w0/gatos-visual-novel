import { MODULE_ID, L } from "./constants.js";
import { setting } from "./settings.js";
import { actorKey, castKeys } from "./cast.js";
import { liveState } from "./stage.js";
import { broadcastRaise, broadcastLower, mayRaise } from "./socket.js";

/**
 * Stage button on the chat-tools speaker bar: puts the current speaker's stand up without a line, or takes it down
 * when it stands. Shown while this user's novel window is on and the setting `chipRaise` lets this user act on that
 * actor (players: own actors). Cast members stand by the GM's cast settings and get no button.
 */
const BTN_CLASS = "gvn-stage-btn";

/** Speaker info of each mounted bar, from the last gctSpeakerBarUpdated (to redraw on stage changes). */
const infos = new WeakMap();

const standsUp = (key) => !!liveState()?.slots?.some((s) => s?.key === key);

function render(bar, info) {
  bar.querySelector(`:scope > .${BTN_CLASS}`)?.remove();
  const actor = info?.actor ?? null;
  if (!actor || !setting("stageEnabled") || !mayRaise(game.user, game.actors.get(actor.id))) return;
  const key = actorKey(actor.id);
  if (castKeys().has(key)) return;
  const up = standsUp(key);
  const btn = document.createElement("a");
  btn.className = `${BTN_CLASS}${up ? " active" : ""}`;
  btn.dataset.tooltip = L(up ? "StageButton.Lower" : "StageButton.Raise", { name: info.name ?? actor.name });
  btn.innerHTML = `<i class="fa-solid ${up ? "fa-person-arrow-down-to-line" : "fa-person-arrow-up-from-line"}"></i>`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (up) broadcastLower(actor);
    else broadcastRaise({ actor, token: info.token ?? null, sceneId: info.sceneId ?? null, alias: info.name ?? null });
  });
  const lock = bar.querySelector(":scope > .gct-sb-lock");
  if (lock) lock.before(btn);
  else bar.append(btn);
}

/** gctSpeakerBarUpdated. */
function onSpeakerBarUpdated(bar, info) {
  infos.set(bar, info);
  render(bar, info);
}

/** Redraw every bar's button with its last speaker (stage, cast or setting changes). */
function refresh() {
  for (const bar of document.querySelectorAll(".gct-speaker-bar")) {
    const info = infos.get(bar);
    if (info) render(bar, info);
  }
}

export function registerStageButtonHooks() {
  Hooks.on("gctSpeakerBarUpdated", onSpeakerBarUpdated);
  Hooks.on("gvnStageChanged", refresh);
  Hooks.on(`${MODULE_ID}.castChanged`, refresh);
  Hooks.on("clientSettingChanged", (key) => {
    if (key === `${MODULE_ID}.stageEnabled`) refresh();
  });
}

export const refreshStageButtons = refresh;
