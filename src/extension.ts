import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { createClient } from "./client";
import { isError, resolveServerPath, ServerConfig } from "./serverPath";

const INSTALL_URL = "https://github.com/abogoyavlensky/clj-pulse#installation";

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Clojure Pulse");

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand("clojurePulse.restart", restart),
    vscode.commands.registerCommand("clojurePulse.showOutput", () =>
      outputChannel?.show(),
    ),
  );

  await start();
}

export async function deactivate(): Promise<void> {
  await stop();
}

function readConfig(): ServerConfig {
  const config = vscode.workspace.getConfiguration("clojurePulse");
  return {
    path: config.get<string>("server.path", "clj-pulse"),
    args: config.get<string[]>("server.args", []),
  };
}

async function start(): Promise<void> {
  const resolution = resolveServerPath(readConfig());

  if (isError(resolution)) {
    outputChannel?.appendLine(`[clojure-pulse] ${resolution.error}`);
    reportMissingServer(resolution.error);
    return;
  }

  outputChannel?.appendLine(`[clojure-pulse] starting server: ${resolution.command}`);
  const newClient = createClient(resolution, outputChannel!);
  client = newClient;

  // Do not await: a failed spawn should surface as an error, not block (or
  // fail) extension activation. Drop the reference on failure so a later
  // restart spawns a fresh client instead of stopping a dead one.
  newClient.start().catch((err: unknown) => {
    outputChannel?.appendLine(`[clojure-pulse] failed to start server: ${String(err)}`);
    if (client === newClient) {
      client = undefined;
    }
  });
}

async function stop(): Promise<void> {
  const current = client;
  client = undefined;
  if (!current) {
    return;
  }
  try {
    await current.stop();
  } catch (err: unknown) {
    // A client that never reached "running" throws on stop(); swallow it so a
    // restart can always proceed to start a fresh client.
    outputChannel?.appendLine(`[clojure-pulse] error stopping server: ${String(err)}`);
  }
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

/** Surfaces a not-found error without blocking activation on the dialog. */
function reportMissingServer(message: string): void {
  void vscode.window
    .showWarningMessage(`Clojure Pulse: ${message}`, "Install clj-pulse")
    .then((choice) => {
      if (choice === "Install clj-pulse") {
        void vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
      }
    });
}
