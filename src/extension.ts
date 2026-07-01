import * as vscode from "vscode";
import { LanguageClient, State } from "vscode-languageclient/node";
import { createClient } from "./client";
import { isError, resolveServerPath, ServerConfig } from "./serverPath";
import { createStatusBar, ServerStatus, StatusBar } from "./statusBar";
import { createJarContentProvider } from "./jarContentProvider";
import {
  createIgnoredFormDecorator,
  IgnoredFormDecorator,
} from "./ignoredForms";
import { indentColumnAt } from "./indent";
import { planShift } from "./maintainIndent";

const INSTALL_URL = "https://github.com/abogoyavlensky/clj-pulse#installation";

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let statusBar: StatusBar | undefined;
let stateListener: vscode.Disposable | undefined;
let decorator: IgnoredFormDecorator | undefined;
let dimRefreshTimer: ReturnType<typeof setTimeout> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Clojure Pulse");
  statusBar = createStatusBar();

  context.subscriptions.push(
    outputChannel,
    statusBar,
    vscode.commands.registerCommand("clojurePulse.restart", restart),
    vscode.commands.registerCommand("clojurePulse.showOutput", () =>
      outputChannel?.show(),
    ),
    vscode.commands.registerCommand("clojurePulse.newline", insertStructuralNewline),
    // `jar:` documents (library / clojure.core sources) are served by the
    // running server; the closure resolves the current client per request so it
    // keeps working across restarts.
    vscode.workspace.registerTextDocumentContentProvider(
      "jar",
      createJarContentProvider((method, param) =>
        client
          ? client.sendRequest(method, param)
          : Promise.reject(new Error("clj-pulse language server is not running")),
      ),
    ),
  );

  setupIgnoredFormDimming(context);
  setupMaintainIndentation(context);

  await start();
}

export async function deactivate(): Promise<void> {
  if (dimRefreshTimer) {
    clearTimeout(dimRefreshTimer);
    dimRefreshTimer = undefined;
  }
  decorator?.dispose();
  decorator = undefined;
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
    statusBar?.update("error", { message: resolution.error });
    reportMissingServer(resolution.error);
    return;
  }

  outputChannel?.appendLine(`[clojure-pulse] starting server: ${resolution.command}`);
  statusBar?.update("starting");
  const newClient = createClient(resolution, outputChannel!);
  client = newClient;

  stateListener = newClient.onDidChangeState((event) => {
    statusBar?.update(toServerStatus(event.newState), {
      serverInfo: newClient.initializeResult?.serverInfo,
      command: resolution.command,
    });
  });

  // Do not await: a failed spawn should surface as an error, not block (or
  // fail) extension activation. Drop the reference on failure so a later
  // restart spawns a fresh client instead of stopping a dead one.
  newClient
    .start()
    // First paint after start() resolves: by then the client has sent its
    // initial `didOpen`s, so the server's live cache holds already-open files
    // (querying on the `Running` state can race ahead of that sync).
    .then(() => refreshAllVisible())
    .catch((err: unknown) => {
      outputChannel?.appendLine(`[clojure-pulse] failed to start server: ${String(err)}`);
      if (client === newClient) {
        stateListener?.dispose();
        stateListener = undefined;
        client = undefined;
        statusBar?.update("error", { message: "failed to start the language server" });
      }
    });
}

function toServerStatus(state: State): ServerStatus {
  switch (state) {
    case State.Running:
      return "running";
    case State.Starting:
      return "starting";
    default:
      return "stopped";
  }
}

async function stop(): Promise<void> {
  stateListener?.dispose();
  stateListener = undefined;
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

/**
 * Dims `#_` discard forms and `(comment …)` blocks (when enabled) by asking the
 * server for their ranges and laying an opacity decoration over them. The
 * `sendRanges` closure re-reads `client` per call so it survives restarts.
 */
function setupIgnoredFormDimming(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("clojurePulse");
  if (!config.get<boolean>("dimIgnoredForms", true)) {
    return;
  }

  const rawOpacity = config.get<number>("dimIgnoredFormsOpacity", 0.6);
  const opacity = Number.isFinite(rawOpacity)
    ? Math.min(1, Math.max(0.1, rawOpacity))
    : 0.6;

  decorator = createIgnoredFormDecorator(
    (uri) =>
      client
        ? client.sendRequest("clojurePulse/ignoredForms", { uri })
        : Promise.reject(new Error("clj-pulse language server is not running")),
    opacity,
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => refreshEditor(editor)),
    vscode.workspace.onDidOpenTextDocument((doc) => refreshDocument(doc)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isClojure(event.document)) {
        return;
      }
      // One coalesced pass over all visible editors — refreshing everything
      // avoids a single timer dropping a pending refresh for another document.
      if (dimRefreshTimer) {
        clearTimeout(dimRefreshTimer);
      }
      dimRefreshTimer = setTimeout(() => refreshAllVisible(), 250);
    }),
  );
}

