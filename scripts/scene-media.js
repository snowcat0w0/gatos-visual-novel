import { MODULE_ID, TEMPLATES, L, mod } from "./constants.js";
import { SingletonMixin, uploadToData, promptText, confirm } from "./lib.js";
import { setting } from "./settings.js";
import { normalizeMedia, hasMedia, presetList, mediaTileData, planTileSync, isVideoPath, ROLES, ROLE_FLAG, MEDIA_FLAG, MEDIA_LIMITS, FITS } from "./media-core.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Scene media ("장면 연출"): a full-canvas backdrop and a centre image per scene, shown with Tile documents.
 *
 * Safety rules (world data):
 *  - Scene and Level backgrounds are never read for writing nor changed.
 *  - Tiles are written only by an explicit GM action (apply, clear, apply a preset), never on canvasReady or while a
 *    slider moves. A sync diffs the module's own fields first and makes no request when nothing changed.
 *  - One tile per role, recognised by `flags.gatos-visual-novel.mediaRole`; other tiles are never touched.
 *  - Scene flags are written by narrow keys (`media`, `presets.<id>`).
 * Client-local only: hiding the grid and the scene border, the hotbar class, the background colour (through the
 * core `configureCanvasEnvironment` hook) and slider previews.
 */

export const PRESETS_FLAG = "presets";
const BLUR_DIR = () => `worlds/${game.world.id}/gatos-vn-blur`;

const flagsOf = (scene) => scene?.flags?.[MODULE_ID] ?? {};
export const getMedia = (scene) => normalizeMedia(flagsOf(scene)[MEDIA_FLAG]);
export const sceneHasMedia = (scene) => !!flagsOf(scene)[MEDIA_FLAG] && hasMedia(flagsOf(scene)[MEDIA_FLAG]);
export const getPresets = (scene) => presetList(flagsOf(scene)[PRESETS_FLAG]);
const isVideo = (src) => !!src && (foundry.helpers?.media?.VideoHelper?.hasVideoExtension?.(src) ?? isVideoPath(src));

function gmOnly() {
  if (game.user.isGM) return true;
  mod.notify.warn("Stage.GMOnly");
  return false;
}

/* -------------------------------------------- */
/*  Tiles                                       */
/* -------------------------------------------- */

let syncQueue = Promise.resolve();

/** Tiles of this module per role (sources, oldest first). */
function mediaTiles(scene) {
  const out = Object.fromEntries(ROLES.map((r) => [r, []]));
  for (const t of scene.tiles) {
    const role = t.flags?.[MODULE_ID]?.[ROLE_FLAG];
    if (out[role]) out[role].push(t._source);
  }
  return out;
}

/**
 * GM: make the scene's media tiles match its media flag (create / update / delete only what differs).
 * Serialised, so two quick clicks cannot create duplicates.
 * @returns {Promise<{creates: object[], updates: object[], deletes: string[]}|null>}
 */
export function syncMediaTiles(scene) {
  if (!game.user.isGM || !scene) return Promise.resolve(null);
  const run = async () => {
    const media = sceneHasMedia(scene) ? getMedia(scene) : null;
    const dims = scene.dimensions;
    const desired = Object.fromEntries(ROLES.map((r) => [r, media ? mediaTileData(r, media, dims, MODULE_ID) : null]));
    const plan = planTileSync(mediaTiles(scene), desired);
    if (plan.deletes.length) await scene.deleteEmbeddedDocuments("Tile", [...new Set(plan.deletes)]);
    if (plan.updates.length) await scene.updateEmbeddedDocuments("Tile", plan.updates);
    if (plan.creates.length) await scene.createEmbeddedDocuments("Tile", plan.creates);
    return plan;
  };
  syncQueue = syncQueue.catch(() => null).then(run);
  return syncQueue.catch((err) => {
    mod.error("media tile sync failed", err);
    mod.notify.error("Media.SyncFailed");
    return null;
  });
}

/** GM: store media on a scene (only when it changed) and sync its tiles. */
export async function applyMedia(scene, media) {
  if (!gmOnly() || !scene) return;
  const clean = normalizeMedia(media);
  const prev = flagsOf(scene)[MEDIA_FLAG];
  // `clean` carries every field, so the (merging) update leaves nothing stale behind.
  if (!prev || !foundry.utils.equals(normalizeMedia(prev), clean)) await scene.update({ [`flags.${MODULE_ID}.${MEDIA_FLAG}`]: clean });
  await syncMediaTiles(scene);
}

