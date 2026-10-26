/**
 * Novel stage DOM renderer (PLAN §6.3).
 *
 * PURE MODULE: no imports and no Foundry globals (game, foundry, ui, Hooks, CONFIG). Everything
 * world-specific (image URLs, permissions, labels, button actions) is injected through `opts`, so
 * the future log player can reuse this file unchanged in an exported folder.
 *
 * render(root, state, opts) options:
 *   resolveUrl(path) → string     image path → URL (default: identity)
 *   typewriter: number            ms per character, 0 = instant
 *   animate: boolean              false while rebuilding (no transitions, no typewriter)
 *   layout: "spread" | "fixed"    spread: occupied slots evenly spaced; fixed: one column per slot
 *   showRef: boolean              show the reference panel
 *   canViewRef(ref) → boolean     false shows a locked card with the name only
 *   onRefClick(ref, event)
 *   onAction(action, event)       dialogue tool buttons (other than the built-in "collapse")
 *   onStandContext(key, event)    right-click on a stand (only reachable while stands take pointer events)
 *   onStandClick(key, event)      left click on a stand (same)
 *   cast: [{ key, slotId, side: "left"|"right", name, stand, standStyle, mirror, pos: {x, y, h, a}|null }]
 *                                 fixed performers drawn besides the slots (live stage only). Unpositioned ones
 *                                 join the automatic layout (left side, slots, right side); positioned ones
 *                                 stand at x% (centre) / y% (bottom) with h% height of the stage.
 *   autoFit: boolean              shrink automatically laid out stands so they do not overlap much
 *   labels: { locked, collapse, expand }
 */

const LEAVE_MS = 220;

function el(doc, tag, cls, attrs = {}) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    e.setAttribute(k, v === true ? "" : String(v));
  }
  return e;
}

/** Icon markup: a Font Awesome class, or a plain glyph where Font Awesome is not loaded (exported pages). */
function icon(fa, glyph, glyphs) {
  return glyphs ? `<span class="gvn-glyph">${glyph}</span>` : `<i class="${fa}"></i>`;
}

/**
 * Build the stage skeleton.
 * @param {Document} doc
 * @param {object} [opts]
 * @param {string} [opts.id]
 * @param {{action: string, icon: string, glyph?: string, title: string}[]} [opts.tools]  Dialogue tool buttons.
 * @param {object} [opts.labels]
 * @param {boolean} [opts.glyphs]  Use text glyphs instead of Font Awesome icons.
 */
export function buildStage(doc = document, { id = "gvn-stage", tools = [], labels = {}, glyphs = false } = {}) {
  const root = el(doc, "section", "gvn-stage", { id });
  const bg = el(doc, "div", "gvn-bg", { hidden: true });
  bg._front = el(doc, "img", "gvn-bg-img layer-a front", { alt: "", draggable: "false" });
  bg._back = el(doc, "img", "gvn-bg-img layer-b", { alt: "", draggable: "false" });
  bg.append(bg._front, bg._back);
  const stands = el(doc, "div", "gvn-stands");
  const ref = el(doc, "div", "gvn-ref", { hidden: true });
  ref.append(el(doc, "div", "gvn-ref-body"), el(doc, "div", "gvn-ref-tabs"));
  const refClose = el(doc, "button", "gvn-ref-close", { type: "button", "aria-label": "close" });
  refClose.textContent = "×";
  ref.append(refClose);

  const dialogue = el(doc, "div", "gvn-dialogue", { hidden: true });
  const name = el(doc, "div", "gvn-name");
  const text = el(doc, "div", "gvn-text");
  const toolbar = el(doc, "div", "gvn-dialogue-tools");
  const all = [{ action: "collapse", icon: "fa-solid fa-chevron-down", glyph: "▾", title: labels.collapse ?? "" }, ...tools];
  for (const t of all) {
    const b = el(doc, "button", `gvn-tool gvn-tool-${t.action}`, {
      type: "button",
      "data-action": t.action,
      "data-tooltip": glyphs ? null : t.title || null,
      title: glyphs ? t.title || null : null,
      "aria-label": t.title || t.action,
    });
    b.innerHTML = icon(t.icon, t.glyph ?? "•", glyphs);
    toolbar.append(b);
  }
  dialogue.append(name, text, toolbar);

  const expand = el(doc, "button", "gvn-expand", { type: "button", hidden: true, "data-tooltip": glyphs ? null : labels.expand || null, "aria-label": labels.expand ?? "expand" });
  expand.innerHTML = icon("fa-solid fa-comment-dots", "💬", glyphs);

  root.append(bg, stands, ref, dialogue, expand);
  root._gvn = { figures: new Map(), opts: {}, state: null, dismissedRef: null, refIndex: 0, refFor: null, dlgKey: null, tw: null, glyphs };

  toolbar.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    ev.preventDefault();
    if (btn.dataset.action === "collapse") return setCollapsed(root, true);
    root._gvn.opts.onAction?.(btn.dataset.action, ev);
  });
  expand.addEventListener("click", (ev) => {
    ev.preventDefault();
    setCollapsed(root, false);
  });
  text.addEventListener("click", () => finishTypewriter(root));
  refClose.addEventListener("click", (ev) => {
    ev.preventDefault();
    root._gvn.dismissedRef = root._gvn.state?.ref?.messageId ?? null;
    ref.hidden = true;
  });
  ref.addEventListener("click", (ev) => {
    const tab = ev.target.closest(".gvn-ref-tab");
    if (tab) {
      root._gvn.refIndex = Number(tab.dataset.index) || 0;
      renderRef(root, root._gvn.state, root._gvn.opts);
      return;
    }
    if (ev.target.closest(".gvn-ref-close")) return;
    const r = currentRef(root);
    if (r && ev.target.closest(".gvn-ref-body")) root._gvn.opts.onRefClick?.(r, ev);
  });
  stands.addEventListener("contextmenu", (ev) => {
    const fig = ev.target.closest(".gvn-stand");
    if (!fig) return;
    ev.preventDefault();
    root._gvn.opts.onStandContext?.(fig.dataset.key, ev);
  });
  stands.addEventListener("click", (ev) => {
    const fig = ev.target.closest(".gvn-stand");
    if (fig) root._gvn.opts.onStandClick?.(fig.dataset.key, ev);
  });
  return root;
}