function isClojure(doc: vscode.TextDocument): boolean {
  return doc.languageId === "clojure";
}

/**
 * Enter, owned by the extension for Clojure (bound in package.json): inserts
 * the newline *and* the structural indent as one atomic edit, so the cursor
 * never lands at a guessed column and hops — unlike onTypeFormatting, which
 * runs after the editor's own auto-indent. Inside a string the indent is
 * omitted (plain newline). Whitespace immediately after each cursor is eaten
 * (Sublimed's `skip_spaces`), so Enter before trailing spaces does not strand
 * them as bogus indentation on the new line.
 */
async function insertStructuralNewline(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const text = doc.getText();
  const edits = [...editor.selections]
    .sort((a, b) => a.start.compareTo(b.start))
    .map((sel) => {
      const lineText = doc.lineAt(sel.end.line).text;
      let wsEnd = sel.end.character;
      while (
        wsEnd < lineText.length &&
        (lineText[wsEnd] === " " || lineText[wsEnd] === "\t")
      ) {
        wsEnd++;
      }
      return {
        range: new vscode.Range(sel.start, new vscode.Position(sel.end.line, wsEnd)),
        indent: indentColumnAt(text, doc.offsetAt(sel.start)) ?? 0,
      };
    });
  const applied = await editor.edit((builder) => {
    for (const edit of edits) {
      builder.replace(edit.range, "\n" + " ".repeat(edit.indent));
    }
  });
  if (!applied) {
    return;
  }
  // replace() leaves each cursor at the range start; place them after the
  // inserted indent. Each edit adds one line and removes the lines its
  // (multi-line) selection spanned.
  let addedLines = 0;
  editor.selections = edits.map((edit) => {
    const line = edit.range.start.line + 1 + addedLines;
    addedLines += 1 - (edit.range.end.line - edit.range.start.line);
    return new vscode.Selection(line, edit.indent, line, edit.indent);
  });
  editor.revealRange(
    new vscode.Range(editor.selection.active, editor.selection.active),
  );
}

/** Set while this extension's own shift edit is in flight, so the change
 *  event it raises is not re-processed. */
let maintainIndentBusy = false;

/**
 * Maintains relative indentation (Cursive-style): when a single edit moves
 * code that later lines of the same form are anchored to, shifts those
 * lines' leading whitespace by the same delta. The shift merges into the
 * user's typing undo group, so one undo reverts keystroke and shift together
 * — which is also why Undo/Redo events themselves are skipped here.
 */
function setupMaintainIndentation(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => void maintainIndent(event)),
  );
}

async function maintainIndent(event: vscode.TextDocumentChangeEvent): Promise<void> {
  if (
    maintainIndentBusy ||
    !isClojure(event.document) ||
    event.reason !== undefined || // Undo/Redo already restore the shifts
    event.contentChanges.length !== 1 || // multi-cursor / bulk edits: bail
    !vscode.workspace
      .getConfiguration("clojurePulse")
      .get<boolean>("maintainIndentation", true)
  ) {
    return;
  }

  const change = event.contentChanges[0];
  const shifts = planShift(event.document.getText(), {
    range: {
      start: {
        line: change.range.start.line,
        character: change.range.start.character,
      },
      end: { line: change.range.end.line, character: change.range.end.character },
    },
    text: change.text,
  });
  if (!shifts || shifts.length === 0) {
    return;
  }
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document === event.document,
  );
  if (!editor) {
    return;
  }

  maintainIndentBusy = true;
  try {
    await editor.edit(
      (builder) => {
        for (const shift of shifts) {
          if (shift.deltaCols > 0) {
            builder.insert(
              new vscode.Position(shift.line, 0),
              " ".repeat(shift.deltaCols),
            );
          } else {
            builder.delete(
              new vscode.Range(shift.line, 0, shift.line, -shift.deltaCols),
            );
          }
        }
      },
      // Merge into the user's typing undo group: one undo reverts both.
      { undoStopBefore: false, undoStopAfter: false },
    );
  } finally {
    maintainIndentBusy = false;
  }
}

/** Refreshes the dim decoration for a single Clojure editor. */
function refreshEditor(editor: vscode.TextEditor | undefined): void {
  if (decorator && editor && isClojure(editor.document)) {
    void decorator.refresh(editor);
  }
}

/** Refreshes every visible editor showing `doc` — decorations are per-editor,
 *  so split views of the same document each need their own refresh. */
function refreshDocument(doc: vscode.TextDocument): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === doc) {
      refreshEditor(editor);
    }
  }
}

/** Refreshes all visible Clojure editors (first paint after the server starts). */
function refreshAllVisible(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    refreshEditor(editor);
  }
}
