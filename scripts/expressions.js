import { MODULE_ID, DEFAULT_EXPRESSION, L, chatTools } from "./constants.js";
import { setting } from "./settings.js";
import { splitInlineTag, isGctNote } from "./tags.js";

const CURRENT_FLAG = "current";

/* -------------------------------------------- */
/*  Actor data                                  */
/* -------------------------------------------- */

function defaultEntry(src = {}) {
  return { id: DEFAULT_EXPRESSION, name: L("Expression.Default"), face: src.face ?? "", stand: src.stand ?? "" };
}

/**
 * The actor's expression entries, always normalized: `default` first (name localized), every entry
 * with string id/name/face/stand. Actors without the flag get just the default entry.
 * @param {Actor|null} actor
 * @returns {{id: string, name: string, face: string, stand: string}[]}
 */
export function getExpressions(actor) {
  const raw = actor?.flags?.[MODULE_ID]?.expressions;
  const list = Array.isArray(raw) ? raw : [];
  const def = list.find((e) => e?.id === DEFAULT_EXPRESSION);
  const rest = list
    .filter((e) => e && typeof e === "object" && e.id && e.id !== DEFAULT_EXPRESSION)
    .map((e) => ({ id: String(e.id), name: String(e.name ?? "").trim(), face: e.face ?? "", stand: e.stand ?? "" }));
  return [defaultEntry(def), ...rest];
}

/** Actor-level stand adjustment { scale, offsetY }. */
export function getStandStyle(actor) {
  const s = actor?.flags?.[MODULE_ID]?.stand ?? {};
  const scale = Number(s.scale);
  const offsetY = Number(s.offsetY);
  return { scale: Number.isFinite(scale) && scale > 0 ? scale : 1, offsetY: Number.isFinite(offsetY) ? offsetY : 0 };
}

/** Validation error key for an expression list, or null. */
export function validateExpressions(list) {
  const names = new Set();
  for (const e of list) {
    if (e.id === DEFAULT_EXPRESSION) continue;
    const n = (e.name ?? "").trim();
    if (!n) return "Config.ErrEmptyName";
    const k = n.toLocaleLowerCase();
    if (names.has(k) || k === L("Expression.Default").toLocaleLowerCase() || k === DEFAULT_EXPRESSION) return "Config.ErrDuplicate";
    names.add(k);
  }
  return null;
}

/**
 * Replace the actor's whole expression list (and optionally the stand adjustment) in one update.
 * @returns {Promise<boolean>}
 */
export async function setExpressions(actor, list, stand) {
  if (!actor) return false;
  if (!game.user.isGM && !actor.isOwner) {
    ui.notifications.warn(L("Config.NoPermission"));
    return false;
  }
  const def = list.find((e) => e.id === DEFAULT_EXPRESSION) ?? {};
  const rest = list.filter((e) => e.id !== DEFAULT_EXPRESSION);
  const clean = [
    { id: DEFAULT_EXPRESSION, name: "", face: def.face ?? "", stand: def.stand ?? "" },
    ...rest.map((e) => ({ id: e.id || foundry.utils.randomID(6), name: (e.name ?? "").trim(), face: e.face ?? "", stand: e.stand ?? "" })),
  ];
  const err = validateExpressions(clean);
  if (err) {
    ui.notifications.warn(L(err));
    return false;
  }
  const update = { [`flags.${MODULE_ID}.expressions`]: clean };
  if (stand) update[`flags.${MODULE_ID}.stand`] = { scale: Number(stand.scale) || 1, offsetY: Number(stand.offsetY) || 0 };
  await actor.update(update);
  Hooks.callAll("gvnExpressionsUpdated", actor);
  return true;
}

/** Find an entry by name (case-insensitive; the localized default name and "default" match the default entry). */
export function findExpressionByName(actor, name) {
  const k = String(name ?? "").trim().toLocaleLowerCase();
  if (!k) return null;
  const list = getExpressions(actor);
  if (k === DEFAULT_EXPRESSION) return list[0];
  return list.find((e) => e.name.toLocaleLowerCase() === k) ?? null;
}

/* -------------------------------------------- */
/*  Current expression (per user, per actor)    */
/* -------------------------------------------- */

/** The expression id this user currently speaks with as the actor (falls back to default). */
export function getCurrentExpression(actorId, user = game.user) {
  if (!actorId) return DEFAULT_EXPRESSION;
  const id = user.getFlag(MODULE_ID, CURRENT_FLAG)?.[actorId];
  const actor = game.actors.get(actorId);
  return id && getExpressions(actor).some((e) => e.id === id) ? id : DEFAULT_EXPRESSION;
}

export async function setCurrentExpression(actorId, id) {
  if (!actorId) return;
  await game.user.update({ [`flags.${MODULE_ID}.${CURRENT_FLAG}.${actorId}`]: id || DEFAULT_EXPRESSION });
}

/* -------------------------------------------- */
/*  Fallback resolution (PLAN §4)               */
/* -------------------------------------------- */

/**
 * Resolve the card face and the stage stand for an expression.
 * face:  entry.face → entry.stand → default.face → token → actor
 * stand: entry.stand → entry.face → default.stand → token → actor
 * Synchronous (used inside preCreate hooks).
 * @param {object} args
 * @param {Actor|null} [args.actor]
 * @param {TokenDocument|null} [args.token]
 * @param {string|null} [args.tokenImg]   Token image when no TokenDocument is at hand.
 * @param {string} [args.expressionId]
 */
