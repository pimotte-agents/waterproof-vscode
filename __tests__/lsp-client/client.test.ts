jest.mock(
  "vscode",
  () => {
    const Position = class {
      constructor(
        public line: number,
        public character: number,
      ) {}
      translate(lineDelta: number, charDelta: number) {
        return new Position(this.line + lineDelta, this.character + charDelta);
      }
      isAfter(other: InstanceType<typeof Position>) {
        return (
          this.line > other.line ||
          (this.line === other.line && this.character > other.character)
        );
      }
      isBeforeOrEqual(other: InstanceType<typeof Position>) {
        return !this.isAfter(other);
      }
    };

    const Range = class {
      constructor(
        public start: InstanceType<typeof Position>,
        public end: InstanceType<typeof Position>,
      ) {}
      contains(
        other: InstanceType<typeof Range> | InstanceType<typeof Position>,
      ) {
        const start = "start" in other ? other.start : other;
        const end = "end" in other ? other.end : other;
        return !this.start.isAfter(start) && !end.isAfter(this.end);
      }
      intersection(
        other: InstanceType<typeof Range>,
      ): InstanceType<typeof Range> | undefined {
        const startLine = Math.max(this.start.line, other.start.line);
        const endLine = Math.min(this.end.line, other.end.line);
        if (startLine > endLine) return undefined;
        return new Range(new Position(startLine, 0), new Position(endLine, 0));
      }
      get isEmpty() {
        return (
          this.start.line === this.end.line &&
          this.start.character === this.end.character
        );
      }
    };

    const CancellationTokenSource = class {
      private listeners: Array<() => void> = [];

      token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => {
          this.listeners.push(listener);
          return {
            dispose: () => {
              this.listeners = this.listeners.filter(
                (item) => item !== listener,
              );
            },
          };
        },
      };

      cancel() {
        this.token.isCancellationRequested = true;
        this.listeners.forEach((listener) => listener());
      }

      dispose() {
        this.listeners = [];
      }
    };

    return {
      Position,
      Range,
      CancellationTokenSource,
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      EventEmitter: class {
        fire() {}
        event = () => ({ dispose: () => {} });
      },
      workspace: {
        getConfiguration: jest.fn(() => ({
          get: jest.fn((_key: string, def?: unknown) => def),
        })),
        onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
        onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
      },
      languages: {
        createDiagnosticCollection: jest.fn(() => ({
          set: jest.fn(),
          dispose: jest.fn(),
        })),
        getDiagnostics: jest.fn(() => []),
        onDidChangeDiagnostics: jest.fn(() => ({ dispose: jest.fn() })),
      },
      window: {
        createOutputChannel: jest.fn(() => ({
          appendLine: jest.fn(),
          dispose: jest.fn(),
        })),
      },
    };
  },
  { virtual: true },
);

jest.mock(
  "vscode-languageclient",
  () => ({
    LogTraceNotification: { type: "$/logTrace" },
    RequestType: jest.fn().mockImplementation(() => ({})),
    NotificationType: jest.fn().mockImplementation(() => ({})),
    DocumentSymbolRequest: { type: {} },
  }),
  { virtual: true },
);

jest.mock(
  "vscode-languageserver-types",
  () => ({
    VersionedTextDocumentIdentifier: {
      create: jest.fn((uri, v) => ({ uri, version: v })),
    },
  }),
  { virtual: true },
);

jest.mock(
  "@impermeable/waterproof-editor",
  () => ({
    InputAreaStatus: {
      Correct: "Correct",
      Incorrect: "Incorrect",
      Invalid: "Invalid",
    },
    Severity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
  }),
  { virtual: true },
);
import {
  Range,
  Position,
  DiagnosticSeverity,
  TextDocument,
  OutputChannel,
  Uri,
  Diagnostic,
  languages,
} from "vscode";
import {
  LanguageClientProvider,
  MessageSegment,
} from "../../src/lsp-client/clientTypes";
import { LspClient } from "../../src/lsp-client/client";
import { WebviewManager } from "../../src/webviewManager";
import { MessageType } from "../../shared";
import { InputAreaStatus } from "@impermeable/waterproof-editor";
import type { GoalAnswer, GoalRequest } from "../../lib/types";
import { VersionedTextDocumentIdentifier } from "vscode-languageserver-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_TEXT = ":::input\nline one\nline two\nline three\nline four\n:::\n";

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}
const LINE_STARTS = computeLineStarts(FAKE_TEXT);

