import { MODULE_ID, L, mod, chatTools } from "./constants.js";
import { esc } from "./lib.js";
import { setting, display } from "./settings.js";
import { describe } from "./entries.js";
import { isGctNote } from "./tags.js";
import { centerOutOrder, STATE_VERSION } from "./stage-state.js";

const BUNDLED = new Set(["zip", "dir"]);

/** File-name-safe slug of a reference: `<type>-<last 8 chars of the uuid>`. */
export function refSlug(ref) {
  const tail = String(ref.uuid ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-8) || "ref";
  return `${String(ref.type ?? "Doc").replace(/[^A-Za-z0-9]/g, "")}-${tail}`;
}

function stageHeader() {
  const maxSlots = setting("maxSlots");
  return { version: STATE_VERSION, maxSlots, slotOrder: centerOutOrder(maxSlots) };
}

/* -------------------------------------------- */
/*  Archive JSON (PLAN §8.1)                    */
/* -------------------------------------------- */

/** gctSerializeMessage: record the expression, refs and stage classification on every message. */
export function onSerializeMessage(message, data) {
  if (isGctNote(message)) {
    data.note = true;
    data.vn = { kind: "ignore", category: "note", refs: [] };
    return;
  }
  try {
    const e = describe(message, { viewer: false });
    data.vn = {
      expression: e.expression,
      refs: e.refs,
      kind: e.kind,
      category: e.category,
      key: e.key,
      name: e.name,
      standStyle: e.standStyle,
      authorGM: !!message.author?.isGM,
    };
  } catch (err) {
    mod.warn("serialize failed", err);
  }
}

/** gctArchiveHeader: the stage rules a log player needs to reproduce the stage. */
export function onArchiveHeader(archive) {
  archive.vn = stageHeader();
}

/* -------------------------------------------- */
/*  Export (PLAN §8.2)                          */
/* -------------------------------------------- */

function uniqueRefs(messages) {
  const map = new Map();
  for (const m of messages) for (const r of m.vn?.refs ?? []) if (r?.uuid && !map.has(r.uuid)) map.set(r.uuid, r);
  return [...map.values()];
}

/** gctExportRender: reference links → sub pages (zip/dir) or inert anchors (single/window); expression names on portraits. */
export function onExportRender(doc, ctx) {
  const bundled = BUNDLED.has(ctx.mode);
  const byId = new Map(ctx.messages.map((m) => [m.id, m]));
  for (const art of doc.querySelectorAll("article[data-message-id]")) {
    const m = byId.get(art.dataset.messageId);
    if (!m?.vn) continue;
    const portrait = art.querySelector("img.portrait");
    if (portrait && m.vn.expression?.name) portrait.dataset.expression = m.vn.expression.name;
    replaceRefAnchors(art, m.vn.refs, bundled);
  }
}

/** Foundry content links to frozen references → plain links to the sub pages (or inert anchors). */
function replaceRefAnchors(scope, refs, bundled) {
  if (!refs?.length) return;
  const doc = scope.ownerDocument;
  for (const a of scope.querySelectorAll("a.content-link[data-uuid]")) {
    const ref = refs.find((r) => r.uuid === a.dataset.uuid);
    if (!ref) continue;
    const link = doc.createElement("a");
    link.className = "ref-link";
    link.textContent = a.textContent.trim() || ref.name;
    link.title = ref.name ?? "";
    if (bundled) {
      link.href = `refs/${refSlug(ref)}.html`;
      link.target = "_blank";
      link.rel = "noopener";
    } else link.href = "#";
    a.replaceWith(link);
  }
}