/** Collapse / expand the dialogue box (local UI state). */
export function setCollapsed(root, collapsed) {
  root.classList.toggle("gvn-collapsed", !!collapsed);
  const d = root.querySelector(".gvn-dialogue");
  const x = root.querySelector(".gvn-expand");
  const hasDialogue = !!root._gvn?.state?.dialogue;
  d.hidden = !!collapsed || !hasDialogue;
  x.hidden = !collapsed;
}

/* -------------------------------------------- */
/*  Stands                                      */
/* -------------------------------------------- */

function makeFigure(doc, key) {
  const fig = el(doc, "figure", "gvn-stand", { "data-key": key });
  const a = el(doc, "img", "gvn-stand-img layer-a front", { alt: "", draggable: "false" });
  const b = el(doc, "img", "gvn-stand-img layer-b", { alt: "", draggable: "false" });
  fig.append(a, b);
  fig._front = a;
  fig._back = b;
  return fig;
}

/** Cross-fade `holder` (an element with two <img> layers, `_front` / `_back`) to a new image. */
function setStandImage(fig, url, animate) {
  if (fig.dataset.src === url) return;
  fig.dataset.src = url;
  if (!animate || !fig._front.getAttribute("src")) {
    fig._front.src = url;
    return;
  }
  const swap = () => {
    if (fig.dataset.src !== url) return; // superseded meanwhile
    const back = fig._back;
    back.src = url;
    back.classList.add("front");
    fig._front.classList.remove("front");
    fig._back = fig._front;
    fig._front = back;
  };
  const pre = new Image();
  pre.onload = swap;
  pre.onerror = swap;
  pre.src = url;
}

/* ---------- layout math (no DOM; tested under Node) ---------- */

/**
 * Horizontal centres (% of the stage width) of automatically laid out stands.
 * spread: every stand evenly spaced; fixed: one column per slot plus one per side performer.
 * @param {object} args
 * @param {number} [args.left=0]       Unpositioned performers on the left.
 * @param {number[]} [args.slots=[]]   Indexes of occupied slots, in slot order.
 * @param {number} [args.right=0]      Unpositioned performers on the right.
 * @param {number} [args.n]            Slot count (fixed layout).
 * @param {"spread"|"fixed"} [args.layout="spread"]
 * @returns {{left: number[], slots: number[], right: number[], columns: number}}
 */
export function autoPositions({ left = 0, slots = [], right = 0, n = slots.length, layout = "spread" } = {}) {
  const fixed = layout === "fixed";
  const middle = fixed ? Math.max(n, 1) : slots.length;
  const columns = left + middle + right;
  const at = (k) => ((k + 0.5) * 100) / Math.max(columns, 1);
  return {
    left: Array.from({ length: left }, (_, k) => at(k)),
    slots: slots.map((i, rank) => at(left + (fixed ? i : rank))),
    right: Array.from({ length: right }, (_, k) => at(left + middle + k)),
    columns,
  };
}