export function resolveImages({ actor = null, token = null, tokenImg = null, expressionId = DEFAULT_EXPRESSION } = {}) {
  const list = actor ? getExpressions(actor) : [];
  const def = list[0] ?? null;
  const entry = list.find((e) => e.id === expressionId) ?? def;
  const tokenSrc = tokenImg ?? token?.texture?.src ?? null;
  const pick = (chain) => chain.find(([v]) => !!v) ?? [null, null];
  const [face, faceSource] = pick([
    [entry?.face, "face"],
    [entry?.stand, "stand"],
    [def?.face, "defaultFace"],
    [tokenSrc, "token"],
    [actor?.img, "actor"],
  ]);
  const [stand, standSource] = pick([
    [entry?.stand, "stand"],
    [entry?.face, "face"],
    [def?.stand, "defaultStand"],
    [tokenSrc, "token"],
    [actor?.img, "actor"],
  ]);
  return { face, stand, faceSource, standSource, entry };
}

/** Speaker → { actor, tokenImg } using the chat-tools lookup when available. */
export function speakerDocs(speaker) {
  const ct = chatTools();
  if (ct?.lookupPortrait) {
    const { token, actorDoc } = ct.lookupPortrait(speaker);
    return { actor: actorDoc ?? null, tokenImg: token ?? null };
  }
  let actor = null;
  let tokenImg = null;
  if (speaker?.scene && speaker?.token) {
    const token = game.scenes.get(speaker.scene)?.tokens.get(speaker.token);
    tokenImg = token?.texture?.src ?? null;
    actor = token?.actor ?? null;
  }
  actor ??= speaker?.actor ? game.actors.get(speaker.actor) : null;
  return { actor, tokenImg };
}

/** The frozen `expression` flag object for a speaker speaking with an expression id. */
export function expressionFlagFor(speaker, expressionId = DEFAULT_EXPRESSION) {
  const { actor, tokenImg } = speakerDocs(speaker);
  if (!actor && !tokenImg) return null;
  const r = resolveImages({ actor, tokenImg, expressionId });
  return {
    id: r.entry?.id ?? null,
    name: r.entry ? (r.entry.id === DEFAULT_EXPRESSION ? L("Expression.Default") : r.entry.name) : null,
    face: r.face,
    stand: r.stand,
    faceSource: r.faceSource,
    standSource: r.standSource,
    standStyle: actor ? getStandStyle(actor) : null,
  };
}

/* -------------------------------------------- */
/*  Message freezing                            */
/* -------------------------------------------- */

const isChitchat = (message) => !!message?.flags?.["gatos-chat-tools"]?.chitchat;

/**
 * Freeze the speaker's expression images on a new message (author's client only).
 * Runs from chat-tools' `gctSpeakerResolved` hook (after the speaker lock) or, as a fallback,
 * from preCreateChatMessage.
 */
export function freezeExpression(message, data, options, userId) {
  if (userId !== game.user.id) return;
  if (isChitchat(message) || isGctNote(message)) return;
  const speaker = message.speaker;
  const { actor } = speakerDocs(speaker);
  const update = {};
  let expressionId = actor ? getCurrentExpression(actor.id) : DEFAULT_EXPRESSION;

  // Inline tag: "{웃음} 대사" speaks this one message with that expression.
  if (actor && setting("inlineTag") && !message.isRoll && typeof message.content === "string") {
    // tags.js: `{@…}` (chat-tools font styles) and `{{…}}` (keyword links) are never an expression tag.
    const tag = splitInlineTag(message.content);
    const entry = tag ? findExpressionByName(actor, tag.name) : null;
    if (entry) {
      update.content = tag.rest;
      expressionId = entry.id;
      if (setting("inlineTagSticky")) setCurrentExpression(actor.id, entry.id);
    }
  }
  const override = message.flags?.[MODULE_ID]?.expressionOverride;
  if (actor && override && getExpressions(actor).some((e) => e.id === override)) expressionId = override;

  const flag = expressionFlagFor(speaker, expressionId);
  if (flag) update[`flags.${MODULE_ID}.expression`] = flag;
  if (override !== undefined) update[`flags.${MODULE_ID}.-=expressionOverride`] = null;
  if (!foundry.utils.isEmpty(update)) message.updateSource(update);
}

/** preUpdateChatMessage: when the speaker changes (chat-tools edit dialog), re-freeze with the new speaker's default. */
export function onPreUpdateChatMessage(message, changes, options, userId) {
  if (userId !== game.user.id || !changes.speaker) return;
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.expression`)) return;
  const before = message.speaker ?? {};
  const after = foundry.utils.mergeObject(foundry.utils.deepClone(before), changes.speaker, { inplace: false });
  if (before.actor === after.actor && before.token === after.token && before.scene === after.scene) return;
  const flag = expressionFlagFor(after, DEFAULT_EXPRESSION);
  foundry.utils.setProperty(changes, `flags.${MODULE_ID}.expression`, flag);
  if (!flag) {
    delete changes.flags[MODULE_ID].expression;
    changes.flags[MODULE_ID]["-=expression"] = null;
  }
}

/** chat-tools portrait provider: the frozen face (with the expression name as label, except for the default). */
export function portraitProvider(message) {
  const e = message?.flags?.[MODULE_ID]?.expression;
  if (!e?.face) return null;
  return { img: e.face, label: e.id && e.id !== DEFAULT_EXPRESSION ? e.name : null };
}
