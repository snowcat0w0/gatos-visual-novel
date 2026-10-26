import { MODULE_ID, TEMPLATES, L, mod } from "./constants.js";
import { SingletonMixin, itemIndex, invalidateItemIndex, debounce, pickOne } from "./lib.js";
import { setting } from "./settings.js";
import { castMembers, paletteAccepts, giveItemTo, getNpcCast, setNpcSeat, pcActorIds, npcSeatCount } from "./cast.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * GM palettes: items to hand out (drag onto a PC cast stand, right-click to pick a PC, double-click opens the
 * sheet) and NPCs to put into / take out of the viewed scene's NPC cast.
 */

const ITEM_INDEX = { key: `${MODULE_ID}.item-palette`, fields: ["folder"], includeWorld: true, visibleOnly: true };
const LIMIT = 300;
const norm = (s) => String(s ?? "").trim().toLocaleLowerCase();

/** Folder of an index entry (world or compendium) and its key `<world|pack>:<id>`. */
function folderOf(entry) {
  if (!entry.folder) return null;
  const id = typeof entry.folder === "object" ? entry.folder?._id ?? entry.folder?.id : entry.folder;
  if (!id) return null;
  return entry.pack ? game.packs.get(entry.pack)?.folders?.get(id) ?? null : game.folders.get(id) ?? null;
}

const folderKey = (folder, pack) => `${pack ?? "world"}:${folder.id}`;
/** Folder chain from the outermost ancestor down to the folder itself. */
const folderChain = (folder) => (folder ? [...(folder.ancestors ?? []).slice().reverse(), folder] : []);
const folderPath = (folder) => folderChain(folder).map((f) => f.name).join(" / ");

/** Folder select options for a set of entries, grouped by source, sorted by path. */
function folderOptions(entries, selected, sourceTitle) {
  const map = new Map();
  for (const e of entries) {
    for (const f of folderChain(folderOf(e))) {
      const key = folderKey(f, e.pack);
      if (map.has(key)) continue;
      map.set(key, { key, label: folderPath(f), group: sourceTitle(e), selected: key === selected });
    }
  }
  const groups = new Map();
  for (const o of [...map.values()].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))) {
    if (!groups.has(o.group)) groups.set(o.group, []);
    groups.get(o.group).push(o);
  }
  return [...groups.entries()].map(([label, options]) => ({ label, options }));
}

/** Does the entry sit (directly or deeper) in the folder `key`? */
const inFolder = (entry, key) => !key || folderChain(folderOf(entry)).some((f) => folderKey(f, entry.pack) === key);

/** PC cast members to give an item to (asks when there are several). */
async function pickPc(title) {
  const pcs = castMembers(canvas?.scene, { includeHidden: true }).filter((m) => m.group === "pc");
  if (!pcs.length) {
    mod.notify.warn("Palette.NoPc");
    return null;
  }
  return pickOne(pcs, { title, label: (m) => m.actor.name, prompt: L("Palette.GiveTo") });
}

/* -------------------------------------------- */
/*  Item palette                                */
/* -------------------------------------------- */

