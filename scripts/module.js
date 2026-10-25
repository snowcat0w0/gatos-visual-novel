import { MODULE_ID, TEMPLATES, L, mod, chatTools, chatToolsHooksAvailable } from "./constants.js";
import { libActive } from "./lib.js";
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
import { registerSocket, broadcastStage, broadcastRemove, clearAll } from "./socket.js";
import { registerArchiveHooks, preloadPlayerAssets } from "./archive-ext.js";
import * as PlayerCore from "./player-core.js";
import { openLogPlayer, playMessages, playSource, loadSource, stopPlayback, isPlaying } from "./log-player.js";

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
  preloadPlayerAssets();
});
