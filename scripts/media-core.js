/**
 * Scene media model and Tile planning (PURE: no imports, no Foundry globals; tested under Node).
 *
 * A scene's media (`flags.gatos-visual-novel.media`) becomes at most one Tile per role, marked with
 * `flags.gatos-visual-novel.mediaRole`:
 *   backdrop  covers the whole canvas (padding included), with its own opacity
 *   center    sits in the middle of the scene rectangle, scaled by `center.scale`
 * Tiles are written only when the GM applies or clears media (scene-media.js), and only the fields this
 * module owns are compared, so a sync with nothing to change makes no request at all.
 */

export const MEDIA_FLAG = "media";
export const ROLE_FLAG = "mediaRole";
export const ROLES = ["backdrop", "center"];
export const FITS = ["cover", "contain"];

/** One clamp for every control and every save (UI ranges are generated from it). */
export const MEDIA_LIMITS = Object.freeze({
  opacity: Object.freeze({ min: 0.05, max: 1, step: 0.05, default: 0.6 }),
  centerScale: Object.freeze({ min: 0.3, max: 1, step: 0.05, default: 0.8 }),
  blurRadius: Object.freeze({ min: 2, max: 40, step: 1, default: 16 }),
});

/** Below every other tile; the backdrop under the centre image. */
export const TILE_SORT = Object.freeze({ backdrop: -100000, center: -99999 });

const clampTo = (v, { min, max, default: d }) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const str = (v) => (typeof v === "string" ? v.trim() : "");
const fit = (v, dflt) => (FITS.includes(v) ? v : dflt);
const color = (v) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : "");

/** Every field present and clamped. */
export function normalizeMedia(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  const b = m.backdrop && typeof m.backdrop === "object" ? m.backdrop : {};
  const c = m.center && typeof m.center === "object" ? m.center : {};
  return {
    backdrop: {
      src: str(b.src),
      fit: fit(b.fit, "cover"),
      opacity: clampTo(b.opacity, MEDIA_LIMITS.opacity),
      blurSrc: str(b.blurSrc),
      useBlur: !!b.useBlur,
    },
    center: {
      src: str(c.src),
      fit: fit(c.fit, "contain"),
      scale: clampTo(c.scale, MEDIA_LIMITS.centerScale),
    },
    bgColor: color(m.bgColor),
    hideHotbar: !!m.hideHotbar,
  };
}

/** Does the media show anything? */
export function hasMedia(raw) {
  const m = normalizeMedia(raw);
  return !!(m.backdrop.src || m.center.src);
}

/** The backdrop image actually shown (the blurred copy when chosen and baked). */
export function backdropSrc(media) {
  const b = normalizeMedia(media).backdrop;
  return b.useBlur && b.blurSrc ? b.blurSrc : b.src;
}

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?.*)?$/i;
/** Video by extension (Foundry's VideoHelper is used in the client; this keeps the pure check). */
export const isVideoPath = (src) => VIDEO_EXT.test(String(src ?? ""));

/**
 * Desired Tile data for a role, or null when the role shows nothing.
 * Tiles use a centred anchor (v14 default 0.5/0.5), so x/y is the centre point.
 * @param {"backdrop"|"center"} role
 * @param {object} media
 * @param {{width: number, height: number, sceneX: number, sceneY: number, sceneWidth: number, sceneHeight: number}} dims
 * @param {string} moduleId
 */
export function mediaTileData(role, media, dims, moduleId) {
  const m = normalizeMedia(media);
  if (!dims) return null;
  let src;
  let rect;
  let alpha = 1;
  let tileFit;
  if (role === "backdrop") {
    src = backdropSrc(m);
    rect = { x: dims.width / 2, y: dims.height / 2, width: dims.width, height: dims.height };
    alpha = m.backdrop.opacity;
    tileFit = m.backdrop.fit;
  } else if (role === "center") {
    src = m.center.src;
    const k = m.center.scale;
    rect = { x: dims.sceneX + dims.sceneWidth / 2, y: dims.sceneY + dims.sceneHeight / 2, width: dims.sceneWidth * k, height: dims.sceneHeight * k };
    tileFit = m.center.fit;
  } else return null;
  if (!src) return null;
  return {
    name: role === "backdrop" ? "GVN Backdrop" : "GVN Centre Image",
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    elevation: 0,
    sort: TILE_SORT[role],
    rotation: 0,
    alpha: Math.round(alpha * 100) / 100,
    hidden: false,
    locked: true,
    texture: { src, fit: tileFit, anchorX: 0.5, anchorY: 0.5, scaleX: 1, scaleY: 1 },
    video: { loop: true, autoplay: true, volume: 0 },
    flags: { [moduleId]: { [ROLE_FLAG]: role } },
  };
}

/** `{ a: { b: 1 } }` → `{ "a.b": 1 }` (arrays are leaves). */
export function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Paths as stored and as typed may differ in percent-encoding. */
function sameSrc(a, b) {
  const dec = (s) => {
    try {
      return decodeURI(String(s ?? ""));
    } catch {
      return String(s ?? "");
    }
  };
  return dec(a) === dec(b);
}

/**
 * The fields of `desired` that differ in `source` (a Tile's `_source`), as a flat dot-path update; {} when equal.
 * Only the keys in `desired` are compared, so fields the GM changed by hand elsewhere (levels, occlusion …) stay.
 */
export function diffTile(source, desired) {
  const out = {};
  for (const [path, want] of Object.entries(flatten(desired))) {
    const have = getPath(source, path);
    if (path === "texture.src" ? sameSrc(have, want) : typeof want === "number" ? Number(have) === want : have === want) continue;
    out[path] = want;
  }
  return out;
}

/**
 * Plan the Tile operations that make the scene match the desired media.
 * @param {Record<string, object[]>} existing  Tile sources (with _id) per role, oldest first.
 * @param {Record<string, object|null>} desired  Tile data per role (null = none).
 * @returns {{creates: object[], updates: object[], deletes: string[]}}
 */
export function planTileSync(existing, desired) {
  const creates = [];
  const updates = [];
  const deletes = [];
  for (const role of ROLES) {
    const tiles = existing?.[role] ?? [];
    const want = desired?.[role] ?? null;
    // Exactly one tile per role: extra ones (e.g. a copy pasted by hand) go.
    const [keep, ...extra] = tiles;
    deletes.push(...extra.map((t) => t._id));
    if (!want) {
      if (keep) deletes.push(keep._id);
      continue;
    }
    if (!keep) {
      creates.push(want);
      continue;
    }
    const diff = diffTile(keep, want);
    if (Object.keys(diff).length) updates.push({ _id: keep._id, ...diff });
  }
  return { creates, updates, deletes };
}

/** Presets: `{ [id]: { id, name, media } }` → sorted list with normalized media. */
export function presetList(raw) {
  return Object.values(raw && typeof raw === "object" ? raw : {})
    .filter((p) => p && typeof p === "object" && p.id && typeof p.name === "string")
    .map((p) => ({ id: String(p.id), name: p.name, media: normalizeMedia(p.media), sort: Number(p.sort) || 0 }))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}
