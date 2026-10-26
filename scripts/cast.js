import { MODULE_ID, DEFAULT_EXPRESSION, mod } from "./constants.js";
import { providerRegistry } from "./lib.js";
import { setting } from "./settings.js";
import { getCurrentExpression, getStandStyle, resolveImages } from "./expressions.js";
import { cleanPosition } from "./stage-dom.js";

/**
 * Cast: fixed performers on the novel stage, on top of the chat-driven seating (stage-state.js "pinned" keys).
 *
 *   PC cast   world setting `pcCast` = { slots: [{ actorId, visible, mirror } | null] } (6 seats, slot ids pc0…pc5)
 *   NPC cast  scene flag `npcCast.n<i>` = { actorId, visible, mirror } (setting npcCastMax seats, slot ids npc0…)
 *   layout    world setting `castLayout` = { [slotId]: { x, y, h, a } }, overridden per seat by scene flag `layout`
 *
 * Every client reads the same documents, so everyone sees the same cast; only GMs write. Scene flags are always
 * written by narrow keys (one seat / one layout entry), never as a whole object.
 */

export const PC_SEATS = 6;
export const NPC_SEATS_MAX = 6;
export const NPC_FLAG = "npcCast";
export const LAYOUT_FLAG = "layout";

export const pcSlotId = (i) => `pc${i}`;
export const npcSlotId = (i) => `npc${i}`;
export const actorKey = (id) => `Actor.${id}`;
const SLOT_ID = /^(pc|npc)[0-5]$/;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function cleanSeat(raw) {
  if (!raw || typeof raw !== "object" || !raw.actorId) return null;
  return { actorId: String(raw.actorId), visible: raw.visible !== false, mirror: !!raw.mirror };
}

function gmOnly() {
  if (game.user.isGM) return true;
  mod.notify.warn("Stage.GMOnly");
  return false;
}

/* -------------------------------------------- */
/*  Seats                                       */
/* -------------------------------------------- */

/** The six PC seats (null = empty). */
export function getPcCast() {
  const raw = setting("pcCast")?.slots;
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: PC_SEATS }, (_, i) => cleanSeat(list[i]));
}

/** GM: replace the PC seats. */
export async function setPcCast(slots) {
  if (!gmOnly()) return;
  const clean = Array.from({ length: PC_SEATS }, (_, i) => cleanSeat(slots?.[i]));
  return game.settings.set(MODULE_ID, "pcCast", { slots: clean });
}

/** GM: change one PC seat (patch merged; null empties it). */
export async function updatePcSeat(index, patch) {
  const slots = getPcCast();
  if (index < 0 || index >= PC_SEATS) return;
  slots[index] = patch === null ? null : cleanSeat({ ...(slots[index] ?? {}), ...patch });
  return setPcCast(slots);
}

/** Number of NPC seats per scene. */
export const npcSeatCount = () => Math.max(1, Math.min(NPC_SEATS_MAX, Number(setting("npcCastMax")) || 4));

/** The NPC seats of a scene (null = empty). Seats above the configured count are kept in the data but not shown. */
export function getNpcCast(scene = canvas?.scene) {
  const raw = scene?.flags?.[MODULE_ID]?.[NPC_FLAG] ?? {};
  return Array.from({ length: npcSeatCount() }, (_, i) => cleanSeat(raw?.[`n${i}`]));
}

/** GM: set or empty one NPC seat of a scene (narrow key). */
export async function setNpcSeat(scene, index, seat) {
  if (!gmOnly() || !scene || index < 0 || index >= NPC_SEATS_MAX) return;
  const path = `flags.${MODULE_ID}.${NPC_FLAG}.n${index}`;
  return scene.update({ [path]: seat ? cleanSeat(seat) : _del });
}

/**
 * Cast members with their actors, PCs first. An actor appears once (a PC seat wins over an NPC seat).
 * @param {Scene|null} [scene]
 * @param {{includeHidden?: boolean}} [options]
 * @returns {{group: "pc"|"npc", index: number, slotId: string, actor: Actor, actorId: string, key: string, visible: boolean, mirror: boolean}[]}
 */
