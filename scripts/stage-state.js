/**
 * Novel stage state reducer (PLAN §6.2).
 *
 * PURE MODULE: no imports and no Foundry globals (game, foundry, ui, Hooks, CONFIG). The future log
 * player copies this file verbatim into exported bundles, so it must run in a plain browser page.
 *
 * Entry = {
 *   id, timestamp,
 *   kind: "speech" | "narration" | "scene" | "ignore",
 *   background?: string | null   (undefined = unchanged, null = clear, path = set; edited logs only)
 *   clearStands?: boolean        (edited logs only)
 *   key: "Actor.<id>" | "Token.<sceneId>.<tokenId>" | "Alias.<alias>" | null,
 *   name, stand, face, html, emote,
 *   standStyle: { scale, offsetY } | null,
 *   refs: [{ uuid, type, name, img, text, href? }]
 * }
 */

export const STATE_VERSION = 1;
export const MAX_SLOTS = 6;

/** Slot priority from the centre outwards, e.g. 6 → [2, 3, 1, 4, 0, 5]. */
export function centerOutOrder(n) {
  n = Math.max(1, Math.min(MAX_SLOTS, Math.floor(n) || 1));
  let left = Math.floor((n - 1) / 2);
  let right = left + 1;
  const order = [left--];
  while (order.length < n) {
    if (right < n) order.push(right++);
    if (order.length < n && left >= 0) order.push(left--);
  }
  return order;
}

/** A fresh, empty stage. */
export function createState(maxSlots = MAX_SLOTS) {
  return { slots: Array(clampSlots(maxSlots)).fill(null), activeKey: null, dialogue: null, ref: null, background: null, seq: 0 };
}

function clampSlots(n) {
  return Math.max(1, Math.min(MAX_SLOTS, Math.floor(n) || MAX_SLOTS));
}

function placeIn(slots, slot, order) {
  const free = order.find((i) => i < slots.length && !slots[i]);
  if (free !== undefined) {
    slots[free] = slot;
    return slots;
  }
  // No free slot: evict whoever has been silent the longest.
  let oldest = 0;
  for (let i = 1; i < slots.length; i++) if (slots[i].lastSeq < slots[oldest].lastSeq) oldest = i;
  slots[oldest] = slot;
  return slots;
}

function dialogueOf(entry, named) {
  return {
    name: named ? entry.name ?? null : entry.name || null,
    html: entry.html ?? "",
    messageId: entry.id ?? null,
    ts: entry.timestamp ?? null,
    emote: !!entry.emote,
    face: entry.face ?? null,
    key: named ? entry.key ?? null : null,
  };
}

/**
 * Apply one entry to the state. Never mutates its input.
 * @param {object} state
 * @param {object} entry
 * @param {object} [opts]
 * @param {number} [opts.maxSlots]
 * @param {number[]} [opts.slotOrder]
 */
export function apply(state, entry, { maxSlots, slotOrder } = {}) {
  if (!entry || entry.kind === "ignore") return state;
  let next = maxSlots && maxSlots !== state.slots.length ? withMaxSlots(state, maxSlots) : state;
  // Editor-only fields (exported logs): dismiss every stand / change the background from this entry on.
  if (entry.clearStands) next = { ...next, slots: next.slots.map(() => null), activeKey: null };
  if (entry.background !== undefined) next = { ...next, background: entry.background || null };
  const order = slotOrder?.length ? slotOrder : centerOutOrder(next.slots.length);
  const seq = next.seq + 1;
  const ref = entry.refs?.length ? { refs: entry.refs, messageId: entry.id ?? null } : null;

  // Scene cut: only the background (and stands) change; no dialogue.
  if (entry.kind === "scene") return { ...next, seq, dialogue: null, ref: null };

  if (entry.kind === "narration") {
    return { ...next, seq, dialogue: dialogueOf(entry, false), ref };
  }

  // speech
  let slots = next.slots;
  const at = entry.key ? slots.findIndex((s) => s?.key === entry.key) : -1;
  if (at >= 0) {
    slots = slots.slice();
    slots[at] = {
      ...slots[at],
      name: entry.name ?? slots[at].name,
      stand: entry.stand ?? slots[at].stand,
      standStyle: entry.standStyle ?? slots[at].standStyle ?? null,
      lastTs: entry.timestamp ?? slots[at].lastTs,
      lastSeq: seq,
      messageId: entry.id ?? null,
    };
  } else if (entry.key && entry.stand) {
    const slot = {
      key: entry.key,
      name: entry.name ?? "",
      stand: entry.stand,
      standStyle: entry.standStyle ?? null,
      lastTs: entry.timestamp ?? 0,
      lastSeq: seq,
      messageId: entry.id ?? null,
    };
    slots = placeIn(slots.slice(), slot, order);
  }
  return { ...next, slots, seq, activeKey: entry.key ?? null, dialogue: dialogueOf(entry, true), ref };
}

/** Apply a list of entries in order. */
export function applyAll(state, entries, opts) {
  return entries.reduce((s, e) => apply(s, e, opts), state);
}

/** Remove a speaker's stand from the stage. */
export function remove(state, key) {
  if (!state.slots.some((s) => s?.key === key)) return state;
  return {
    ...state,
    slots: state.slots.map((s) => (s?.key === key ? null : s)),
    activeKey: state.activeKey === key ? null : state.activeKey,
  };
}

/** Remove every stand that has not spoken since `beforeTs`. */
export function removeIdle(state, beforeTs) {
  const stale = state.slots.filter((s) => s && (s.lastTs ?? 0) < beforeTs).map((s) => s.key);
  return stale.reduce((s, key) => remove(s, key), state);
}

/** Empty the stage completely. */
export function clear(state) {
  return createState(state.slots.length);
}

/**
 * Change the number of slots. When shrinking, the most recent speakers are kept and re-seated
 * in centre-out order.
 */
export function withMaxSlots(state, n) {
  n = clampSlots(n);
  if (n === state.slots.length) return state;
  const occupied = state.slots.filter(Boolean);
  if (n > state.slots.length && occupied.length) {
    // Growing: keep everyone where they are (indexes stay valid) and add empty slots.
    return { ...state, slots: [...state.slots, ...Array(n - state.slots.length).fill(null)] };
  }
  const kept = occupied.sort((a, b) => b.lastSeq - a.lastSeq).slice(0, n);
  const slots = Array(n).fill(null);
  const order = centerOutOrder(n);
  kept.forEach((s, i) => (slots[order[i]] = s));
  return { ...state, slots };
}

/** Patch the dialogue when its message was edited. */
export function patchDialogue(state, messageId, patch) {
  if (!state.dialogue || state.dialogue.messageId !== messageId) return state;
  return { ...state, dialogue: { ...state.dialogue, ...patch } };
}

/** Forget a deleted message: empties the dialogue (and reference panel) that showed it; stands stay. */
export function dropMessage(state, messageId) {
  let next = state;
  if (state.dialogue?.messageId === messageId) next = { ...next, dialogue: null };
  if (state.ref?.messageId === messageId) next = { ...next, ref: null };
  return next;
}
