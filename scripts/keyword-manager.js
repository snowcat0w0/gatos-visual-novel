import { TEMPLATES, L } from "./constants.js";
import { SingletonMixin, debounce, impl } from "./lib.js";
import { getKeywords, hasLinkPermission } from "./links.js";
import { requestKeywordOp } from "./socket.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TYPE_ICONS = { Actor: "fa-user", Item: "fa-suitcase", JournalEntry: "fa-book-open", JournalEntryPage: "fa-file-lines" };

/** The one manager object of this session (0.3.0 kept it in a static field, so the search text survives close/open). */
let kept = null;

/**
 * World keyword registry (PLAN §7.4): keyword → document. Players' changes go through the GM.
 * gatos-lib SingletonMixin: `instance` is the open window or null; `open()` re-renders an open manager
 * like 0.3.0's `instance.render({ force: true })` and reuses the same object across close/open.
 */
export class KeywordManager extends SingletonMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  /** Open the manager, or re-render it when it is already open. Resolves to the window after rendering (0.3.0 shape). */
  static open() {
    const app = (kept ??= new this());
    this.instance = app;
    return app.render({ force: true });
  }

  #search = "";

  static DEFAULT_OPTIONS = {
    id: "gvn-keyword-manager",
    classes: ["gvn-keyword-manager"],
    tag: "form",
    window: { title: "GVN.Keywords.Title", icon: "fa-solid fa-link", resizable: true },
    position: { width: 560, height: 560 },
    form: { submitOnChange: false, closeOnSubmit: false, handler: KeywordManager.#onSubmit },
    actions: { remove: KeywordManager.#onRemove, open: KeywordManager.#onOpen },
  };

  static PARTS = { main: { template: TEMPLATES.keywordManager, scrollable: [".gvn-kw-list"] } };

  async _prepareContext() {
    const q = this.#search.trim().toLocaleLowerCase();
    const rows = getKeywords()
      .map((e) => {
        let doc = null;
        try {
          doc = fromUuidSync(e.uuid);
        } catch {
          doc = null;
        }
        const user = game.users.get(e.addedBy);
        return {
          ...e,
          docName: doc?.name ?? L("Keywords.Missing"),
          type: doc?.documentName ?? "",
          icon: TYPE_ICONS[doc?.documentName] ?? "fa-circle-question",
          missing: !doc,
          canOpen: !!doc && hasLinkPermission(doc),
          addedByName: user?.name ?? "-",
          canRemove: game.user.isGM || e.addedBy === game.user.id,
        };
      })
      .filter((r) => !q || r.keyword.toLocaleLowerCase().includes(q) || r.docName.toLocaleLowerCase().includes(q))
      .sort((a, b) => a.keyword.localeCompare(b.keyword, game.i18n.lang));
    return { rows, search: this.#search, syntax: L("Keywords.SyntaxExample", { open: "{{", close: "}}" }) };
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    // gatos-lib debounce (trailing, 200 ms) replaces the hand-rolled timer.
    const search = debounce(() => this.render({ parts: ["main"] }).then(() => this.#refocusSearch()), 200);
    this.element.addEventListener("input", (ev) => {
      if (ev.target?.name !== "search") return;
      this.#search = ev.target.value;
      search();
    });
    this.element.addEventListener("dragover", (ev) => ev.preventDefault());
    this.element.addEventListener("drop", (ev) => this.#onDrop(ev));
  }

  #refocusSearch() {
    const input = this.element.querySelector("input[name=search]");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async #onDrop(ev) {
    ev.preventDefault();
    const data = impl.TextEditor().getDragEventData(ev);
    if (!data?.uuid) return;
    const uuidInput = this.element.querySelector("input[name=uuid]");
    const kwInput = this.element.querySelector("input[name=keyword]");
    if (uuidInput) uuidInput.value = data.uuid;
    if (kwInput && !kwInput.value) {
      try {
        kwInput.value = (await fromUuid(data.uuid))?.name ?? "";
      } catch {
        /* ignore */
      }
    }
  }

  static async #onSubmit(event, form, formData) {
    const { keyword, uuid } = formData.object;
    if (!keyword?.trim() && !uuid?.trim()) return; // Enter pressed in the search box
    const res = await requestKeywordOp("add", { keyword, uuid: String(uuid ?? "").trim() });
    if (!res.ok) return ui.notifications.warn(L(res.error ?? "Keywords.ErrInvalid"));
    ui.notifications.info(L("Keywords.Added", { keyword }));
    form.reset();
  }

  static async #onRemove(event, target) {
    const keyword = target.closest("[data-keyword]")?.dataset.keyword;
    if (!keyword) return;
    const res = await requestKeywordOp("remove", { keyword });
    if (!res.ok) return ui.notifications.warn(L(res.error ?? "Keywords.ErrInvalid"));
  }

  static async #onOpen(event, target) {
    const uuid = target.closest("[data-uuid]")?.dataset.uuid;
    const doc = uuid ? await fromUuid(uuid) : null;
    if (!doc || !hasLinkPermission(doc)) return;
    if (doc.documentName === "JournalEntryPage") return doc.parent.sheet.render({ force: true, pageId: doc.id });
    doc.sheet?.render({ force: true });
  }
}

export const openKeywordManager = () => KeywordManager.open();

/** keywords setting onChange: refresh the open manager on every client. */
export function onKeywordsChanged() {
  const app = KeywordManager.instance;
  if (app?.rendered) app.render();
}
