import type {
  DocChange,
  WrappingDocChange,
} from "@impermeable/waterproof-editor";
import { Message, MessageType } from "../../shared";

/** A random id for this instance of the webview. */
function newWebviewId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The editor's side of keeping the editor and the document in the extension in sync.
 *
 * The editor sends its changes to the extension, tagged with the epoch of the content they were
 * made to (each `init` starts a new epoch). When the document was changed elsewhere, the
 * extension sends `outOfSync`, and the editor asks for the document with `requestDocument`.
 * Messages arrive in order, so the extension receives all changes the editor made before the
 * request, and answers with `init` once it has applied them. The editor shows that content only
 * if it has not sent any changes since its request; otherwise the content misses those changes,
 * and it asks again.
 *
 * VS Code rebuilds the webview when it is hidden and shown again. `ready` carries an id of the
 * webview instance, and `init` is addressed to one; an `init` for another instance is ignored.
 */
export class EditorDocumentSync {
  /** The epoch of the content the editor shows, from the last `init` it showed; 0 if none. */
  private epoch = 0;

  /** Whether the editor asked for the document and has not received the answer yet. */
  private requested = false;

  /** Whether the editor sent changes since its request. */
  private sentSinceRequest = false;

  constructor(
    private readonly post: (msg: Message) => void,
    readonly webview: string = newWebviewId(),
  ) {}

  /** Tells the extension that this webview has loaded. */
  ready(): void {
    this.post({ type: MessageType.ready, body: { webview: this.webview } });
  }

  /** Sends a change made in the editor to the extension. */
  sendChange(change: DocChange | WrappingDocChange): void {
    if (this.requested) this.sentSinceRequest = true;
    this.post({
      type: MessageType.docChange,
      body: { change, epoch: this.epoch },
    });
  }

  /** Handles `outOfSync`: the document was changed outside the editor. */
  outOfSync(): void {
    // Without content, this was meant for an earlier instance of the webview; this one gets
    // the document for its `ready`. A request that is under way is answered with the document
    // as it is now.
    if (this.epoch === 0 || this.requested) return;
    this.request();
  }

  /**
   * Handles `init`.
   * @returns Whether the editor should show the content.
   */
  acceptInit(body: { epoch: number; webview: string }): boolean {
    if (body.webview !== this.webview) return false;
    if (this.sentSinceRequest) {
      // The content misses changes that are still on their way to the extension.
      this.request();
      return false;
    }
    this.requested = false;
    this.epoch = body.epoch;
    return true;
  }

  private request(): void {
    this.requested = true;
    this.sentSinceRequest = false;
    this.post({
      type: MessageType.requestDocument,
      body: { epoch: this.epoch },
    });
  }
}
