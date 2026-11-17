import type {
  DocChange,
  WrappingDocChange,
} from "@impermeable/waterproof-editor";

/**
 * The extension's side of keeping the Waterproof editor (the webview) and the text document in
 * sync. See `editor/src/documentSync.ts` for the editor's side.
 *
 * Changes from the editor are applied to the document. When the document was changed elsewhere
 * in the meantime (a text editor, save actions, other extensions), they are moved past that
 * change ("rebased"); a change that overlaps it is dropped, and the document wins.
 *
 * When the document differs from what the editor shows, the extension sends `outOfSync`. The
 * editor answers with `requestDocument`; since messages arrive in order, all changes it made
 * before have arrived by then. Once they are applied, and the document has not been changed
 * elsewhere for a moment, the extension answers with `init`. The editor ignores that content if
 * it sent changes in the meantime, and asks again; its changes then still refer to the content
 * it shows, which is why the extension keeps track of the content it sent until it learns
 * whether the editor took it.
 *
 * This class does not depend on VS Code; see {@linkcode DocumentSyncHost}.
 */

export type EditorChange = DocChange | WrappingDocChange;

/** A change to a text: replace `[start, end)` with `text`. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface DocumentSyncHost {
  /** The current text of the document. */
  documentText(): string;
  /** The current version of the document. */
  documentVersion(): number;
  /** Whether queued edits are still being applied to the document. */
  editsInProgress(): boolean;
  /**
   * Queues an edit to the document. `build` is called right before the edit is applied, and
   * returns the edits (offsets into the document at that moment), or `undefined` to skip it.
   * The host calls {@linkcode DocumentSync.editsFinished} when the queue is empty.
   */
  queueEdit(build: () => TextEdit[] | undefined): void;
  /** Sends `init` to the editor webview with id `webview`. */
  sendInit(text: string, version: number, epoch: number, webview: string): void;
  /** Sends `outOfSync` to the editor. */
  sendOutOfSync(): void;
  /** Tells the user that changes made in the editor were discarded. */
  reportDiscardedChanges(count: number): void;
  log(message: string): void;
}

/** How long the document must be unchanged before the editor gets its text, in milliseconds. */
export const DEFAULT_QUIET_PERIOD_MS = 300;

/** The edits of `change`, each expressed in offsets into the text the change is based on. */
export function editsOf(change: EditorChange): TextEdit[] {
  const edits =
    "firstEdit" in change ? [change.firstEdit, change.secondEdit] : [change];
  return edits.map((e) => ({
    start: e.startInFile,
    end: e.endInFile,
    text: e.finalText,
  }));
}

/** Applies edits that are all expressed in offsets into `text`. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  // Apply them from the back, so that applying one does not shift the others.
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (acc, e) => acc.slice(0, e.start) + e.text + acc.slice(e.end),
      text,
    );
}

/**
 * Moves `edits`, expressed in offsets into `base`, onto `current`.
 *
 * The difference between the two texts is taken to be the single range between their common
 * prefix and their common suffix. Edits before or after that range are moved along; an edit
 * that overlaps it conflicts with the other change, and `undefined` is returned.
 */
