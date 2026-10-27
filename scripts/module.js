import { MODULE_ID, TEMPLATES, L, mod, chatTools, chatToolsHooksAvailable } from "./constants.js";
import { libActive, addSceneControlTool } from "./lib.js";
import { registerSettings } from "./settings.js";
import * as StageState from "./stage-state.js";
import * as StageDOM from "./stage-dom.js";
import {
  getExpressions,
  setExpressions,
  resolveImages,
  getCurrentExpression,
  setCurrentExpression,
  freezeExpression,
  onPreUpdateChatMessage as onPreUpdateExpression,
  portraitProvider,
} from "./expressions.js";
import { openExpressionConfig, registerExpressionConfigHooks } from "./expression-config.js";
import { registerPickerHooks } from "./expression-picker.js";
import { registerStageHooks, startStage, enable, disable, toggle, rebuild, getState, removeStandLocal } from "./stage.js";
import { toEntry, describe } from "./entries.js";
import {
  resolveKeyword,
  onPreCreateChatMessageLinks,
  onPreUpdateChatMessageLinks,
  onRenderChatMessageLinks,
  registerEnricher,
  openRef,
} from "./links.js";
import { openKeywordManager } from "./keyword-manager.js";
import { registerSocket, broadcastStage, broadcastRemove, broadcastFocus, broadcastRelease, clearAll } from "./socket.js";
import { registerArchiveHooks, preloadPlayerAssets } from "./archive-ext.js";
import * as PlayerCore from "./player-core.js";
import { openLogPlayer, playMessages, playSource, loadSource, stopPlayback, isPlaying } from "./log-player.js";
import {
  registerCastStatProvider,
  registerCastItemProvider,
  registerItemPaletteFilter,
  castMembers,
  getPcCast,
  setPcCast,
  updatePcSeat,
  getNpcCast,
  setNpcSeat,
  getLayout,
  saveLayout,
  resetLayout,
  giveItemTo,
} from "./cast.js";
import { openCastConfig, registerCastConfigHooks } from "./cast-config.js";
import {
  registerSceneMediaHooks,
  openSceneMedia,
  getMedia,
  getPresets,
  applyMedia,
  clearMedia,
  syncMediaTiles,
  savePreset,
  applyPreset,
  deletePreset,
  bakeBlur,
} from "./scene-media.js";
import { registerPaletteHooks, openItemPalette, openNpcPalette, toggleNpc } from "./palettes.js";
import { registerQuickbarHooks, renderQuickbar, toggleQuickbar } from "./quickbar.js";
import { setDirector, toggleDirector, setLayoutEditing, toggleLayoutEditing, openRemoveStands } from "./stage-extras.js";