const FAKE_DOCUMENT = {
  uri: { toString: () => "file:///test.wp", path: "/test.wp" },
  version: 1,
  getText: () => FAKE_TEXT,
  offsetAt: (pos: Position) => LINE_STARTS[pos.line] + pos.character,
  positionAt: (offset: number) => {
    let line = 0;
    for (let i = 0; i < LINE_STARTS.length; i++) {
      if (LINE_STARTS[i] <= offset) line = i;
      else break;
    }
    return new Position(line, offset - LINE_STARTS[line]);
  },
  lineCount: 6,
} as TextDocument;

// A document with two separate input areas, separated by non-input text:
//   line 0: :::input
//   line 1: first area line     <- inside area 1
//   line 2: :::
//   line 3: non-input text
//   line 4: :::input
//   line 5: second area line    <- inside area 2
//   line 6: :::
const MULTI_AREA_TEXT =
  ":::input\nfirst area line\n:::\nnon-input text\n:::input\nsecond area line\n:::\n";
const MULTI_AREA_LINE_STARTS = computeLineStarts(MULTI_AREA_TEXT);

const MULTI_AREA_DOCUMENT = {
  uri: { toString: () => "file:///multi.wp", path: "/multi.wp" },
  version: 1,
  getText: () => MULTI_AREA_TEXT,
  offsetAt: (pos: Position) => MULTI_AREA_LINE_STARTS[pos.line] + pos.character,
  positionAt: (offset: number) => {
    let line = 0;
    for (let i = 0; i < MULTI_AREA_LINE_STARTS.length; i++) {
      if (MULTI_AREA_LINE_STARTS[i] <= offset) line = i;
      else break;
    }
    return new Position(line, offset - MULTI_AREA_LINE_STARTS[line]);
  },
  lineCount: 7,
} as TextDocument;

/**
 * A minimal, entirely test-owned concrete subclass of the abstract `LspClient`.
 *
 * This exists purely to exercise the base-class behaviour (diagnostics
 * processing, input-area matching, ...) without depending on any real
 * language client.
 *
 * `getInputAreas` recognizes simple ":::input" / ":::" delimited blocks,
 * matching the fixture documents defined above (`FAKE_DOCUMENT`,
 * `MULTI_AREA_DOCUMENT`).
 */
class TestLspClient extends LspClient<GoalRequest, GoalAnswer> {
  readonly language = "test-lang";

  protected getInputAreas(document: TextDocument): Range[] | undefined {
    const lines = document.getText().split("\n");
    const areas: Range[] = [];
    let openLine: number | undefined;

    lines.forEach((line, i) => {
      if (line.trim() === ":::input") {
        openLine = i;
      } else if (line.trim() === ":::" && openLine !== undefined) {
        areas.push(new Range(new Position(openLine, 0), new Position(i, 0)));
        openLine = undefined;
      }
    });

    return areas;
  }

  protected async determineProofStatus(): Promise<InputAreaStatus> {
    // Not exercised by these tests; a constant is sufficient.
    return InputAreaStatus.Correct;
  }

  createGoalsRequestParameters(
    document: TextDocument,
    position: Position,
  ): GoalRequest {
    return {
      textDocument: VersionedTextDocumentIdentifier.create(
        document.uri.toString(),
        document.version,
      ),
      position,
    };
  }

  requestGoals(
    _parametersOrPosition?: GoalRequest | Position,
  ): Promise<GoalAnswer | null> {
    return Promise.resolve(null);
  }

  async sendViewportHint(): Promise<void> {
    /* no-op: not exercised by these tests */
  }
}