export function castMembers(scene = canvas?.scene, { includeHidden = false } = {}) {
  const out = [];
  const seen = new Set();
  const add = (group, seat, i) => {
    if (!seat) return;
    const actor = game.actors?.get(seat.actorId);
    if (!actor || seen.has(actor.id)) return;
    seen.add(actor.id);
    if (!includeHidden && !seat.visible) return;
    out.push({ group, index: i, slotId: group === "pc" ? pcSlotId(i) : npcSlotId(i), actor, actorId: actor.id, key: actorKey(actor.id), ...seat });
  };
  getPcCast().forEach((seat, i) => add("pc", seat, i));
  if (scene) getNpcCast(scene).forEach((seat, i) => add("npc", seat, i));
  return out;
}

/** Stage keys of the visible cast (the reducer's pinned keys). */
export const castKeys = (scene = canvas?.scene) => new Set(castMembers(scene).map((m) => m.key));

/** The visible cast member standing as `key`, or null. */
export const memberByKey = (key, scene = canvas?.scene) => castMembers(scene).find((m) => m.key === key) ?? null;

/** Actor ids in the PC cast (hidden seats included). */
export const pcActorIds = () => new Set(getPcCast().filter(Boolean).map((s) => s.actorId));

/** GM: flip a member horizontally. */
export function toggleMirror(member, scene = canvas?.scene) {
  if (!member) return;
  if (member.group === "pc") return updatePcSeat(member.index, { mirror: !member.mirror });
  return setNpcSeat(scene, member.index, { actorId: member.actorId, visible: member.visible, mirror: !member.mirror });
}

/** GM: take a member off the stage (PC: hidden, the seat is kept; NPC: the seat is emptied). */
export function removeMember(member, scene = canvas?.scene) {
  if (!member) return;
  if (member.group === "pc") return updatePcSeat(member.index, { visible: false });
  return setNpcSeat(scene, member.index, null);
}

/* -------------------------------------------- */
/*  Look (stand image)                          */
/* -------------------------------------------- */

/**
 * The user whose current expression a cast member shows, chosen the same way on every client: the assigned
 * player, other owners, then GMs (each by id), the first one who picked an expression for this actor.
 */
function expressionUser(actor) {
  const users = (game.users?.contents ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
  const assigned = users.filter((u) => u.character?.id === actor.id);
  const owners = users.filter((u) => !u.isGM && !assigned.includes(u) && actor.testUserPermission(u, "OWNER"));
  const gms = users.filter((u) => u.isGM && !assigned.includes(u));
  return [...assigned, ...owners, ...gms].find((u) => u.getFlag(MODULE_ID, "current")?.[actor.id]) ?? null;
}

/** Stand image of a cast member's current expression (GVN expressions, then token / actor image). */
export function currentLook(actor) {
  const user = expressionUser(actor);
  const expressionId = user ? getCurrentExpression(actor.id, user) : DEFAULT_EXPRESSION;
  const r = resolveImages({ actor, tokenImg: actor.prototypeToken?.texture?.src ?? null, expressionId });
  return { stand: r.stand, standStyle: getStandStyle(actor) };
}

/* -------------------------------------------- */
/*  Layout                                      */
/* -------------------------------------------- */

/** Free positions per slot id: the scene's own entries over the world's. Entries from the scene carry `scene: true`. */
export function getLayout(scene = canvas?.scene) {
  const out = {};
  for (const [k, v] of Object.entries(setting("castLayout") ?? {})) {
    const p = SLOT_ID.test(k) ? cleanPosition(v) : null;
    if (p) out[k] = p;
  }
  for (const [k, v] of Object.entries(scene?.flags?.[MODULE_ID]?.[LAYOUT_FLAG] ?? {})) {
    const p = SLOT_ID.test(k) ? cleanPosition(v) : null;
    if (p) out[k] = { ...p, scene: true };
  }
  return out;
}

/** GM: store a seat's free position in the world layout, or in the scene's own layout when `scene` is given. */
export async function saveLayout(slotId, pos, { scene = null } = {}) {
  if (!gmOnly() || !SLOT_ID.test(slotId)) return;
  const p = cleanPosition(pos);
  if (!p) return;
  const value = { x: round2(p.x), y: round2(p.y), h: round2(p.h), a: p.a ? round2(p.a) : null };
  if (scene) return scene.update({ [`flags.${MODULE_ID}.${LAYOUT_FLAG}.${slotId}`]: value });
  const all = foundry.utils.deepClone(setting("castLayout") ?? {});
  all[slotId] = value;
  return game.settings.set(MODULE_ID, "castLayout", all);
}

/** GM: forget free positions (the world's, or one scene's). */
export async function resetLayout({ scene = null } = {}) {
  if (!gmOnly()) return;
  if (scene) {
    if (!scene.flags?.[MODULE_ID]?.[LAYOUT_FLAG]) return;
    return scene.update({ [`flags.${MODULE_ID}.${LAYOUT_FLAG}`]: _del });
  }
  return game.settings.set(MODULE_ID, "castLayout", {});
}

/* -------------------------------------------- */
/*  Providers (system modules)                  */
/* -------------------------------------------- */

const statProviders = providerRegistry();
const itemProviders = providerRegistry();
const paletteFilters = [];

const changed = () => Hooks.callAll(`${MODULE_ID}.castChanged`);
const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([\d\s.,%]+\))$/i;

