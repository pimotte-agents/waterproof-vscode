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
  DocumentSync,
  rebaseEdits,
  TextEdit,
} from "../../src/pm-editor/documentSync";
import { EditorDocumentSync } from "../../editor/src/documentSync";
import { Message, MessageType } from "../../shared";

const QUIET_MS = 50;

/**
 * A simulation of both sides: the document and the edit queue (modelled after
 * `SequentialEditor`, which builds an edit when it starts applying it and applies it
 * asynchronously), the editor webview with its real sync logic, and the message channels in
 * both directions.
 */
class World {
  doc: string;
  version = 1;
  inProgress = false;
  current: TextEdit[] | undefined;
  queue: Array<() => TextEdit[] | undefined> = [];

  editor!: EditorDocumentSync;
  editorText: string | undefined;
  webviews = 0;
  toEditor: Message[] = [];
  toExtension: Message[] = [];

  discarded = 0;
  outOfSyncs = 0;
  drops = 0;
  sync: DocumentSync;

  constructor(text: string) {
    this.doc = text;
    this.sync = new DocumentSync(
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
        sendInit: (value, version, epoch, webview) =>
          this.toEditor.push({
            type: MessageType.init,
            body: { value, version, epoch, webview },
          }),
        sendOutOfSync: () => {
          this.outOfSyncs++;
          this.toEditor.push({ type: MessageType.outOfSync });
        },
        reportDiscardedChanges: (count) => (this.discarded += count),
        log: (message) => {
          if (message.includes("Dropped")) this.drops++;
        },
      },
      QUIET_MS,
      () => Date.now(),
    );
    this.reloadWebview();
  }

  /** VS Code (re)builds the webview, losing messages to the previous one. */
  reloadWebview() {
    this.editor = new EditorDocumentSync(
      (msg) => this.toExtension.push(msg),
      `w${++this.webviews}`,
    );
    this.editorText = undefined;
    this.toEditor = [];
    this.editor.ready();
  }

  /** The user edits in the editor. */
  type(edit: TextEdit) {
    if (this.editorText === undefined) return false;
    this.editorText = applyEdits(this.editorText, [edit]);
    this.editor.sendChange({
      startInFile: edit.start,
      endInFile: edit.end,
      finalText: edit.text,
    });
    return true;
  }

  /** Something other than the editor changes the document. */
  outsideEdit(edit: TextEdit) {
    this.doc = applyEdits(this.doc, [edit]);
    this.version++;
    this.sync.documentChanged();
  }

  deliverToEditor() {
    const msg = this.toEditor.shift();
    if (!msg) return false;
    if (msg.type === MessageType.init) {
      if (this.editor.acceptInit(msg.body)) this.editorText = msg.body.value;
    } else if (msg.type === MessageType.outOfSync) {
      this.editor.outOfSync();
    }
    return true;
  }

  deliverToExtension() {
    const msg = this.toExtension.shift();
    if (!msg) return false;
    if (msg.type === MessageType.docChange)
      this.sync.changeFromEditor(msg.body.change, msg.body.epoch);
    else if (msg.type === MessageType.requestDocument)
      this.sync.documentRequested(msg.body.epoch);
    else if (msg.type === MessageType.ready)
      this.sync.editorReady(msg.body.webview);
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

describe("rebaseEdits", () => {
  it("moves edits after a change and keeps edits before it", () => {
    const base = "abc def ghi";
    const current = "abc XX def ghi"; // "XX " inserted at 4
    expect(
      rebaseEdits(
        [
          { start: 0, end: 1, text: "A" },
          { start: 8, end: 9, text: "G" },
        ],
        base,
        current,
      ),
    ).toEqual([
      { start: 0, end: 1, text: "A" },
      { start: 11, end: 12, text: "G" },
    ]);
  });

  it("reports a conflict for an edit that overlaps the change", () => {
    expect(
      rebaseEdits([{ start: 3, end: 6, text: "" }], "abc def", "abcXdef"),
    ).toBeUndefined();
  });
});

describe("DocumentSync", () => {
  it("initializes the editor when it is ready", () => {
    const w = started();
    expect(w.editorText).toBe("hello world");
    expect(w.outOfSyncs).toBe(0);
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
    w.settle();

    expect(w.doc).toBe("lo world");
    expect(w.editorText).toBe("lo world");
    expect(w.outOfSyncs).toBe(0);
  });

  it("brings an outside change to the editor once the document is quiet", () => {
    const w = started();
    w.outsideEdit({ start: 0, end: 0, text: "X" });
    expect(w.toEditor).toEqual([{ type: MessageType.outOfSync }]);
    w.deliverToEditor();
    w.deliverToExtension(); // requestDocument
    jest.advanceTimersByTime(QUIET_MS - 10);
    w.outsideEdit({ start: 0, end: 0, text: "Y" });
    jest.advanceTimersByTime(QUIET_MS - 10);
    expect(w.toEditor).toEqual([]);
    w.settle();

    expect(w.editorText).toBe("YXhello world");
  });

  it("rebases changes made before the editor got the outside change", () => {
    const w = started();
    w.outsideEdit({ start: 0, end: 0, text: "X" });
    // The user types before outOfSync arrives, and keeps typing while the request is out.
    w.type({ start: 5, end: 5, text: "!" });
    w.deliverToEditor(); // outOfSync: the editor requests the document
    w.type({ start: 12, end: 12, text: "?" });
    w.settle();

    expect(w.doc).toBe("Xhello! world?");
    expect(w.editorText).toBe(w.doc);
    expect(w.discarded).toBe(0);
  });

  it("does not show content that misses changes the editor sent since its request", () => {
    const w = started();
    w.outsideEdit({ start: 0, end: 0, text: "X" });
    w.deliverToEditor(); // outOfSync
    w.deliverToExtension(); // requestDocument
    jest.advanceTimersByTime(QUIET_MS);
    expect(w.toEditor.map((m) => m.type)).toEqual([MessageType.init]);
    // The user types before the answer arrives.
    w.type({ start: 0, end: 0, text: "a" });
    w.deliverToEditor(); // init is ignored, and the editor asks again
    expect(w.editorText).toBe("ahello world");
    w.settle();

    // Both inserted at the same position; the editor's change goes first.
    expect(w.editorText).toBe("aXhello world");
    expect(w.doc).toBe("aXhello world");
  });

  it("drops a change that overlaps an outside change, and reports it", () => {
    const w = started();
    w.outsideEdit({ start: 0, end: 5, text: "HELLO" });
    w.type({ start: 0, end: 1, text: "j" });
    w.settle();

    expect(w.doc).toBe("HELLO world");
    expect(w.editorText).toBe("HELLO world");
    expect(w.discarded).toBe(1);
  });

  it("brings the editor in line when an edit is not applied", () => {
    const w = started();
    w.type({ start: 0, end: 0, text: "a" });
    w.deliverToExtension();
    w.current = undefined; // VS Code does not apply it
    w.settle();

    expect(w.editorText).toBe("hello world");
    expect(w.doc).toBe("hello world");
  });

  it("replaces the document and updates the editor", () => {
    const w = started();
    w.sync.replaceDocument("restored");
    w.settle();

    expect(w.doc).toBe("restored");
    expect(w.editorText).toBe("restored");
  });

  it("initializes a rebuilt webview after the queue is done", () => {
    const w = started();
    w.type({ start: 0, end: 0, text: "a" });
    w.deliverToExtension();
    w.reloadWebview();
    w.deliverToExtension(); // ready
    expect(w.toEditor).toEqual([]);
    w.settle();

    expect(w.editorText).toBe("ahello world");
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

/** A random edit of `text` within `[from, text.length]`. */
function randomEdit(rand: () => number, text: string, from = 0): TextEdit {
  const a = from + Math.floor(rand() * (text.length - from + 1));
  const b = Math.min(text.length, a + Math.floor(rand() * 3));
  const letters = "abc \n";
  const insert =
    rand() < 0.5 ? "" : letters[Math.floor(rand() * letters.length)];
  return { start: a, end: rand() < 0.5 ? a : b, text: insert };
}

describe("DocumentSync with random interleavings", () => {
  /** Performs one random step; `act` makes the user or something else edit. */
  function step(w: World, rand: () => number, act: () => void) {
    const r = rand();
    if (r < 0.4) act();
    else if (r < 0.58) w.deliverToExtension();
    else if (r < 0.73) w.completeEdit();
    else if (r < 0.88) w.deliverToEditor();
    else if (r < 0.97) jest.advanceTimersByTime(Math.floor(rand() * QUIET_MS));
    else w.reloadWebview();
  }

  it.each(Array.from({ length: 200 }, (_, i) => i))(
    "editor and document agree in the end, with outside edits (seed %i)",
    (seed) => {
      const rand = mulberry32(seed);
      const w = new World("The quick brown fox.\n");
      for (let i = 0; i < 300; i++)
        step(w, rand, () => {
          if (rand() < 0.8) {
            if (w.editorText !== undefined)
              w.type(randomEdit(rand, w.editorText));
          } else w.outsideEdit(randomEdit(rand, w.doc));
        });
      w.settle();
      expect(w.editorText).toBe(w.doc);
    },
  );

  it.each(Array.from({ length: 200 }, (_, i) => i))(
    "only the editor writes: nothing is lost and no refresh is needed (seed %i)",
    (seed) => {
      const rand = mulberry32(seed);
      const w = new World("The quick brown fox.\n");
      for (let i = 0; i < 300; i++)
        step(w, rand, () => {
          if (w.editorText !== undefined)
            w.type(randomEdit(rand, w.editorText));
        });
      w.settle();
      expect(w.editorText).toBe(w.doc);
      expect(w.outOfSyncs).toBe(0);
      expect(w.discarded + w.drops).toBe(0);
    },
  );

  it.each(Array.from({ length: 200 }, (_, i) => i))(
    "changes that don't overlap outside changes are all kept, in place (seed %i)",
    (seed) => {
      // The document is "<prefix>|<body>". Outside edits only change the prefix, the user only
      // edits the body; then every change of the user must end up in the body, as typed.
      // Outside edits don't happen while VS Code applies an edit: an edit's offsets are
      // computed right before it is applied, and VS Code offers no way to tie them to a version
      // of the document. In VS Code, that window is a few milliseconds.
      const rand = mulberry32(seed);
      const w = new World("|The quick brown fox.\n");
      let body = "The quick brown fox.\n";
      for (let i = 0; i < 300; i++)
        step(w, rand, () => {
          if (rand() < 0.75) {
            const text = w.editorText;
            if (text === undefined) return;
            const bodyStart = text.indexOf("|") + 1;
            const edit = randomEdit(rand, text, bodyStart);
            w.type(edit);
            body = applyEdits(body, [
              {
                start: edit.start - bodyStart,
                end: edit.end - bodyStart,
                text: edit.text,
              },
            ]);
          } else if (!w.inProgress) {
            const prefixLength = w.doc.indexOf("|");
            if (rand() < 0.5 || prefixLength === 0)
              w.outsideEdit({ start: 0, end: 0, text: "x" });
            else w.outsideEdit({ start: 0, end: 1, text: "" });
          }
        });
      w.settle();
      expect(w.editorText).toBe(w.doc);
      expect(w.doc.slice(w.doc.indexOf("|") + 1)).toBe(body);
      expect(w.discarded + w.drops).toBe(0);
    },
  );
});
