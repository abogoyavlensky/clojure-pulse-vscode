import * as crypto from "crypto";
import * as vscode from "vscode";
import { Transcript, TranscriptEntry } from "./transcript";

/** Messages posted to the webview. */
type ToWebview =
  | { type: "reset"; entries: TranscriptEntry[] }
  | { type: "append"; entry: TranscriptEntry; evicted: number };

/**
 * The REPL pane: a webview view living in the bottom panel (next to
 * Terminal/Output). The extension host owns the transcript; the webview is a
 * dumb renderer that re-hydrates by asking for a full reset on load, so
 * `retainContextWhenHidden` can stay off.
 */
export class ReplPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "clojurePulse.replView";

  private view: vscode.WebviewView | undefined;

  constructor(private readonly transcript: Transcript) {
    transcript.onDidAppend((entry, evicted) =>
      this.post({ type: "append", entry, evicted }),
    );
    transcript.onDidClear(() => this.post({ type: "reset", entries: [] }));
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ReplPanelProvider.viewId, this),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml();
    view.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === "ready") {
        this.post({ type: "reset", entries: this.transcript.entries() });
      }
    });
  }

  /** Brings the REPL view into view (opens the panel if needed). */
  reveal(): void {
    void vscode.commands.executeCommand(`${ReplPanelProvider.viewId}.focus`);
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }
}

function renderHtml(): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  // Entry text is inserted with textContent (never innerHTML), so transcript
  // content cannot inject markup; the CSP additionally blocks anything but
  // this inline script and style.
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body {
    margin: 0;
    padding: 4px 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: transparent;
  }
  #log { white-space: pre-wrap; word-break: break-word; }
  .entry { min-height: 1.2em; }
  .banner, .info {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .in { color: var(--vscode-descriptionForeground); }
  .in::before { content: "=> "; opacity: 0.7; }
  .value { color: var(--vscode-terminal-ansiGreen, var(--vscode-editor-foreground)); }
  .err { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<div id="log"></div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const log = document.getElementById("log");

  // Stay pinned to the bottom unless the user has scrolled up to read.
  function isPinned() {
    const el = document.scrollingElement;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }
  function scrollToBottom() {
    const el = document.scrollingElement;
    el.scrollTop = el.scrollHeight;
  }

  function render(entry) {
    const node = document.createElement("div");
    node.className = "entry " + entry.kind;
    node.textContent = entry.text;
    return node;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "reset") {
      log.replaceChildren(...msg.entries.map(render));
      scrollToBottom();
      return;
    }
    if (msg.type === "append") {
      const pinned = isPinned();
      for (let i = 0; i < msg.evicted && log.firstChild; i++) {
        log.removeChild(log.firstChild);
      }
      log.appendChild(render(msg.entry));
      if (pinned) {
        scrollToBottom();
      }
    }
  });

  vscodeApi.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