/** GM: remove the scene's media and its tiles (other tiles and the scene background stay). */
export async function clearMedia(scene) {
  if (!gmOnly() || !scene) return;
  if (flagsOf(scene)[MEDIA_FLAG]) await scene.update({ [`flags.${MODULE_ID}.${MEDIA_FLAG}`]: _del });
  await syncMediaTiles(scene);
}

/* -------------------------------------------- */
/*  Location presets                            */
/* -------------------------------------------- */

/** GM: save media as a named location preset of the scene. */
export async function savePreset(scene, name, media) {
  if (!gmOnly() || !scene) return null;
  const id = foundry.utils.randomID(8);
  const preset = { id, name: String(name).trim() || L("Media.PresetUnnamed"), media: normalizeMedia(media), sort: Date.now() };
  await scene.update({ [`flags.${MODULE_ID}.${PRESETS_FLAG}.${id}`]: preset });
  return preset;
}

/** GM: delete a preset. */
export async function deletePreset(scene, id) {
  if (!gmOnly() || !scene || !flagsOf(scene)[PRESETS_FLAG]?.[id]) return;
  await scene.update({ [`flags.${MODULE_ID}.${PRESETS_FLAG}.${id}`]: _del });
}

/** GM: apply a preset (writes the media flag and syncs the tiles). */
export async function applyPreset(scene, id) {
  const preset = getPresets(scene).find((p) => p.id === id);
  if (!preset) return;
  await applyMedia(scene, preset.media);
  ui.notifications.info(L("Media.PresetApplied", { name: preset.name }));
}

/* -------------------------------------------- */
/*  Blurred backdrop copy                       */
/* -------------------------------------------- */

async function shortHash(text) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * GM: bake a blurred copy of an image into `worlds/<world>/gatos-vn-blur/` (WebP, ASCII name from a hash of the
 * source path) and return its path. Never for video. Needs the FILES_UPLOAD permission.
 */
export async function bakeBlur(src, radius = MEDIA_LIMITS.blurRadius.default) {
  if (!game.user.can("FILES_UPLOAD")) throw new Error(L("Media.NoUpload"));
  if (!src) throw new Error(L("Media.NoBackdrop"));
  if (isVideo(src)) throw new Error(L("Media.BlurVideo"));
  radius = Math.round(Math.min(MEDIA_LIMITS.blurRadius.max, Math.max(MEDIA_LIMITS.blurRadius.min, Number(radius) || 16)));
  // Same-origin fetch + createImageBitmap: no CORS taint, no <img> element.
  const res = await fetch(src, { credentials: "same-origin" });
  if (!res.ok) throw new Error(L("Media.BlurLoadFailed", { status: res.status }));
  const bitmap = await createImageBitmap(await res.blob());
  const MAX = 1600;
  const k = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  const bleed = radius * 2;
  if (typeof ctx.filter === "string") {
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(bitmap, -bleed, -bleed, w + bleed * 2, h + bleed * 2);
  } else {
    // No canvas filters: down- and up-scale with smoothing.
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(w / radius));
    small.height = Math.max(1, Math.round(h / radius));
    small.getContext("2d").drawImage(bitmap, 0, 0, small.width, small.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, w, h);
  }
  bitmap.close?.();
  let blob = await new Promise((r) => cv.toBlob(r, "image/webp", 0.86));
  if (!blob || blob.type !== "image/webp") blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.9));
  if (!blob) throw new Error(L("Media.BlurEncodeFailed"));
  const ext = blob.type === "image/jpeg" ? "jpg" : "webp";
  const name = `blur-${await shortHash(src)}-r${radius}.${ext}`;
  const path = await uploadToData(BLUR_DIR(), new File([blob], name, { type: blob.type }));
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/* -------------------------------------------- */
/*  Client-local canvas chrome                  */
/* -------------------------------------------- */

function setHidden(obj, hide) {
  if (!obj || obj.destroyed) return;
  if (hide) {
    if (!obj._gvnHidden) {
      obj._gvnHidden = true;
      obj._gvnWasVisible = obj.visible;
    }
    obj.visible = false;
  } else if (obj._gvnHidden) {
    obj.visible = obj._gvnWasVisible ?? true;
    delete obj._gvnHidden;
    delete obj._gvnWasVisible;
  }
}

