import { TEMPLATES, L, mod } from "./constants.js";
import { SingletonMixin, impl } from "./lib.js";
import { getPcCast, setPcCast, getNpcCast, setNpcSeat, PC_SEATS } from "./cast.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const sameSeat = (a, b) => (a?.actorId ?? null) === (b?.actorId ?? null) && !!a?.visible === !!b?.visible && !!a?.mirror === !!b?.mirror;

/**
 * "출연진 설정" (GM): the world's PC cast (6 seats) and the viewed scene's NPC cast. Each seat: actor, visible,
 * mirrored. Actors can also be dropped onto a seat. Saving writes the PC setting once and each changed NPC seat by
 * its own key.
 */
export class CastConfig extends SingletonMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    id: "gvn-cast-config",
    classes: ["gvn-cast-config"],
    tag: "form",
    window: { title: "GVN.Cast.Title", icon: "fa-solid fa-users", resizable: true },
    position: { width: 560, height: "auto" },
    form: { submitOnChange: false, closeOnSubmit: false, handler: CastConfig.#onSubmit },
    actions: { clearSeat: CastConfig.#onClearSeat, reset: CastConfig.#onReset },
  };

  static PARTS = { main: { template: TEMPLATES.castConfig, scrollable: [".gvn-cc-body"] } };

  #pc = [];
  #npc = [];
  #sceneId = null;
  #dirty = false;

  constructor(options = {}) {
    super(options);
    this.#load();
  }

  get scene() {
    return game.scenes.get(this.#sceneId) ?? null;
  }

  #load() {
    this.#sceneId = canvas?.scene?.id ?? null;
    this.#pc = getPcCast().map((s) => (s ? { ...s } : null));
    this.#npc = this.scene ? getNpcCast(this.scene).map((s) => (s ? { ...s } : null)) : [];
    this.#dirty = false;
  }

  /** Settings / flags changed elsewhere: reload unless there are unsaved edits. */
  static refresh() {
    const app = this.instance;
    if (!app?.rendered) return;
    if (!app.#dirty) app.#load();
    app.render();
  }

  async _prepareContext() {
    const actors = game.actors.contents.slice().sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    const row = (seat, i, group) => {
      const actor = seat ? game.actors.get(seat.actorId) : null;
      return {
        group,
        index: i,
        n: i + 1,
        actorId: actor?.id ?? "",
        img: actor?.img ?? null,
        missing: !!seat && !actor,
        visible: seat ? seat.visible : true,
        mirror: !!seat?.mirror,
        options: actors.map((a) => ({ id: a.id, name: a.name, selected: a.id === actor?.id })),
      };
    };
    const scene = this.scene;
    return {
      groups: [
        { legend: L("Cast.PcLegend"), rows: this.#pc.map((s, i) => row(s, i, "pc")), empty: "" },
        {
          legend: scene ? `${L("Cast.NpcLegend")} — ${scene.name}` : L("Cast.NpcLegend"),
          rows: scene ? this.#npc.map((s, i) => row(s, i, "npc")) : [],
          empty: L("Media.NoScene"),
        },
      ],
      dirty: this.#dirty,
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this.element.addEventListener("change", (ev) => this.#onChange(ev));
    this.element.addEventListener("dragover", (ev) => {
      if (ev.target.closest?.(".gvn-cc-seat")) ev.preventDefault();
    });
    this.element.addEventListener("drop", (ev) => this.#onDrop(ev));
  }

  #list(group) {
    return group === "npc" ? this.#npc : this.#pc;
  }

  #onChange(ev) {
    const rowEl = ev.target.closest?.(".gvn-cc-seat");
    if (!rowEl) return;
    const list = this.#list(rowEl.dataset.group);
    const i = Number(rowEl.dataset.index);
    const field = ev.target.dataset.field;
    if (field === "actor") {
      const id = ev.target.value;
      list[i] = id ? { actorId: id, visible: list[i]?.visible ?? true, mirror: list[i]?.mirror ?? false } : null;
    } else if (field === "visible" || field === "mirror") {
      if (!list[i]) return;
      list[i] = { ...list[i], [field]: ev.target.checked };
    } else return;
    this.#dirty = true;
    this.render();
  }

  async #onDrop(ev) {
    const rowEl = ev.target.closest?.(".gvn-cc-seat");
    if (!rowEl) return;
    ev.preventDefault();
    const data = impl.TextEditor().getDragEventData(ev);
    if (data?.type !== "Actor" || !data.uuid) return;
    const actor = await fromUuid(data.uuid).catch(() => null);
    if (!actor || actor.pack) return mod.notify.warn("Cast.WorldActorsOnly");
    const list = this.#list(rowEl.dataset.group);
    const i = Number(rowEl.dataset.index);
    list[i] = { actorId: actor.id, visible: list[i]?.visible ?? true, mirror: list[i]?.mirror ?? false };
    this.#dirty = true;
    this.render();
  }

  static #onClearSeat(event, target) {
    const rowEl = target.closest(".gvn-cc-seat");
    if (!rowEl) return;
    this.#list(rowEl.dataset.group)[Number(rowEl.dataset.index)] = null;
    this.#dirty = true;
    this.render();
  }

  static #onReset() {
    this.#load();
    this.render();
  }

  static async #onSubmit() {
    // One actor per cast: a later seat holding the same actor is dropped.
    const seen = new Set();
    const dedupe = (s) => {
      if (!s || seen.has(s.actorId)) return null;
      seen.add(s.actorId);
      return s;
    };
    const pc = this.#pc.map(dedupe);
    const npc = this.#npc.map(dedupe);
    const prevPc = getPcCast();
    if (pc.some((s, i) => !sameSeat(s, prevPc[i]))) await setPcCast(pc.concat(Array(Math.max(0, PC_SEATS - pc.length)).fill(null)));
    const scene = this.scene;
    if (scene) {
      const prevNpc = getNpcCast(scene);
      for (let i = 0; i < npc.length; i++) if (!sameSeat(npc[i], prevNpc[i])) await setNpcSeat(scene, i, npc[i]);
    }
    this.#load();
    this.render();
    ui.notifications.info(L("Cast.Saved"));
  }
}

export function openCastConfig() {
  if (!game.user.isGM) return mod.notify.warn("Stage.GMOnly");
  return CastConfig.open();
}

export function registerCastConfigHooks() {
  const refresh = () => CastConfig.refresh();
  Hooks.on("gatos-visual-novel.castChanged", refresh);
  Hooks.on("canvasReady", refresh);
  Hooks.on("updateScene", (scene, changes) => {
    if (changes.flags?.["gatos-visual-novel"]) refresh();
  });
}