/**
 * Height factor for automatically laid out stands so `count` of them fit side by side. A stand box is half as wide
 * as it is high; neighbours may overlap by `overlap` of their width (stand art rarely fills its box).
 * @param {object} args
 * @param {number} args.count             Stands (columns) sharing the width.
 * @param {number} args.aspect            Stage width / height.
 * @param {number} [args.standHeight=85]  Stand height in % of the stage.
 * @param {number} [args.overlap=0.25]
 * @param {number} [args.min=0.4]
 * @returns {number} 1 when everything fits, else the shrink factor (>= min).
 */
export function autoFit({ count, aspect, standHeight = 85, overlap = 0.25, min = 0.4 } = {}) {
  if (!(count > 1) || !(aspect > 0)) return 1;
  const width = ((standHeight / 100) * 0.5) / aspect; // one box, as a fraction of the stage width
  const need = count * width * (1 - overlap);
  return need <= 1 ? 1 : Math.max(min, 1 / need);
}

/**
 * Height factor for a freely positioned stand saved at stage aspect `refAspect`: on a narrower stage the stand
 * shrinks with it, so stands placed side by side keep their gaps.
 */
export function positionFit({ aspect, refAspect, min = 0.5 } = {}) {
  if (!(aspect > 0) || !(refAspect > 0) || aspect >= refAspect) return 1;
  return Math.max(min, aspect / refAspect);
}

/** A stored free position, clamped; null when unusable. { x, y: % of the stage, h: % height, a: aspect saved at } */
export function cleanPosition(pos) {
  if (!pos || typeof pos !== "object") return null;
  const x = Number(pos.x);
  const y = Number(pos.y);
  const h = Number(pos.h);
  if (![x, y, h].every(Number.isFinite)) return null;
  const a = Number(pos.a);
  return {
    x: Math.min(100, Math.max(0, x)),
    y: Math.min(95, Math.max(-50, y)),
    h: Math.min(150, Math.max(10, h)),
    a: Number.isFinite(a) && a > 0 ? a : null,
  };
}

/* ---------- rendering ---------- */

/** Apply the size-dependent factors (call after a resize; render calls it too). */
export function applyFit(root) {
  const g = root?._gvn;
  if (!g) return;
  const rect = root.getBoundingClientRect();
  const aspect = rect.height > 0 ? rect.width / rect.height : 0;
  const view = root.ownerDocument.defaultView;
  const height = parseFloat(view?.getComputedStyle(root).getPropertyValue("--gvn-stand-height")) || 85;
  const fit = g.opts?.autoFit ? autoFit({ count: g.autoCount ?? 0, aspect, standHeight: height }) : 1;
  root.style.setProperty("--gvn-fit", String(Math.round(fit * 1000) / 1000));
  for (const fig of g.figures.values()) {
    if (!fig.classList.contains("gvn-pos")) continue;
    const pf = positionFit({ aspect, refAspect: Number(fig.dataset.refAspect) || 0 });
    fig.style.setProperty("--gvn-pfit", String(Math.round(pf * 1000) / 1000));
  }
}

