import { MODULE_ID, L } from "./constants.js";
import { htmlRoot } from "./lib.js";
import { setting } from "./settings.js";
import { getExpressions } from "./expressions.js";

/** `{{키워드}}` or `{{키워드|표시 텍스트}}` (PLAN §7.1). A fresh RegExp per use (global state). */
export const keywordRegExp = () => /\{\{([^}|]+?)(?:\|([^}]+?))?\}\}/g;

const MAX_TEXT = 20000;
const norm = (s) => String(s ?? "").trim().toLocaleLowerCase();

/* -------------------------------------------- */
/*  Permission                                  */
/* -------------------------------------------- */

/** The configured minimum ownership level for creating and opening links. */
export function linkPermissionLevel() {
  const L_ = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  return L_[setting("linkPermission")] ?? L_.OBSERVER;
}

/** May this user link to / open the document? GMs always may. */
export function hasLinkPermission(doc, user = game.user) {
  if (!doc) return false;
  if (user?.isGM) return true;
  return !!doc.testUserPermission?.(user, linkPermissionLevel());
}

/** May the current user see a frozen reference (stage panel / sheet)? */
export function canViewRef(ref) {
  if (game.user.isGM) return true;
  try {
    return hasLinkPermission(fromUuidSync(ref?.uuid));
  } catch {
    return false;
  }
}

/* -------------------------------------------- */
/*  Keyword registry                            */
/* -------------------------------------------- */

/** [{ keyword, uuid, addedBy }] */
export function getKeywords() {
  return foundry.utils.deepClone(setting("keywords")?.list ?? []);
}

/**
 * Apply a registry change on a GM client (direct or from a player's socket request).
 * @returns {{ok: boolean, error?: string}}
 */