Hooks.once("init", () => {
  // Installed-but-disabled library = "half state" (gatos-lib PLAN §5.6): code imports fine, but the library's
  // lang/css/api are missing. Foundry blocks activation when the library is missing entirely (relationships.requires).
  if (!libActive()) {
    Hooks.once("ready", () =>
      ui.notifications.error("Gato's Visual Novel: gatos-lib 모듈을 활성화해야 합니다. / Enable the gatos-lib module.", { permanent: true }),
    );
  }

  registerSettings();
  mod.preloadTemplates(Object.values(TEMPLATES));
  registerEnricher();

  game.keybindings.register(MODULE_ID, "toggleStage", {
    name: "GVN.Stage.Toggle",
    editable: [],
    onDown: () => {
      toggle();
      return true;
    },
  });

  mod.exposeApi({
    getExpressions,
    setExpressions,
    resolveImages,
    getCurrentExpression,
    setCurrentExpression,
    openExpressionConfig,
    openKeywordManager,
    stage: {
      enable,
      disable,
      toggle,
      clear: clearAll,
      remove: (key) => (game.user.isGM ? broadcastRemove(key) : removeStandLocal(key)),
      openRemove: openRemoveStands,
      getState,
      rebuild,
    },
    broadcastStage,
    player: { open: openLogPlayer, play: playMessages, playSource, loadSource, stop: stopPlayback, isPlaying },
    resolveKeyword,
    openRef,
    toEntry,
    describe,
    StageState,
    StageDOM,
    PlayerCore,
    // 0.6.0: cast, director tools, scene media, palettes (GM writes; reads work for everyone)
    cast: {
      members: castMembers,
      getPc: getPcCast,
      setPc: setPcCast,
      updatePcSeat,
      getNpc: getNpcCast,
      setNpcSeat,
      getLayout,
      saveLayout,
      resetLayout,
      giveItem: giveItemTo,
      toggleNpc,
      openConfig: openCastConfig,
    },
    focus: (key) => broadcastFocus(key),
    releaseFocus: () => broadcastRelease(),
    director: { set: setDirector, toggle: toggleDirector, setLayoutEditing, toggleLayoutEditing },
    media: { open: openSceneMedia, get: getMedia, presets: getPresets, apply: applyMedia, clear: clearMedia, sync: syncMediaTiles, savePreset, applyPreset, deletePreset, bakeBlur },
    openItemPalette,
    openNpcPalette,
    quickbar: { render: renderQuickbar, toggle: toggleQuickbar },
    registerCastStatProvider,
    registerCastItemProvider,
    registerItemPaletteFilter,
  });

  // Message creation, in order: links (content) → [chat-tools speaker lock] → expression freeze.
  Hooks.on("preCreateChatMessage", onPreCreateChatMessageLinks);
  if (chatToolsHooksAvailable()) Hooks.on("gctSpeakerResolved", freezeExpression);
  else Hooks.on("preCreateChatMessage", freezeExpression);
  Hooks.on("preUpdateChatMessage", onPreUpdateChatMessageLinks);
  Hooks.on("preUpdateChatMessage", onPreUpdateExpression);
  Hooks.on("renderChatMessageHTML", onRenderChatMessageLinks);

  registerExpressionConfigHooks();
  registerPickerHooks();
  registerStageHooks();
  registerArchiveHooks();
  registerSceneMediaHooks();
  registerPaletteHooks();
  registerCastConfigHooks();
  registerQuickbarHooks();

  // Scene controls (token layer, GM only): quickbar, scene media, cast. v13 record shape (tools record,
  // onChange(event, active), client/applications/ui/scene-controls.mjs) via gatos-lib addSceneControlTool.
  const gm = () => !!game.user?.isGM;
  addSceneControlTool({ layer: "tokens", name: "gvnQuickbar", title: "GVN.Tools.Quickbar", icon: "fa-solid fa-clapperboard", visible: gm, onClick: () => toggleQuickbar() });
  addSceneControlTool({ layer: "tokens", name: "gvnSceneMedia", title: "GVN.Media.Title", icon: "fa-solid fa-panorama", visible: gm, onClick: () => openSceneMedia() });
  addSceneControlTool({ layer: "tokens", name: "gvnCast", title: "GVN.Cast.Title", icon: "fa-solid fa-users", visible: gm, onClick: () => openCastConfig() });
});

Hooks.once("ready", async () => {
  registerSocket();
  const ct = chatTools();
  if (ct) ct.registerPortraitProvider(portraitProvider);
  else mod.notify.warn("ChatToolsMissing", undefined, { permanent: true });
  if (ct) {
    // The bar may have been mounted before our hooks could add the expression strip.
    const bar = document.querySelector(".gct-speaker-bar");
    if (bar && !bar.nextElementSibling?.classList.contains("gvn-expr-strip")) Hooks.callAll("gctSpeakerBarMounted", bar);
    ct.updateSpeakerBar?.();
    ct.refreshPortraits?.();
    // chat-tools 0.3.1+: "replay as novel" in the archive viewer (listed or selected messages).
    ct.registerViewerAction?.({
      id: "gvn-replay",
      label: "GVN.Player.ViewerAction",
      tooltip: "GVN.Player.ViewerActionHint",
      icon: "fa-solid fa-film",
      callback: (messages, meta) => {
        foundry.applications.instances.get("gct-archive-viewer")?.minimize();
        return playMessages(messages, { title: meta.source ?? meta.title });
      },
    });
  }
  await startStage();
  renderQuickbar();
  preloadPlayerAssets();
});
