import { MODULE_ID, TEMPLATES, DEFAULT_EXPRESSION, L, mod } from "./constants.js";
import { PerDocumentMixin, addActorSheetHeaderButton, canControl } from "./lib.js";
import { getExpressions, getStandStyle, setExpressions, resolveImages, validateExpressions } from "./expressions.js";
import { ACTOR_CONTEXT_HOOK } from "./compat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SOURCE_KEYS = {
  face: "Source.Face",
  stand: "Source.Stand",
  defaultFace: "Source.DefaultFace",
  defaultStand: "Source.DefaultStand",
  token: "Source.Token",
  actor: "Source.Actor",
};

/**
 * Actor expression / standing image editor (PLAN §5.1). One window per actor: gatos-lib PerDocumentMixin
 * registry keyed by actor uuid (dropped on close, as 0.3.0's Map was); `open()` re-renders an open editor.
 */
export class ExpressionConfig extends PerDocumentMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  /** PerDocumentMixin.open(actor) → this constructor. */
  static createFor(actor, options = {}) {
    return new this({ actor, ...options });
  }

  /** Open (or focus) the editor for an actor. */
  static open(actor) {
    if (!actor) return null;
    if (!game.user.isGM && !actor.isOwner) {
      ui.notifications.warn(L("Config.NoPermission"));
      return null;
    }
    const app = this.instanceFor(actor);
    if (app) {
      app.render({ force: true });
      return app;
    }
    return super.open(actor);
  }

  /** Re-render open editors after an actor changed elsewhere. */
  static refreshFor(actor) {
    const app = this.instanceFor(actor);
    if (app?.rendered && !app.#dirty) {
      app.#load();
      app.render();
    }
  }

  constructor({ actor, ...options } = {}) {
    super({ id: `gvn-expressions-${actor.id}`, ...options });
    this.actor = actor;
    this.#load();
  }

  #list = [];
  #stand = { scale: 1, offsetY: 0 };
  #selected = DEFAULT_EXPRESSION;
  #dirty = false;

  #load() {
    this.#list = foundry.utils.deepClone(getExpressions(this.actor));
    this.#stand = getStandStyle(this.actor);
    if (!this.#list.some((e) => e.id === this.#selected)) this.#selected = DEFAULT_EXPRESSION;
    this.#dirty = false;
  }

  static DEFAULT_OPTIONS = {
    classes: ["gvn-expression-config"],
    tag: "form",
    window: { icon: "fa-solid fa-masks-theater", resizable: true },
    position: { width: 760, height: 620 },
    form: { submitOnChange: false, closeOnSubmit: false, handler: ExpressionConfig.#onSubmit },
    actions: {
      select: ExpressionConfig.#onSelect,
      add: ExpressionConfig.#onAdd,
      remove: ExpressionConfig.#onRemove,
      moveUp: ExpressionConfig.#onMove,
      moveDown: ExpressionConfig.#onMove,
      clearImage: ExpressionConfig.#onClearImage,
      reset: ExpressionConfig.#onReset,
    },
  };

  static PARTS = { main: { template: TEMPLATES.expressionConfig } };

  get title() {
    return L("Config.Title", { name: this.actor.name });
  }

  async _prepareContext() {
    const actorImg = this.actor.img;
    const token = this.actor.getActiveTokens?.(false, true)?.[0] ?? null;
    const entries = this.#list.map((e, i) => {
      const r = resolveImages({ actor: this.#previewActor(), token, expressionId: e.id });
      return {
        ...e,
        isDefault: e.id === DEFAULT_EXPRESSION,
        label: e.id === DEFAULT_EXPRESSION ? L("Expression.Default") : e.name || L("Config.Unnamed"),
        thumb: e.face || e.stand || r.face,
        selected: e.id === this.#selected,
        canUp: i > 1,
        canDown: i > 0 && i < this.#list.length - 1,
      };
    });
    const sel = entries.find((e) => e.selected) ?? entries[0];
    const r = resolveImages({ actor: this.#previewActor(), token, expressionId: sel.id });
    return {
      entries,
      sel,
      actorImg,
      stand: this.#stand,
      preview: {
        face: r.face,
        stand: r.stand,
        faceSource: r.faceSource ? L(SOURCE_KEYS[r.faceSource]) : L("Source.None"),
        standSource: r.standSource ? L(SOURCE_KEYS[r.standSource]) : L("Source.None"),
      },
      dirty: this.#dirty,
    };
  }

  /** A stand-in actor carrying the unsaved list, so previews follow the working copy. */
  #previewActor() {
    const flags = { ...(this.actor.flags ?? {}), [MODULE_ID]: { expressions: this.#list, stand: this.#stand } };
    return { img: this.actor.img, flags, id: this.actor.id };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    // The form element survives re-renders, so these are bound once.
    this.element.addEventListener("change", (ev) => this.#onFieldChange(ev));
    this.element.addEventListener("input", (ev) => {
      if (ev.target?.name === "name") this.#syncField(ev.target);
    });
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const form = this.element;
    // Drag to reorder (the default entry stays first).
    for (const li of form.querySelectorAll(".gvn-entry[draggable=true]")) {
      li.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", li.dataset.id);
        ev.dataTransfer.effectAllowed = "move";
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
    }
    for (const li of form.querySelectorAll(".gvn-entry")) {
      li.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        li.classList.add("drop-target");
      });
      li.addEventListener("dragleave", () => li.classList.remove("drop-target"));
      li.addEventListener("drop", (ev) => {
        ev.preventDefault();
        li.classList.remove("drop-target");
        const id = ev.dataTransfer.getData("text/plain");
        this.#moveTo(id, li.dataset.id);
      });
    }
  }

  #entry(id = this.#selected) {
    return this.#list.find((e) => e.id === id);
  }

  #syncField(input) {
    const e = this.#entry();
    if (!e) return;
    const field = input.name;
    if (field === "name" && e.id !== DEFAULT_EXPRESSION) {
      e.name = input.value;
      const label = this.element.querySelector(`.gvn-entry[data-id="${e.id}"] .gvn-entry-name`);
      if (label) label.textContent = input.value || L("Config.Unnamed");
    } else if (field === "face" || field === "stand") {
      e[field] = input.value ?? "";
    } else if (field === "scale" || field === "offsetY") {
      this.#stand[field] = Number(input.value);
    } else return false;
    this.#dirty = true;
    return true;
  }

  #onFieldChange(ev) {
    const target = ev.target;
    if (!target?.name) return;
    if (this.#syncField(target) && target.name !== "name") this.render();
  }

  #moveTo(id, beforeId) {
    if (!id || id === beforeId || id === DEFAULT_EXPRESSION) return;
    const from = this.#list.findIndex((e) => e.id === id);
    if (from < 1) return;
    const [item] = this.#list.splice(from, 1);
    let to = this.#list.findIndex((e) => e.id === beforeId);
    to = Math.max(1, to < 0 ? this.#list.length : to);
    this.#list.splice(to, 0, item);
    this.#dirty = true;
    this.render();
  }

  static #onSelect(event, target) {
    const id = target.closest("[data-id]")?.dataset.id;
    if (!id || id === this.#selected) return;
    this.#selected = id;
    this.render();
  }

  static #onAdd() {
    const used = new Set(this.#list.map((e) => e.name));
    let n = this.#list.length;
    let name = L("Config.NewName", { n });
    while (used.has(name)) name = L("Config.NewName", { n: ++n });
    const id = foundry.utils.randomID(6);
    this.#list.push({ id, name, face: "", stand: "" });
    this.#selected = id;
    this.#dirty = true;
    this.render();
  }

  static #onRemove(event, target) {
    const id = target.closest("[data-id]")?.dataset.id ?? this.#selected;
    if (id === DEFAULT_EXPRESSION) return;
    const i = this.#list.findIndex((e) => e.id === id);
    if (i < 0) return;
    this.#list.splice(i, 1);
    if (this.#selected === id) this.#selected = this.#list[Math.min(i, this.#list.length - 1)]?.id ?? DEFAULT_EXPRESSION;
    this.#dirty = true;
    this.render();
  }

  static #onMove(event, target) {
    const id = target.closest("[data-id]")?.dataset.id;
    const i = this.#list.findIndex((e) => e.id === id);
    const dir = target.dataset.action === "moveUp" ? -1 : 1;
    const j = i + dir;
    if (i < 1 || j < 1 || j >= this.#list.length) return;
    [this.#list[i], this.#list[j]] = [this.#list[j], this.#list[i]];
    this.#dirty = true;
    this.render();
  }

  static #onClearImage(event, target) {
    const field = target.dataset.field;
    const e = this.#entry();
    if (!e || !["face", "stand"].includes(field)) return;
    e[field] = "";
    this.#dirty = true;
    this.render();
  }

  static #onReset() {
    this.#load();
    this.render();
  }

  static async #onSubmit() {
    // Pick up a name typed but not yet blurred.
    const nameInput = this.element.querySelector("input[name=name]");
    if (nameInput) this.#syncField(nameInput);
    const err = validateExpressions(this.#list);
    if (err) return ui.notifications.warn(L(err));
    const ok = await setExpressions(this.actor, this.#list, this.#stand);
    if (!ok) return;
    this.#dirty = false;
    ui.notifications.info(L("Config.Saved", { name: this.actor.name }));
    this.#load();
    this.render();
  }

}

