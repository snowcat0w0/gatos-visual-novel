import { MODULE_ID, chatTools } from "./constants.js";
import { pure } from "./lib.js";
import { isGctNote } from "./tags.js";

const { stripTooltips } = pure;
import { setting } from "./settings.js";
import { expressionFlagFor } from "./expressions.js";

/**
 * Raw category of a message, independent of client preferences:
 * hidden | note | chitchat | narration | roll | ooc | speech | emote  (note = chat-tools shared note, always ignored)
 * @param {ChatMessage} message
 * @param {object} [opts]
 * @param {boolean} [opts.viewer=true]  Treat messages this client cannot see as hidden.
 */
export function categorize(message, { viewer = true } = {}) {
  const S = CONST.CHAT_MESSAGE_STYLES;
  const flags = message.flags?.[MODULE_ID] ?? {};
  const speaker = message.speaker ?? {};
  // Whispered ROLLS are `visible` to everybody in core (shown as "rolled privately"): use the content visibility,
  // or the roll totals and flavor of a GM's private roll would reach every stage with rollMode "narration".
  if (viewer && (message.visible === false || message.isContentVisible === false)) return "hidden";
  if (isGctNote(message)) return "note";
  if (message.flags?.["gatos-chat-tools"]?.chitchat) return "chitchat";
  if (flags.narration) return "narration";
  if (message.isRoll) return "roll";
  if (message.style === S.OOC) return "ooc";
  if (speaker.actor || speaker.token) return message.style === S.EMOTE ? "emote" : "speech";
  return "narration";
}

/** Map a category to the reducer kind using this client's settings. */
export function kindOf(category, message) {
  switch (category) {
    case "speech":
    case "emote":
      return "speech";
    case "narration":
      return "narration";
    case "roll":
      return setting("rollMode") === "narration" ? "narration" : "ignore";
    case "ooc": {
      const mode = setting("oocMode");
      if (mode === "narration") return "narration";
      if (mode === "gmNarration" && message.author?.isGM) return "narration";
      return "ignore";
    }
    default:
      return "ignore";
  }
}

/** Stand slot key for a speaker: one stand per actor (PLAN §15.2). */
export function slotKey(speaker) {
  if (speaker?.actor) return `Actor.${speaker.actor}`;
  if (speaker?.token) return `Token.${speaker.scene ?? ""}.${speaker.token}`;
  if (speaker?.alias) return `Alias.${speaker.alias}`;
  return null;
}

/** The frozen expression of a message, or a live default for messages made before the module. */
export function expressionOf(message) {
  const frozen = message.flags?.[MODULE_ID]?.expression;
  if (frozen) return frozen;
  const speaker = message.speaker ?? {};
  if (!speaker.actor && !speaker.token) return null;
  return expressionFlagFor(speaker);
}

/**
 * Synchronous part of the entry (everything but the dialogue HTML).
 * @returns {object} Entry with `category`; `html` is "".
 */
export function describe(message, { viewer = true } = {}) {
  const category = categorize(message, { viewer });
  const kind = kindOf(category, message);
  const speaker = message.speaker ?? {};
  const flags = message.flags?.[MODULE_ID] ?? {};
  const entry = {
    id: message.id,
    timestamp: message.timestamp,
    kind,
    category,
    key: null,
    name: null,
    stand: null,
    face: null,
    emote: category === "emote",
    standStyle: null,
    expression: null,
    refs: Array.isArray(flags.refs) ? flags.refs : [],
    html: "",
  };
  if (category === "speech" || category === "emote") {
    const e = expressionOf(message);
    entry.key = slotKey(speaker);
    entry.name = message.alias ?? speaker.alias ?? "";
    entry.stand = e?.stand ?? null;
    entry.face = e?.face ?? null;
    entry.standStyle = e?.standStyle ?? null;
    entry.expression = e ? { id: e.id, name: e.name, face: e.face, stand: e.stand } : null;
  } else {
    const alias = speaker.alias && speaker.alias !== message.author?.name ? speaker.alias : null;
    entry.name = category === "roll" ? message.alias ?? null : alias;
  }
  return entry;
}

/**
 * Rendered `.message-content` HTML for the dialogue box. Markup is kept as rendered (sanitized by the server and
 * the renderer): chat-tools font-style spans (`<span class="gct-fs" style="…">`) and ruby survive, and the
 * typewriter types text node by text node so the styling stays while a line is typed out.
 * gatos-lib stripTooltips parses with DOMParser (inert: no image loads or handlers).
 */
export async function dialogueHtml(message) {
  if (message.isRoll && categorize(message) === "roll") {
    const totals = message.rolls.map((r) => `<strong class="gvn-roll-total">${r.total}</strong>`).join(" ");
    return `${message.flavor ? `<span class="gvn-roll-flavor">${message.flavor}</span> ` : ""}${totals}`;
  }
  const ct = chatTools();
  let html;
  if (ct?.renderMessageContent) html = await ct.renderMessageContent(message);
  else {
    try {
      const el = await message.renderHTML();
      html = el?.querySelector?.(".message-content")?.innerHTML ?? message.content ?? "";
    } catch {
      html = message.content ?? "";
    }
  }
  return stripTooltips(html);
}

/** Full entry for the reducer. */
export async function toEntry(message, { html = true } = {}) {
  const entry = describe(message);
  if (html && entry.kind !== "ignore") entry.html = await dialogueHtml(message);
  return entry;
}