/**
 * The scene border: v14 InterfaceCanvasGroup#drawOutline adds an unnamed PIXI.Graphics directly to canvas.interface
 * that strokes `dimensions.rect` and `dimensions.sceneRect`. Matched by that geometry, not by "any Graphics child".
 */
function sceneOutline() {
  const group = canvas?.interface;
  const d = canvas?.dimensions;
  if (!group || !d?.sceneRect) return null;
  const same = (s, r) => !!s && s.x === r.x && s.y === r.y && s.width === r.width && s.height === r.height;
  return (
    group.children.find(
      (c) => c instanceof PIXI.Graphics && !c.destroyed && (c.geometry?.graphicsData ?? []).some((g) => same(g.shape, d.sceneRect)),
    ) ?? null
  );
}

/** Apply grid / border / hotbar hiding for the viewed scene (no world writes). */
export function applyCanvasChrome() {
  const scene = canvas?.ready ? canvas.scene : null;
  const media = scene && sceneHasMedia(scene) ? getMedia(scene) : null;
  const hide = !!media && !!setting("mediaHideGrid");
  setHidden(canvas?.interface?.grid?.mesh, hide);
  setHidden(sceneOutline(), hide);
  document.body.classList.toggle("gvn-hide-hotbar", !!media?.hideHotbar);
  document.body.classList.toggle("gvn-scene-media", !!media);
}

/** configureCanvasEnvironment: the media's background colour for this client (the scene's own colour is untouched). */
function onConfigureEnvironment(config) {
  const scene = canvas?.scene;
  if (!scene || !sceneHasMedia(scene) || config.backgroundColor !== undefined) return;
  const bg = getMedia(scene).bgColor;
  if (bg) config.backgroundColor = bg;
}

function onUpdateScene(scene, changes) {
  const f = changes.flags?.[MODULE_ID];
  if (!f) return;
  const mediaChanged = MEDIA_FLAG in f || `-=${MEDIA_FLAG}` in f;
  const presetsChanged = PRESETS_FLAG in f || `-=${PRESETS_FLAG}` in f;
  if (scene.id === canvas?.scene?.id && mediaChanged) {
    applyCanvasChrome();
    // Background colour: re-run the environment set-up locally.
    try {
      if (canvas.ready) canvas.environment.initialize();
    } catch (err) {
      mod.warn("environment refresh failed", err);
    }
  }
  if (mediaChanged || presetsChanged) {
    SceneMediaConfig.refreshFor(scene);
    Hooks.callAll(`${MODULE_ID}.presetsChanged`, scene);
  }
}

export function registerSceneMediaHooks() {
  Hooks.on("configureCanvasEnvironment", onConfigureEnvironment);
  Hooks.on("canvasReady", () => applyCanvasChrome());
  Hooks.on("updateScene", onUpdateScene);
  Hooks.on(`${MODULE_ID}.mediaChrome`, () => applyCanvasChrome());
}

/* -------------------------------------------- */
/*  Window                                      */
/* -------------------------------------------- */

/** Rounded range attributes from MEDIA_LIMITS. */
const rangeOf = (lim) => ({ min: lim.min, max: lim.max, step: lim.step });

/**
 * "장면 연출" (GM): edit the viewed scene's media and presets. Controls change a working copy and preview on this
 * client only; "Apply" writes the flag and syncs the tiles.
 */
