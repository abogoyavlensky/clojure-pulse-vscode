import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { ResolvedServer } from "./serverPath";

/** Language id contributed in package.json; covers .clj/.cljs/.cljc/.edn/.bb/.lg. */
const LANGUAGE_ID = "clojure";

/**
 * Documents VS Code routes to the language server. `file` is the project's own
 * code; `jar` is a dependency's source, opened read-only through the `jar:`
 * content provider registered in `extension.ts`. Without the `jar` entry that
 * document matches no selector, so VS Code sends no LSP request for it at all
 * and it reads as plain text — no go to definition, hover or completion. The
 * server already serves jar URIs: it advertises
 * `experimental.textDocumentContentProvider.schemes: ["jar"]`, and it
 * publishes diagnostics only for `file:` documents, so read-only sources stay
 * free of squiggles.
 */
export const CLOJURE_DOCUMENT_SELECTOR = [
  { scheme: "file", language: LANGUAGE_ID },
  { scheme: "jar", language: LANGUAGE_ID },
];

/**
 * Builds (but does not start) a language client that talks to the clj-pulse
 * server over stdio. The client id `clojurePulse` makes the standard
 * `clojurePulse.trace.server` setting drive LSP tracing automatically.
 * `initializationOptions` is sent verbatim in the `initialize` request — the
 * server reads the bare `{projects: [...], kondo: {...}, clojuredocs: {path}}`
 * config object from it.
 */
export function createClient(
  server: ResolvedServer,
  outputChannel: vscode.OutputChannel,
  initializationOptions?: unknown,
): LanguageClient {
  const serverOptions: ServerOptions = {
    command: server.command,
    args: server.args,
    transport: TransportKind.stdio,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: CLOJURE_DOCUMENT_SELECTOR,
    outputChannel,
    traceOutputChannel: outputChannel,
    initializationOptions,
  };

  return new LanguageClient(
    "clojurePulse",
    "Clojure Pulse",
    serverOptions,
    clientOptions,
  );
}
