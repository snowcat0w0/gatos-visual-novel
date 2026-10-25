import { MODULE_ID, L, mod } from "./constants.js";
import { createSocket } from "./lib.js";
import { applyKeywordOp } from "./links.js";
import { removeStandLocal } from "./stage.js";

/**
 * gatos-lib socket on `module.gatos-visual-novel`. Broadcasts ("stage", "remove") reach every other client and
 * are honoured only when the sender is a GM (the library resolves the sender from the server-supplied id);
 * "keyword" is a request answered by the active GM.
 */
export const socket = createSocket(mod);

socket.registerHandler(
  "stage",
  async ({ enabled }, user) => {
    // GM switches every client's own stage setting; each player may switch it back afterwards.
    if (!user?.isGM) return;
    await game.settings.set(MODULE_ID, "stageEnabled", !!enabled);
    ui.notifications.info(L(enabled ? "Stage.ForcedOn" : "Stage.ForcedOff"));
  },
  { anyClient: true },
);

socket.registerHandler(
  "remove",
  ({ key }, user) => {
    if (user?.isGM) removeStandLocal(key);
  },
  { anyClient: true },
);

/** Active GM: apply a player's registry change with that player's permission; the result goes back to them. */
socket.registerHandler("keyword", ({ op, entry }, user) => applyKeywordOp(op, entry, user));

export function registerSocket() {
  socket.init();
}

/** GM: switch the stage on/off for everyone (including this client). */
export async function broadcastStage(enabled) {
  if (!game.user.isGM) return ui.notifications.warn(L("Stage.GMOnly"));
  socket.broadcast("stage", { enabled: !!enabled });
  await game.settings.set(MODULE_ID, "stageEnabled", !!enabled);
  ui.notifications.info(L(enabled ? "Stage.BroadcastOn" : "Stage.BroadcastOff"));
}

/** GM: empty every stage. Stored as a world timestamp so rebuilds (reloads) stay empty too. */
export async function clearAll() {
  if (!game.user.isGM) return ui.notifications.warn(L("Stage.GMOnly"));
  await game.settings.set(MODULE_ID, "stageClearedAt", Date.now());
}

/** GM: take one stand off every stage. */
export function broadcastRemove(key) {
  if (!game.user.isGM) return;
  socket.broadcast("remove", { key });
  removeStandLocal(key);
}

/**
 * Change the keyword registry: directly on a GM client, otherwise through the active GM (8 s timeout).
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function requestKeywordOp(op, entry) {
  const res = await socket.request("keyword", { op, entry });
  // The library's own failure codes map to this module's lang keys, as in 0.3.0 (an exception inside
  // applyKeywordOp reached the player as a timeout back then; `error` would otherwise be raw text).
  if (!res.ok && res.code === "noGM") return { ok: false, error: "Keywords.NoGM" };
  if (!res.ok && res.code) return { ok: false, error: "Keywords.Timeout" };
  return res;
}
