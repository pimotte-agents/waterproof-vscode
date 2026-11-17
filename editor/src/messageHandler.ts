import type { MessageHandlerEditor } from "@impermeable/waterproof-editor";
import { Message, MessageType, ServerStatus } from "../../shared";

/** What the editor keeps to stay in sync with the document in the extension. */
export interface EditorSyncState {
  /** The epoch of the content the editor shows, from the last `init`. */
  epoch: number;
  /** The id of this webview instance, sent in `ready`. */
  webview: string;
  /** Sends a message to the extension. */
  reply: (msg: Message) => void;
}

export function handleEditorMessage(
  editor: MessageHandlerEditor,
  msg: Message,
  sync?: EditorSyncState,
): void {
  switch (msg.type) {
    case MessageType.init:
      // Content for an earlier instance of this webview; the extension sends its own once it
      // has received this instance's `ready`.
      if (sync && msg.body.webview !== sync.webview) break;
      if (sync) sync.epoch = msg.body.epoch;
      editor.init(msg.body.value, msg.body.version);
      break;
    case MessageType.freeze:
      // A freeze for older content is outdated: that content has been replaced already.
      if (sync && msg.body.epoch !== sync.epoch) break;
      editor.freeze();
      sync?.reply({
        type: MessageType.frozen,
        body: { epoch: msg.body.epoch },
      });
      break;
    case MessageType.insert: {
      // Insert symbol message, retrieve the symbol from the message.
      const { symbolUnicode } = msg.body;
      if (msg.body.type === "tactics") {
        // `symbolUnicode` stores the tactic template.
        if (!symbolUnicode) {
          console.error("no template provided for snippet");
          return;
        }
        editor.handleSnippet(symbolUnicode);
      } else {
        editor.insertSymbol(symbolUnicode);
      }
      break;
    }
    case MessageType.replaceRange: {
      const { start, end, text } = msg.body;
      editor.replaceRange(start, end, text);
      break;
    }
    case MessageType.setAutocomplete:
      // Handle autocompletion
      editor.handleCompletions(msg.body);
      break;
    case MessageType.qedStatus: {
      const statuses = msg.body; // one status for each input area, in order
      editor.setInputAreaStatus(statuses);
      break;
    }
    case MessageType.setShowLineNumbers: {
      const show = msg.body;
      editor.setShowLineNumbers(show);
      break;
    }
    case MessageType.setShowMenuItems: {
      const show = msg.body;
      editor.setShowMenuItems(show);
      break;
    }
    case MessageType.editorHistoryChange:
      editor.handleHistoryChange(msg.body);
      break;
    case MessageType.teacher:
      editor.setTeacherMode(msg.body);
      break;
    case MessageType.progress: {
      const { numberOfLines, progress } = msg.body;
      if (progress.length === 0) {
        editor.removeBusyIndicators();
        editor.reportProgress(numberOfLines, numberOfLines, "File verified");
      } else {
        const at = progress[0].range.start.line + 1;
        editor.reportProgress(
          at,
          numberOfLines,
          `Verified file up to line: ${at}`,
        );
      }
      break;
    }
    case MessageType.executionInfo: {
      const range = msg.body;
      editor.setBusyIndicator(range.from);
      break;
    }
    case MessageType.diagnostics:
      editor.setActiveDiagnostics(
        msg.body.positionedDiagnostics,
        msg.body.version,
      );
      break;
    case MessageType.serverStatus: {
      const status: ServerStatus = msg.body;
      if (status.status === "Busy") {
        editor.startSpinner();
      } else {
        editor.stopSpinner();
      }
      break;
    }
    case MessageType.themeUpdate:
      editor.updateNodeViewThemes(msg.body.theme);
      break;
    default:
      // If we reach this 'default' case, then we have encountered an unknown message type.
      console.log(`[WEBVIEW] Unrecognized message type '${msg.type}'`);
      break;
  }
}