function renderStands(root, state, opts) {
  const doc = root.ownerDocument;
  const box = root.querySelector(".gvn-stands");
  const figures = root._gvn.figures;
  const resolve = opts.resolveUrl ?? ((p) => p);
  const animate = opts.animate !== false;
  const n = state.slots.length || 1;
  const cast = (Array.isArray(opts.cast) ? opts.cast : []).filter((c) => c?.key && c.stand);
  const castKeys = new Set(cast.map((c) => c.key));
  const occupied = state.slots.map((s, i) => (s && !castKeys.has(s.key) ? { s, i } : null)).filter(Boolean);
  const activeKey = state.focusKey || state.activeKey || null;
  const seen = new Set();

  const autoLeft = cast.filter((c) => c.side !== "right" && !cleanPosition(c.pos));
  const autoRight = cast.filter((c) => c.side === "right" && !cleanPosition(c.pos));
  const lefts = autoPositions({ left: autoLeft.length, slots: occupied.map((o) => o.i), right: autoRight.length, n, layout: opts.layout });
  root._gvn.autoCount = lefts.columns;
  const autoLeftOf = new Map([...autoLeft.map((c, k) => [c.key, lefts.left[k]]), ...autoRight.map((c, k) => [c.key, lefts.right[k]])]);

  const items = [
    ...cast.map((c) => ({ key: c.key, name: c.name, stand: c.stand, standStyle: c.standStyle, cast: c, slot: null, left: autoLeftOf.get(c.key) })),
    ...occupied.map(({ s, i }, rank) => ({ key: s.key, name: s.name, stand: s.stand, standStyle: s.standStyle, cast: null, slot: i, left: lefts.slots[rank] })),
  ];

  for (const it of items) {
    seen.add(it.key);
    let fig = figures.get(it.key);
    const fresh = !fig || fig.classList.contains("leaving");
    if (fresh) {
      fig?.remove();
      fig = makeFigure(doc, it.key);
      figures.set(it.key, fig);
      if (animate) fig.classList.add("entering");
      box.append(fig);
    }
    const c = it.cast;
    const pos = c ? cleanPosition(c.pos) : null;
    fig.classList.toggle("gvn-pos", !!pos);
    if (pos) {
      fig.style.setProperty("--gvn-x", String(pos.x));
      fig.style.setProperty("--gvn-y", String(pos.y));
      fig.style.setProperty("--gvn-h", String(pos.h));
      fig.dataset.refAspect = pos.a ? String(pos.a) : "";
    } else {
      fig.style.setProperty("--gvn-left", `${it.left}%`);
      delete fig.dataset.refAspect;
    }
    fig.style.setProperty("--gvn-scale", String(it.standStyle?.scale ?? 1));
    fig.style.setProperty("--gvn-offset-y", String(it.standStyle?.offsetY ?? 0));
    if (it.slot !== null) fig.dataset.slot = String(it.slot);
    else delete fig.dataset.slot;
    fig.dataset.name = it.name ?? "";
    fig.classList.toggle("gvn-cast", !!c);
    fig.classList.toggle("gvn-cast-left", !!c && c.side !== "right");
    fig.classList.toggle("gvn-cast-right", !!c && c.side === "right");
    fig.classList.toggle("mirror", !!c?.mirror);
    if (c?.slotId) fig.dataset.slotId = c.slotId;
    else delete fig.dataset.slotId;
    fig.classList.toggle("active", it.key === activeKey);
    fig.classList.toggle("focused", !!state.focusKey && it.key === state.focusKey);
    setStandImage(fig, resolve(it.stand), animate && !fresh);
    if (fresh && animate) requestAnimationFrame(() => requestAnimationFrame(() => fig.classList.remove("entering")));
  }
  root.classList.toggle("gvn-has-active", !!activeKey);

  for (const [key, fig] of figures) {
    if (seen.has(key)) continue;
    figures.delete(key);
    if (!animate) {
      fig.remove();
      continue;
    }
    fig.classList.add("leaving");
    setTimeout(() => fig.remove(), LEAVE_MS);
  }
  applyFit(root);
}

/* -------------------------------------------- */
/*  Background                                  */
/* -------------------------------------------- */

function renderBackground(root, state, opts) {
  const box = root.querySelector(".gvn-bg");
  if (!box) return;
  const resolve = opts.resolveUrl ?? ((p) => p);
  const url = state.background ? resolve(state.background) : "";
  if (!url) {
    if (box.dataset.src) {
      box.dataset.src = "";
      box._front.removeAttribute("src");
      box._back.removeAttribute("src");
    }
    box.hidden = true;
    return;
  }
  box.hidden = false;
  setStandImage(box, url, opts.animate !== false);
}

/* -------------------------------------------- */
/*  Dialogue                                    */
/* -------------------------------------------- */

/** Is a line still being typed out? */
export function isTyping(root) {
  return !!root?._gvn?.tw;
}

/** Show the line being typed in full right away. */
export function finishTyping(root) {
  finishTypewriter(root);
}

function finishTypewriter(root) {
  const tw = root._gvn?.tw;
  if (!tw) return;
  clearInterval(tw.timer);
  for (const [node, full] of tw.nodes) node.textContent = full;
  root._gvn.tw = null;
  root.querySelector(".gvn-text")?.classList.remove("typing");
}

function typewrite(root, target, ms) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(target, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push([n, n.textContent]);
    n.textContent = "";
  }
  if (!nodes.length) return;
  let ni = 0;
  let ci = 0;
  target.classList.add("typing");
  const timer = setInterval(() => {
    while (ni < nodes.length && ci >= nodes[ni][1].length) {
      ni++;
      ci = 0;
    }
    if (ni >= nodes.length) return finishTypewriter(root);
    const [node, full] = nodes[ni];
    ci++;
    node.textContent = full.slice(0, ci);
  }, ms);
  root._gvn.tw = { timer, nodes };
}

