import {
  Position,
  TextDocument,
  Range,
  OutputChannel,
  languages,
  workspace,
  Disposable,
  DiagnosticSeverity,
  Diagnostic,
  CancellationToken,
  CancellationTokenSource,
} from "vscode";
import {
  DocumentSymbol,
  DocumentSymbolParams,
  DocumentSymbolRequest,
  LogTraceNotification,
  SymbolInformation,
} from "vscode-languageclient";
import { SentenceManager } from "./sentenceManager";
import { IFileProgressComponent } from "../components";
import { WebviewManager } from "../webviewManager";
import {
  qualifiedSettingName,
  WaterproofConfigHelper,
  WaterproofSetting,
  WaterproofLogger as wpl,
} from "../helpers";

import {
  InputAreaStatus,
  OffsetDiagnostic,
  OffsetMessageSegment,
  Severity,
  WaterproofCompletion,
} from "@impermeable/waterproof-editor";
import { convertToSimple, FileProgressParams } from "./requestTypes";
import { MessageType, SimpleProgressParams } from "../../shared";
import {
  ILspClient,
  LanguageClient,
  LanguageClientProvider,
  MessageSegment,
  WpDiagnostic,
} from "./clientTypes";
import { GoalAnswer, GoalRequest } from "../../lib/types";

function vscodeSeverityToWaterproof(severity: DiagnosticSeverity): Severity {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return Severity.Error;
    case DiagnosticSeverity.Warning:
      return Severity.Warning;
    case DiagnosticSeverity.Information:
      return Severity.Information;
    case DiagnosticSeverity.Hint:
      return Severity.Hint;
  }
}

/** Identifies a diagnostic across diagnostics passes, for carrying segments over. */
function diagnosticKey(d: OffsetDiagnostic): string {
  return `${d.startOffset}:${d.endOffset}:${d.message}`;
}

function wasCanceledByServer(reason: unknown): boolean {
  return (
    !!reason &&
    typeof reason === "object" &&
    "message" in reason &&
    reason.message === "Request got old in server"
  ); // or: code == -32802
}

export abstract class LspClient<
  GoalRequestT extends GoalRequest,
  GoalAnswerT extends GoalAnswer,
