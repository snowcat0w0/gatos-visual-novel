/**
 * Every Foundry-version dependent lookup lives here (PLAN §10). Code elsewhere must not branch on
 * game.release.generation directly. Since 0.4.0 the lookups come from gatos-lib core/compat (this file
 * was its seed); the names below are kept for the module's own imports.
 */
import { HOOKS, impl } from "./lib.js";

export { generation, renderTemplate, mountPoint, isChatPopout } from "./lib.js";

export const FilePicker = () => impl.FilePicker();
export const TextEditor = () => impl.TextEditor();
export const ContextMenu = () => impl.ContextMenu();

/** Hook names for the actor sheet header (AppV2 sheets and legacy AppV1 sheets such as pf1's). */
export const ACTOR_SHEET_HEADER_HOOKS = HOOKS.actorSheetHeader;

/** Hook name of the actor directory context menu (v13: `get${documentName}ContextOptions`). */
export const ACTOR_CONTEXT_HOOK = HOOKS.actorContext;