export function rebaseEdits(
  edits: TextEdit[],
  base: string,
  current: string,
): TextEdit[] | undefined {
  if (base === current) return edits;

  const maxCommon = Math.min(base.length, current.length);
  let prefix = 0;
  while (prefix < maxCommon && base[prefix] === current[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxCommon - prefix &&
    base[base.length - 1 - suffix] === current[current.length - 1 - suffix]
  )
    suffix++;
  const changedEnd = base.length - suffix;
  const shift = current.length - base.length;

  const rebased: TextEdit[] = [];
  for (const e of edits) {
    if (e.end <= prefix) rebased.push(e);
    else if (e.start >= changedEnd)
      rebased.push({
        start: e.start + shift,
        end: e.end + shift,
        text: e.text,
      });
    else return undefined;
  }
  return rebased;
}

/** Content sent to the editor: its epoch and its text, with the editor's changes applied. */
interface Content {
  epoch: number;
  text: string;
}

export class DocumentSync {
  /** The epoch of the last `init`. */
  private epoch = 0;

  /** The id of the webview instance that sent the last `ready`. */
  private webview = "";

  /** The content the editor shows, as far as known. */
  private shown?: Content;

  /** Content sent to the editor, while it is not known whether the editor took it. */
  private sent?: Content;

  /** Whether the editor asked for the document, and has not been answered yet. */
  private requestPending = false;

  /** Whether `outOfSync` was sent, and the editor has not asked for the document since. */
  private outOfSyncSent = false;

  /** When the document was last changed by something other than the editor. */
  private lastOutsideChange = -Infinity;

  /** The number of changes from the editor dropped since the last `init`. */
  private discarded = 0;

  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly host: DocumentSyncHost,
    private readonly quietPeriodMs = DEFAULT_QUIET_PERIOD_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** The (re)built webview with id `webview` is ready; it shows nothing and sent nothing. */
  editorReady(webview: string): void {
    this.webview = webview;
    this.shown = undefined;
    this.sent = undefined;
    this.outOfSyncSent = false;
    this.requestPending = true;
    this.tryReply();
  }

  /** The editor, showing the content of `epoch`, asks for the document. */
  documentRequested(epoch: number): void {
    // The editor took the content it was sent if it shows it now, and ignored it otherwise.
    // (Messages arrive in order, so the editor decided on that content before this request.)
    if (this.sent?.epoch === epoch) this.shown = this.sent;
    this.sent = undefined;
    this.outOfSyncSent = false;
    this.requestPending = true;
    this.tryReply();
  }

  /**
   * Handles a change from the editor, made to the content of `epoch`.
   * @returns The text the editor shows after the change, or `undefined` if it was dropped.
   */
  changeFromEditor(change: EditorChange, epoch: number): string | undefined {
    if (this.sent?.epoch === epoch) {
      // The editor took the content it was sent.
      this.shown = this.sent;
      this.sent = undefined;
    }
    if (this.shown?.epoch !== epoch) {
      // From an earlier instance of the webview.
      this.host.log(`[sync] Dropped a change for outdated content (${epoch})`);
      return undefined;
    }
    const edits = editsOf(change);
    const base = this.shown.text;
    this.shown.text = applyEdits(base, edits);
    this.host.queueEdit(() => {
      // The document may have been changed elsewhere since the editor got its content.
      const rebased = rebaseEdits(edits, base, this.host.documentText());
      if (rebased === undefined) {
        this.discarded++;
        this.host.log(
          "[sync] Dropped a change from the editor that overlaps a change made elsewhere",
        );
      }
      return rebased;
    });
    return this.shown.text;
  }

  /** The document changed, by the editor's changes or by something else. */
  documentChanged(): void {
    // While edits are being applied, this is most likely one of them; anything else is
    // noticed when they are done.
    if (this.host.editsInProgress()) return;
    this.lastOutsideChange = this.now();
    this.check();
  }

  /** All queued edits have been applied. */
  editsFinished(): void {
    this.check();
  }

  /** Replaces the whole document with `text`; the editor is updated like for any other change. */
  replaceDocument(text: string): void {
    this.host.queueEdit(() => [
      { start: 0, end: this.host.documentText().length, text },
    ]);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  /** Tells the editor when the document differs from its content. */
  private check(): void {
    if (this.host.editsInProgress()) return;
    if (this.requestPending) {
      this.tryReply();
      return;
    }
    const latest = this.sent ?? this.shown;
    if (latest === undefined || this.outOfSyncSent) return;
    if (this.host.documentText() !== latest.text) {
      this.outOfSyncSent = true;
      this.host.sendOutOfSync();
    }
  }

  /** Answers a request for the document, once that is possible. */
  private tryReply(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.requestPending || this.host.editsInProgress()) return;
    // Wait until the document has been left alone for a moment, so that typing in a text
    // editor next to the Waterproof editor does not rebuild it on every key press.
    const wait = this.lastOutsideChange + this.quietPeriodMs - this.now();
    if (wait > 0) {
      this.timer = setTimeout(() => this.tryReply(), wait);
      return;
    }

    this.requestPending = false;
    this.epoch++;
    this.sent = { epoch: this.epoch, text: this.host.documentText() };
    if (this.discarded > 0) this.host.reportDiscardedChanges(this.discarded);
    this.discarded = 0;
    this.host.sendInit(
      this.sent.text,
      this.host.documentVersion(),
      this.epoch,
      this.webview,
    );
  }
}
