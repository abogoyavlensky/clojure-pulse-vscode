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
 * Builds (but does not start) a language client that talks to the clj-pulse
 * server over stdio. The client id `clojurePulse` makes the standard
 * `clojurePulse.trace.server` setting drive LSP tracing automatically.
 */
export function createClient(
  server: ResolvedServer,
  outputChannel: vscode.OutputChannel,
): LanguageClient {
  const serverOptions: ServerOptions = {
    command: server.command,
    args: server.args,
    transport: TransportKind.stdio,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: LANGUAGE_ID }],
    outputChannel,
    traceOutputChannel: outputChannel,
  };

  return new LanguageClient(
    "clojurePulse",
    "Clojure Pulse",
    serverOptions,
    clientOptions,
  );
}