export const openExpressionConfig = (actor) => ExpressionConfig.open(actor);

/* -------------------------------------------- */
/*  Entry points: sheet header, directory menu  */
/* -------------------------------------------- */

/** GM or owner (gatos-lib canControl). */
const canEdit = (actor) => canControl(game.user, actor);

export function registerExpressionConfigHooks() {
  // Actor sheet header, AppV2 (control pushed last, key label) and legacy AppV1 (button first, short label) — as in 0.3.0.
  addActorSheetHeaderButton(mod, {
    cls: "gvn-expressions",
    action: "gvnExpressions",
    icon: "fa-solid fa-masks-theater",
    label: { v1: "GVN.Config.OpenShort", v2: "GVN.Config.Open" },
    position: { v1: "start", v2: "end" },
    condition: (actor) => canEdit(actor),
    onClick: (actor) => openExpressionConfig(actor),
  });
  // Actor directory context menu.
  Hooks.on(ACTOR_CONTEXT_HOOK, (app, options) => {
    options.push({
      name: "GVN.Config.Open",
      icon: '<i class="fa-solid fa-masks-theater"></i>',
      condition: (li) => canEdit(game.actors.get(li.dataset.entryId)),
      callback: (li) => openExpressionConfig(game.actors.get(li.dataset.entryId)),
    });
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) || "img" in changes) ExpressionConfig.refreshFor(actor);
  });
}