export async function applyKeywordOp(op, entry, user) {
  if (!game.user.isGM) return { ok: false, error: "Keywords.GMRequired" };
  const list = getKeywords();
  const keyword = String(entry?.keyword ?? "").trim();
  if (op === "add") {
    if (!keyword || !entry?.uuid) return { ok: false, error: "Keywords.ErrInvalid" };
    if (/[{}|]/.test(keyword)) return { ok: false, error: "Keywords.ErrChars" };
    let doc = null;
    try {
      doc = fromUuidSync(entry.uuid);
    } catch {
      doc = null;
    }
    if (!doc) return { ok: false, error: "Keywords.ErrNoDoc" };
    if (!["Actor", "Item", "JournalEntry", "JournalEntryPage"].includes(doc.documentName)) return { ok: false, error: "Keywords.ErrType" };
    if (!hasLinkPermission(doc, user)) return { ok: false, error: "Link.NoPermissionCreate" };
    if (list.some((e) => norm(e.keyword) === norm(keyword))) return { ok: false, error: "Keywords.ErrDuplicate" };
    list.push({ keyword, uuid: doc.uuid, addedBy: user?.id ?? null });
  } else if (op === "remove") {
    const i = list.findIndex((e) => norm(e.keyword) === norm(keyword));
    if (i < 0) return { ok: false, error: "Keywords.ErrMissing" };
    if (!user?.isGM && list[i].addedBy !== user?.id) return { ok: false, error: "Keywords.ErrNotOwner" };
    list.splice(i, 1);
  } else return { ok: false, error: "Keywords.ErrInvalid" };
  await game.settings.set(MODULE_ID, "keywords", { list });
  return { ok: true };
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

/**
 * Resolve keyword text to a document the user may link to.
 * Order: registry → actor → item → journal → journal page → "journal/page".
 * @returns {{doc: Document|null, found: boolean}} found: a matching document exists (permission may be missing).
 */
export function resolveKeyword(text, user = game.user) {
  const k = norm(text);
  if (!k) return { doc: null, found: false };
  const candidates = [];
  const reg = getKeywords().find((e) => norm(e.keyword) === k);
  if (reg) {
    try {
      const d = fromUuidSync(reg.uuid);
      if (d) candidates.push(d);
    } catch {
      /* stale registry entry */
    }
  }
  for (const coll of [game.actors, game.items, game.journal]) {
    for (const d of coll) if (norm(d.name) === k) candidates.push(d);
  }
  for (const j of game.journal) {
    for (const p of j.pages) if (norm(p.name) === k) candidates.push(p);
  }
  const slash = String(text).indexOf("/");
  if (slash > 0) {
    const jn = norm(String(text).slice(0, slash));
    const pn = norm(String(text).slice(slash + 1));
    for (const j of game.journal) {
      if (norm(j.name) !== jn) continue;
      for (const p of j.pages) if (norm(p.name) === pn) candidates.push(p);
    }
  }
  const doc = candidates.find((d) => hasLinkPermission(d, user)) ?? null;
  return { doc, found: candidates.length > 0 };
}

function stripSecrets(html) {
  if (!html || !/secret/.test(html)) return html;
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("section.secret").forEach((s) => s.remove());
  return div.innerHTML;
}

function capText(html) {
  if (!html) return null;
  html = stripSecrets(html);
  return html.length > MAX_TEXT ? `${html.slice(0, MAX_TEXT)}…` : html;
}

const sortedPages = (journal) => journal.pages.contents.slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

/** Freeze the reference data of a linked document (PLAN §7.3). */
export function buildRef(doc, keyword) {
  const ref = { uuid: doc.uuid, type: doc.documentName, name: doc.name, keyword, img: null, text: null };
  switch (doc.documentName) {
    case "Actor":
      ref.img = getExpressions(doc)[0]?.face || doc.img || null;
      break;
    case "Item":
      ref.img = doc.img || null;
      break;
    case "JournalEntry": {
      const pages = sortedPages(doc);
      ref.img = pages.find((p) => p.type === "image" && p.src)?.src ?? null;
      ref.text = capText(pages.find((p) => p.type === "text")?.text?.content ?? null);
      break;
    }
    case "JournalEntryPage":
      if (doc.type === "image") ref.img = doc.src || null;
      else if (doc.type === "text") ref.text = capText(doc.text?.content ?? null);
      break;
  }
  return ref;
}

/**
 * Turn keyword links into `@UUID[…]{…}` content links.
 * Unresolved keywords are left as text but split by an empty span so the `{{…}}` enricher cannot
 * resolve them later with the *viewer's* permission.
 * @returns {{content: string, refs: object[], failed: string[]}}
 */
export function processContent(content, user = game.user) {
  const refs = [];
  const failed = [];
  const out = content.replace(keywordRegExp(), (whole, kw, label) => {
    const keyword = kw.trim();
    const { doc } = resolveKeyword(keyword, user);
    if (!doc) {
      failed.push(keyword);
      return `{<span class="gvn-kw-raw"></span>${whole.slice(1)}`;
    }
    if (!refs.some((r) => r.uuid === doc.uuid)) refs.push(buildRef(doc, keyword));
    return `@UUID[${doc.uuid}]{${(label ?? kw).trim()}}`;
  });
  return { content: out, refs, failed };
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

/** preCreateChatMessage (author's client): resolve links with the author's permission and freeze refs. */
export function onPreCreateChatMessageLinks(message, data, options, userId) {
  if (userId !== game.user.id) return;
  const content = message.content;
  if (typeof content !== "string" || !content.includes("{{")) return;
  const { content: out, refs, failed } = processContent(content);
  const update = {};
  if (out !== content) update.content = out;
  if (refs.length) update[`flags.${MODULE_ID}.refs`] = refs;
  if (!foundry.utils.isEmpty(update)) message.updateSource(update);
  if (failed.length) ui.notifications.warn(L("Link.NotFound", { keywords: failed.join(", ") }));
}

/** preUpdateChatMessage (editor's client): same for edited content; refs are merged. */
export function onPreUpdateChatMessageLinks(message, changes, options, userId) {
  if (userId !== game.user.id || typeof changes.content !== "string" || !changes.content.includes("{{")) return;
  const { content, refs, failed } = processContent(changes.content);
  changes.content = content;
  if (refs.length) {
    const prev = message.flags?.[MODULE_ID]?.refs ?? [];
    const merged = [...prev, ...refs.filter((r) => !prev.some((p) => p.uuid === r.uuid))];
    foundry.utils.setProperty(changes, `flags.${MODULE_ID}.refs`, merged);
  }
  if (failed.length) ui.notifications.warn(L("Link.NotFound", { keywords: failed.join(", ") }));
}

/** Open the linked document for the current user (permission per the module setting). */
export async function openRef(ref) {
  let doc = null;
  try {
    doc = await fromUuid(ref?.uuid);
  } catch {
    doc = null;
  }
  if (!doc) return ui.notifications.warn(L("Link.Missing", { name: ref?.name ?? "?" }));
  if (!hasLinkPermission(doc)) return ui.notifications.warn(L("Link.NoPermission", { name: ref?.name ?? doc.name }));
  Hooks.callAll("gvnRefOpened", ref);
  if (doc.documentName === "JournalEntryPage") return doc.parent.sheet.render({ force: true, pageId: doc.id });
  return doc.sheet?.render({ force: true });
}

/** renderChatMessageHTML: mark frozen reference links and route their clicks through our permission check. */
export function onRenderChatMessageLinks(message, html) {
  const el = htmlRoot(html);
  const refs = message?.flags?.[MODULE_ID]?.refs;
  if (!el || !refs?.length) return;
  for (const a of el.querySelectorAll("a.content-link[data-uuid]")) {
    const index = refs.findIndex((r) => r.uuid === a.dataset.uuid);
    if (index < 0 || a.classList.contains("gvn-ref-link")) continue;
    a.classList.add("gvn-ref-link");
    a.dataset.gvnRefIndex = String(index);
    if (!canViewRef(refs[index])) a.classList.add("gvn-ref-locked");
    // Capture on the anchor itself: runs before Foundry's body-level content-link handler (LIMITED only).
    a.addEventListener(
      "click",
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openRef(refs[index]);
      },
      { capture: true }
    );
  }
}

/** The same syntax outside chat (journals, item descriptions): resolved with the *viewer's* permission, no reference panel. */
export function registerEnricher() {
  CONFIG.TextEditor.enrichers.push({
    pattern: keywordRegExp(),
    enricher: async (match) => {
      const { doc } = resolveKeyword(match[1]);
      if (!doc) return null;
      return doc.toAnchor({ name: (match[2] ?? match[1]).trim() });
    },
  });
}