> implements ILspClient {
  private _client?: LanguageClient;

  /**
   * Gets the underlying VS Code language client.
   * Initializes one if necessary.
   */
  get client(): LanguageClient {
    if (this._client === undefined) {
      wpl.log(`${this.language} client not running, initializing`);
      this._client = this.provideClient();
    }
    return this._client;
  }

  /**
   * Whether the underlying client has been created.
   *
   * Unlike `isRunning`, reading this never creates one, and it stays true for a
   * client that was created but failed to start. Such a client still owns
   * resources that have to be released — in the web build, the worker its
   * server runs in.
   */
  get hasClient(): boolean {
    return this._client !== undefined;
  }

  /**
   * Checks whether the underlying client exists and is running.
   */
  isRunning(): boolean {
    if (this._client === undefined) return false;
    return this._client.isRunning();
  }

  /**
   * Run any pre-launch checks before starting this client.
   */
  async prelaunchChecks(): Promise<string[]> {
    return this.language ? [this.language] : [];
  }

  /**
   * Language identifier of this client, e.g. 'rocq' or 'lean4'
   */
  readonly language: string | undefined;

  /**
   * Resources that must be released upon disposal of this client.
   */
  readonly disposables: Disposable[] = [];

  detailedErrors: boolean = false;

  activeDocument: TextDocument | undefined;
  activeCursorPosition: Position | undefined;

  /**
   * The object that keeps track of the (end) positions of the sentences in `activeDocument`.
   */
  readonly sentenceManager: SentenceManager;
  protected readonly fileProgressComponents: IFileProgressComponent[] = [];

  webviewManager: WebviewManager | undefined;

  /**
   * Whether we are using viewport based checking.
   */
  readonly viewPortBasedChecking: boolean = !WaterproofConfigHelper.get(
    WaterproofSetting.ContinuousChecking,
  );
  /**
   * The range of the current viewport.
   */
  viewPortRange: Range | undefined = undefined;

  /*
   * Constructs a Waterproof language client.
   */
  constructor(
    private readonly provideClient: LanguageClientProvider,
    protected readonly lspOutputChannel: OutputChannel,
  ) {
    this.sentenceManager = new SentenceManager();

    // forward progress notifications to editor
    this.fileProgressComponents.push({
      dispose() {
        /* noop */
      },
      onProgress: (params) => {
        const document = this.activeDocument;
        if (!document) return;
        const body: SimpleProgressParams = {
          numberOfLines: document.lineCount,
          progress: params.processing.map(convertToSimple),
        };
        this.webviewManager!.postAndCacheMessage(document, {
          type: MessageType.progress,
          body,
        });
      },
    });

    // deduce (end) positions of sentences from progress notifications
    this.fileProgressComponents.push(this.sentenceManager);
    const diagnosticsCollection = languages.createDiagnosticCollection(
      this.language,
    );

    // Set detailedErrors to the value of the `Waterproof.detailedErrorsMode` setting.
    this.detailedErrors = WaterproofConfigHelper.get(
      WaterproofSetting.DetailedErrorsMode,
    );
    // Update `detailedErrors` when the setting changes.
    this.disposables.push(
      workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(
            qualifiedSettingName(WaterproofSetting.DetailedErrorsMode),
          )
        ) {
          this.detailedErrors = WaterproofConfigHelper.get(
            WaterproofSetting.DetailedErrorsMode,
          );
        }

        // When the LogDebugStatements setting changes we update the logDebug boolean in the WaterproofLogger class.
        if (
          e.affectsConfiguration(
            qualifiedSettingName(WaterproofSetting.LogDebugStatements),
          )
        ) {
          wpl.logDebug = WaterproofConfigHelper.get(
            WaterproofSetting.LogDebugStatements,
          );
        }
      }),
    );

    // send diagnostics to editor (for squiggly lines)
    this.client.middleware.handleDiagnostics = (uri, diagnostics_) => {
      // Note: Here we typecast diagnostics_ to WpDiagnostic[], the new type includes the custom data field
      //      added by coq-lsp required for the line long error mode.
      if (!this.detailedErrors) {
        const diagnostics = diagnostics_ as WpDiagnostic[];
        diagnosticsCollection.set(
          uri,
          diagnostics.map((d) => {
            const start = d.data?.sentenceRange?.start ?? d.range.start;
            const end = d.data?.sentenceRange?.end ?? d.range.end;
            return {
              ...d,
              range: new Range(start, end),
            };
          }),
        );
      } else {
        diagnosticsCollection.set(uri, diagnostics_);
      }
    };

    this.disposables.push(
      languages.onDidChangeDiagnostics((e) => {
        if (this.activeDocument === undefined) return;
        // Comparing the uris (by doing uris.includes(this.activeDocument.uri)) does not seem to achieve
        // the same result.
        if (
          e.uris.map((uri) => uri.path).includes(this.activeDocument.uri.path)
        ) {
          this.processDiagnostics().catch((e) =>
            wpl.log(`[LspClient] Failed to process diagnostics: ${e}`),
          );
        }
      }),
    );

    // send proof statuses to editor when document checking is done
    this.disposables.push(
      this.client.onNotification(LogTraceNotification.type, (params) => {
        // Print `params.message` to custom lsp output channel
        this.lspOutputChannel.appendLine(params.message);

        if (params.message.includes("document fully checked")) {
          this.onCheckingCompleted();
        }
      }),
    );
  }

  protected onFileProgress(params: FileProgressParams): void {
    // convert LSP range to VSC range
    params.processing.forEach((fp): void => {
      fp.range = this.client.protocol2CodeConverter.asRange(fp.range);
    });
    // notify each component
    this.fileProgressComponents.forEach((c) => c.onProgress(params));
  }

  /**
   * Whether the client resolves message segments (see {@linkcode resolveMessageSegments}).
   */
  protected readonly requestsMessageSegments: boolean = false;

  /**
   * Splits the messages of diagnostics into segments, some of which are suggestions with an
   * edit (e.g. Lean's "Try this"). Only called for diagnostics inside input areas, and only
   * when {@linkcode requestsMessageSegments} is set.
   *
   * @param document The document the diagnostics belong to.
   * @param diagnostics All diagnostics of the document.
   * @param indices The indices (into `diagnostics`) to resolve segments for.
   * @param token Cancelled when a newer diagnostics pass starts.
   * @returns The segments per index, or `undefined` if they could not be resolved (in which
   *   case the segments of the previous pass are kept). Indices without an entry get no
   *   segments.
   */
  protected async resolveMessageSegments(
    _document: TextDocument,
    _diagnostics: readonly Diagnostic[],
    _indices: readonly number[],
    _token: CancellationToken,
  ): Promise<Map<number, MessageSegment[]> | undefined> {
    return undefined;
  }

  /**
   * Converts message segments to offset-based segments. A suggestion whose edit reaches
   * outside the input area is kept as plain text, since we don't want to apply edits that
   * could corrupt the proof with no recovery.
   */
  private toOffsetSegments(
    document: TextDocument,
    text: string,
    segments: readonly MessageSegment[],
    containingArea: Range,
  ): OffsetMessageSegment[] {
    const areaStart = document.offsetAt(containingArea.start);
    const areaEnd = document.offsetAt(containingArea.end);
    return segments.map(({ text: segmentText, edit }) => {
      if (!edit) return { text: segmentText };
      const start = document.offsetAt(
        new Position(edit.range.start.line, edit.range.start.character),
      );
      const end = document.offsetAt(
        new Position(edit.range.end.line, edit.range.end.character),
      );
      if (start < areaStart || end > areaEnd) {
        wpl.debug(
          `[toOffsetSegments] suggestion "${edit.newText}" is outside input area [${areaStart}, ${areaEnd}]`,
        );
        return { text: segmentText };
      }
      return {
        text: segmentText,
        edit: {
          start,
          end,
          newText: edit.newText,
          oldText: text.slice(start, end),
        },
      };
    });
  }

  /**
   * Sends the diagnostics of the active document to its editor, and then resolves and
   * streams in the message segments for the diagnostics inside input areas.
   */
  protected async processDiagnostics(): Promise<void> {
    const document = this.activeDocument;
    if (!document) return;
    const uri = document.uri.toString();

    // A newer pass for the same document supersedes any pass still in flight.
    const previousCts = this.diagnosticsCts.get(uri);
    previousCts?.cancel();
    previousCts?.dispose();
    const cts = new CancellationTokenSource();
    this.diagnosticsCts.set(uri, cts);
    const token = cts.token;

    const diagnostics = languages.getDiagnostics(document.uri);
    const docVersionAtStart = document.version;

    // Note that switching to another document does not make a pass stale: its results are
    // still posted to (and cached for) the editor of the document they belong to.
    const isStale = (): boolean =>
      token.isCancellationRequested || document.version !== docVersionAtStart;

    const positionedDiagnostics: OffsetDiagnostic[] = diagnostics.map((d) => ({
      message: d.message,
      severity: vscodeSeverityToWaterproof(d.severity),
      startOffset: document.offsetAt(d.range.start),
      endOffset: document.offsetAt(d.range.end),
    }));

    try {
      const segmentsEnabled = this.requestsMessageSegments;

      // Only diagnostics inside an input area get segments, since we only want to apply
      // edits inside input areas. This avoids unnecessary LSP requests.
      const inputAreas = segmentsEnabled
        ? this.getInputAreas(document)
        : undefined;
      const containingAreas = diagnostics.map((d) =>
        inputAreas?.find((area) => area.contains(d.range)),
      );
      const requested = containingAreas.flatMap((area, index) =>
        area ? [index] : [],
      );

      // Carry over the segments of the previous pass for diagnostics that are still there,
      // as long as their edits still apply to the current text. This keeps them visible
      // across progressive diagnostics updates while they are re-resolved.
      const previous = this.resolvedSegments.get(uri);
      const current = new Map<string, OffsetMessageSegment[]>();
      this.resolvedSegments.set(uri, current);
      const text = document.getText();
      const stillApplies = (segments: readonly OffsetMessageSegment[]) =>
        segments.every(
          ({ edit: e }) =>
            !e ||
            (e.oldText !== undefined &&
              text.slice(e.start, e.end) === e.oldText),
        );
      if (previous && requested.length > 0) {
        for (const index of requested) {
          const d = positionedDiagnostics[index];
          const key = diagnosticKey(d);
          const carried = previous.get(key);
          if (carried && stillApplies(carried)) {
            d.segments = carried;
            current.set(key, carried);
          }
        }
      }

      wpl.debug(
        `[diag] sending ${positionedDiagnostics.length} base diagnostics, version=${docVersionAtStart}`,
      );

      // Send the diagnostics right away, so squiggles/messages show up without waiting
      // on segment resolution. A copy is sent, since the entries are updated below.
      this.webviewManager!.postAndCacheMessage(document, {
        type: MessageType.diagnostics,
        body: {
          positionedDiagnostics: positionedDiagnostics.map((d) => ({ ...d })),
          version: docVersionAtStart,
        },
      });

      if (requested.length === 0) return;

      let resolved: Map<number, MessageSegment[]> | undefined;
      try {
        resolved = await this.resolveMessageSegments(
          document,
          diagnostics,
          requested,
          token,
        );
      } catch (e) {
        if (!token.isCancellationRequested) {
          wpl.log(`[LspClient] Failed to resolve message segments: ${e}`);
        }
        return;
      }
      if (resolved === undefined || isStale()) return;

      const patches: { index: number; segments: OffsetMessageSegment[] }[] = [];
      for (const index of requested) {
        const diagnostic = positionedDiagnostics[index];
        const key = diagnosticKey(diagnostic);
        const raw = resolved.get(index);
        const segments = raw
          ? this.toOffsetSegments(document, text, raw, containingAreas[index]!)
          : undefined;
        const hasSuggestion = segments?.some((s) => s.edit) ?? false;
        // Nothing to report: no segments now, and none were carried over.
        if (!hasSuggestion && diagnostic.segments === undefined) continue;

        if (hasSuggestion) {
          diagnostic.segments = segments;
          current.set(key, segments!);
        } else {
          delete diagnostic.segments;
          current.delete(key);
        }
        patches.push({ index, segments: hasSuggestion ? segments! : [] });
      }
      if (patches.length === 0) return;

      wpl.debug(
        `[diag] sending segment patches indices=${patches.map((p) => p.index).join(",")} version=${docVersionAtStart}`,
      );

      this.webviewManager!.postMessage(uri, {
        type: MessageType.diagnosticSegmentsResolved,
        body: { version: docVersionAtStart, patches },
      });

      // Cache the final message with all segments so that they remain when we switch tabs.
      this.webviewManager!.cacheMessage(document, {
        type: MessageType.diagnostics,
        body: { positionedDiagnostics, version: docVersionAtStart },
      });
    } finally {
      if (this.diagnosticsCts.get(uri) === cts) {
        this.diagnosticsCts.delete(uri);
      }
      cts.dispose();
    }
  }

  protected async onCheckingCompleted(): Promise<void> {
    // ensure there is an active document
    const document = this.activeDocument;
    if (!document) {
      wpl.debug(
        `[onCheckingCompleted] 'document fully checked' received but no active document`,
      );
      return;
    }
    wpl.debug(
      `[onCheckingCompleted] 'document fully checked' for ` +
        `${document.uri.toString().split("/").pop()}; recomputing input area status`,
    );

    // send message to ProseMirror editor that checking is done
    // (in addition to LSP message that indicates last Markdown is still being processed)
    this.webviewManager!.postAndCacheMessage(document.uri.toString(), {
      type: MessageType.progress,
      body: { numberOfLines: document.lineCount, progress: [] },
    });

    this.computeInputAreaStatus(document);
  }

  protected abstract determineProofStatus(
    document: TextDocument,
    inputArea: Range,
    diagnostics: Array<Diagnostic>,
    lowerBound: Position,
  ): Promise<InputAreaStatus>;

  protected abstract getInputAreas(document: TextDocument): Range[] | undefined;

  // This setTimeout creates a NodeJS.Timeout object, but in the browser it is just a number.
  computeInputAreaStatusTimer?: NodeJS.Timeout | number;

  /**
   * Tracks, per document URI, the most recent in-flight `processDiagnostics` pass so it can
   * be cancelled when a newer one supersedes it (e.g. the user keeps typing while
   * segments are still being resolved against the previous diagnostics snapshot).
   */
  private readonly diagnosticsCts = new Map<string, CancellationTokenSource>();

  /**
   * Per document URI, the segments of the latest diagnostics pass, keyed by
   * {@linkcode diagnosticKey}. Used to carry them over to the next pass.
   */
  private readonly resolvedSegments = new Map<
    string,
    Map<string, OffsetMessageSegment[]>
  >();

  protected async computeInputAreaStatus(
    document: TextDocument,
  ): Promise<void> {
    if (this.computeInputAreaStatusTimer) {
      clearTimeout(this.computeInputAreaStatusTimer);
    }
    // Computing where all the input areas are requires a fair bit of work,
    // so we add a debounce delay to this function to avoid recomputing on every keystroke.
    this.computeInputAreaStatusTimer = setTimeout(async () => {
      // get input areas based on tags
      const inputAreas = this.getInputAreas(document);
      if (!inputAreas) {
        wpl.debug(
          `[computeInputAreaStatus] getInputAreas returned undefined for ` +
            `${document.uri.toString()} -> illegal input areas`,
        );
        throw new Error("Cannot check proof status; illegal input areas.");
      }

      const diags = languages.getDiagnostics(document.uri);

      wpl.debug(
        `[computeInputAreaStatus] doc=${document.uri.toString().split("/").pop()}, ` +
          `inputAreas=${inputAreas.length}, diagnostics=${diags.length}, ` +
          `viewPortBasedChecking=${this.viewPortBasedChecking}, ` +
          `viewPortRange=${this.viewPortRange ? JSON.stringify({ start: { line: this.viewPortRange.start.line, ch: this.viewPortRange.start.character }, end: { line: this.viewPortRange.end.line, ch: this.viewPortRange.end.character } }) : "undefined"}`,
      );

      // for each input area, check the proof status
      try {
        const statuses = await Promise.all(
          inputAreas.map((area, i) => {
            // compute lower bound for this input area: end of previous input area, or (0, 0) for the first one
            const lowerBound =
              i === 0 ? new Position(0, 0) : inputAreas[i - 1].end;

            if (
              this.viewPortBasedChecking &&
              this.viewPortRange &&
              area.intersection(this.viewPortRange) === undefined
            ) {
              // This input area is outside of the range that has been checked and thus we can't determine its status
              return Promise.resolve(InputAreaStatus.OutOfView);
            }

            return this.determineProofStatus(document, area, diags, lowerBound);
          }),
        );

        wpl.debug(
          `[computeInputAreaStatus] computed statuses for ` +
            `doc=${document.uri.toString().split("/").pop()}: ${JSON.stringify(statuses)} ` +
            `(sending qedStatus message to editor)`,
        );

        // forward statuses to corresponding ProseMirror editor
        this.webviewManager!.postAndCacheMessage(document, {
          type: MessageType.qedStatus,
          body: statuses,
        });
      } catch (reason) {
        if (wasCanceledByServer(reason)) return; // we've likely already sent new requests
        console.log(
          "[computeInputAreaStatus] The catch block caught an error that we don't classify as 'cancelled by server':",
          reason,
        );
      }
    }, 250);
  }

  async startWithHandlers(
    webviewManager: WebviewManager,
    allowedLanguages: string[],
  ): Promise<string[]> {
    if (!this.language || !allowedLanguages.includes(this.language)) {
      return [];
    }

    this.webviewManager = webviewManager;

    // after every document change, request symbols and send completions to the editor
    this.disposables.push(
      workspace.onDidChangeTextDocument((event) => {
        if (
          webviewManager.has(event.document.uri.toString()) &&
          event.document.languageId === this.language
        ) {
          this.updateCompletions(event.document);
        }
      }),
    );

    wpl.debug(`Starting ${this.language} client...`);
    await this.client.start();
    return [this.language ?? "unknown"];
  }

  /**
   * Creates parameter object for a goals request.
   */
  abstract createGoalsRequestParameters(
    document: TextDocument,
    position: Position,
  ): GoalRequestT;

  /** Sends an LSP request with the specified parameters to retrieve the goals. */
  abstract requestGoals(parameters: GoalRequestT): Promise<GoalAnswerT | null>;
  /** Sends an LSP request to retrieve the goals at `position` in the active document. */
  abstract requestGoals(position: Position): Promise<GoalAnswerT | null>;
  /** Sends an LSP request to retrieve the goals at the active cursor position. */
  abstract requestGoals(): Promise<GoalAnswerT | null>;

  async requestSymbols(document?: TextDocument): Promise<DocumentSymbol[]> {
    // use active document if no document is given
    document ??= this.activeDocument;
    if (!document) {
      throw new Error("Cannot request symbols; there is no active document.");
    }

    // send "documentSymbol" request and wait for response
    const params: DocumentSymbolParams = {
      textDocument: {
        uri: document.uri.toString(),
      },
    };
    const response = await this.client.sendRequest(
      DocumentSymbolRequest.type,
      params,
    );

    // convert `response` to array of `DocumentSymbol` (if necessary) and return it
    if (!response) {
      console.error("Response to 'textDocument/documentSymbol' was `null`.");
      return [];
    } else if (response.length === 0 || "range" in response[0]) {
      return response as DocumentSymbol[];
    } else {
      return (response as SymbolInformation[]).map((s) => ({
        name: s.name,
        kind: s.kind,
        tags: s.tags,
        range: s.location.range,
        selectionRange: s.location.range,
      }));
    }
  }

  abstract sendViewportHint(
    document: TextDocument,
    start: number,
    end: number,
  ): Promise<void>;

  async updateCompletions(document: TextDocument): Promise<void> {
    if (!this.client.isRunning()) return;
    if (!this.webviewManager?.has(document)) {
      throw new Error(
        "Cannot update completions; no Waterproof webview is known for " +
          document.uri.toString(),
      );
    }

    // request symbols for `document`
    let symbols: DocumentSymbol[];
    try {
      symbols = await this.requestSymbols(document);
    } catch (reason) {
      if (wasCanceledByServer(reason)) return; // we've likely already sent a new request
      throw reason;
    }

    // convert symbols to completions
    const completions: WaterproofCompletion[] = symbols.map((s) => ({
      label: s.name,
      detail: s.detail?.toLowerCase() ?? "",
      type: "variable",
      template: s.name,
    }));

    // send completions to (all code blocks in) the document's editor (not cached!)
    this.webviewManager.postMessage(document.uri.toString(), {
      type: MessageType.setAutocomplete,
      body: completions,
    });
  }

  dispose(timeout?: number): Promise<void> {
    for (const cts of this.diagnosticsCts.values()) {
      cts.cancel();
      cts.dispose();
    }
    this.diagnosticsCts.clear();
    this.resolvedSegments.clear();
    this.fileProgressComponents.forEach((c) => c.dispose());
    this.disposables.forEach((d) => d.dispose());
    return this.client.dispose(timeout);
  }
}
