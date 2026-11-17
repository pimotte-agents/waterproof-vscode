import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  applyEdits,
  EditorChange,
  EditorSync,
  TextEdit,
} from "../../src/pm-editor/editorSync";

const QUIET_MS = 50;

type ToEditor =
  | { type: "init"; text: string; epoch: number; webview: string }
  | { type: "freeze"; epoch: number };
type ToExtension =
  | { type: "change"; change: EditorChange; epoch: number }
  | { type: "frozen"; epoch: number }
  | { type: "ready"; webview: string };

/**
 * A simulation of the extension's environment: the document, the edit queue (modelled after
 * `SequentialEditor`, which builds an edit when it starts applying it and applies it
 * asynchronously), the editor webview, and the message channels in both directions.
 */
class World {
  doc: string;
  version = 1;
  inProgress = false;
  current: TextEdit[] | undefined;
  queue: Array<() => TextEdit[] | undefined> = [];

  editorText: string | undefined;
  webview = "w0";
  webviews = 0;
  editorEpoch = 0;
  editorFrozen = false;
  toEditor: ToEditor[] = [];
  toExtension: ToExtension[] = [];

  discarded = 0;
  inits = 0;
  readies = 0;
  freezes = 0;
  sync: EditorSync;

  constructor(text: string) {
    this.doc = text;
    this.sync = new EditorSync(
      {
        documentText: () => this.doc,
        documentVersion: () => this.version,
        editsInProgress: () => this.inProgress,
        queueEdit: (build) => {
          if (this.inProgress) {
            this.queue.push(build);
          } else {
            this.inProgress = true;
            this.current = build();
          }
        },
        sendInit: (text, _version, epoch, webview) => {
          this.inits++;
          this.toEditor.push({ type: "init", text, epoch, webview });
        },
        sendFreeze: (epoch) => {
          this.freezes++;
          this.toEditor.push({ type: "freeze", epoch });
        },
        reportDiscardedChanges: (count) => (this.discarded += count),
        log: () => {},
      },
      QUIET_MS,
      () => Date.now(),
    );
    this.toExtension.push({ type: "ready", webview: this.webview });
  }

  /** The user edits in the editor. */
  type(edit: TextEdit) {
    if (this.editorText === undefined || this.editorFrozen) return false;
    this.editorText = applyEdits(this.editorText, [edit]);
    this.toExtension.push({
      type: "change",
      change: {
        startInFile: edit.start,
        endInFile: edit.end,
        finalText: edit.text,
      },
      epoch: this.editorEpoch,
    });
    return true;
  }

  /** Something other than the editor changes the document. */
  outsideEdit(edit: TextEdit) {
    this.doc = applyEdits(this.doc, [edit]);
    this.version++;
    this.sync.documentChanged();
  }

  /**
   * The webview is hidden and shown again: VS Code rebuilds it, losing messages to it.
   */
  reloadWebview() {
    this.webview = `w${++this.webviews}`;
    this.editorText = undefined;
    this.editorEpoch = 0;
    this.editorFrozen = false;
    this.toEditor = [];
    this.toExtension.push({ type: "ready", webview: this.webview });
  }

  deliverToEditor() {
    const msg = this.toEditor.shift();
    if (!msg) return false;
    if (msg.type === "init") {
      if (msg.webview !== this.webview) return true;
      this.editorText = msg.text;
      this.editorEpoch = msg.epoch;
      this.editorFrozen = false;
    } else if (msg.epoch === this.editorEpoch) {
      this.editorFrozen = true;
      this.toExtension.push({ type: "frozen", epoch: msg.epoch });
    }
    return true;
  }

  deliverToExtension() {
    const msg = this.toExtension.shift();
    if (!msg) return false;
    if (msg.type === "change")
      this.sync.changeFromEditor(msg.change, msg.epoch);
    else if (msg.type === "frozen") this.sync.editorFrozen(msg.epoch);
    else {
      this.readies++;
      this.sync.editorReady(msg.webview);
    }
    return true;
  }

