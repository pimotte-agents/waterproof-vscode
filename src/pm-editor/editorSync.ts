import type {
  DocChange,
  WrappingDocChange,
} from "@impermeable/waterproof-editor";

/**
 * Keeps the Waterproof editor (the webview) and the text document in sync.
 *
 * While the editor is open, it is the only writer of the document: its changes are applied to
 * the document in the order it sent them. Nothing else is expected to change the document. When
 * something does anyway (a text editor, undo there, save actions, other extensions), the
 * document wins and the editor is reloaded with its text:
 *
 * 1. The extension sends `freeze`. The editor becomes read-only and answers `frozen`. Messages
 *    arrive in order, so all changes it sent before have arrived by then.
 * 2. Once all changes are applied to the document, and the document hasn't changed for a short
 *    while, the extension sends `init` with the document text.
 *
 * Changes from the editor that arrive while it is being reloaded are based on outdated text and
 * are dropped. Each `init` starts a new epoch, and changes carry the epoch of the content they
 * are based on, so changes from before a reload are recognized as well.
 *
 * VS Code rebuilds the webview when it is hidden and shown again. Each webview instance has an
 * id, which it sends in `ready`; `init` is addressed to the instance that sent the last `ready`,
 * so that a new instance does not take content meant for an earlier one.
 *
 * This class does not depend on VS Code, see {@linkcode EditorSyncHost} for its environment.
 */

export type EditorChange = DocChange | WrappingDocChange;

/** A change to a text: replace `[start, end)` with `text`. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface EditorSyncHost {
  /** The current text of the document. */
  documentText(): string;
  /** The current version of the document. */
  documentVersion(): number;
  /** Whether queued edits are still being applied to the document. */
  editsInProgress(): boolean;
  /**
   * Queues an edit to the document. `build` is called right before the edit is applied, and
   * returns the edits (offsets into the document at that moment), or `undefined` to skip it.
   * The host calls {@linkcode EditorSync.editFailed} when applying fails, and
   * {@linkcode EditorSync.editsFinished} when the queue is empty.
   */
  queueEdit(build: () => TextEdit[] | undefined): void;
  /** Sends `init` to the editor webview with id `webview`. */
  sendInit(text: string, version: number, epoch: number, webview: string): void;
  /** Sends `freeze` to the editor. */
  sendFreeze(epoch: number): void;
  /** Tells the user that changes made in the editor were discarded. */
  reportDiscardedChanges(count: number): void;
  log(message: string): void;
}

/** How long the document must be unchanged before the editor is reloaded, in milliseconds. */
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

export class EditorSync {
  /** The epoch of the content the editor shows; incremented by every `init`. */
  private epoch = 0;

  /** The id of the webview instance that sent the last `ready`. */
  private webview = "";

  /**
   * The text the editor shows: the text of the last `init` with all changes received since
   * applied. While in sync, the document equals this once all queued edits are applied.
   */
  private expected: string;

  /**
   * `synced`: changes from the editor are applied to the document.
   * `reloading`: the editor is (to be) frozen and reloaded; its changes are dropped.
   * The editor starts out without content, so it starts in `reloading`.
   */
  private state: "synced" | "reloading" = "reloading";

  /** While reloading: whether the editor won't send any more changes (frozen, or fresh). */
  private editorQuiet = false;

  /** Text to replace the document with before reloading the editor. */
  private pendingReplacement?: string;

  /** When the document was last changed by something other than the editor. */
  private lastOutsideChange = -Infinity;

