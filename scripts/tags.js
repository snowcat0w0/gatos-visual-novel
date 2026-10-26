/**
 * Chat markup owned by this module (PURE: no imports, no Foundry globals; tested under Node).
 *
 *   `{표정}` at the start of a message   inline expression tag (expressions.js)
 *   `{{키워드}}` / `{{키워드|텍스트}}`    keyword link (links.js)
 *
 * gatos-chat-tools turns `{@name text}` into a styled `<span class="gct-fs">` (font styles). Neither pattern may
 * claim that markup: a brace followed by `@` is never ours.
 */

/** Leading `{표정}` tag: single braces, not `{{`, not `{@…}`; `|` is chat-tools' ruby markup. */
export const INLINE_TAG = /^(\s*(?:<p>)?\s*)\{(?![{@])([^{}|]+?)\}\s*/;

/** `{{키워드}}` or `{{키워드|표시 텍스트}}`, never `{{@…}}`. A fresh RegExp per use (global state). */
export const keywordRegExp = () => /\{\{(?!@)([^}|]+?)(?:\|([^}]+?))?\}\}/g;

/**
 * Is this a gatos-chat-tools shared note (a public OOC message flagged `flags["gatos-chat-tools"].note`)?
 * Notes are table notes, not story: the stage, bubbles, keyword references, the log player and exports skip them.
 * Accepts a ChatMessage, its source data, or a serialized archive message (`note` / `flags`).
 */
export function isGctNote(message) {
  return !!(message?.flags?.["gatos-chat-tools"]?.note || message?.note === true);
}

/**
 * Split an inline tag off the start of message content.
 * @param {string} content
 * @returns {{name: string, rest: string}|null}  `rest` keeps the leading `<p>` (if any) and drops the tag.
 */
export function splitInlineTag(content) {
  if (typeof content !== "string") return null;
  const m = INLINE_TAG.exec(content);
  if (!m) return null;
  return { name: m[2], rest: m[1] + content.slice(m[0].length) };
}
