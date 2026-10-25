import { CHAT_TOOLS_ID, L, mod, chatTools } from "./constants.js";
import { esc, formDialog, readForm } from "./lib.js";
import { enterPlayback, exitPlayback, isPlaying } from "./stage.js";

const LIVE = "__live__";

/** Same rule as the chat-tools viewer: players do not see others' whispers / blind rolls in archives. */
function visibleArchived(m) {
  if (game.user.isGM) return true;
  let hide = true;
  try {
    hide = game.settings.get(CHAT_TOOLS_ID, "hideSecret");
  } catch {
    hide = true;
  }
  if (!hide) return true;
  if (m.blind) return false;
  if (m.whisper?.length) return m.userId === game.user.id || m.whisper.includes(game.user.id);
  return true;
}

/** Serialize the current chat log (only what this user can see). */
async function serializeLive() {
  const ct = chatTools();
  const docs = game.messages.contents.filter((m) => m.visible).sort((a, b) => a.timestamp - b.timestamp);
  const progress = ui.notifications.info(L("Player.Loading", { count: docs.length }), { progress: true });
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    out.push(await ct.serializeMessage(docs[i]));
    if (i % 20 === 0) progress.update({ pct: i / docs.length });
  }
  progress.update({ pct: 1 });
  return out;
}

/**
 * Load messages for a source: the live chat log, or a chat-tools archive (entry or id).
 * @returns {Promise<{messages: object[], title: string}|null>}
 */
export async function loadSource(source) {
  const ct = chatTools();
  if (!ct) {
    ui.notifications.warn(L("ChatToolsMissing"));
    return null;
  }
  if (!source || source === LIVE) return { messages: await serializeLive(), title: L("Player.LiveLog") };
  const entry = typeof source === "string" ? ct.getIndex().find((e) => e.id === source) : source;
  if (!entry) return null;
  try {
    const archive = await ct.loadArchive(entry);
    return { messages: (archive.messages ?? []).filter(visibleArchived), title: archive.name ?? entry.name };
  } catch (err) {
    mod.error("archive load failed", err);
    ui.notifications.error(L("Player.LoadFailed", { name: entry.name }));
    return null;
  }
}

/** Replay serialized messages on the stage. */
export function playMessages(messages, opts = {}) {
  return enterPlayback(messages, opts);
}

/** Load a source and replay it. */
export async function playSource(source, opts = {}) {
  const loaded = await loadSource(source);
  if (!loaded) return null;
  return playMessages(loaded.messages, { title: loaded.title, ...opts });
}

/** Ask which log to replay (current chat log or a saved archive), then play it. */
export async function openLogPlayer() {
  const ct = chatTools();
  if (!ct) return ui.notifications.warn(L("ChatToolsMissing"));
  const archives = ct
    .getIndex()
    .slice()
    .sort((a, b) => (b.from ?? b.createdAt) - (a.from ?? a.createdAt));
  const fmt = (ts) => (ts ? new Date(ts).toLocaleDateString(game.i18n.lang) : "?");
  const options = [
    `<option value="${LIVE}">${esc(L("Player.LiveLog"))} (${game.messages.size})</option>`,
    ...archives.map((e) => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(fmt(e.from))}${e.to && fmt(e.to) !== fmt(e.from) ? `~${esc(fmt(e.to))}` : ""} (${e.count ?? "?"})</option>`),
  ].join("");
  const content = `<div class="gvn-player-pick">
    <div class="form-group"><label>${esc(L("Player.Source"))}</label><div class="form-fields"><select name="source">${options}</select></div></div>
    <div class="form-group"><label>${esc(L("Player.Autoplay"))}</label><div class="form-fields"><input type="checkbox" name="autoplay" checked></div></div>
    <p class="hint">${esc(L("Player.Hint"))}</p>
  </div>`;
  // gatos-lib formDialog: Play (default, reads the form) / Cancel; null when cancelled or closed.
  const result = await formDialog({
    title: L("Player.Title"),
    icon: "fa-solid fa-film",
    classes: ["gvn-player-dialog"],
    width: 460,
    content,
    ok: { action: "play", label: L("Player.Play"), icon: "fa-solid fa-play", read: (button) => readForm(button) },
    cancel: { label: L("Player.Cancel") },
  });
  if (!result) return null;
  return playSource(result.source, { autoplay: !!result.autoplay });
}

export { exitPlayback as stopPlayback, isPlaying };
