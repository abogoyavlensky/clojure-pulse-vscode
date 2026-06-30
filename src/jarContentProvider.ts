import * as vscode from "vscode";

/**
 * Minimal slice of `LanguageClient.sendRequest`, injected so the provider can
 * be unit-tested without a live server.
 */
export type SendRequest = (method: string, param: { uri: string }) => Thenable<unknown>;

/** clojure-lsp-compatible request the clj-pulse server answers for jar contents. */
const DEPENDENCY_CONTENTS = "clojure/dependencyContents";

/**
 * Serves read-only text for `jar:` URIs by delegating to the server's
 * `clojure/dependencyContents` request. Registering this for the `jar` scheme
 * is what lets go-to-definition into library and clojure.core sources actually
 * open a document — plain vscode-languageclient does not handle it.
 */
export function createJarContentProvider(
  sendRequest: SendRequest,
): vscode.TextDocumentContentProvider {
  return {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const content = await sendRequest(DEPENDENCY_CONTENTS, { uri: uri.toString() });
      return typeof content === "string" ? content : "";
    },
  };
}