/** Rewrite <img> sources inside reference text to bundle files; `strip` turns a root path into one relative to the page. */
function relinkHtml(html, ctx, strip = "") {
  if (!html || !/<img/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  for (const img of doc.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src");
    if (/^data:/.test(src)) continue;
    const path = ctx.relink(src, "refs/images");
    img.setAttribute("src", strip && path.startsWith(strip) ? path.slice(strip.length) : path);
  }
  return doc.getElementById("root").innerHTML;
}

function refPage(ref, { img, text, back }) {
  const type = L(`Export.Type.${ref.type}`);
  return `<!DOCTYPE html>
<html lang="${esc(game.i18n.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ref.name)}</title>
<link rel="stylesheet" href="../chat-styles.css">
<style>
.ref-page { max-width: 900px; margin: 0 auto; }
.ref-page .back { font-size: 12px; }
.ref-page .back a { color: #8ab4f8; }
.ref-page .ref-img { display: block; max-width: 100%; max-height: 80vh; margin: 12px auto; border-radius: 6px; border: 1px solid #3a3d47; }
.ref-page .ref-text { background: #23262f; border: 1px solid #3a3d47; border-radius: 6px; padding: 12px 16px; }
.ref-page .ref-text img { max-width: 100%; height: auto; }
</style></head>
<body><div class="wrap ref-page">
<p class="back"><a href="../${esc(encodeURIComponent(back))}">← ${esc(L("Export.BackToLog"))}</a></p>
<h1>${esc(ref.name)}</h1>
<div class="meta">${esc(type)}${ref.keyword && ref.keyword !== ref.name ? ` · ${esc(ref.keyword)}` : ""}</div>
${img ? `<img class="ref-img" src="${esc(img)}" alt="">` : ""}
${text ? `<div class="ref-text content">${text}</div>` : ""}
</div></body></html>`;
}

/** gctExportBundle (zip/dir): one `refs/<slug>.html` sub page per linked document, with its images. */
export function onExportBundle(bundle, ctx) {
  for (const ref of uniqueRefs(ctx.messages)) {
    const imgPath = ref.img ? ctx.relink(ref.img, "refs/images") : null;
    const img = imgPath?.startsWith("refs/") ? imgPath.slice(5) : imgPath;
    const text = relinkHtml(ref.text, ctx, "refs/");
    bundle.files.set(`refs/${refSlug(ref)}.html`, { text: refPage(ref, { img, text, back: bundle.name }) });
  }
  addPlayer(bundle, ctx);
}

/** gctExportLog (zip/dir): bundle-relative stand/face/ref paths for the future log player. */
export function onExportLog(log, ctx) {
  log.vn = stageHeader();
  const withImages = setting("exportStands");
  const abs = chatTools()?.absoluteUrl ?? ((p) => p);
  for (const m of log.messages) {
    const vn = m.vn;
    if (!vn) continue;
    if (vn.expression) {
      for (const [field, folder] of [["face", "faces"], ["stand", "stands"]]) {
        const v = vn.expression[field];
        if (v) vn.expression[field] = withImages ? ctx.relink(v, folder) : abs(v);
      }
    }
    for (const r of vn.refs ?? []) {
      if (r.img) r.img = ctx.relink(r.img, "refs/images");
      if (r.text) r.text = relinkHtml(r.text, ctx);
      r.href = `refs/${refSlug(r)}.html`;
    }
    if (vn.refs?.length && m.html && /content-link/.test(m.html)) {
      const doc = new DOMParser().parseFromString(`<div id="root">${m.html}</div>`, "text/html");
      replaceRefAnchors(doc.getElementById("root"), vn.refs, true);
      m.html = doc.getElementById("root").innerHTML;
    }
  }
  ctx.vnLog = log;
}

/* -------------------------------------------- */
/*  Exported player page (PLAN §8.3 B)          */
/* -------------------------------------------- */

const PLAYER_SOURCES = [
  ["StageState", "scripts/stage-state.js"],
  ["StageDOM", "scripts/stage-dom.js"],
  ["PlayerCore", "scripts/player-core.js"],
  ["PlayerEditor", "scripts/player-editor.js"],
];
const assets = { scripts: null, css: null, loading: null };

/** Fetch the pure player files once, so the (synchronous) export hooks can inline them. */
export function preloadPlayerAssets() {
  assets.loading ??= (async () => {
    const base = `modules/${MODULE_ID}/`;
    const get = async (p) => {
      const res = await fetch(foundry.utils.getRoute(`${base}${p}`));
      if (!res.ok) throw new Error(`${p}: ${res.status}`);
      return res.text();
    };
    const scripts = [];
    for (const [ns, path] of PLAYER_SOURCES) scripts.push(toClassicScript(await get(path), ns));
    assets.scripts = scripts.join("\n");
    assets.css = await get("styles/visual-novel.css");
  })().catch((err) => {
    assets.loading = null;
    mod.error("player assets failed to load", err);
  });
  return assets.loading;
}

/**
 * ES module → classic script: `const NS = (() => { …; return { exports }; })();`. Namespace imports of
 * the sibling files are dropped because the namespaces are defined earlier in the same script.
 */
export function toClassicScript(source, ns) {
  const names = [];
  const body = source
    .replace(/^import \* as \w+ from "\.\/[\w-]+\.js";[ \t]*$/gm, "")
    .replace(/^export (async function|function|const|let|class) (\w+)/gm, (_, kw, name) => {
      names.push(name);
      return `${kw} ${name}`;
    });
  return `const ${ns} = (() => {\n${body}\nreturn { ${names.join(", ")} };\n})();\n`;
}

// Only "<" needs escaping: the JSON is read back with textContent + JSON.parse.
const LT_ESCAPE = `${String.fromCharCode(92)}u003c`; // JSON escape for "<" so "</script>" cannot end the tag
const jsonForScript = (data) => JSON.stringify(data).replace(/</g, LT_ESCAPE);

const PAGE_CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; background: radial-gradient(ellipse at 50% 30%, #2b3040 0%, #12141b 70%); color: #eee; }
#gvn-app { position: fixed; inset: 0; }
#gvn-app #gvn-stage { position: absolute; inset: 0; }
.gvn-local .gvn-player-bar { left: 50%; right: auto; transform: translateX(-50%); width: min(980px, calc(100% - 24px)); min-width: 0; }
.gvn-local .gvn-stand-img { max-height: none; }
`;

function playerLabels() {
  const keys = ["First", "Prev", "Play", "Pause", "Next", "Last", "Speed", "List", "Close", "Empty", "Narration", "Scene"];
  const out = Object.fromEntries(keys.map((k) => [k.charAt(0).toLowerCase() + k.slice(1), L(`Player.${k}`)]));
  out.locked = L("Link.Locked");
  out.collapse = L("Stage.Collapse");
  out.expand = L("Stage.Expand");
  return out;
}

const EDITOR_LABEL_KEYS = [
  "Edit", "CloseEditor", "Undo", "Redo", "Save", "SaveHint", "Download", "DownloadHint", "Connect", "ConnectHint", "Connected",
  "Line", "Kind", "KindSpeech", "KindEmote", "KindNarration", "KindScene", "KindKeep", "Speaker", "NoSpeaker", "Name", "Expression",
  "Stand", "Face", "Background", "BgInherited", "BgNone", "BgSet", "BgClear", "BgKeep", "ClearStands", "Change", "Remove", "Text",
  "RawHtml", "Propagate", "InsertBefore", "InsertAfter", "DeleteLine", "MoveUp", "MoveDown", "PickTitle", "PickExpression", "FromFile",
  "Path", "Ok", "Cancel", "GroupExpressions", "GroupStands", "GroupFaces", "GroupBackgrounds", "GroupOther", "GroupFolder", "NoImages",
  "NewLine", "EditorUser", "HiddenLine", "SceneLine", "NarrationLine", "DraftFound", "DraftLoad", "DraftDiscard", "Saved", "Downloaded",
  "WrongFolder", "FolderUnsupported", "Overwrite", "Unsaved", "SaveFailed", "EmbeddedNote",
];

/** Every `Editor.*` string, keyed in camelCase for PlayerEditor.attach (placeholders stay for the page to fill). */
function editorLabels() {
  const out = {};
  for (const k of EDITOR_LABEL_KEYS) {
    const key = `GVN.Editor.${k}`;
    if (game.i18n.has(key)) out[k.charAt(0).toLowerCase() + k.slice(1)] = game.i18n.localize(key);
  }
  return out;
}

function playerPage(log, title) {
  const config = {
    labels: playerLabels(),
    prefs: { oocMode: setting("oocMode"), rollMode: setting("rollMode") },
    typewriter: display("typewriterMs") || 30,
    layout: display("standLayout"),
    dimStyle: display("dimStyle"),
    standHeight: display("standHeight"),
    dialogueOpacity: display("dialogueOpacity"),
    fontSize: display("dialogueFontSize"),
    title,
    editorLabels: editorLabels(),
  };
  const script = assets.scripts.replace(/<\/script/gi, "<\\/script");
  return `<!DOCTYPE html>
<html lang="${esc(game.i18n.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${assets.css}\n${PAGE_CSS}</style></head>
<body class="gvn-local"><div id="gvn-app"></div>
<script type="application/json" id="gvn-config">${jsonForScript(config)}</script>
<script type="application/json" id="gvn-log">${jsonForScript(log)}</script>
<script>
"use strict";
${script}
(() => {
  const config = JSON.parse(document.getElementById("gvn-config").textContent);
  config.log = JSON.parse(document.getElementById("gvn-log").textContent);
  window.gvnPlayer = PlayerCore.startLocal(config);
  window.gvnEditor = PlayerEditor.attach(window.gvnPlayer, { log: config.log, labels: config.editorLabels });
})();
</script>
</body></html>`;
}

/** The player page's file name for a bundle: `<log name>.player.html`. */
export const playerFileName = (bundleName) => bundleName.replace(/\.html$/i, "") + ".player.html";

function addPlayer(bundle, ctx) {
  if (!ctx.vnLog) return;
  if (!assets.scripts) {
    preloadPlayerAssets();
    ui.notifications.warn(L("Player.AssetsNotReady"));
    return;
  }
  const file = playerFileName(bundle.name);
  const title = ctx.meta?.title ?? ctx.vnLog.title ?? "";
  bundle.files.set(file, { text: playerPage(ctx.vnLog, title) });
  // Link it from the log page.
  const doc = new DOMParser().parseFromString(bundle.html, "text/html");
  const h1 = doc.querySelector("h1");
  if (h1) {
    const p = doc.createElement("p");
    p.className = "vn-player-link";
    p.innerHTML = `<a href="${esc(encodeURIComponent(file))}" style="display:inline-block;padding:4px 12px;border:1px solid #c9a84c;border-radius:4px;color:#e3c27a;text-decoration:none;">▶ ${esc(L("Player.OpenLocal"))}</a>`;
    h1.after(p);
    bundle.html = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  }
}

export function registerArchiveHooks() {
  Hooks.on("gctSerializeMessage", onSerializeMessage);
  Hooks.on("gctArchiveHeader", onArchiveHeader);
  Hooks.on("gctExportRender", onExportRender);
  Hooks.on("gctExportBundle", onExportBundle);
  Hooks.on("gctExportLog", onExportLog);
}
