/**
 * Log editor for the exported player page: fix a line's text, speaker, expression, stand/face
 * images and background after the fact, delete lines, insert new ones, reorder, and write the result
 * back into the bundle (`<name>.player.html` + `<name>.log.json`) or download it.
 *
 * PURE MODULE: imports only the player core; no Foundry globals (game, foundry, ui, Hooks, CONFIG).
 * archive-ext.js inlines it into the exported page as a classic script, so keep the import exactly
 * `import * as PlayerCore …` and export only `function`s / `const`s.
 */
import * as PlayerCore from "./player-core.js";

export const EDITOR_VERSION = 1;

const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|svg|bmp)$/i;
const BUNDLE_FOLDERS = ["stands", "faces", "backgrounds", "images", "portraits", "refs/images"];
const STYLE = { OTHER: 0, OOC: 1, IC: 2, EMOTE: 3 };
const HISTORY_MAX = 100;

const DEFAULT_LABELS = {
  edit: "Edit log",
  closeEditor: "Close editor",
  undo: "Undo",
  redo: "Redo",
  save: "Save",
  saveHint: "Write the edited player and log into the bundle folder",
  download: "Download",
  downloadHint: "Download the edited player page (and log JSON)",
  connect: "Bundle folder…",
  connectHint: "Open the exported folder to list its images and save in place",
  connected: "Folder: {name}",
  line: "Line",
  kind: "Type",
  kindSpeech: "Speech",
  kindEmote: "Emote",
  kindNarration: "Narration",
  kindScene: "Scene cut (background only)",
  kindKeep: "Keep as is ({category})",
  speaker: "Speaker",
  noSpeaker: "(none)",
  name: "Name",
  expression: "Expression",
  stand: "Stand",
  face: "Face",
  background: "Background",
  bgInherited: "unchanged (from earlier lines)",
  bgNone: "none",
  bgSet: "Set…",
  bgClear: "Clear from this line",
  bgKeep: "No change",
  clearStands: "Dismiss every stand before this line",
  change: "Change…",
  remove: "Remove",
  text: "Text",
  rawHtml: "Edit as HTML",
  propagate: "Also change the following lines that use the same expression",
  insertBefore: "Insert before",
  insertAfter: "Insert after",
  deleteLine: "Delete line",
  moveUp: "Move up",
  moveDown: "Move down",
  pickTitle: "Choose an image",
  pickExpression: "Choose an expression",
  fromFile: "From file…",
  path: "Path",
  ok: "OK",
  cancel: "Cancel",
  groupExpressions: "This character's expressions",
  groupStands: "Stands",
  groupFaces: "Faces",
  groupBackgrounds: "Backgrounds",
  groupOther: "Other images",
  groupFolder: "Folder: {folder}",
  noImages: "No images yet. Open the bundle folder or pick a file.",
  newLine: "(new line)",
  editorUser: "Editor",
  hiddenLine: "not shown",
  sceneLine: "Scene",
  narrationLine: "Narration",
  draftFound: "This log has an unsaved draft from {when}.",
  draftLoad: "Load draft",
  draftDiscard: "Discard",
  saved: "Saved {files} in {folder}.",
  downloaded: "Downloaded {file}.",
  wrongFolder: "{file} is not in that folder. Choose the folder the player was exported to.",
  folderUnsupported: "This browser cannot write into folders; the edited page will be downloaded instead.",
  overwrite: "Overwrite {file} in \"{folder}\"?",
  unsaved: "Unsaved changes",
  saveFailed: "Saving failed: {error}",
  embeddedNote: "{count} new image(s) are embedded in the page because no folder is connected.",
  dirty: "●",
};

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const fmt = (s, data = {}) => String(s ?? "").replace(/\{(\w+)\}/g, (_, k) => (data[k] ?? `{${k}}`));
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fileNameOf = (p) => {
  if (!p) return "";
  if (/^data:/.test(p)) return "(embedded)";
  try {
    return decodeURIComponent(String(p).split(/[?#]/)[0].split("/").pop());
  } catch {
    return String(p).split("/").pop();
  }
};
const randomId = () => "ed" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function plainText(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll(".dice-tooltip, script, style").forEach((e) => e.remove());
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** HTML made only of <p> / <br> → plain text with newlines; anything richer → null. */
export function htmlToText(html) {
  if (!html) return "";
  if (/<(?!\/?(p|br)\b)[a-z]/i.test(html)) return null;
  let s = String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "");
  const div = document.createElement("div");
  div.innerHTML = s; // only entities are left
  s = div.textContent ?? "";
  return s.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

/** Plain text → paragraphs (<p>), single newlines → <br>. */
export function textToHtml(text) {
  const paras = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.length);
  return paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

/** A timestamp strictly between two neighbours when possible (integer when the gap allows). */
export function between(a, b) {
  if (a == null && b == null) return Date.now();
  if (a == null) return b - 1000;
  if (b == null) return a + 1000;
  const gap = b - a;
  if (gap <= 0) return a;
  if (gap >= 2) return Math.floor((a + b) / 2);
  return a + gap / 2;
}

const isSpeech = (m) => {
  const c = PlayerCore.categoryOf(m);
  return c === "speech" || c === "emote";
};

const speakerKey = (m) => m.vn?.key ?? (m.actor ? `Actor.${m.actor}` : m.token ? `Token..${m.token}` : null);

/** The expression a serialized message shows (card portrait doubles as stand in pre-module archives). */
function expressionOf(m) {
  if (m.vn) return m.vn.expression ?? null;
  return m.img ? { id: null, name: fileNameOf(m.img), face: m.img, stand: m.img } : null;
}

const exprKey = (e) => (e ? e.id ?? `${e.face ?? ""}|${e.stand ?? ""}` : "");

function imagesInHtml(html, out) {
  if (!html || !/<img/i.test(html)) return;
  for (const m of String(html).matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) if (!/^data:/.test(m[1])) out.add(m[1]);
}

/** Characters, expressions and image pools found in a log. */
export function buildCatalog(messages) {
  const characters = new Map();
  const stands = new Set();
  const faces = new Set();
  const backgrounds = new Set();
  const other = new Set();
  for (const m of messages) {
    if (isSpeech(m)) {
      const key = speakerKey(m);
      if (key) {
        let c = characters.get(key);
        if (!c) characters.set(key, (c = { key, name: "", expressions: new Map() }));
        const name = m.vn?.name ?? m.alias ?? "";
        if (name) c.name = name;
        const e = expressionOf(m);
        if (e && (e.face || e.stand)) {
          const k = exprKey(e);
          if (!c.expressions.has(k)) c.expressions.set(k, { ...e });
        }
      }
    }
    const e = m.vn?.expression;
    if (e?.stand) stands.add(e.stand);
    if (e?.face) faces.add(e.face);
    if (m.vn?.background) backgrounds.add(m.vn.background);
    if (m.img && !/^data:/.test(m.img)) other.add(m.img);
    imagesInHtml(m.html, other);
    for (const r of m.vn?.refs ?? []) if (r.img) other.add(r.img);
  }
  return { characters, stands, faces, backgrounds, other };
}

/* -------------------------------------------- */
/*  Editor                                      */
/* -------------------------------------------- */

/**
 * Attach the editor to a local player.
 * @param {object} player   From PlayerCore.createPlayer (needs reload / onIndex / bar / root).
 * @param {object} config
 * @param {object} config.log            The parsed log (messages are replaced, header kept).
 * @param {object} [config.labels]
 * @param {string} [config.pageName]     File name of this page (default: from location).
 * @param {Storage} [config.storage]     Draft storage (default: localStorage).
 */
export function attach(player, config = {}) {
  const doc = player.root.ownerDocument;
  const win = doc.defaultView;
  const labels = { ...DEFAULT_LABELS, ...(config.labels ?? {}) };
  const log = config.log ?? { messages: [] };
  const app = player.root.parentElement ?? doc.body;
  const pageName = config.pageName ?? decodeURIComponent((win.location.pathname.split("/").pop() || "player.html").replace(/\+/g, "%2B"));
  const baseName = /\.player\.html$/i.test(pageName) ? pageName.replace(/\.player\.html$/i, "") : pageName.replace(/\.html$/i, "");
  const logName = `${baseName}.log.json`;
  let storage = config.storage;
  if (storage === undefined) {
    try {
      storage = win.localStorage;
    } catch {
      storage = null;
    }
  }
  const draftKey = `gvn-draft:${pageName}:${log.exportedAt ?? ""}`;

  let messages = (log.messages ?? []).slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  let catalog = buildCatalog(messages);
  const past = [];
  const future = [];
  let selectedId = null;
  let dirty = false;
  let open = false;
  let dir = null; // FileSystemDirectoryHandle
  const folderFiles = new Map(); // folder → [paths]
  const pending = new Map(); // data URL → { folder, name, blob }
  const prefs = player.prefs ?? {};

  const byId = () => new Map(messages.map((m, i) => [m.id, i]));
  const findMessage = (id) => messages.find((m) => m.id === id) ?? null;

  /* ---------- history / commit ---------- */

  function snapshot() {
    return { messages, selectedId };
  }

  function commit(next, { focusId = selectedId, animate = false } = {}) {
    past.push(snapshot());
    if (past.length > HISTORY_MAX) past.shift();
    future.length = 0;
    messages = next;
    afterChange(focusId, animate);
  }

  function undo() {
    if (!past.length) return;
    future.push(snapshot());
    const s = past.pop();
    messages = s.messages;
    afterChange(s.selectedId);
  }

  function redo() {
    if (!future.length) return;
    past.push(snapshot());
    const s = future.pop();
    messages = s.messages;
    afterChange(s.selectedId);
  }

  function afterChange(focusId, animate = false) {
    dirty = true;
    catalog = buildCatalog(messages);
    player.reload(messages, { focusId, animate });
    selectedId = focusId && findMessage(focusId) ? focusId : currentPlayerId();
    refresh();
    scheduleDraft();
  }

  function currentPlayerId() {
    return player.entries[player.index]?.id ?? null;
  }

  function update(id, patch) {
    const i = messages.findIndex((m) => m.id === id);
    if (i < 0) return;
    const m = JSON.parse(JSON.stringify(messages[i]));
    m.vn ??= { expression: null, refs: [], kind: "narration", category: "narration", key: null, name: null, standStyle: null, authorGM: true };
    patch(m, i);
    m.edited = true;
    const next = messages.slice();
    next[i] = m;
    commit(next, { focusId: id });
  }

  /* ---------- message shaping ---------- */

  function setCategory(m, category) {
    m.vn.category = category;
    if (category === "speech" || category === "emote") {
      m.vn.kind = "speech";
      m.style = category === "emote" ? STYLE.EMOTE : STYLE.IC;
      if (!m.vn.key) setSpeaker(m, lastSpeakerBefore(m) ?? [...catalog.characters.keys()][0] ?? null);
    } else if (category === "narration") {
      m.vn.kind = "narration";
      m.style = STYLE.OTHER;
      m.vn.key = null;
    } else if (category === "scene") {
      m.vn.kind = "scene";
      m.vn.key = null;
    } else m.vn.kind = PlayerCore.kindFor(m, category, prefs);
  }

  function lastSpeakerBefore(m) {
    const ts = m.timestamp ?? 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const o = messages[i];
      if (o.id === m.id || (o.timestamp ?? 0) > ts) continue;
      if (isSpeech(o) && speakerKey(o)) return speakerKey(o);
    }
    return null;
  }

  function lastExpressionOf(key, beforeTs, exceptId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const o = messages[i];
      if (o.id === exceptId || (o.timestamp ?? 0) > beforeTs) continue;
      if (speakerKey(o) === key && isSpeech(o)) {
        const e = expressionOf(o);
        if (e) return { ...e };
      }
    }
    const c = catalog.characters.get(key);
    const first = c ? [...c.expressions.values()][0] : null;
    return first ? { ...first } : null;
  }

  function setSpeaker(m, key) {
    m.vn.key = key;
    if (!key) {
      m.actor = null;
      m.token = null;
      return;
    }
    const c = catalog.characters.get(key);
    const name = c?.name ?? m.vn.name ?? m.alias ?? "";
    m.vn.name = name;
    m.alias = name;
    m.actor = key.startsWith("Actor.") ? key.slice(6) : null;
    m.token = key.startsWith("Token.") ? key.split(".").pop() : null;
    const e = lastExpressionOf(key, m.timestamp ?? 0, m.id);
    m.vn.expression = e;
    if (e?.face) m.img = e.face;
  }

  function setExpression(m, e) {
    m.vn.expression = e ? { id: e.id ?? null, name: e.name ?? fileNameOf(e.stand ?? e.face), face: e.face ?? null, stand: e.stand ?? null } : null;
    if (e?.face) m.img = e.face;
  }

  function newMessage(afterTs, beforeTs, like) {
    const m = {
      id: randomId(),
      timestamp: between(afterTs, beforeTs),
      user: labels.editorUser,
      userId: null,
      color: null,
      alias: "",
      img: null,
      actor: null,
      token: null,
      flavor: "",
      content: "",
      whisper: [],
      whisperNames: [],
      blind: false,
      chitchat: false,
      highlight: false,
      sessionMarker: null,
      isRoll: false,
      rolls: [],
      type: 0,
      style: STYLE.OTHER,
      html: "",
      edited: true,
      vn: { expression: null, refs: [], kind: "narration", category: "narration", key: null, name: null, standStyle: null, authorGM: true },
    };
    if (like && isSpeech(like) && speakerKey(like)) {
      m.vn.category = PlayerCore.categoryOf(like);
      m.vn.kind = "speech";
      m.style = like.style ?? STYLE.IC;
      setSpeaker(m, speakerKey(like));
      m.vn.expression = expressionOf(like) ? { ...expressionOf(like) } : m.vn.expression;
      if (m.vn.expression?.face) m.img = m.vn.expression.face;
    }
    return m;
  }

  function insert(relativeTo, where) {
    const idx = messages.findIndex((m) => m.id === relativeTo);
    const at = idx < 0 ? messages.length : where === "before" ? idx : idx + 1;
    const prev = messages[at - 1] ?? null;
    const nextM = messages[at] ?? null;
    const like = idx < 0 ? prev : messages[idx];
    const m = newMessage(prev?.timestamp ?? null, nextM?.timestamp ?? null, like);
    const next = messages.slice();
    next.splice(at, 0, m);
    commit(next, { focusId: m.id });
  }

  function removeLine(id) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const next = messages.slice();
    next.splice(idx, 1);
    const focus = next[idx]?.id ?? next[idx - 1]?.id ?? null;
    commit(next, { focusId: focus });
  }

  function move(id, dir) {
    const idx = messages.findIndex((m) => m.id === id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= messages.length) return;
    const next = messages.slice();
    const [m] = next.splice(idx, 1);
    next.splice(to, 0, m);
    const moved = JSON.parse(JSON.stringify(m));
    moved.timestamp = between(next[to - 1]?.timestamp ?? null, next[to + 1]?.timestamp ?? null);
    moved.edited = true;
    next[to] = moved;
    commit(next, { focusId: id });
  }

  /** Change the expression of one line and, optionally, the following lines of the same speaker that still use the old one. */
  function applyExpression(id, e, propagate) {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const key = speakerKey(messages[idx]);
    const oldKey = exprKey(expressionOf(messages[idx]));
    const next = messages.slice();
    const patch = (i) => {
      const m = JSON.parse(JSON.stringify(next[i]));
      m.vn ??= { expression: null, refs: [], kind: "speech", category: "speech", key, name: m.alias ?? null, standStyle: null, authorGM: true };
      setExpression(m, e);
      m.edited = true;
      next[i] = m;
    };
    patch(idx);
    if (propagate) {
      for (let i = idx + 1; i < next.length; i++) {
        const o = next[i];
        if (!isSpeech(o) || speakerKey(o) !== key) continue;
        if (exprKey(expressionOf(o)) !== oldKey) break;
        patch(i);
      }
    }
    commit(next, { focusId: id });
  }

  /* ---------- stage state helpers ---------- */

  /** Background in force when the selected line is shown (from the player's state). */
  function inheritedBackground(id) {
    const i = player.entries.findIndex((e) => e.id === id);
    if (i < 0) return null;
    return player.stateAt(i)?.background ?? null;
  }

  /* ---------- panel ---------- */

  const panel = el(doc, "aside", "gvn-editor");
  panel.hidden = true;
  const head = el(doc, "div", "gvn-ed-head");
  const btn = (cls, text, title, fn) => {
    const b = el(doc, "button", `gvn-ed-btn ${cls}`, text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      fn(ev);
    });
    return b;
  };
  const bUndo = btn("gvn-ed-undo", "↶", labels.undo, undo);
  const bRedo = btn("gvn-ed-redo", "↷", labels.redo, redo);
  const bSave = btn("gvn-ed-save primary", labels.save, labels.saveHint, () => save());
  const bDownload = btn("gvn-ed-download", "⤓", labels.downloadHint, () => download());
  const bConnect = btn("gvn-ed-connect", "📁", labels.connectHint, () => connectFolder());
  const dirtyMark = el(doc, "span", "gvn-ed-dirty", "");
  const bClose = btn("gvn-ed-close", "✕", labels.closeEditor, () => toggle(false));
  head.append(bUndo, bRedo, el(doc, "span", "gvn-ed-spacer"), dirtyMark, bConnect, bDownload, bSave, bClose);

  const folderLine = el(doc, "div", "gvn-ed-folder");
  folderLine.hidden = true;

  const form = el(doc, "form", "gvn-ed-form");
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const row = (label, ...nodes) => {
    const r = el(doc, "label", "gvn-ed-row");
    const l = el(doc, "span", "gvn-ed-label", label);
    r.append(l, ...nodes);
    return r;
  };
  const select = (cls) => {
    const s = el(doc, "select", `gvn-ed-input ${cls}`);
    return s;
  };

  const lineTitle = el(doc, "div", "gvn-ed-line");
  const kindSel = select("gvn-ed-kind");
  const speakerSel = select("gvn-ed-speaker");
  const nameIn = el(doc, "input", "gvn-ed-input gvn-ed-name");
  nameIn.type = "text";
  const exprBox = imageField(labels.expression, { kind: "expression" });
  const standBox = imageField(labels.stand, { kind: "stand" });
  const faceBox = imageField(labels.face, { kind: "face" });
  const bgBox = imageField(labels.background, { kind: "background" });
  const propagateIn = el(doc, "input");
  propagateIn.type = "checkbox";
  propagateIn.checked = true;
  const propagateRow = el(doc, "label", "gvn-ed-check");
  propagateRow.append(propagateIn, el(doc, "span", null, labels.propagate));
  const clearStandsIn = el(doc, "input");
  clearStandsIn.type = "checkbox";
  const clearStandsRow = el(doc, "label", "gvn-ed-check");
  clearStandsRow.append(clearStandsIn, el(doc, "span", null, labels.clearStands));
  const textArea = el(doc, "textarea", "gvn-ed-input gvn-ed-text");
  textArea.rows = 5;
  const rawIn = el(doc, "input");
  rawIn.type = "checkbox";
  const rawRow = el(doc, "label", "gvn-ed-check gvn-ed-raw");
  rawRow.append(rawIn, el(doc, "span", null, labels.rawHtml));
  const textRow = el(doc, "div", "gvn-ed-row gvn-ed-textrow");
  textRow.append(el(doc, "span", "gvn-ed-label", labels.text), textArea, rawRow);

  const actions = el(doc, "div", "gvn-ed-actions");
  actions.append(
    btn("", labels.insertBefore, null, () => selectedId && insert(selectedId, "before")),
    btn("", labels.insertAfter, null, () => insert(selectedId, "after")),
    btn("", "↑", labels.moveUp, () => selectedId && move(selectedId, -1)),
    btn("", "↓", labels.moveDown, () => selectedId && move(selectedId, 1)),
    btn("danger", labels.deleteLine, null, () => selectedId && removeLine(selectedId)),
  );

  const speakerRow = row(labels.speaker, speakerSel);
  const nameRow = row(labels.name, nameIn);
  form.append(lineTitle, row(labels.kind, kindSel), speakerRow, nameRow, exprBox.root, propagateRow, standBox.root, faceBox.root, bgBox.root, clearStandsRow, textRow);

  const list = el(doc, "ol", "gvn-ed-list");
  list.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-id]");
    if (li) selectLine(li.dataset.id, true);
  });

  panel.append(head, folderLine, form, actions, list);
  app.append(panel);
  for (const e of [panel]) {
    e.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    e.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z" && !ev.target.closest("textarea, input[type=text]")) {
        ev.preventDefault();
        ev.shiftKey ? redo() : undo();
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        save();
      }
      ev.stopPropagation();
    });
  }

  function imageField(label, { kind }) {
    const root = el(doc, "div", `gvn-ed-row gvn-ed-image gvn-ed-image-${kind}`);
    const lab = el(doc, "span", "gvn-ed-label", label);
    const thumb = el(doc, "img", "gvn-ed-thumb");
    thumb.alt = "";
    thumb.loading = "lazy";
    const caption = el(doc, "span", "gvn-ed-caption");
    const buttons = el(doc, "div", "gvn-ed-imgbtns");
    const bChange = btn("", kind === "background" ? labels.bgSet : labels.change, null, () => pickFor(kind));
    buttons.append(bChange);
    if (kind === "background") {
      buttons.append(btn("", labels.bgClear, null, () => selectedId && update(selectedId, (m) => (m.vn.background = null))));
      buttons.append(btn("", labels.bgKeep, null, () => selectedId && update(selectedId, (m) => delete m.vn.background)));
    } else if (kind !== "expression") buttons.append(btn("", labels.remove, null, () => clearImage(kind)));
    const body = el(doc, "div", "gvn-ed-imgbody");
    body.append(thumb, caption, buttons);
    root.append(lab, body);
    return { root, thumb, caption, set: (src, text) => setThumb(thumb, caption, src, text) };
  }

  function setThumb(thumb, caption, src, text) {
    if (src) {
      thumb.src = src;
      thumb.hidden = false;
    } else {
      thumb.removeAttribute("src");
      thumb.hidden = true;
    }
    caption.textContent = text ?? (src ? fileNameOf(src) : labels.bgNone);
  }

  function clearImage(kind) {
    if (!selectedId) return;
    update(selectedId, (m) => {
      const e = m.vn.expression ?? { id: null, name: "", face: null, stand: null };
      e[kind] = null;
      e.id = null;
      m.vn.expression = e.face || e.stand ? e : null;
      if (kind === "face") m.img = null;
    });
  }

  /* ---------- form fill ---------- */

  let filling = false;
  let rawForced = false; // "edit as HTML" was switched on by a rich line, not by the user

  function categoryOptions(current) {
    const base = [
      ["speech", labels.kindSpeech],
      ["emote", labels.kindEmote],
      ["narration", labels.kindNarration],
      ["scene", labels.kindScene],
    ];
    if (current && !base.some(([v]) => v === current)) base.push([current, fmt(labels.kindKeep, { category: current })]);
    return base;
  }

  function fillSelect(sel, options, value) {
    sel.innerHTML = "";
    for (const [v, text] of options) {
      const o = el(doc, "option", null, text);
      o.value = v;
      sel.append(o);
    }
    sel.value = value ?? "";
    if (sel.value !== (value ?? "")) {
      const o = el(doc, "option", null, value ?? "");
      o.value = value ?? "";
      sel.append(o);
      sel.value = value ?? "";
    }
  }

  function refresh() {
    fillList();
    fillForm();
    bUndo.disabled = !past.length;
    bRedo.disabled = !future.length;
    dirtyMark.textContent = dirty ? labels.dirty : "";
    dirtyMark.title = dirty ? labels.unsaved : "";
  }

  function fillForm() {
    const m = selectedId ? findMessage(selectedId) : null;
    filling = true;
    form.classList.toggle("empty", !m);
    if (!m) {
      lineTitle.textContent = "";
      filling = false;
      return;
    }
    const category = PlayerCore.categoryOf(m);
    const speech = category === "speech" || category === "emote";
    const scene = category === "scene";
    const idx = messages.indexOf(m) + 1;
    lineTitle.textContent = `${labels.line} ${idx} / ${messages.length}${m.edited ? " ✎" : ""}`;
    fillSelect(kindSel, categoryOptions(category), category);
    const chars = [...catalog.characters.values()].map((c) => [c.key, c.name || c.key]);
    fillSelect(speakerSel, [["", labels.noSpeaker], ...chars], speech ? speakerKey(m) ?? "" : "");
    nameIn.value = m.vn?.name ?? m.alias ?? "";
    const e = expressionOf(m);
    exprBox.set(e?.stand ?? e?.face ?? null, e ? e.name || fileNameOf(e.stand ?? e.face) : labels.bgNone);
    standBox.set(e?.stand ?? null);
    faceBox.set(e?.face ?? null);
    const bg = m.vn?.background;
    if (bg === undefined) {
      const inh = inheritedBackground(m.id);
      bgBox.set(inh, `${labels.bgInherited}${inh ? ` · ${fileNameOf(inh)}` : ""}`);
    } else bgBox.set(bg ?? null, bg ? fileNameOf(bg) : labels.bgNone);
    clearStandsIn.checked = !!m.vn?.clearStands;
    speakerRow.hidden = !speech;
    nameRow.hidden = scene;
    exprBox.root.hidden = !speech;
    propagateRow.hidden = !speech;
    standBox.root.hidden = !speech;
    faceBox.root.hidden = !speech;
    textRow.hidden = scene;
    const html = category === "roll" ? "" : m.html ?? m.content ?? "";
    const simple = htmlToText(html);
    if (simple === null) {
      if (!rawIn.checked) rawForced = true;
      rawIn.checked = true;
    } else if (rawForced) {
      rawIn.checked = false;
      rawForced = false;
    }
    textArea.value = rawIn.checked ? html : simple;
    textArea.disabled = category === "roll";
    filling = false;
  }

  function fillList() {
    const visible = new Set(player.entries.map((e) => e.id));
    list.innerHTML = "";
    const frag = doc.createDocumentFragment();
    messages.forEach((m, i) => {
      const cat = PlayerCore.categoryOf(m);
      const li = el(doc, "li", `gvn-ed-item${visible.has(m.id) ? "" : " hidden-line"}${m.id === selectedId ? " current" : ""}${m.edited ? " edited" : ""}`);
      li.dataset.id = m.id;
      const n = el(doc, "span", "gvn-ed-num", String(i + 1));
      const who = el(doc, "span", "gvn-ed-who", cat === "scene" ? labels.sceneLine : cat === "speech" || cat === "emote" || cat === "roll" ? m.vn?.name ?? m.alias ?? "" : m.vn?.name ?? (m.alias && m.alias !== m.user ? m.alias : labels.narrationLine));
      const t = plainText(cat === "scene" ? "" : m.html || m.content || "");
      const text = el(doc, "span", "gvn-ed-snippet", cat === "scene" ? fileNameOf(m.vn?.background) || labels.bgNone : t.length > 60 ? `${t.slice(0, 60)}…` : t || labels.newLine);
      if (!visible.has(m.id)) text.title = `${labels.hiddenLine} (${cat})`;
      li.append(n, who, text);
      frag.append(li);
    });
    list.append(frag);
    list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  function markCurrent(id) {
    list.querySelector(".current")?.classList.remove("current");
    const li = list.querySelector(`li[data-id="${CSS.escape(id)}"]`);
    li?.classList.add("current");
    li?.scrollIntoView({ block: "nearest" });
  }

  function selectLine(id, seek = false) {
    selectedId = id;
    const i = player.entries.findIndex((e) => e.id === id);
    // Seeking fires the index listener, which only reacts to a *different* id, so fill the form here either way.
    if (seek && i >= 0 && i !== player.index) player.seek(i);
    fillForm();
    markCurrent(id);
  }

  /* ---------- form events ---------- */

  kindSel.addEventListener("change", () => {
    if (filling || !selectedId) return;
    update(selectedId, (m) => setCategory(m, kindSel.value));
  });
  speakerSel.addEventListener("change", () => {
    if (filling || !selectedId) return;
    update(selectedId, (m) => setSpeaker(m, speakerSel.value || null));
  });
  nameIn.addEventListener("change", () => {
    if (filling || !selectedId) return;
    update(selectedId, (m) => {
      m.vn.name = nameIn.value.trim() || null;
      if (PlayerCore.categoryOf(m) !== "narration") m.alias = nameIn.value.trim();
    });
  });
  clearStandsIn.addEventListener("change", () => {
    if (filling || !selectedId) return;
    update(selectedId, (m) => {
      if (clearStandsIn.checked) m.vn.clearStands = true;
      else delete m.vn.clearStands;
    });
  });
  rawIn.addEventListener("change", () => {
    if (filling) return;
    rawForced = false;
    fillForm();
  });
  let textTimer = null;
  textArea.addEventListener("input", () => {
    if (filling || !selectedId) return;
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
      const id = selectedId;
      const html = rawIn.checked ? textArea.value : textToHtml(textArea.value);
      const m = findMessage(id);
      if (!m || (m.html ?? "") === html) return;
      const pos = [textArea.selectionStart, textArea.selectionEnd];
      update(id, (x) => {
        x.html = html;
        x.content = html;
      });
      if (doc.activeElement !== textArea) textArea.focus();
      textArea.setSelectionRange(pos[0], pos[1]);
    }, 350);
  });
  textArea.addEventListener("blur", () => {
    if (textTimer) {
      clearTimeout(textTimer);
      textTimer = null;
      textArea.dispatchEvent(new Event("input"));
    }
  });

  /* ---------- image picking ---------- */

  const folderItems = (folder) => (folderFiles.get(folder) ?? []).map((p) => ({ src: p, name: fileNameOf(p) }));
  const setItems = (set) => [...set].map((p) => ({ src: p, name: fileNameOf(p) }));

  function dedupe(groups) {
    const seen = new Set();
    return groups
      .map((g) => ({ ...g, items: g.items.filter((it) => (seen.has(it.src) ? false : (seen.add(it.src), true))) }))
      .filter((g) => g.items.length);
  }

  function pickFor(kind) {
    const m = selectedId ? findMessage(selectedId) : null;
    if (!m) return;
    const key = speakerKey(m);
    const c = key ? catalog.characters.get(key) : null;
    const e = expressionOf(m);
    let groups;
    let folder;
    let current;
    if (kind === "expression") {
      groups = [{ label: labels.groupExpressions, items: c ? [...c.expressions.values()].map((x) => ({ src: x.stand ?? x.face, name: x.name || fileNameOf(x.stand ?? x.face), expression: x })) : [] }];
      groups.push({ label: labels.groupStands, items: [...setItems(catalog.stands), ...folderItems("stands")] });
      folder = "stands";
      current = e?.stand ?? e?.face;
    } else if (kind === "stand") {
      groups = [
        { label: labels.groupStands, items: [...setItems(catalog.stands), ...folderItems("stands")] },
        { label: labels.groupFaces, items: [...setItems(catalog.faces), ...folderItems("faces")] },
        { label: labels.groupOther, items: [...setItems(catalog.other), ...folderItems("images"), ...folderItems("portraits"), ...folderItems("refs/images")] },
      ];
      folder = "stands";
      current = e?.stand;
    } else if (kind === "face") {
      groups = [
        { label: labels.groupFaces, items: [...setItems(catalog.faces), ...folderItems("faces"), ...folderItems("portraits")] },
        { label: labels.groupStands, items: [...setItems(catalog.stands), ...folderItems("stands")] },
        { label: labels.groupOther, items: [...setItems(catalog.other), ...folderItems("images"), ...folderItems("refs/images")] },
      ];
      folder = "faces";
      current = e?.face;
    } else {
      groups = [
        { label: labels.groupBackgrounds, items: [...setItems(catalog.backgrounds), ...folderItems("backgrounds")] },
        { label: labels.groupOther, items: [...setItems(catalog.other), ...folderItems("images"), ...folderItems("refs/images")] },
        { label: labels.groupStands, items: [...setItems(catalog.stands), ...folderItems("stands")] },
      ];
      folder = "backgrounds";
      current = m.vn?.background ?? null;
    }
    openPicker({
      title: kind === "expression" ? labels.pickExpression : labels.pickTitle,
      groups: dedupe(groups),
      folder,
      current,
      onPick: (item) => {
        const id = selectedId;
        if (!id) return;
        if (kind === "expression") {
          const x = item.expression ?? { id: null, name: item.name, face: e?.face ?? null, stand: item.src };
          applyExpression(id, x, propagateIn.checked);
        } else if (kind === "background") update(id, (x) => (x.vn.background = item.src));
        else
          update(id, (x) => {
            const cur = x.vn.expression ?? { id: null, name: "", face: null, stand: null };
            cur[kind] = item.src;
            cur.id = null;
            if (!cur.name) cur.name = item.name;
            x.vn.expression = cur;
            if (kind === "face") x.img = item.src;
          });
      },
    });
  }

  function openPicker({ title, groups, folder, current, onPick }) {
    const overlay = el(doc, "div", "gvn-modal");
    const box = el(doc, "div", "gvn-modal-box");
    const h = el(doc, "div", "gvn-modal-head");
    h.append(el(doc, "span", "gvn-modal-title", title));
    const close = () => overlay.remove();
    h.append(btn("gvn-modal-close", "✕", labels.cancel, close));
    const body = el(doc, "div", "gvn-modal-body");
    if (!groups.length) body.append(el(doc, "p", "gvn-modal-empty", labels.noImages));
    for (const g of groups) {
      body.append(el(doc, "h4", null, g.label));
      const grid = el(doc, "div", "gvn-pick-grid");
      for (const it of g.items) {
        const b = el(doc, "button", `gvn-pick${it.src === current ? " current" : ""}`);
        b.type = "button";
        const img = el(doc, "img");
        img.src = it.src;
        img.alt = "";
        img.loading = "lazy";
        const cap = el(doc, "span", "gvn-pick-cap", it.name);
        b.title = it.name;
        b.append(img, cap);
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          close();
          onPick(it);
        });
        grid.append(b);
      }
      body.append(grid);
    }
    const foot = el(doc, "div", "gvn-modal-foot");
    const fileIn = el(doc, "input");
    fileIn.type = "file";
    fileIn.accept = "image/*";
    fileIn.hidden = true;
    fileIn.addEventListener("change", async () => {
      const file = fileIn.files?.[0];
      if (!file) return;
      const dataUrl = await readAsDataUrl(file);
      pending.set(dataUrl, { folder, name: file.name, blob: file });
      close();
      onPick({ src: dataUrl, name: file.name });
    });
    const bFile = btn("", labels.fromFile, null, () => fileIn.click());
    const pathIn = el(doc, "input", "gvn-ed-input gvn-pick-path");
    pathIn.type = "text";
    pathIn.placeholder = `${labels.path} (${folder}/…)`;
    const bOk = btn("primary", labels.ok, null, () => {
      const p = pathIn.value.trim();
      if (!p) return;
      close();
      onPick({ src: p, name: fileNameOf(p) });
    });
    pathIn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        bOk.click();
      }
    });
    foot.append(bFile, fileIn, pathIn, bOk);
    box.append(h, body, foot);
    overlay.append(box);
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close();
    });
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
      ev.stopPropagation();
    });
    overlay.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    doc.body.append(overlay);
    box.tabIndex = -1;
    box.focus();
  }

  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });

  /* ---------- folder & saving ---------- */

  async function connectFolder() {
    if (typeof win.showDirectoryPicker !== "function") {
      toast(labels.folderUnsupported);
      return false;
    }
    let handle;
    try {
      handle = await win.showDirectoryPicker({ mode: "readwrite", id: "gvn-bundle" });
    } catch {
      return false;
    }
    try {
      await handle.getFileHandle(pageName);
    } catch {
      toast(fmt(labels.wrongFolder, { file: pageName }));
      return false;
    }
    dir = handle;
    folderLine.textContent = fmt(labels.connected, { name: handle.name });
    folderLine.hidden = false;
    bConnect.classList.add("active");
    await scanFolder();
    return true;
  }

  async function scanFolder() {
    folderFiles.clear();
    for (const folder of BUNDLE_FOLDERS) {
      try {
        let h = dir;
        for (const part of folder.split("/")) h = await h.getDirectoryHandle(part);
        const files = [];
        for await (const [name, entry] of h.entries()) if (entry.kind === "file" && IMAGE_RE.test(name)) files.push(`${folder}/${name}`);
        files.sort((a, b) => a.localeCompare(b));
        folderFiles.set(folder, files);
      } catch {
        /* folder absent */
      }
    }
  }

  /** The log to write: header kept, messages replaced, pending files resolved to bundle paths when writing to a folder. */
  function outputLog(resolvePending) {
    const out = JSON.parse(JSON.stringify(messages));
    const used = new Map();
    if (resolvePending) {
      const taken = new Set([...folderFiles.values()].flat());
      const nameFor = (p) => {
        let name = p.name.replace(/[\\/:*?"<>|]+/g, "_");
        let path = `${p.folder}/${name}`;
        let n = 1;
        while (taken.has(path) && !used.has(path)) {
          const dot = name.lastIndexOf(".");
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          path = `${p.folder}/${stem}-${++n}${ext}`;
        }
        taken.add(path);
        return path;
      };
      const swap = (v) => {
        if (typeof v !== "string" || !pending.has(v)) return v;
        const p = pending.get(v);
        if (!p.path) p.path = nameFor(p);
        used.set(p.path, p);
        return p.path;
      };
      for (const m of out) {
        m.img = swap(m.img);
        if (m.vn?.expression) {
          m.vn.expression.stand = swap(m.vn.expression.stand);
          m.vn.expression.face = swap(m.vn.expression.face);
        }
        if (m.vn && typeof m.vn.background === "string") m.vn.background = swap(m.vn.background);
      }
    }
    const logOut = { ...log, messages: out, count: out.length, from: out[0]?.timestamp ?? null, to: out.at(-1)?.timestamp ?? null, edited: { at: Date.now(), editor: EDITOR_VERSION } };
    return { log: logOut, files: used };
  }

  /** This page with the log replaced: everything the player added at runtime is stripped. */
  function buildPage(logOut) {
    const root = doc.documentElement.cloneNode(true);
    const appEl = root.querySelector("#gvn-app");
    if (appEl) {
      appEl.replaceChildren();
      appEl.removeAttribute("class");
    }
    root.querySelectorAll(".gvn-modal, .gvn-toast, .gvn-editor").forEach((e) => e.remove());
    root.querySelector("body")?.classList.remove("gvn-alt", "gvn-editing");
    const s = root.querySelector("#gvn-log");
    if (!s) throw new Error("#gvn-log missing");
    s.textContent = JSON.stringify(logOut).replace(/</g, "\\u003c");
    return `<!DOCTYPE html>\n${root.outerHTML}`;
  }

  async function writeFile(dirHandle, path, data) {
    const parts = path.split("/");
    const name = parts.pop();
    let h = dirHandle;
    for (const part of parts) h = await h.getDirectoryHandle(part, { create: true });
    const fh = await h.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  async function save() {
    if (!dir) {
      if (typeof win.showDirectoryPicker !== "function") return download();
      const ok = await connectFolder();
      if (!ok) return false;
    }
    if (!win.confirm(fmt(labels.overwrite, { file: pageName, folder: dir.name }))) return false;
    try {
      const { log: logOut, files } = outputLog(true);
      for (const [path, p] of files) await writeFile(dir, path, p.blob);
      await writeFile(dir, pageName, buildPage(logOut));
      await writeFile(dir, logName, JSON.stringify(logOut));
      // Pending images now live in the folder: point the working copy at them.
      if (files.size) {
        messages = logOut.messages.map((m) => {
          const { edited, ...rest } = m;
          return edited ? { ...rest, edited } : rest;
        });
        for (const p of files.values()) for (const [k, v] of pending) if (v === p) pending.delete(k);
        catalog = buildCatalog(messages);
        player.reload(messages, { focusId: selectedId });
      }
      await scanFolder();
      dirty = false;
      clearDraft();
      refresh();
      toast(fmt(labels.saved, { files: `${pageName}, ${logName}${files.size ? `, +${files.size}` : ""}`, folder: dir.name }));
      return true;
    } catch (err) {
      console.error("gatos-visual-novel | save failed", err);
      toast(fmt(labels.saveFailed, { error: err?.message ?? err }));
      return false;
    }
  }

  function downloadBlob(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = name;
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function download() {
    const { log: logOut } = outputLog(false);
    downloadBlob(pageName, buildPage(logOut), "text/html;charset=utf-8");
    downloadBlob(logName, JSON.stringify(logOut), "application/json;charset=utf-8");
    const embedded = [...pending.keys()].filter((k) => JSON.stringify(logOut.messages).includes(k)).length;
    dirty = false;
    clearDraft();
    refresh();
    toast(`${fmt(labels.downloaded, { file: `${pageName}, ${logName}` })}${embedded ? ` ${fmt(labels.embeddedNote, { count: embedded })}` : ""}`);
    return true;
  }

  /* ---------- drafts ---------- */

  let draftTimer = null;
  function scheduleDraft() {
    if (!storage) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        storage.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), messages }));
      } catch (err) {
        console.warn("gatos-visual-novel | draft not saved", err);
      }
    }, 500);
  }
  function clearDraft() {
    clearTimeout(draftTimer);
    try {
      storage?.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }
  function offerDraft() {
    if (!storage) return;
    let draft = null;
    try {
      draft = JSON.parse(storage.getItem(draftKey) ?? "null");
    } catch {
      draft = null;
    }
    if (!draft?.messages?.length) return;
    toast(fmt(labels.draftFound, { when: new Date(draft.savedAt).toLocaleString() }), [
      [
        labels.draftLoad,
        () => {
          past.push(snapshot());
          messages = draft.messages;
          toggle(true);
          afterChange(currentPlayerId());
        },
      ],
      [labels.draftDiscard, () => clearDraft()],
    ]);
  }

  /* ---------- toasts ---------- */

  function toast(text, buttons = []) {
    const t = el(doc, "div", "gvn-toast");
    t.append(el(doc, "span", null, text));
    for (const [label, fn] of buttons)
      t.append(
        btn("", label, null, () => {
          fn();
          t.remove();
        }),
      );
    const x = btn("gvn-toast-close", "✕", null, () => t.remove());
    t.append(x);
    doc.body.append(t);
    if (!buttons.length) setTimeout(() => t.remove(), 6000);
  }

  /* ---------- open / close ---------- */

  const bEdit = el(doc, "button", "gvn-pb gvn-pb-edit", "✎");
  bEdit.type = "button";
  bEdit.title = labels.edit;
  bEdit.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    toggle();
  });
  const closeBtn = player.bar.querySelector(".gvn-pb-close");
  if (closeBtn) player.bar.insertBefore(bEdit, closeBtn);
  else player.bar.append(bEdit);

  function toggle(force) {
    open = force === undefined ? !open : !!force;
    panel.hidden = !open;
    app.classList.toggle("gvn-editing", open);
    bEdit.classList.toggle("active", open);
    if (open) {
      player.pause();
      selectedId ??= currentPlayerId();
      refresh();
    }
  }

  const offIndex = player.onIndex((i, entry) => {
    if (!open) return;
    if (entry && entry.id !== selectedId) {
      selectedId = entry.id;
      fillForm();
      markCurrent(entry.id);
    }
  });

  const onUnload = (ev) => {
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  };
  win.addEventListener("beforeunload", onUnload);

  offerDraft();

  return {
    get open() {
      return open;
    },
    get dirty() {
      return dirty;
    },
    get messages() {
      return messages;
    },
    get selectedId() {
      return selectedId;
    },
    toggle,
    select: selectLine,
    update,
    insert,
    remove: removeLine,
    move,
    applyExpression,
    undo,
    redo,
    save,
    download,
    connectFolder,
    buildPage: () => buildPage(outputLog(false).log),
    destroy() {
      offIndex();
      win.removeEventListener("beforeunload", onUnload);
      panel.remove();
      bEdit.remove();
      app.classList.remove("gvn-editing");
    },
  };
}
