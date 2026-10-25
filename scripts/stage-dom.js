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
 *   onStandContext(key, event)    right-click on a stand (only reachable while body.gvn-alt is set)
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

function renderStands(root, state, opts) {
  const doc = root.ownerDocument;
  const box = root.querySelector(".gvn-stands");
  const figures = root._gvn.figures;
  const resolve = opts.resolveUrl ?? ((p) => p);
  const animate = opts.animate !== false;
  const n = state.slots.length || 1;
  const occupied = state.slots.map((s, i) => (s ? { s, i } : null)).filter(Boolean);
  const seen = new Set();

  occupied.forEach(({ s, i }, rank) => {
    seen.add(s.key);
    let fig = figures.get(s.key);
    const fresh = !fig || fig.classList.contains("leaving");
    if (fresh) {
      fig?.remove();
      fig = makeFigure(doc, s.key);
      figures.set(s.key, fig);
      if (animate) fig.classList.add("entering");
      box.append(fig);
    }
    const left = opts.layout === "fixed" ? ((i + 0.5) * 100) / n : ((rank + 0.5) * 100) / occupied.length;
    fig.style.setProperty("--gvn-left", `${left}%`);
    fig.style.setProperty("--gvn-scale", String(s.standStyle?.scale ?? 1));
    fig.style.setProperty("--gvn-offset-y", String(s.standStyle?.offsetY ?? 0));
    fig.dataset.slot = String(i);
    fig.dataset.name = s.name ?? "";
    fig.classList.toggle("active", s.key === state.activeKey);
    setStandImage(fig, resolve(s.stand), animate && !fresh);
    if (fresh && animate) requestAnimationFrame(() => requestAnimationFrame(() => fig.classList.remove("entering")));
  });

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