function makeClientDouble() {
  return {
    isRunning: jest.fn(() => true),
    start: jest.fn(() => Promise.resolve()),
    dispose: jest.fn(() => Promise.resolve()),
    onNotification: jest.fn(() => ({ dispose: jest.fn() })),
    sendRequest: jest.fn().mockResolvedValue([]),
    middleware: { handleDiagnostics: undefined },
    protocol2CodeConverter: {
      asRange: (r: Range) => r,
    },
    code2ProtocolConverter: {
      asUri: (u: Uri) => u.toString(),
      asDiagnostic: (d: Diagnostic) => d,
      asRange: (range: Range) => range,
    },
  };
}

function makeClient() {
  const clientDouble = makeClientDouble();
  const instance = new TestLspClient(
    jest.fn(() => clientDouble) as unknown as LanguageClientProvider,
    { appendLine: jest.fn() } as unknown as OutputChannel,
  );
  instance.activeDocument = FAKE_DOCUMENT;
  instance.webviewManager = {
    postMessage: jest.fn(),
    postAndCacheMessage: jest.fn(),
    cacheMessage: jest.fn(),
    has: jest.fn(() => true),
  } as unknown as WebviewManager;
  return instance;
}

// ===========================================================================
// Tests
// ===========================================================================
describe("LspClient.processDiagnostics", () => {
  const getDiagnostics =
    languages.getDiagnostics as unknown as jest.MockedFunction<
      (uri: Uri) => Diagnostic[]
    >;

  const processDiagnostics = (instance: TestLspClient) => {
    // @ts-expect-error protected
    return instance.processDiagnostics();
  };

  /** Pulls every base-diagnostics message sent to the webview. */
  const diagnosticsMessages = (instance: TestLspClient) => {
    const postAndCache = instance.webviewManager
      ?.postAndCacheMessage as jest.Mock;
    return postAndCache.mock.calls
      .map(([, message]) => message)
      .filter((m) => m.type === MessageType.diagnostics);
  };

  beforeEach(() => {
    getDiagnostics.mockReturnValue([]);
  });

  it("does nothing when there is no active document", async () => {
    const instance = makeClient();
    instance.activeDocument = undefined;
    const postAndCache = instance.webviewManager!
      .postAndCacheMessage as jest.Mock;
    const postMessage = instance.webviewManager!.postMessage as jest.Mock;

    await processDiagnostics(instance);

    expect(postAndCache).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("maps each vscode diagnostic severity to the corresponding waterproof severity", async () => {
    const mk = (message: string, severity: DiagnosticSeverity) =>
      ({
        message,
        severity,
        range: new Range(new Position(0, 0), new Position(0, 1)),
      }) as Diagnostic;

    getDiagnostics.mockReturnValue([
      mk("e", DiagnosticSeverity.Error),
      mk("w", DiagnosticSeverity.Warning),
      mk("i", DiagnosticSeverity.Information),
      mk("h", DiagnosticSeverity.Hint),
    ]);
    const instance = makeClient();

    await processDiagnostics(instance);

    const [message] = diagnosticsMessages(instance);
    expect(
      message.body.positionedDiagnostics.map(
        (d: { severity: number }) => d.severity,
      ),
    ).toEqual([0, 1, 2, 3]);
  });
});

describe("LspClient.processDiagnostics message segments", () => {
  const getDiagnostics =
    languages.getDiagnostics as unknown as jest.MockedFunction<
      (uri: Uri) => Diagnostic[]
    >;

  /** A test client that resolves message segments. */
  class SegmentTestClient extends TestLspClient {
    protected override readonly requestsMessageSegments = true;
    resolveSegments = jest.fn<
      Promise<Map<number, MessageSegment[]> | undefined>,
      [TextDocument, readonly Diagnostic[], readonly number[]]
    >(async () => new Map());

    protected override resolveMessageSegments(
      document: TextDocument,
      diagnostics: readonly Diagnostic[],
      indices: readonly number[],
    ) {
      return this.resolveSegments(document, diagnostics, indices);
    }
  }

  function makeSegmentClient(document: TextDocument = FAKE_DOCUMENT) {
    const instance = new SegmentTestClient(
      jest.fn(() => makeClientDouble()) as unknown as LanguageClientProvider,
      { appendLine: jest.fn() } as unknown as OutputChannel,
    );
    instance.activeDocument = document;
    instance.webviewManager = {
      postMessage: jest.fn(),
      postAndCacheMessage: jest.fn(),
      cacheMessage: jest.fn(),
      has: jest.fn(() => true),
    } as unknown as WebviewManager;
    return instance;
  }

  // "ne o" on line 1 ("line one", offsets 9..17) of FAKE_DOCUMENT, inside its input area.
  const helpDiagnostic = (): Diagnostic =>
    ({
      message: "Help\n  • We apply h",
      severity: DiagnosticSeverity.Information,
      range: new Range(new Position(1, 2), new Position(1, 6)),
    }) as Diagnostic;

  const lspRange = (sl: number, sc: number, el: number, ec: number) => ({
    start: { line: sl, character: sc },
    end: { line: el, character: ec },
  });

  /** Segments whose suggestion replaces `range` by "We apply h". */
  const segmentsFor = (range = lspRange(1, 0, 1, 8)): MessageSegment[] => [
    { text: "Help\n  • " },
    { text: "We apply h", edit: { range, newText: "We apply h" } },
  ];

  const processDiagnostics = (instance: TestLspClient) =>
    // @ts-expect-error protected
    instance.processDiagnostics();

  const segmentPatches = (instance: TestLspClient) =>
    (instance.webviewManager?.postMessage as jest.Mock).mock.calls
      .map(([, message]) => message)
      .filter((m) => m.type === MessageType.diagnosticSegmentsResolved);

  const diagnosticsMessages = (instance: TestLspClient) =>
    (instance.webviewManager?.postAndCacheMessage as jest.Mock).mock.calls
      .map(([, message]) => message)
      .filter((m) => m.type === MessageType.diagnostics);

  const cachedMessages = (instance: TestLspClient) =>
    (instance.webviewManager?.cacheMessage as jest.Mock).mock.calls
      .map(([, message]) => message)
      .filter((m) => m.type === MessageType.diagnostics);

  const EXPECTED_SEGMENTS = [
    { text: "Help\n  • " },
    {
      text: "We apply h",
      edit: { start: 9, end: 17, newText: "We apply h", oldText: "line one" },
    },
  ];

  beforeEach(() => {
    getDiagnostics.mockReturnValue([]);
  });

  it("shows diagnostics right away, without waiting for segments to resolve", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    const instance = makeSegmentClient();
    // Segment resolution never finishes during this test.
    instance.resolveSegments.mockImplementation(() => new Promise(() => {}));

    void processDiagnostics(instance);
    await new Promise((resolve) => setImmediate(resolve));

    const messages = diagnosticsMessages(instance);
    expect(messages).toHaveLength(1);
    expect(messages[0].body.positionedDiagnostics).toEqual([
      expect.objectContaining({ startOffset: 11, endOffset: 15 }),
    ]);
  });

  it("patches in segments with offset-based edits and caches the result", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    const instance = makeSegmentClient();
    instance.resolveSegments.mockResolvedValue(new Map([[0, segmentsFor()]]));

    await processDiagnostics(instance);

    expect(segmentPatches(instance)).toEqual([
      {
        type: MessageType.diagnosticSegmentsResolved,
        body: {
          version: 1,
          patches: [{ index: 0, segments: EXPECTED_SEGMENTS }],
        },
      },
    ]);
    expect(
      cachedMessages(instance)[0].body.positionedDiagnostics[0].segments,
    ).toEqual(EXPECTED_SEGMENTS);
    // The base message was sent before the segments were known.
    expect(
      diagnosticsMessages(instance)[0].body.positionedDiagnostics[0].segments,
    ).toBeUndefined();
  });

  it("only asks for segments of diagnostics inside input areas", async () => {
    getDiagnostics.mockReturnValue([
      {
        ...helpDiagnostic(),
        range: new Range(new Position(3, 0), new Position(3, 4)),
      } as Diagnostic,
      {
        ...helpDiagnostic(),
        range: new Range(new Position(1, 0), new Position(1, 4)),
      } as Diagnostic,
    ]);
    const instance = makeSegmentClient(MULTI_AREA_DOCUMENT);

    await processDiagnostics(instance);

    expect(instance.resolveSegments).toHaveBeenCalledWith(
      MULTI_AREA_DOCUMENT,
      expect.anything(),
      [1],
    );
  });

  it("does not ask for segments when no diagnostic is inside an input area", async () => {
    getDiagnostics.mockReturnValue([
      {
        ...helpDiagnostic(),
        range: new Range(new Position(3, 0), new Position(3, 4)),
      } as Diagnostic,
    ]);
    const instance = makeSegmentClient(MULTI_AREA_DOCUMENT);

    await processDiagnostics(instance);

    expect(instance.resolveSegments).not.toHaveBeenCalled();
  });

  it("keeps a suggestion whose edit reaches outside the input area as plain text", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    const instance = makeSegmentClient();
    // The input area ends at the start of line 5 (the closing ":::").
    instance.resolveSegments.mockResolvedValue(
      new Map([[0, segmentsFor(lspRange(1, 0, 5, 3))]]),
    );

    await processDiagnostics(instance);

    // Without any suggestion left there is nothing to patch.
    expect(segmentPatches(instance)).toEqual([]);
  });

  it("sends nothing when segments could not be resolved", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    const instance = makeSegmentClient();
    instance.resolveSegments.mockResolvedValue(undefined);

    await processDiagnostics(instance);

    expect(segmentPatches(instance)).toEqual([]);
    expect(cachedMessages(instance)).toEqual([]);
  });

  it("logs and recovers when resolving segments fails", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    const instance = makeSegmentClient();
    instance.resolveSegments.mockRejectedValue(new Error("rpc failed"));

    await expect(processDiagnostics(instance)).resolves.toBeUndefined();
    expect(segmentPatches(instance)).toEqual([]);
  });

  it("drops segments when the document changed while they were resolved", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    const document = { ...FAKE_DOCUMENT, version: 1 } as TextDocument;
    const instance = makeSegmentClient(document);
    instance.resolveSegments.mockImplementation(async () => {
      (document as { version: number }).version = 2;
      return new Map([[0, segmentsFor()]]);
    });

    await processDiagnostics(instance);

    expect(segmentPatches(instance)).toEqual([]);
  });

  it("carries segments over to the next pass, and removes them if they are gone", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    const instance = makeSegmentClient();
    instance.resolveSegments.mockResolvedValueOnce(
      new Map([[0, segmentsFor()]]),
    );
    await processDiagnostics(instance);

    // The next pass: the base message already has the segments...
    let resolveSecond!: (v: Map<number, MessageSegment[]>) => void;
    instance.resolveSegments.mockReturnValueOnce(
      new Promise((resolve) => (resolveSecond = resolve)),
    );
    const second = processDiagnostics(instance);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      diagnosticsMessages(instance)[1].body.positionedDiagnostics[0].segments,
    ).toEqual(EXPECTED_SEGMENTS);

    // ...and when the server no longer has them, an empty patch removes them.
    resolveSecond(new Map());
    await second;
    expect(segmentPatches(instance)[1].body.patches).toEqual([
      { index: 0, segments: [] },
    ]);
    expect(
      cachedMessages(instance)[1].body.positionedDiagnostics[0].segments,
    ).toBeUndefined();
  });

  it("does not carry segments over when the text they replace has changed", async () => {
    getDiagnostics.mockReturnValue([helpDiagnostic()]);
    let text = FAKE_TEXT;
    const document = { ...FAKE_DOCUMENT, getText: () => text } as TextDocument;
    const instance = makeSegmentClient(document);
    instance.resolveSegments.mockResolvedValueOnce(
      new Map([[0, segmentsFor()]]),
    );
    await processDiagnostics(instance);

    text = FAKE_TEXT.replace("line one", "LINE ONE");
    instance.resolveSegments.mockResolvedValueOnce(undefined);
    await processDiagnostics(instance);

    expect(
      diagnosticsMessages(instance)[1].body.positionedDiagnostics[0].segments,
    ).toBeUndefined();
  });
});
