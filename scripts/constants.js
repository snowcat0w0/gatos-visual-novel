import { defineModule, requireModule } from "./lib.js";

export const MODULE_ID = "gatos-visual-novel";
export const CHAT_TOOLS_ID = "gatos-chat-tools";
export const SOCKET = `module.${MODULE_ID}`;

/** Reserved id of the expression entry every actor has. */
export const DEFAULT_EXPRESSION = "default";

export const TEMPLATES = {
  expressionConfig: `modules/${MODULE_ID}/templates/expression-config.hbs`,
  keywordManager: `modules/${MODULE_ID}/templates/keyword-manager.hbs`,
  displayConfig: `modules/${MODULE_ID}/templates/display-config.hbs`,
};

/** Library handle: `mod.L("Stage.Title")` = `game.i18n.localize("GVN.Stage.Title")`, settings under `GVN.Settings`. */
export const mod = defineModule(MODULE_ID, { langPrefix: "GVN" });

/** Localize a key under the GVN namespace, formatting with data when given. */
export const L = mod.L;

/** The gatos-chat-tools API when an extension-capable version (>= 0.2.0) is active, else null. */
export function chatTools() {
  return requireModule(CHAT_TOOLS_ID, { members: ["registerPortraitProvider"] });
}

/** Does the installed gatos-chat-tools fire the v0.2.0 hooks (gctSpeakerResolved …)? */
export function chatToolsHooksAvailable() {
  return !!requireModule(CHAT_TOOLS_ID, { minVersion: "0.2.0" });
}
