/**
 * The hover provider behind Show ClojureDocs.
 *
 * VS Code merges every provider's part into one popup, so this one adds a
 * ClojureDocs part under the server's arglists-and-docstring part. It answers
 * only a request the command recorded (see `clojureDocsRequest.ts`); every
 * other hover, from the mouse or `Ctrl+K Ctrl+I`, gets nothing from it.
 *
 * The lookup happens here, not in the command: the command cannot await the
 * hover VS Code shows, so this is where "no entry" and server failures are
 * reported. Everything it touches is injected, and it never throws — a
 * provider that throws would break the whole hover.
 */

import * as vscode from "vscode";
import {
  buildClojureDocsMarkdown,
  ClojureDocsParams,
  ClojureDocsResult,
  describeClojureDocsFailure,
  noEntryMessage,
} from "./clojureDocs";
import { PendingClojureDocsRequest } from "./clojureDocsRequest";

/** The command see-also links re-run; the markdown trusts only this one. */
const SHOW_COMMAND = "clojurePulse.showClojureDocs";

export interface ClojureDocsHoverDeps {
  pending: PendingClojureDocsRequest;
  /** The server round-trip. Rejects with the request's error. */
  lookup: (params: ClojureDocsParams) => Promise<ClojureDocsResult>;
  /** The running server's version, for the "needs 0.4.0" message. */
  serverVersion: () => string | undefined;
  notify: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

export function createClojureDocsHoverProvider(deps: ClojureDocsHoverDeps): vscode.HoverProvider {
  return {
    async provideHover(document, position): Promise<vscode.Hover | undefined> {
      const request = deps.pending.take(document.uri.toString(), position.line, position.character);
      if (!request) {
        return undefined;
      }
      const params: ClojureDocsParams = request.symbol
        ? { symbol: request.symbol }
        : {
            textDocument: { uri: request.uri },
            position: { line: request.line, character: request.character },
          };
      let result: ClojureDocsResult;
      try {
        result = await deps.lookup(params);
      } catch (error) {
        deps.notify.warn(describeClojureDocsFailure(error, deps.serverVersion()));
        return undefined;
      }
      if (!result.entry) {
        deps.notify.info(noEntryMessage(result.symbol));
        return undefined;
      }
      const markdown = new vscode.MarkdownString(buildClojureDocsMarkdown(result.entry));
      markdown.isTrusted = { enabledCommands: [SHOW_COMMAND] };
      return new vscode.Hover(markdown);
    },
  };
}
