/**
 * Library shim (gatos-lib PLAN §5.1): the only place this module names the library path.
 * Import everything from "./lib.js" inside the module. The four pure player files (stage-state, stage-dom,
 * player-core, player-editor) are inlined into exported pages and must not import it (PLAN §5.7).
 */
export * from "../../gatos-lib/scripts/index.js";