  /** The number of changes from the editor dropped since the last reload. */
  private dropped = 0;

  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly host: EditorSyncHost,
    private readonly quietPeriodMs = DEFAULT_QUIET_PERIOD_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.expected = host.documentText();
  }

  /** The text the editor shows, as far as known. */
  get editorText(): string {
    return this.expected;
  }

  /** Whether changes from the editor are currently being applied. */
  get isSynced(): boolean {
    return this.state === "synced";
  }

  /**
   * The (re)built editor webview with id `webview` is ready; it has no content and has not sent
   * any changes.
   */
  editorReady(webview: string): void {
    this.webview = webview;
    this.state = "reloading";
    this.editorQuiet = true;
    this.tryReload();
  }

  /**
   * Handles a change from the editor, made to the content of `epoch`.
   * @returns Whether the change was accepted.
   */
  changeFromEditor(change: EditorChange, epoch: number): boolean {
    if (this.state !== "synced" || epoch !== this.epoch) {
      this.dropped++;
      this.host.log(
        `[sync] Dropped a change from the editor (epoch ${epoch}, current ${this.epoch}, ${this.state})`,
      );
      return false;
    }
    const edits = editsOf(change);
    const base = this.expected;
    this.expected = applyEdits(base, edits);
    this.host.queueEdit(() => {
      // The offsets are only valid if nothing else changed the document in the meantime.
      if (this.host.documentText() !== base) {
        this.dropped++;
        this.diverged(
          "the document changed before a change from the editor was applied",
        );
        return undefined;
      }
      return edits;
    });
    return true;
  }

  /** The document changed, by the editor's changes or by something else. */
  documentChanged(): void {
    if (this.host.editsInProgress()) {
      // Most likely one of the queued edits; anything else is noticed when the queue is done.
      return;
    }
    if (this.state === "synced") {
      if (this.host.documentText() !== this.expected)
        this.diverged("the document was changed outside the editor");
    } else {
      this.lastOutsideChange = this.now();
      this.tryReload();
    }
  }

  /** All queued edits have been applied. */
  editsFinished(): void {
    if (this.state === "synced") {
      if (this.host.documentText() !== this.expected)
        this.diverged("the document was changed outside the editor");
    } else {
      this.tryReload();
    }
  }

  /** Applying a queued edit failed. */
  editFailed(): void {
    this.diverged("an edit could not be applied");
  }

  /** The editor confirmed a `freeze` for `epoch`. */
  editorFrozen(epoch: number): void {
    if (this.state !== "reloading" || epoch !== this.epoch) return;
    this.editorQuiet = true;
    this.tryReload();
  }

  /** Replaces the whole document with `text` and reloads the editor with it. */
  replaceDocument(text: string): void {
    this.pendingReplacement = text;
    this.startReload();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private diverged(reason: string): void {
    this.host.log(`[sync] Reloading the editor: ${reason}`);
    this.lastOutsideChange = this.now();
    this.startReload();
  }

  private startReload(): void {
    if (this.state === "reloading") {
      this.tryReload();
      return;
    }
    this.state = "reloading";
    this.editorQuiet = false;
    this.host.sendFreeze(this.epoch);
  }

  private tryReload(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.state !== "reloading" || !this.editorQuiet) return;
    if (this.host.editsInProgress()) return; // `editsFinished` calls this again.

    if (this.pendingReplacement !== undefined) {
      const text = this.pendingReplacement;
      this.pendingReplacement = undefined;
      this.host.queueEdit(() => [
        { start: 0, end: this.host.documentText().length, text },
      ]);
      return;
    }

    // Wait until the document has been left alone for a moment, so that typing in a text
    // editor next to the Waterproof editor does not reload it on every key press.
    const wait = this.lastOutsideChange + this.quietPeriodMs - this.now();
    if (wait > 0) {
      this.timer = setTimeout(() => this.tryReload(), wait);
      return;
    }

    this.epoch++;
    this.expected = this.host.documentText();
    this.state = "synced";
    this.editorQuiet = false;
    if (this.dropped > 0) this.host.reportDiscardedChanges(this.dropped);
    this.dropped = 0;
    this.host.sendInit(
      this.expected,
      this.host.documentVersion(),
      this.epoch,
      this.webview,
    );
  }
}