function renderDialogue(root, state, opts) {
  const d = state.dialogue;
  const box = root.querySelector(".gvn-dialogue");
  const collapsed = root.classList.contains("gvn-collapsed");
  root.querySelector(".gvn-expand").hidden = !collapsed;
  if (!d) {
    finishTypewriter(root);
    box.hidden = true;
    root._gvn.dlgKey = null;
    return;
  }
  box.hidden = collapsed;
  box.classList.toggle("gvn-emote", !!d.emote);
  box.classList.toggle("gvn-narration", !d.name);
  const name = box.querySelector(".gvn-name");
  name.textContent = d.name ?? "";
  name.hidden = !d.name;
  const key = `${d.messageId}\u0000${d.html}`;
  if (root._gvn.dlgKey === key) return;
  root._gvn.dlgKey = key;
  finishTypewriter(root);
  const text = box.querySelector(".gvn-text");
  text.innerHTML = d.html ?? "";
  text.scrollTop = 0;
  if (opts.animate !== false && opts.typewriter > 0) typewrite(root, text, opts.typewriter);
}

/* -------------------------------------------- */
/*  Reference panel                             */
/* -------------------------------------------- */

function currentRef(root) {
  const refs = root._gvn.state?.ref?.refs ?? [];
  return refs[Math.min(root._gvn.refIndex, refs.length - 1)] ?? null;
}

function renderRef(root, state, opts) {
  const panel = root.querySelector(".gvn-ref");
  const r = state?.ref;
  if (!r || opts.showRef === false || root._gvn.dismissedRef === r.messageId) {
    panel.hidden = true;
    return;
  }
  if (root._gvn.refFor !== r.messageId) {
    root._gvn.refFor = r.messageId;
    root._gvn.refIndex = 0;
    root._gvn.dismissedRef = null;
  }
  const doc = root.ownerDocument;
  const resolve = opts.resolveUrl ?? ((p) => p);
  const ref = currentRef(root);
  const body = panel.querySelector(".gvn-ref-body");
  body.innerHTML = "";
  const allowed = opts.canViewRef ? opts.canViewRef(ref) : true;
  panel.classList.toggle("locked", !allowed);
  const title = el(doc, "div", "gvn-ref-title");
  title.textContent = ref.name ?? "";
  if (!allowed) {
    const lock = el(doc, "div", "gvn-ref-locked");
    lock.innerHTML = `${icon("fa-solid fa-lock", "🔒", root._gvn.glyphs)} `;
    lock.append(doc.createTextNode(opts.labels?.locked ?? ""));
    body.append(title, lock);
  } else if (ref.img) {
    const img = el(doc, "img", "gvn-ref-img", { src: resolve(ref.img), alt: ref.name ?? "" });
    body.append(img, title);
  } else if (ref.text) {
    const text = el(doc, "div", "gvn-ref-text");
    text.innerHTML = ref.text;
    body.append(title, text);
  } else {
    body.append(title);
  }

  const tabs = panel.querySelector(".gvn-ref-tabs");
  tabs.innerHTML = "";
  const refs = r.refs ?? [];
  tabs.hidden = refs.length < 2;
  if (refs.length > 1) {
    refs.forEach((x, i) => {
      const tab = el(doc, "button", `gvn-ref-tab${i === root._gvn.refIndex ? " active" : ""}`, { type: "button", "data-index": i, "data-tooltip": x.name || null });
      const ok = opts.canViewRef ? opts.canViewRef(x) : true;
      if (ok && x.img) tab.append(el(doc, "img", "", { src: resolve(x.img), alt: "" }));
      else tab.textContent = x.name ?? `#${i + 1}`;
      tabs.append(tab);
    });
  }
  panel.hidden = false;
}

/* -------------------------------------------- */
/*  Entry point                                 */
/* -------------------------------------------- */

/** Reflect a state on the stage DOM. */
export function render(root, state, opts = {}) {
  if (!root?._gvn || !state) return;
  root._gvn.opts = opts;
  root._gvn.state = state;
  root.classList.toggle("gvn-no-anim", opts.animate === false);
  renderBackground(root, state, opts);
  renderStands(root, state, opts);
  renderDialogue(root, state, opts);
  renderRef(root, state, opts);
  if (opts.animate === false) requestAnimationFrame(() => root.classList.remove("gvn-no-anim"));
}