export class ItemPalette extends SingletonMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    id: "gvn-item-palette",
    classes: ["gvn-palette", "gvn-item-palette"],
    window: { title: "GVN.Palette.ItemTitle", icon: "fa-solid fa-suitcase", resizable: true },
    position: { width: 400, height: 600 },
    actions: { favorite: ItemPalette.#onFavorite, give: ItemPalette.#onGive, reload: ItemPalette.#onReload },
    gatos: { persistPosition: { mod, key: "itemPalettePosition" } },
  };

  static PARTS = { main: { template: TEMPLATES.itemPalette, scrollable: [".gvn-pal-list"] } };

  #search = "";
  #source = "all";
  #folder = "";

  async _prepareContext() {
    let entries = [];
    let failed = false;
    try {
      entries = (await itemIndex(ITEM_INDEX)).filter((e) => paletteAccepts(e));
    } catch (err) {
      mod.error("item index failed", err);
      failed = true;
    }
    const favs = new Set(setting("itemFavorites") ?? []);
    const sourceTitle = (e) => (e.pack ? e.packTitle ?? e.pack : L("Palette.World"));
    const bySource = entries.filter((e) => {
      if (this.#source === "favorites") return favs.has(e.uuid);
      if (this.#source === "world") return !e.pack;
      if (this.#source === "compendium") return !!e.pack;
      return true;
    });
    const folders = folderOptions(bySource, this.#folder, sourceTitle);
    if (this.#folder && !folders.some((g) => g.options.some((o) => o.key === this.#folder))) this.#folder = "";
    const q = norm(this.#search);
    const matching = bySource.filter((e) => inFolder(e, this.#folder) && (!q || norm(e.name).includes(q))).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    const typeLabel = (t) => game.i18n.localize(CONFIG.Item?.typeLabels?.[t] ?? t ?? "");
    const rows = matching.slice(0, LIMIT).map((e) => ({
      uuid: e.uuid,
      name: e.name,
      img: e.img || "icons/svg/item-bag.svg",
      type: typeLabel(e.type),
      source: sourceTitle(e),
      fav: favs.has(e.uuid),
    }));
    const sources = ["all", "favorites", "world", "compendium"].map((v) => ({ value: v, label: L(`Palette.Source${v.charAt(0).toUpperCase()}${v.slice(1)}`), selected: v === this.#source }));
    return { rows, search: this.#search, sources, folders, folder: this.#folder, more: Math.max(0, matching.length - LIMIT), total: matching.length, failed };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const el = this.element;
    const rerender = debounce(() => this.render({ parts: ["main"] }).then(() => this.#refocus()), 200);
    el.addEventListener("input", (ev) => {
      if (ev.target?.name !== "search") return;
      this.#search = ev.target.value;
      rerender();
    });
    el.addEventListener("change", (ev) => {
      const name = ev.target?.name;
      if (name === "source") this.#source = ev.target.value;
      else if (name === "folder") this.#folder = ev.target.value;
      else return;
      this.render({ parts: ["main"] });
    });
    el.addEventListener("dragstart", (ev) => {
      const row = ev.target.closest?.(".gvn-pal-row[data-uuid]");
      if (!row) return;
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: row.dataset.uuid }));
      ev.dataTransfer.effectAllowed = "copy";
      document.body.classList.add("gvn-item-dragging");
    });
    el.addEventListener("dragend", () => document.body.classList.remove("gvn-item-dragging"));
    el.addEventListener("dblclick", async (ev) => {
      const row = ev.target.closest(".gvn-pal-row[data-uuid]");
      if (!row || ev.target.closest("[data-action]")) return;
      const item = await fromUuid(row.dataset.uuid).catch(() => null);
      item?.sheet?.render({ force: true });
    });
    el.addEventListener("contextmenu", (ev) => {
      const row = ev.target.closest(".gvn-pal-row[data-uuid]");
      if (!row) return;
      ev.preventDefault();
      this.#give(row.dataset.uuid, row.dataset.name);
    });
  }

  #refocus() {
    const input = this.element.querySelector("input[name=search]");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async #give(uuid, name) {
    const pc = await pickPc(L("Palette.GiveTitle", { name: name ?? "" }));
    if (pc) await giveItemTo(pc.actor, uuid);
  }

  static async #onFavorite(event, target) {
    const uuid = target.closest("[data-uuid]")?.dataset.uuid;
    if (!uuid) return;
    const list = new Set(setting("itemFavorites") ?? []);
    if (list.has(uuid)) list.delete(uuid);
    else list.add(uuid);
    await game.settings.set(MODULE_ID, "itemFavorites", [...list]);
  }

  static #onGive(event, target) {
    const row = target.closest("[data-uuid]");
    if (row) this.#give(row.dataset.uuid, row.dataset.name);
  }

  static #onReload() {
    invalidateItemIndex(ITEM_INDEX);
    this.render();
  }
}

/* -------------------------------------------- */
/*  NPC palette                                 */
/* -------------------------------------------- */

export class NpcPalette extends SingletonMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    id: "gvn-npc-palette",
    classes: ["gvn-palette", "gvn-npc-palette"],
    window: { title: "GVN.Palette.NpcTitle", icon: "fa-solid fa-user-plus", resizable: true },
    position: { width: 360, height: 560 },
    actions: { toggle: NpcPalette.#onToggle, clearSeat: NpcPalette.#onClearSeat },
    gatos: { persistPosition: { mod, key: "npcPalettePosition" } },
  };

  static PARTS = { main: { template: TEMPLATES.npcPalette, scrollable: [".gvn-pal-list"] } };

  #search = "";
  #folder = "";

  async _prepareContext() {
    const scene = canvas?.scene ?? null;
    const seats = scene ? getNpcCast(scene) : [];
    const seatOf = new Map(seats.map((s, i) => [s?.actorId, i]).filter(([id]) => id));
    const pcs = pcActorIds();
    const q = norm(this.#search);
    const actors = game.actors.contents.filter((a) => !pcs.has(a.id));
    const folders = new Map();
    for (const a of actors) for (const f of folderChain(a.folder)) folders.set(f.id, { key: f.id, label: folderPath(f), selected: f.id === this.#folder });
    if (this.#folder && !folders.has(this.#folder)) this.#folder = "";
    const rows = actors
      .filter((a) => (!this.#folder || folderChain(a.folder).some((f) => f.id === this.#folder)) && (!q || norm(a.name).includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .slice(0, LIMIT)
      .map((a) => ({ id: a.id, name: a.name, img: a.img, inCast: seatOf.has(a.id), seat: seatOf.has(a.id) ? seatOf.get(a.id) + 1 : null }));
    const seatRows = seats.map((s, i) => {
      const actor = s ? game.actors.get(s.actorId) : null;
      return { index: i, n: i + 1, name: actor?.name ?? null, img: actor?.img ?? null };
    });
    return {
      scene,
      sceneName: scene?.name ?? "",
      rows,
      seats: seatRows,
      search: this.#search,
      folders: [...folders.values()].sort((a, b) => a.label.localeCompare(b.label)),
      folder: this.#folder,
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const rerender = debounce(() => this.render({ parts: ["main"] }).then(() => this.#refocus()), 200);
    this.element.addEventListener("input", (ev) => {
      if (ev.target?.name !== "search") return;
      this.#search = ev.target.value;
      rerender();
    });
    this.element.addEventListener("change", (ev) => {
      if (ev.target?.name !== "folder") return;
      this.#folder = ev.target.value;
      this.render({ parts: ["main"] });
    });
  }

  #refocus() {
    const input = this.element.querySelector("input[name=search]");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Put an actor into the scene's NPC cast or take it out; when every seat is taken, ask which one to replace. */
  static async #onToggle(event, target) {
    const actor = game.actors.get(target.closest("[data-actor-id]")?.dataset.actorId);
    const scene = canvas?.scene;
    if (!actor) return;
    if (!scene) return mod.notify.warn("Media.NoScene");
    await toggleNpc(scene, actor);
  }

  static async #onClearSeat(event, target) {
    const index = Number(target.closest("[data-seat]")?.dataset.seat);
    if (Number.isInteger(index) && canvas?.scene) await setNpcSeat(canvas.scene, index, null);
  }
}

/** GM: toggle an actor in the scene's NPC cast (asks which seat to replace when full). */
export async function toggleNpc(scene, actor) {
  const seats = getNpcCast(scene);
  const at = seats.findIndex((s) => s?.actorId === actor.id);
  if (at >= 0) return setNpcSeat(scene, at, null);
  let index = seats.findIndex((s) => !s);
  if (index < 0) {
    const choice = await pickOne(
      seats.map((s, i) => ({ i, name: game.actors.get(s?.actorId)?.name ?? "?" })),
      { title: L("Palette.NpcFull"), label: (o) => L("Palette.SeatLabel", { n: o.i + 1, name: o.name }), prompt: L("Palette.ReplaceSeat", { name: actor.name }) },
    );
    if (!choice) return;
    index = choice.i;
  }
  if (index >= npcSeatCount()) return;
  return setNpcSeat(scene, index, { actorId: actor.id, visible: true, mirror: seats[index]?.mirror ?? false });
}

export const openItemPalette = () => (game.user.isGM ? ItemPalette.open() : mod.notify.warn("Stage.GMOnly"));
export const openNpcPalette = () => (game.user.isGM ? NpcPalette.open() : mod.notify.warn("Stage.GMOnly"));

/** Keep the palettes current (cheap: re-render only open windows, coalesced). */
export function registerPaletteHooks() {
  const refreshItems = debounce(() => ItemPalette.refresh(["main"]), 250);
  const refreshNpcs = debounce(() => NpcPalette.refresh(["main"]), 250);
  const itemsChanged = () => {
    invalidateItemIndex(ITEM_INDEX);
    if (ItemPalette.instance?.rendered) refreshItems();
  };
  for (const hook of ["createItem", "deleteItem"]) Hooks.on(hook, (item) => !item.parent && itemsChanged());
  Hooks.on("updateItem", (item, changes) => {
    if (!item.parent && ("name" in changes || "img" in changes || "folder" in changes || "type" in changes)) itemsChanged();
  });
  for (const hook of ["createFolder", "updateFolder", "deleteFolder"]) {
    Hooks.on(hook, (folder) => {
      if (folder.type === "Item") itemsChanged();
      if (folder.type === "Actor") refreshNpcs();
    });
  }
  Hooks.on("updateCompendium", () => itemsChanged());
  Hooks.on(`${MODULE_ID}.favorites`, () => ItemPalette.refresh(["main"]));
  Hooks.on(`${MODULE_ID}.paletteFilters`, () => ItemPalette.refresh(["main"]));
  for (const hook of ["createActor", "deleteActor"]) Hooks.on(hook, () => refreshNpcs());
  Hooks.on("updateActor", (actor, changes) => {
    if ("name" in changes || "img" in changes || "folder" in changes) refreshNpcs();
  });
  Hooks.on("updateScene", (scene, changes) => {
    if (scene.id === canvas?.scene?.id && changes.flags?.[MODULE_ID]) refreshNpcs();
  });
  Hooks.on("canvasReady", () => refreshNpcs());
  Hooks.on(`${MODULE_ID}.castChanged`, () => refreshNpcs());
}