export class SceneMediaConfig extends SingletonMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    id: "gvn-scene-media",
    classes: ["gvn-scene-media"],
    tag: "form",
    window: { title: "GVN.Media.Title", icon: "fa-solid fa-panorama", resizable: true },
    position: { width: 560, height: "auto" },
    form: { submitOnChange: false, closeOnSubmit: false, handler: SceneMediaConfig.#onSubmit },
    actions: {
      clear: SceneMediaConfig.#onClear,
      bakeBlur: SceneMediaConfig.#onBakeBlur,
      savePreset: SceneMediaConfig.#onSavePreset,
      applyPreset: SceneMediaConfig.#onApplyPreset,
      loadPreset: SceneMediaConfig.#onLoadPreset,
      deletePreset: SceneMediaConfig.#onDeletePreset,
      revert: SceneMediaConfig.#onRevert,
    },
  };

  static PARTS = { main: { template: TEMPLATES.sceneMedia, scrollable: [".gvn-sm-body"] } };

  /** Re-render the open window when its scene changed elsewhere (a dirty working copy is kept). */
  static refreshFor(scene) {
    const app = this.instance;
    if (app?.rendered && app.scene?.id === scene?.id) {
      if (!app.#dirty) app.#load();
      app.render();
    }
  }

  #sceneId = null;
  #media = normalizeMedia(null);
  #dirty = false;
  #previewed = false;
  #busy = false;

  constructor(options = {}) {
    super(options);
    this.#sceneId = options.sceneId ?? canvas?.scene?.id ?? null;
    this.#load();
  }

  get scene() {
    return game.scenes.get(this.#sceneId) ?? null;
  }

  /** Switch the open window to another scene (unsaved changes are dropped). */
  setScene(sceneId) {
    if (sceneId === this.#sceneId) return;
    this.#endPreview();
    this.#sceneId = sceneId;
    this.#load();
    this.render({ force: true });
  }

  get title() {
    return `${L("Media.Title")}${this.scene ? ` — ${this.scene.name}` : ""}`;
  }

  #load() {
    this.#media = foundry.utils.deepClone(getMedia(this.scene));
    this.#dirty = false;
  }

  async _prepareContext() {
    const scene = this.scene;
    const m = this.#media;
    const fits = (sel) => FITS.map((f) => ({ value: f, label: L(`Media.Fit${f.charAt(0).toUpperCase()}${f.slice(1)}`), selected: f === sel }));
    return {
      scene,
      sceneName: scene?.name ?? "",
      media: m,
      backdropFits: fits(m.backdrop.fit),
      centerFits: fits(m.center.fit),
      opacityRange: rangeOf(MEDIA_LIMITS.opacity),
      scaleRange: rangeOf(MEDIA_LIMITS.centerScale),
      bgOn: !!m.bgColor,
      bgColor: m.bgColor || "#111111",
      backdropIsVideo: isVideo(m.backdrop.src),
      canBlur: game.user.can("FILES_UPLOAD") && !!m.backdrop.src && !isVideo(m.backdrop.src),
      canUpload: game.user.can("FILES_UPLOAD"),
      presets: getPresets(scene),
      applied: sceneHasMedia(scene),
      dirty: this.#dirty,
      busy: this.#busy,
    };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this.element.addEventListener("change", (ev) => this.#onControl(ev, true));
    this.element.addEventListener("input", (ev) => this.#onControl(ev, false));
  }

  /** Read every named control into the working copy. */
  #readControls() {
    const form = this.element;
    const val = (name) => form.querySelector(`[name="${name}"]`)?.value;
    const checked = (name) => !!form.querySelector(`[name="${name}"]`)?.checked;
    const next = {
      backdrop: {
        src: val("backdrop.src") ?? "",
        fit: val("backdrop.fit"),
        opacity: Number(val("backdrop.opacity")),
        blurSrc: this.#media.backdrop.blurSrc,
        useBlur: checked("backdrop.useBlur"),
      },
      center: { src: val("center.src") ?? "", fit: val("center.fit"), scale: Number(val("center.scale")) },
      bgColor: checked("bgOn") ? val("bgColor") : "",
      hideHotbar: checked("hideHotbar"),
    };
    // A different backdrop image invalidates the baked copy.
    if (next.backdrop.src !== this.#media.backdrop.src) {
      next.backdrop.blurSrc = "";
      next.backdrop.useBlur = false;
    }
    return normalizeMedia(next);
  }

  #onControl(ev, committed) {
    if (!ev.target?.closest?.("[name], range-picker, file-picker")) return;
    const next = this.#readControls();
    if (foundry.utils.equals(next, this.#media)) return;
    this.#media = next;
    this.#dirty = true;
    this.#preview();
    // Structural changes (image picked, blur toggled) re-render; slider moves only preview.
    if (committed && ev.target.closest?.("file-picker, [type=checkbox], select")) this.render();
    else this.#markDirty();
  }

  #markDirty() {
    this.element.querySelector(".gvn-sm-dirty")?.removeAttribute("hidden");
  }

  /** Client-local preview on the existing tiles of the viewed scene: opacity and centre scale only. */
  #preview() {
    const scene = this.scene;
    if (!scene || scene.id !== canvas?.scene?.id || !canvas.ready) return;
    const d = canvas.dimensions;
    for (const tile of canvas.tiles?.placeables ?? []) {
      const role = tile.document.flags?.[MODULE_ID]?.[ROLE_FLAG];
      if (!role || !tile.mesh) continue;
      try {
        if (role === "backdrop") tile.mesh.unoccludedAlpha = this.#media.backdrop.opacity;
        if (role === "center") {
          const k = this.#media.center.scale;
          tile.mesh.resize(Math.round(d.sceneWidth * k), Math.round(d.sceneHeight * k), { fit: tile.document.texture.fit, scaleX: 1, scaleY: 1 });
        }
        this.#previewed = true;
      } catch (err) {
        mod.warn("media preview failed", err);
      }
    }
  }

  /** Put the tiles back to their document state. */
  #endPreview() {
    if (!this.#previewed) return;
    this.#previewed = false;
    for (const tile of canvas?.tiles?.placeables ?? []) {
      if (tile.document.flags?.[MODULE_ID]?.[ROLE_FLAG]) tile.renderFlags.set({ refreshMesh: true, refreshSize: true });
    }
  }

  _onClose(options) {
    this.#endPreview();
    super._onClose(options);
  }

  async #run(fn) {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await fn();
    } catch (err) {
      mod.error(err);
      ui.notifications.error(err?.message ?? String(err));
    } finally {
      this.#busy = false;
      if (this.rendered) this.render();
    }
  }

  /** Apply (submit). */
  static async #onSubmit() {
    const scene = this.scene;
    if (!scene) return mod.notify.warn("Media.NoScene");
    this.#media = this.#readControls();
    await this.#run(async () => {
      this.#endPreview();
      if (!hasMedia(this.#media)) {
        await clearMedia(scene);
        mod.notify.info("Media.Cleared");
      } else {
        await applyMedia(scene, this.#media);
        mod.notify.info("Media.Applied");
      }
      this.#load();
    });
  }

  static async #onClear() {
    const scene = this.scene;
    if (!scene) return;
    const ok = await confirm({ title: L("Media.Title"), content: L("Media.ClearConfirm") });
    if (!ok) return;
    await this.#run(async () => {
      this.#endPreview();
      await clearMedia(scene);
      this.#load();
      mod.notify.info("Media.Cleared");
    });
  }

  static #onRevert() {
    this.#endPreview();
    this.#load();
    this.render();
  }

  static async #onBakeBlur() {
    const src = this.#media.backdrop.src;
    await this.#run(async () => {
      const progress = ui.notifications.info(L("Media.BlurBaking"), { progress: true });
      try {
        const path = await bakeBlur(src);
        this.#media = normalizeMedia({ ...this.#media, backdrop: { ...this.#media.backdrop, blurSrc: path, useBlur: true } });
        this.#dirty = true;
        progress.update({ pct: 1, message: L("Media.BlurDone") });
      } catch (err) {
        progress.update({ pct: 1 });
        throw err;
      }
    });
  }

  static async #onSavePreset() {
    const scene = this.scene;
    if (!scene) return;
    const media = this.#readControls();
    if (!hasMedia(media)) return mod.notify.warn("Media.PresetEmpty");
    const name = await promptText({ title: L("Media.PresetSave"), label: L("Media.PresetName"), value: "" });
    if (!name) return;
    await this.#run(() => savePreset(scene, name, media));
  }

  static async #onApplyPreset(event, target) {
    const id = target.closest("[data-preset-id]")?.dataset.presetId;
    const scene = this.scene;
    if (!id || !scene) return;
    await this.#run(async () => {
      this.#endPreview();
      await applyPreset(scene, id);
      this.#load();
    });
  }

  static #onLoadPreset(event, target) {
    const id = target.closest("[data-preset-id]")?.dataset.presetId;
    const preset = getPresets(this.scene).find((p) => p.id === id);
    if (!preset) return;
    this.#media = foundry.utils.deepClone(preset.media);
    this.#dirty = true;
    this.#preview();
    this.render();
  }

  static async #onDeletePreset(event, target) {
    const row = target.closest("[data-preset-id]");
    const scene = this.scene;
    if (!row || !scene) return;
    const ok = await confirm({ title: L("Media.PresetDelete"), content: L("Media.PresetDeleteConfirm", { name: row.dataset.presetName ?? "" }) });
    if (ok) await this.#run(() => deletePreset(scene, row.dataset.presetId));
  }
}

/** Open the window for the viewed scene (GM). */
export function openSceneMedia(scene = canvas?.scene) {
  if (!gmOnly()) return null;
  if (!scene) return mod.notify.warn("Media.NoScene");
  const open = SceneMediaConfig.instance;
  if (open?.rendered) open.setScene(scene.id);
  return SceneMediaConfig.open({ sceneId: scene.id });
}