/**
 * Register `fn(actor) → [{ label, value, max?, color? }]` for the cast card HUD; the answers of every provider are
 * concatenated in registration order. Returns an unregister function.
 * The HUD shows nothing unless a provider answers (the module itself knows no game system).
 */
export function registerCastStatProvider(fn) {
  const off = statProviders.register(fn);
  changed();
  return () => {
    off();
    changed();
  };
}

/** Register `fn(actor) → items[]` (Item documents or `{ name, img, uuid? }`) for the cast card HUD. */
export function registerCastItemProvider(fn) {
  const off = itemProviders.register(fn);
  changed();
  return () => {
    off();
    changed();
  };
}

/** Stats for a cast card, cleaned. */
export function castStats(actor) {
  if (!statProviders.size) return [];
  return statProviders
    .all(actor)
    .flat()
    .filter((s) => s && typeof s === "object" && s.label != null)
    .map((s) => {
      const max = Number(s.max);
      return {
        label: String(s.label),
        value: typeof s.value === "number" || typeof s.value === "string" ? s.value : String(s.value ?? ""),
        max: Number.isFinite(max) && max > 0 ? max : null,
        color: typeof s.color === "string" && CSS_COLOR.test(s.color.trim()) ? s.color.trim() : null,
      };
    });
}

/** Items for a cast card, cleaned. */
export function castItems(actor) {
  if (!itemProviders.size) return [];
  return itemProviders
    .all(actor)
    .flat()
    .filter((i) => i && typeof i === "object" && i.name != null)
    .map((i) => ({ name: String(i.name), img: typeof i.img === "string" ? i.img : null, uuid: typeof i.uuid === "string" ? i.uuid : null }));
}

/**
 * Register `fn(indexEntry) → boolean` for the GM item palette: `true` shows the entry. With several filters an entry
 * is shown only when every filter returns true (none registered = everything shown).
 * Index entries: `{ _id, uuid, name, img, type, folder, pack, packTitle }`. Returns an unregister function.
 */
export function registerItemPaletteFilter(fn) {
  if (typeof fn !== "function") throw new Error(`${MODULE_ID} | registerItemPaletteFilter needs a function`);
  if (!paletteFilters.includes(fn)) paletteFilters.push(fn);
  Hooks.callAll(`${MODULE_ID}.paletteFilters`);
  return () => {
    const i = paletteFilters.indexOf(fn);
    if (i >= 0) paletteFilters.splice(i, 1);
    Hooks.callAll(`${MODULE_ID}.paletteFilters`);
  };
}

/** Does every registered palette filter return true for the entry? (A filter that throws hides nothing.) */
export function paletteAccepts(entry) {
  for (const fn of paletteFilters) {
    try {
      if (fn(entry) !== true) return false;
    } catch (err) {
      mod.warn("item palette filter failed", err);
    }
  }
  return true;
}

/* -------------------------------------------- */
/*  Items                                       */
/* -------------------------------------------- */

/** GM: give a copy of an item (world or compendium) to an actor. */
export async function giveItemTo(actor, uuid) {
  if (!gmOnly() || !actor || !uuid) return null;
  let item = null;
  try {
    item = await fromUuid(uuid);
  } catch {
    item = null;
  }
  if (!item || item.documentName !== "Item") {
    mod.notify.warn("Palette.NoItem");
    return null;
  }
  const data = item.toObject();
  for (const k of ["_id", "folder", "sort", "ownership"]) delete data[k];
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  if (created) mod.notify.info("Palette.Given", { item: item.name, actor: actor.name });
  return created ?? null;
}
