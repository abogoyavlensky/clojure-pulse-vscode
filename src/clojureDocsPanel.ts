/**
 * The ClojureDocs panel: one webview tab beside the editor showing the entry
 * for the symbol the user asked about, reused for every lookup.
 *
 * The panel is a dumb renderer over `renderClojureDocsHtml`. Everything it
 * touches is injected: `createPanel` makes the tab, `lookup` asks the server
 * (the extension wires it to `clojurePulse/clojureDocs`), and `onError`
 * reports failures of lookups the webview itself starts — see-also clicks —
 * which have no caller to reject to. The command's own `show` call rejects
 * to the command, which shows the message. Nothing here imports `vscode`.
 *
 * Lookups can overlap (a see-also click while a keypress is in flight);
 * a sequence number lets only the newest render, so a slow earlier answer
 * never overwrites a later one.
 */

import * as crypto from "crypto";
import { ClojureDocsParams, ClojureDocsResult, renderClojureDocsHtml } from "./clojureDocs";

/** The slice of `vscode.Webview` the panel uses; a plain object satisfies it. */
export interface ClojureDocsWebview {
  html: string;
  onDidReceiveMessage(listener: (message: unknown) => void): void;
}

/** The slice of `vscode.WebviewPanel` the panel uses. */
export interface ClojureDocsPanelHost {
  title: string;
  webview: ClojureDocsWebview;
  /** `vscode.WebviewPanel.reveal`'s shape; the panel always keeps focus. */
  reveal(viewColumn?: undefined, preserveFocus?: boolean): void;
  dispose(): void;
  onDidDispose(listener: () => void): void;
}

export interface ClojureDocsPanelDeps {
  createPanel: () => ClojureDocsPanelHost;
  /** The server round-trip. Rejects with the request's error. */
  lookup: (params: ClojureDocsParams) => Promise<ClojureDocsResult>;
  /** Failures of webview-initiated lookups (see-also clicks). */
  onError: (error: unknown) => void;
}

export class ClojureDocsPanel {
  private panel: ClojureDocsPanelHost | undefined;
  /** Bumped per lookup; only the newest may render. */
  private sequence = 0;
  /** Webview-initiated lookups in flight — a test hook. */
  private inflight: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ClojureDocsPanelDeps) {}

  /** Every webview-initiated lookup finished. */
  settled(): Promise<void> {
    return this.inflight;
  }

  /**
   * Looks the params up and shows the entry. With no entry, nothing opens —
   * the caller reports that — but an already open panel shows the empty
   * state, so a see-also click to an undocumented var still gets an answer.
   * Returns the server's result either way; rejects when the lookup does.
   */
  async show(params: ClojureDocsParams): Promise<ClojureDocsResult> {
    const sequence = ++this.sequence;
    const result = await this.deps.lookup(params);
    if (sequence !== this.sequence) {
      return result;
    }
    if (result.entry || this.panel) {
      this.render(result);
    }
    return result;
  }

  dispose(): void {
    this.panel?.dispose();
    this.closed();
  }

  /** The tab is gone: forget it, and drop any lookup still in flight — its
   *  answer must not reopen what the user just closed. */
  private closed(): void {
    this.panel = undefined;
    this.sequence++;
  }

  private render(result: ClojureDocsResult): void {
    let panel = this.panel;
    if (panel) {
      // Keep focus in the editor: the point is to keep reading and typing.
      panel.reveal(undefined, true);
    } else {
      panel = this.deps.createPanel();
      this.panel = panel;
      panel.webview.onDidReceiveMessage((message) => this.handle(message));
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.closed();
        }
      });
    }
    const entry = result.entry;
    panel.title = entry ? `${entry.ns}/${entry.name}` : (result.symbol ?? "ClojureDocs");
    panel.webview.html = renderClojureDocsHtml(
      result,
      crypto.randomBytes(16).toString("base64"),
    );
  }

  /** `{type: "lookup", symbol}` from a see-also link; anything else is noise. */
  private handle(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const { type, symbol } = message as { type?: unknown; symbol?: unknown };
    if (type !== "lookup" || typeof symbol !== "string" || symbol === "") {
      return;
    }
    const run = this.show({ symbol }).then(
      () => undefined,
      (error) => this.deps.onError(error),
    );
    this.inflight = this.inflight.then(() => run);
  }
}