  /** VS Code finishes applying the current edit. */
  completeEdit() {
    if (!this.inProgress) return false;
    if (this.current) {
      const clamped = this.current.map((e) => ({
        start: Math.min(e.start, this.doc.length),
        end: Math.min(e.end, this.doc.length),
        text: e.text,
      }));
      this.doc = applyEdits(this.doc, clamped);
      this.version++;
      this.sync.documentChanged();
    }
    const next = this.queue.shift();
    if (next) {
      this.current = next();
    } else {
      this.inProgress = false;
      this.current = undefined;
      this.sync.editsFinished();
    }
    return true;
  }

  /** Runs everything that is pending, including timers, until nothing is left. */
  settle() {
    for (let i = 0; i < 10_000; i++) {
      if (this.deliverToExtension()) continue;
      if (this.completeEdit()) continue;
      if (this.deliverToEditor()) continue;
      if (jest.getTimerCount() > 0) {
        jest.advanceTimersByTime(QUIET_MS);
        continue;
      }
      return;
    }
    throw new Error("did not settle");
  }
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

function started(text = "hello world") {
  const w = new World(text);
  w.settle();
  return w;
}

describe("EditorSync", () => {
  it("initializes the editor when it is ready", () => {
    const w = started();
    expect(w.editorText).toBe("hello world");
    expect(w.sync.isSynced).toBe(true);
    expect(w.inits).toBe(1);
  });

  it("applies changes that arrive while earlier ones are still being applied", () => {
    const w = started();
    // Hold delete at the start: several changes in flight before any is applied.
    w.type({ start: 0, end: 1, text: "" });
    w.type({ start: 0, end: 1, text: "" });
    w.deliverToExtension();
    w.type({ start: 0, end: 1, text: "" });
    w.deliverToExtension();
    w.completeEdit();
    w.deliverToExtension();
    w.settle();

    expect(w.doc).toBe("lo world");
    expect(w.editorText).toBe("lo world");
    expect(w.inits).toBe(1);
    expect(w.discarded).toBe(0);
  });

  it("reloads the editor after an outside change, once the document is quiet", () => {
    const w = started();
    w.outsideEdit({ start: 0, end: 0, text: "X" });
    expect(w.toEditor).toEqual([{ type: "freeze", epoch: 1 }]);
    w.deliverToEditor();
    expect(w.editorFrozen).toBe(true);
    w.deliverToExtension(); // frozen

    // More outside changes postpone the reload.
    jest.advanceTimersByTime(QUIET_MS - 10);
    w.outsideEdit({ start: 0, end: 0, text: "Y" });
    jest.advanceTimersByTime(QUIET_MS - 10);
    expect(w.toEditor).toEqual([]);
    jest.advanceTimersByTime(10);
    expect(w.toEditor).toEqual([
      { type: "init", text: "YXhello world", epoch: 2, webview: "w0" },
    ]);

    w.settle();
    expect(w.editorText).toBe("YXhello world");
    expect(w.editorFrozen).toBe(false);
    expect(w.sync.isSynced).toBe(true);
  });

  it("drops changes made before the editor was frozen, and reports them", () => {
    const w = started();
    w.outsideEdit({ start: 0, end: 0, text: "X" });
    // The user types before the freeze arrives.
    w.type({ start: 5, end: 5, text: "!" });
    w.settle();

    expect(w.doc).toBe("Xhello world");
    expect(w.editorText).toBe("Xhello world");
    expect(w.discarded).toBe(1);
  });

  it("does not apply a queued change when the document changed before it was applied", () => {
    const w = started();
    w.type({ start: 0, end: 0, text: "a" });
    w.type({ start: 0, end: 0, text: "b" });
    w.deliverToExtension();
    w.deliverToExtension(); // "b" is queued behind "a"
    // An outside change lands while "a" is being applied.
    w.doc = "Z" + w.doc;
    w.completeEdit();
    w.settle();

    expect(w.doc).toBe("aZhello world");
    expect(w.editorText).toBe(w.doc);
    expect(w.discarded).toBe(1);
  });

  it("replaces the document and reloads the editor", () => {
    const w = started();
    w.sync.replaceDocument("restored");
    expect(w.toEditor).toEqual([{ type: "freeze", epoch: 1 }]);
    w.settle();

    expect(w.doc).toBe("restored");
    expect(w.editorText).toBe("restored");
    expect(w.discarded).toBe(0);
  });

  it("reloads the editor when an edit fails", () => {
    const w = started();
    w.type({ start: 0, end: 0, text: "a" });
    w.deliverToExtension();
    w.current = undefined; // VS Code does not apply it
    w.sync.editFailed();
    w.settle();

    expect(w.editorText).toBe("hello world");
    expect(w.doc).toBe("hello world");
  });

  it("reloads a webview that became ready again after the queue is done", () => {
    const w = started();
    w.type({ start: 0, end: 0, text: "a" });
    w.deliverToExtension();
    // The webview was hidden and shown again, and reloaded.
    w.reloadWebview();
    w.deliverToExtension();
    expect(w.toEditor).toEqual([]);
    w.settle();

    expect(w.editorText).toBe("ahello world");
    expect(w.doc).toBe("ahello world");
  });

  it("drops changes made to content that has been replaced since", () => {
    const w = started();
    w.sync.replaceDocument("restored");
    w.settle();
    const accepted = w.sync.changeFromEditor(
      { startInFile: 0, endInFile: 0, finalText: "a" },
      1,
    );
    w.settle();

    expect(accepted).toBe(false);
    expect(w.doc).toBe("restored");
  });

  it("recovers when a freeze is lost because the webview was rebuilt", () => {
    const w = started();
    w.outsideEdit({ start: 0, end: 0, text: "X" });
    w.reloadWebview();
    w.settle();

    expect(w.editorText).toBe("Xhello world");
    expect(w.sync.isSynced).toBe(true);
  });

  it("ignores outdated frozen messages", () => {
    const w = started();
    w.sync.editorFrozen(0);
    w.sync.editorFrozen(1);
    expect(w.sync.isSynced).toBe(true);
    expect(w.toEditor).toEqual([]);
  });
});

/** A small seeded PRNG, so failures can be reproduced. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEdit(rand: () => number, text: string): TextEdit {
  const a = Math.floor(rand() * (text.length + 1));
  const b = Math.min(text.length, a + Math.floor(rand() * 3));
  const letters = "abc \n";
  const insert =
    rand() < 0.5 ? "" : letters[Math.floor(rand() * letters.length)];
  return { start: a, end: rand() < 0.5 ? a : b, text: insert };
}

/** Runs random interleavings of everything that can happen. */
function simulate(seed: number, outsideEdits: boolean) {
  const rand = mulberry32(seed);
  const w = new World("The quick brown fox.\n");
  let typed = 0;
  for (let i = 0; i < 300; i++) {
    const r = rand();
    if (r < 0.35) {
      if (w.editorText !== undefined && w.type(randomEdit(rand, w.editorText)))
        typed++;
    } else if (r < 0.55) w.deliverToExtension();
    else if (r < 0.7) w.completeEdit();
    else if (r < 0.85) w.deliverToEditor();
    else if (r < 0.93) jest.advanceTimersByTime(Math.floor(rand() * QUIET_MS));
    else if (r < 0.95) w.reloadWebview();
    else if (outsideEdits) w.outsideEdit(randomEdit(rand, w.doc));
  }
  w.settle();
  return { w, typed };
}

describe("EditorSync with random interleavings", () => {
  it.each(Array.from({ length: 200 }, (_, i) => i))(
    "editor and document agree in the end, with outside edits (seed %i)",
    (seed) => {
      const { w } = simulate(seed, true);
      expect(w.sync.isSynced).toBe(true);
      expect(w.editorText).toBe(w.doc);
      expect(w.editorFrozen).toBe(false);
    },
  );

  it.each(Array.from({ length: 200 }, (_, i) => i))(
    "only the editor writes: nothing is lost or reloaded (seed %i)",
    (seed) => {
      const { w } = simulate(seed, false);
      expect(w.editorText).toBe(w.doc);
      // The editor is never frozen and reloaded; it is only initialized when its webview is
      // (re)built.
      expect(w.freezes).toBe(0);
      expect(w.discarded).toBe(0);
    },
  );
});
