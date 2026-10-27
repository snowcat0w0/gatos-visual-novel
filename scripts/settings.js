import { MODULE_ID, mod } from "./constants.js";
import { applyEnabled, applyDisplaySettings, setMaxSlots, rebuild, refreshToggleButtons, clearLocal } from "./stage.js";
import { refreshPickers } from "./expression-picker.js";
import { onKeywordsChanged } from "./keyword-manager.js";
import { DisplaySettingsConfig } from "./display-config.js";

/**
 * gatos-lib settings table (same keys, order, scopes, types, defaults, choices and onChange as 0.3.0).
 * Lang keys default to `GVN.Settings.<PascalKey>.Name` / `.Hint`; `typewriterMs` keeps its `Typewriter` keys.
 * Hidden entries (`displayOverrides`, `keywords`, `stageClearedAt`) are `config: false` without name/hint;
 * the display menu is registered in the same place as before (between `displayOverrides` and `showRefInStage`).
 */
export function registerSettings() {
  mod.registerSettings({
    // ---- Stage visibility
    stageEnabled: { scope: "client", type: Boolean, default: true, onChange: () => applyEnabled() },
    playersCanToggle: { scope: "world", type: Boolean, default: true, onChange: () => refreshToggleButtons() },
    hideInCombat: { scope: "client", type: Boolean, default: false, onChange: () => applyEnabled() },

    // ---- Stage layout
    maxSlots: { scope: "world", type: Number, default: 6, range: { min: 1, max: 6, step: 1 }, onChange: (v) => setMaxSlots(v) },

    // ---- Display: world defaults set by the GM; each user may override single keys (see display()).
    standLayout: {
      scope: "world", type: String,
      choices: { spread: "GVN.Settings.StandLayout.Spread", fixed: "GVN.Settings.StandLayout.Fixed" },
      default: "spread", onChange: () => applyDisplaySettings(),
    },
    standHeight: { scope: "world", type: Number, default: 85, range: { min: 40, max: 100, step: 5 }, onChange: () => applyDisplaySettings() },
    dimStyle: {
      scope: "world", type: String,
      choices: { grayscale: "GVN.Settings.DimStyle.Grayscale", darken: "GVN.Settings.DimStyle.Darken", none: "GVN.Settings.DimStyle.None" },
      default: "grayscale", onChange: () => applyDisplaySettings(),
    },
    dialogueOpacity: { scope: "world", type: Number, default: 0.8, range: { min: 0.2, max: 1, step: 0.05 }, onChange: () => applyDisplaySettings() },
    dialogueFontSize: { scope: "world", type: Number, default: 18, range: { min: 12, max: 32, step: 1 }, onChange: () => applyDisplaySettings() },
    typewriterMs: { scope: "world", type: Number, default: 0, range: { min: 0, max: 100, step: 5 }, nameKey: "GVN.Settings.Typewriter.Name", hintKey: "GVN.Settings.Typewriter.Hint" },
    // This user's overrides of the display defaults: { [key]: value } — only keys the user changed.
    displayOverrides: { hidden: true, scope: "client", type: Object, default: {}, onChange: () => applyDisplaySettings() },
    displayMenu: { menu: { icon: "fa-solid fa-display", type: DisplaySettingsConfig, restricted: false } },
    showRefInStage: { scope: "client", type: Boolean, default: true, onChange: () => applyDisplaySettings() },

    // ---- What reaches the stage
    oocMode: {
      scope: "client", type: String,
      choices: { gmNarration: "GVN.Settings.OocMode.GmNarration", narration: "GVN.Settings.OocMode.Narration", ignore: "GVN.Settings.OocMode.Ignore" },
      default: "gmNarration", onChange: () => rebuild(),
    },
    rollMode: {
      scope: "client", type: String,
      choices: { ignore: "GVN.Settings.RollMode.Ignore", narration: "GVN.Settings.RollMode.Narration" },
      default: "ignore", onChange: () => rebuild(),
    },
    rebuildCount: { scope: "client", type: Number, default: 40, range: { min: 0, max: 200, step: 10 } },
    idleMinutes: { scope: "world", type: Number, default: 0, range: { min: 0, max: 120, step: 5 } },

    // ---- Expressions
    pickerMode: {
      scope: "client", type: String,
      choices: { thumbnails: "GVN.Settings.PickerMode.Thumbnails", names: "GVN.Settings.PickerMode.Names", dropdown: "GVN.Settings.PickerMode.Dropdown" },
      default: "thumbnails", onChange: () => refreshPickers(),
    },
    inlineTag: { scope: "world", type: Boolean, default: true },
    inlineTagSticky: { scope: "client", type: Boolean, default: false },

    // ---- Links & export
    linkPermission: {
      scope: "world", type: String,
      choices: { LIMITED: "GVN.Settings.LinkPermission.Limited", OBSERVER: "GVN.Settings.LinkPermission.Observer", OWNER: "GVN.Settings.LinkPermission.Owner" },
      default: "OBSERVER",
    },
    exportStands: { scope: "world", type: Boolean, default: true },

    // ---- Cast (fixed performers). String onChange = module hook `gatos-visual-novel.<name>` (stage.js listens).
    // PC cast: { slots: [{ actorId, visible, mirror } | null] } (6 seats). NPC casts live in scene flags.
    pcCast: { hidden: true, scope: "world", type: Object, default: { slots: [] }, onChange: "castChanged" },
    npcCastMax: { scope: "world", type: Number, default: 4, range: { min: 1, max: 6, step: 1 }, onChange: "castChanged" },
    // Free stand positions per seat: { [slotId]: { x, y, h, a } } (scenes may override per seat in a flag).
    castLayout: { hidden: true, scope: "world", type: Object, default: {}, onChange: "castChanged" },
    castAutoFit: { scope: "world", type: Boolean, default: true, onChange: "castChanged" },
    castHud: { scope: "world", type: Boolean, default: true, onChange: "castChanged" },
    npcHud: { scope: "world", type: String, choices: ["gm", "off"], default: "gm", onChange: "castChanged" },
    bubbleMode: { scope: "world", type: String, choices: ["off", "both", "bubble"], default: "off", onChange: "castChanged" },

    // ---- Scene media (GM window "장면 연출"); the media itself lives in scene flags and tiles.
    mediaHideGrid: { scope: "client", type: Boolean, default: true, onChange: "mediaChrome" },

    // ---- GM tools
    showQuickbar: { scope: "client", type: Boolean, default: true, onChange: "quickbar" },
    quickbarPlacement: { hidden: true, scope: "client", type: Object, default: {} },
    itemFavorites: { hidden: true, scope: "client", type: Array, default: [], onChange: "favorites" },
    // Window positions of the GM palettes (gatos-lib persistPosition).
    itemPalettePosition: { hidden: true, scope: "client", type: Object, default: {} },
    npcPalettePosition: { hidden: true, scope: "client", type: Object, default: {} },

    // Keyword registry: { list: [{ keyword, uuid, addedBy }] }
    keywords: { hidden: true, scope: "world", type: Object, default: { list: [] }, onChange: () => onKeywordsChanged() },
    // When the GM last emptied every stage; rebuilds ignore older messages.
    stageClearedAt: { hidden: true, scope: "world", type: Number, default: 0, onChange: () => clearLocal() },
    // Stands the GM took down: { [key]: timestamp }. Rebuilds (reloads, late joiners) keep a stand down until it
    // speaks again after that time. Live removal travels over the socket; no onChange needed.
    removedStands: { hidden: true, scope: "world", type: Object, default: {} },
  });
}

export const setting = (key) => game.settings.get(MODULE_ID, key);

/** Display settings: world defaults (GM) that each user may override key by key. */
export const DISPLAY_KEYS = ["standLayout", "standHeight", "dimStyle", "dialogueOpacity", "dialogueFontSize", "typewriterMs"];

/** This user's overrides ({ key: value } for overridden keys only). */
export function displayOverrides() {
  const o = setting("displayOverrides");
  return o && typeof o === "object" ? { ...o } : {};
}

/** Effective display value: this user's override when set, otherwise the GM's world default. */
export function display(key) {
  const o = displayOverrides();
  return Object.hasOwn(o, key) ? o[key] : setting(key);
}

/** Replace this user's overrides (keys outside DISPLAY_KEYS are dropped). */
export async function setDisplayOverrides(overrides) {
  const clean = Object.fromEntries(Object.entries(overrides ?? {}).filter(([k, v]) => DISPLAY_KEYS.includes(k) && v !== undefined && v !== null));
  return game.settings.set(MODULE_ID, "displayOverrides", clean);
}
