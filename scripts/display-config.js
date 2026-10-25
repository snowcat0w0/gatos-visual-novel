import { MODULE_ID, TEMPLATES, L } from "./constants.js";
import { DISPLAY_KEYS, setting, displayOverrides, setDisplayOverrides } from "./settings.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Settings-registry config of a display key (its world default registration). */
const configOf = (key) => game.settings.settings.get(`${MODULE_ID}.${key}`);

function formatValue(cfg, value) {
  if (cfg?.choices) return game.i18n.localize(cfg.choices[value] ?? String(value));
  return String(value);
}

/**
 * "노벨창 화면 설정(개인)": every user sees the GM's world default for each display setting and may
 * tick "use my own value" per row. Only ticked rows are stored (client setting displayOverrides).
 */
export class DisplaySettingsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "gvn-display-config",
    classes: ["gvn-display-config"],
    tag: "form",
    window: { title: "GVN.Display.Title", icon: "fa-solid fa-display" },
    position: { width: 560 },
    form: { submitOnChange: false, closeOnSubmit: true, handler: DisplaySettingsConfig.#onSubmit },
    actions: { resetAll: DisplaySettingsConfig.#onResetAll },
  };

  static PARTS = { main: { template: TEMPLATES.displayConfig } };

  async _prepareContext() {
    const overrides = displayOverrides();
    const rows = DISPLAY_KEYS.map((key) => {
      const cfg = configOf(key);
      const def = setting(key);
      const own = Object.hasOwn(overrides, key);
      const value = own ? overrides[key] : def;
      return {
        key,
        name: game.i18n.localize(cfg?.name ?? key),
        hint: game.i18n.localize(cfg?.hint ?? ""),
        own,
        defaultLabel: formatValue(cfg, def),
        isChoice: !!cfg?.choices,
        choices: cfg?.choices ? Object.entries(cfg.choices).map(([v, label]) => ({ value: v, label: game.i18n.localize(label), selected: v === value })) : [],
        isRange: !!cfg?.range,
        range: cfg?.range ?? null,
        value,
      };
    });
    return { rows, isGM: game.user.isGM };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    // Touching a control means "use my own value" for that row.
    for (const row of this.element.querySelectorAll(".gvn-dc-row")) {
      const box = row.querySelector("input.gvn-dc-own");
      row.querySelector(".gvn-dc-control")?.addEventListener("change", () => {
        box.checked = true;
        row.classList.add("own");
      });
      box.addEventListener("change", () => row.classList.toggle("own", box.checked));
    }
  }

  static async #onSubmit(event, form) {
    const out = {};
    for (const row of form.querySelectorAll(".gvn-dc-row")) {
      const key = row.dataset.key;
      if (!row.querySelector("input.gvn-dc-own")?.checked) continue;
      const control = row.querySelector(".gvn-dc-control");
      const cfg = configOf(key);
      const raw = control?.value;
      out[key] = cfg?.type === Number ? Number(raw) : raw;
    }
    await setDisplayOverrides(out);
    ui.notifications.info(L("Display.Saved"));
  }

  static async #onResetAll() {
    await setDisplayOverrides({});
    this.render();
  }
}
