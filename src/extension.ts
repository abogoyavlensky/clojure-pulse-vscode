import * as vscode from "vscode";
import { LanguageClient, State } from "vscode-languageclient/node";
import { createClient } from "./client";
import { isError, resolveServerPath, ServerConfig } from "./serverPath";
import { createStatusBar, ServerStatus, StatusBar } from "./statusBar";
import { createJarContentProvider } from "./jarContentProvider";
import { ExternalLibrariesProvider } from "./externalLibraries";
import {
  createIgnoredFormDecorator,
  IgnoredFormDecorator,
} from "./ignoredForms";
import { indentColumnAt } from "./indent";
import { planShift } from "./maintainIndent";
import {
  ConnectCancelledError,
  EvalOptions,
  ReplConnectionInfo,
} from "./repl/connectionManager";
import {
  defaultCreateCommand,
  parseReplConfigurations,
  readNreplPort,
  ReplConfig,
} from "./repl/replConfig";
import { ReplRegistry } from "./repl/replRegistry";
import { ReplSession, ReplSessionLike } from "./repl/replSession";
import { ReplTreeNode, ReplTreeProvider } from "./repl/replTree";
import { createReplStatusBar, ReplStatusState } from "./repl/replStatusBar";
import { InlineResultsManager } from "./repl/inlineResults";
import { formAtCursor, nsBefore } from "./repl/forms";

const INSTALL_URL = "https://github.com/abogoyavlensky/clj-pulse#installation";

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let statusBar: StatusBar | undefined;
let stateListener: vscode.Disposable | undefined;
let librariesChangedListener: vscode.Disposable | undefined;
let externalLibraries: ExternalLibrariesProvider | undefined;
let decorator: IgnoredFormDecorator | undefined;
let dimRefreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Kept out of `context.subscriptions` so deactivate() can *await* shutdown:
 *  disposables are fire-and-forget, and killing REPL processes is not. */
let replRegistry: ReplRegistry | undefined;

/** What activate() returns; consumed by integration tests. */
export interface ExtensionApi {
  repls: ReplRegistry;
  inlineResults: InlineResultsManager;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<ExtensionApi> {
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

  // External Libraries panel. The request closure resolves the current client
  // per call (same seam as the jar content provider) so it survives restarts;
  // with no client the tree simply shows its empty/welcome state.
  externalLibraries = new ExternalLibrariesProvider(
    (method, param) =>
      client
        ? client.sendRequest(method, param)
        : Promise.reject(new Error("clj-pulse language server is not running")),
    undefined,
    (message) => outputChannel?.appendLine(`[clojure-pulse] ${message}`),
  );
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "clojurePulse.externalLibraries",
      externalLibraries,
    ),
    vscode.commands.registerCommand("clojurePulse.refreshExternalLibraries", () =>
      externalLibraries?.refresh(),
    ),
  );

  setupIgnoredFormDimming(context);
  setupMaintainIndentation(context);
  const repl = setupRepl(context);

  await start();
  return repl;
}

export async function deactivate(): Promise<void> {
  if (dimRefreshTimer) {
    clearTimeout(dimRefreshTimer);
    dimRefreshTimer = undefined;
  }
  decorator?.dispose();
  decorator = undefined;
  // Awaited: nREPL servers we spawned get their SIGTERM grace (and, on
  // Windows, their taskkill) before the host tears the extension down.
  const repls = replRegistry;
  replRegistry = undefined;
  await repls?.dispose();
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

  // Refresh the panel whenever the server (re)indexes libraries. Registered per
  // client (handlers do not carry across restarts) and before start() so the
  // startup indexing notification can't race ahead of the handler.
  librariesChangedListener = newClient.onNotification(
    "clojurePulse/librariesChanged",
    () => externalLibraries?.refresh(),
  );

  // Do not await: a failed spawn should surface as an error, not block (or
  // fail) extension activation. Drop the reference on failure so a later
  // restart spawns a fresh client instead of stopping a dead one.
  newClient
    .start()
    // First paint after start() resolves: by then the client has sent its
    // initial `didOpen`s, so the server's live cache holds already-open files
    // (querying on the `Running` state can race ahead of that sync). Also load
    // the library list now, in case indexing already finished before the
    // notification handler was live.
    .then(() => {
      refreshAllVisible();
      externalLibraries?.refresh();
    })
    .catch((err: unknown) => {
      outputChannel?.appendLine(`[clojure-pulse] failed to start server: ${String(err)}`);
      if (client === newClient) {
        stateListener?.dispose();
        stateListener = undefined;
        librariesChangedListener?.dispose();
        librariesChangedListener = undefined;
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
  librariesChangedListener?.dispose();
  librariesChangedListener = undefined;
  const current = client;
  client = undefined;
  // Drop the previous client's libraries so the panel doesn't show stale rows
  // while the next client (if any) starts up.
  externalLibraries?.refresh();
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

/**
 * Wires the REPL manager: the registry of configured REPLs, the sidebar view,
 * the status bar item, and every REPL command. Fully independent of the
 * clj-pulse language server.
 */
function setupRepl(context: vscode.ExtensionContext): ExtensionApi {
  const inlineResults = new InlineResultsManager();
  const registry = new ReplRegistry({
    // A channel per REPL, with the `clojure` language id: syntax highlighting,
    // search, and cursor navigation over the transcript come for free.
    createChannel: (name) =>
      vscode.window.createOutputChannel(`REPL: ${name}`, "clojure"),
    createSession: (config, channelFor) =>
      new ReplSession(config, {
        workspaceRoot: workspaceRoot(),
        createChannel: channelFor,
      }),
  });
  replRegistry = registry;

  const tree = new ReplTreeProvider(registry);
  const replStatus = createReplStatusBar();
  const paint = (): void => replStatus.update(statusState(registry));
  registry.onDidChange(paint);
  paint();
  applyReplConfigs(registry);
  // Inline results are not cleared on disconnect: a mid-eval socket drop then
  // resolves its pending decoration to the failure (via runEval's catch)
  // instead of silently vanishing, and past results stay readable until the
  // form is edited or "Clear Inline Results" runs.

  context.subscriptions.push(
    replStatus,
    inlineResults,
    vscode.window.registerTreeDataProvider("clojurePulse.replManager", tree),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("clojurePulse.replConfigurations")) {
        applyReplConfigs(registry);
      }
    }),
    vscode.commands.registerCommand("clojurePulse.startRepl", (arg?: unknown) =>
      startRepl(registry, arg),
    ),
    vscode.commands.registerCommand("clojurePulse.stopRepl", (arg?: unknown) =>
      stopRepl(registry, arg),
    ),
    vscode.commands.registerCommand("clojurePulse.connectRepl", (arg?: unknown) =>
      connectRepl(registry, arg),
    ),
    vscode.commands.registerCommand("clojurePulse.disconnectRepl", async () => {
      const active = registry.active;
      if (!active) {
        vscode.window.showInformationMessage("No REPL is connected.");
        return;
      }
      await stopSession(active);
    }),
    vscode.commands.registerCommand("clojurePulse.addReplConfig", () =>
      addReplConfig(),
    ),
    vscode.commands.registerCommand("clojurePulse.editReplConfig", () =>
      vscode.commands.executeCommand("workbench.action.openWorkspaceSettingsFile"),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.deleteReplConfig",
      (arg?: unknown) => deleteReplConfig(registry, arg),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.setActiveRepl",
      (arg?: unknown) => setActiveRepl(registry, arg),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.showReplOutput",
      (arg?: unknown) => showReplOutput(registry, arg),
    ),
    vscode.commands.registerCommand("clojurePulse.evalSelection", () =>
      evalSelection(registry, inlineResults),
    ),
    vscode.commands.registerCommand("clojurePulse.evalCurrentForm", () =>
      evalCurrentForm(registry, inlineResults),
    ),
    vscode.commands.registerCommand("clojurePulse.evalFile", () =>
      evalFile(registry),
    ),
    vscode.commands.registerCommand("clojurePulse.clearInlineResults", () =>
      inlineResults.clearAll(),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.copyEvalResult",
      (id?: string) => copyEvalResult(inlineResults, id),
    ),
    vscode.commands.registerCommand("clojurePulse.replMenu", () =>
      replMenu(registry),
    ),
  );
  return { repls: registry, inlineResults };
}

/** First workspace folder, which relative `cwd` and port files resolve against. */
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Reads `clojurePulse.replConfigurations` into the registry, logging (rather
 *  than throwing on) entries that do not validate. */
function applyReplConfigs(registry: ReplRegistry): void {
  const raw = vscode.workspace
    .getConfiguration("clojurePulse")
    .get<unknown>("replConfigurations");
  const { configs, warnings } = parseReplConfigurations(raw);
  for (const warning of warnings) {
    outputChannel?.appendLine(`[clojure-pulse] ${warning}`);
  }
  void registry.setConfigs(configs);
}

function statusState(registry: ReplRegistry): ReplStatusState {
  const active = registry.active;
  return {
    active: active ? { name: active.name, info: active.connectionInfo } : undefined,
    busy: registry.sessions.some(
      (session) => session.state === "starting" || session.state === "connecting",
    ),
    total: registry.sessions.length,
  };
}

/**
 * The one way commands learn which REPL they act on: a name from a keybinding
 * (`"args": "dev"`), a node from a tree menu, or nothing from the palette —
 * in which case the caller falls back to a quick pick.
 */
function resolveSessionName(arg: unknown): string | undefined {
  if (typeof arg === "string" && arg.trim().length > 0) {
    return arg.trim();
  }
  const node = arg as ReplTreeNode | undefined;
  return typeof node?.name === "string" ? node.name : undefined;
}

/** Quick-picks one of the sessions matching `predicate`. */
async function pickSession(
  registry: ReplRegistry,
  predicate: (session: ReplSessionLike) => boolean,
  placeHolder: string,
  emptyMessage: string,
): Promise<string | undefined> {
  const matches = registry.sessions.filter(predicate);
  if (matches.length === 0) {
    vscode.window.showInformationMessage(emptyMessage);
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0].name;
  }
  const choice = await vscode.window.showQuickPick(
    matches.map((session) => ({
      label: session.name,
      description: describeSession(session),
    })),
    { placeHolder },
  );
  return choice?.label;
}

function describeSession(session: ReplSessionLike): string {
  const info = session.connectionInfo;
  return info ? `${session.state} · ${info.host}:${info.port}` : session.state;
}

/** Resolves the session a command should act on, or reports why it cannot. */
async function sessionFor(
  registry: ReplRegistry,
  arg: unknown,
  pick: () => Promise<string | undefined>,
): Promise<ReplSessionLike | undefined> {
  const name = resolveSessionName(arg) ?? (await pick());
  if (name === undefined) {
    return undefined;
  }
  const session = registry.get(name);
  if (!session) {
    void vscode.window.showErrorMessage(
      `Clojure Pulse: no REPL named "${name}" — check clojurePulse.replConfigurations.`,
    );
    return undefined;
  }
  return session;
}

async function startRepl(registry: ReplRegistry, arg?: unknown): Promise<void> {
  const session = await sessionFor(registry, arg, () =>
    pickSession(
      registry,
      (candidate) => candidate.state === "stopped",
      "Start a REPL",
      "Every configured REPL is already running.",
    ),
  );
  if (!session) {
    return;
  }
  await runSessionStart(session);
}

/** Starts a session, reporting failures once, in the notification area. */
async function runSessionStart(session: ReplSessionLike): Promise<void> {
  try {
    await session.start();
  } catch (err: unknown) {
    if (err instanceof ConnectCancelledError) {
      return; // the user stopped it mid-attempt; nothing to report
    }
    const reason = err instanceof Error ? err.message : String(err);
    void vscode.window
      .showErrorMessage(
        `Clojure Pulse: "${session.name}" could not start — ${reason}`,
        "Show Output",
      )
      .then((choice) => (choice === "Show Output" ? session.showOutput() : undefined));
  }
}

async function stopRepl(registry: ReplRegistry, arg?: unknown): Promise<void> {
  const session = await sessionFor(registry, arg, () =>
    pickSession(
      registry,
      (candidate) => candidate.state !== "stopped",
      "Stop a REPL",
      "No REPL is running.",
    ),
  );
  if (session) {
    await stopSession(session);
  }
}

async function stopSession(session: ReplSessionLike): Promise<void> {
  try {
    await session.stop();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `Clojure Pulse: "${session.name}" could not be stopped — ${reason}`,
    );
  }
}

/**
 * Connects a configured REPL. Without an argument, offers the `connect`
 * configurations plus the ad-hoc host/port flow, which needs no settings at
 * all — the way in when nothing is configured yet.
 */
async function connectRepl(registry: ReplRegistry, arg?: unknown): Promise<void> {
  const name = resolveSessionName(arg);
  if (name !== undefined) {
    const session = registry.get(name);
    if (!session) {
      void vscode.window.showErrorMessage(
        `Clojure Pulse: no REPL named "${name}" — check clojurePulse.replConfigurations.`,
      );
      return;
    }
    await runSessionStart(session);
    return;
  }

  const AD_HOC = "$(plug) Connect to host:port…";
  const candidates = registry.sessions.filter(
    (session) => session.config.type === "connect" && session.state === "stopped",
  );
  const choice = await vscode.window.showQuickPick(
    [
      ...candidates.map((session) => ({
        label: session.name,
        description: describeSession(session),
      })),
      { label: AD_HOC, description: "without saving a configuration" },
    ],
    { placeHolder: "Connect to an nREPL server" },
  );
  if (!choice) {
    return;
  }
  if (choice.label !== AD_HOC) {
    const session = registry.get(choice.label);
    if (session) {
      await runSessionStart(session);
    }
    return;
  }

  const info = await promptForAddress();
  if (info) {
    await runSessionStart(registry.addAdHoc(info));
  }
}

/** The unsaved host/port prompt, pre-filled from the project's `.nrepl-port`. */
async function promptForAddress(): Promise<ReplConnectionInfo | undefined> {
  const host = await vscode.window.showInputBox({
    prompt: "nREPL host",
    value: "localhost",
    ignoreFocusOut: true,
  });
  if (!host) {
    return undefined;
  }
  const root = workspaceRoot();
  const detectedPort = root ? readNreplPort(root) : undefined;
  const portText = await vscode.window.showInputBox({
    prompt: "nREPL port",
    value: detectedPort ? String(detectedPort) : undefined,
    ignoreFocusOut: true,
    validateInput: (value) =>
      /^\d+$/.test(value.trim()) &&
      Number.parseInt(value, 10) > 0 &&
      Number.parseInt(value, 10) <= 65535
        ? undefined
        : "Enter a port number between 1 and 65535",
  });
  if (!portText) {
    return undefined;
  }
  return { host: host.trim(), port: Number.parseInt(portText.trim(), 10) };
}

async function setActiveRepl(registry: ReplRegistry, arg?: unknown): Promise<void> {
  const session = await sessionFor(registry, arg, () =>
    pickSession(
      registry,
      (candidate) => candidate.state === "connected",
      "Evaluate in which REPL?",
      "No REPL is connected.",
    ),
  );
  if (!session) {
    return;
  }
  if (session.state !== "connected") {
    void vscode.window.showWarningMessage(
      `Clojure Pulse: "${session.name}" is not connected, so it cannot evaluate yet.`,
    );
    return;
  }
  registry.setActive(session.name);
}

async function showReplOutput(registry: ReplRegistry, arg?: unknown): Promise<void> {
  const session = await sessionFor(registry, arg, () =>
    pickSession(
      registry,
      () => true,
      "Show the output of which REPL?",
      "No REPLs are configured yet.",
    ),
  );
  session?.showOutput();
}

/** Adds a configuration to the workspace settings, prefilled per type. */
async function addReplConfig(): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showErrorMessage(
      "Clojure Pulse: open a folder before saving a REPL configuration.",
    );
    return;
  }
  const type = await vscode.window.showQuickPick(
    [
      {
        label: "Start a server",
        description: "run a command that starts nREPL, then connect",
        value: "create" as const,
      },
      {
        label: "Connect to a running server",
        description: "attach to an nREPL that is already up",
        value: "connect" as const,
      },
    ],
    { placeHolder: "What kind of REPL?" },
  );
  if (!type) {
    return;
  }

  const existing = currentReplConfigurations();
  const name = await vscode.window.showInputBox({
    prompt: "REPL name",
    value: type.value === "create" ? "dev" : "local",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return "Enter a name";
      }
      return existing.some((entry) => entry.name === trimmed)
        ? `"${trimmed}" is already configured`
        : undefined;
    },
  });
  if (!name) {
    return;
  }

  const entry =
    type.value === "create"
      ? await promptCreateEntry(name.trim())
      : await promptConnectEntry(name.trim());
  if (!entry) {
    return;
  }
  await vscode.workspace
    .getConfiguration("clojurePulse")
    .update("replConfigurations", [...existing, entry], vscode.ConfigurationTarget.Workspace);
}

async function promptCreateEntry(
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const command = await vscode.window.showInputBox({
    prompt: "Command that starts the nREPL server",
    value: defaultCreateCommand(),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? "Enter a command" : undefined),
  });
  return command ? { name, type: "create", command: command.trim() } : undefined;
}

async function promptConnectEntry(
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const host = await vscode.window.showInputBox({
    prompt: "nREPL host",
    value: "localhost",
    ignoreFocusOut: true,
  });
  if (!host) {
    return undefined;
  }
  const port = await vscode.window.showInputBox({
    prompt: "nREPL port, or a file holding one",
    value: ".nrepl-port",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? "Enter a port or a port file path" : undefined,
  });
  if (!port) {
    return undefined;
  }
  const trimmed = port.trim();
  return {
    name,
    type: "connect",
    host: host.trim(),
    port: /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : trimmed,
  };
}

async function deleteReplConfig(
  registry: ReplRegistry,
  arg?: unknown,
): Promise<void> {
  const session = await sessionFor(registry, arg, () =>
    pickSession(
      registry,
      (candidate) => !registry.isAdHoc(candidate.name),
      "Delete which REPL configuration?",
      "No REPLs are configured yet.",
    ),
  );
  if (!session || registry.isAdHoc(session.name)) {
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Delete the REPL configuration "${session.name}"?`,
    { modal: true },
    "Delete",
  );
  if (confirmed !== "Delete") {
    return;
  }
  const remaining = currentReplConfigurations().filter(
    (entry) => entry.name !== session.name,
  );
  await vscode.workspace
    .getConfiguration("clojurePulse")
    .update("replConfigurations", remaining, vscode.ConfigurationTarget.Workspace);
}

/** The configured entries as raw objects, so an edit preserves fields this
 *  version does not know about. */
function currentReplConfigurations(): Array<Record<string, unknown> & { name?: string }> {
  const raw = vscode.workspace
    .getConfiguration("clojurePulse")
    .get<unknown>("replConfigurations");
  return Array.isArray(raw)
    ? (raw.filter(
        (entry) => typeof entry === "object" && entry !== null,
      ) as Array<Record<string, unknown> & { name?: string }>)
    : [];
}

/** True when inline eval results are enabled in settings (default on). */
function inlineEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("clojurePulse")
    .get<boolean>("inlineEvalResults", true);
}

/** Guards eval commands on a live connection; warns with a Start action and
 *  returns undefined when nothing is connected. */
function activeSession(registry: ReplRegistry): ReplSessionLike | undefined {
  const active = registry.active;
  if (active) {
    return active;
  }
  void vscode.window
    .showWarningMessage("No REPL is connected.", "Start REPL")
    .then((choice) =>
      choice === "Start REPL" ? startRepl(registry) : undefined,
    );
  return undefined;
}

async function evalSelection(
  registry: ReplRegistry,
  inlineResults: InlineResultsManager,
): Promise<void> {
  const session = activeSession(registry);
  if (!session) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const code = editor?.document.getText(editor.selection);
  if (!editor || !code || code.trim().length === 0) {
    vscode.window.showWarningMessage("Select an expression to evaluate.");
    return;
  }
  session.showOutput();
  await runEval(session, inlineResults, {
    editor,
    range: editor.selection,
    code,
    opts: sourceParams(editor, editor.selection.start),
  });
}

async function evalCurrentForm(
  registry: ReplRegistry,
  inlineResults: InlineResultsManager,
): Promise<void> {
  const session = activeSession(registry);
  if (!session) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // A non-empty selection wins; otherwise resolve the form at the cursor.
  let range: vscode.Range;
  if (!editor.selection.isEmpty) {
    range = editor.selection;
  } else {
    const text = editor.document.getText();
    const found = formAtCursor(text, editor.document.offsetAt(editor.selection.active));
    if (!found) {
      void vscode.window.setStatusBarMessage(
        "Clojure Pulse: no form found at cursor",
        3000,
      );
      return;
    }
    range = new vscode.Range(
      editor.document.positionAt(found.start),
      editor.document.positionAt(found.end),
    );
  }

  const code = editor.document.getText(range);
  const nsName = nsBefore(editor.document.getText(), editor.document.offsetAt(range.start));
  // Inline results make the value visible in place; reveal the REPL's output
  // channel only when they are off.
  if (!inlineEnabled()) {
    session.showOutput();
  }
  await runEval(session, inlineResults, {
    editor,
    range,
    code,
    opts: { ...sourceParams(editor, range.start), ns: nsName },
  });
}

async function evalFile(registry: ReplRegistry): Promise<void> {
  const session = activeSession(registry);
  if (!session) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  session.showOutput();
  const doc = editor.document;
  const onDisk = doc.uri.scheme === "file";
  try {
    await session.loadFile(doc.getText(), {
      filePath: onDisk ? doc.uri.fsPath : undefined,
      fileName: onDisk ? basename(doc.uri.fsPath) : undefined,
    });
  } catch (err: unknown) {
    reportEvalError(err);
  }
}

/** Source-location params for a position, for stack traces. `file` is sent
 *  only for on-disk documents; line/column are 1-based. */
function sourceParams(
  editor: vscode.TextEditor,
  position: vscode.Position,
): EvalOptions {
  const uri = editor.document.uri;
  return {
    file: uri.scheme === "file" ? uri.fsPath : undefined,
    line: position.line + 1,
    column: position.character + 1,
  };
}

interface EvalRequest {
  editor: vscode.TextEditor;
  range: vscode.Range;
  code: string;
  opts: EvalOptions;
}

/** Runs one evaluation: marks the range pending (when inline results are on),
 *  streams to the session's channel, and resolves the inline decoration. */
async function runEval(
  session: ReplSessionLike,
  inlineResults: InlineResultsManager,
  req: EvalRequest,
): Promise<void> {
  const id = inlineEnabled()
    ? inlineResults.markPending(req.editor, req.range)
    : undefined;
  try {
    const outcome = await session.eval(req.code, req.opts);
    if (id) {
      inlineResults.resolve(id, outcome);
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    if (id) {
      inlineResults.fail(id, reason);
    }
    reportEvalError(err);
  }
}

function reportEvalError(err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(
    `Clojure Pulse: evaluation failed — ${reason}`,
  );
}

/** Copies a result's full value: the given id (from the hover link), else the
 *  result under the cursor, else the most recent one. */
async function copyEvalResult(
  inlineResults: InlineResultsManager,
  id?: string,
): Promise<void> {
  let text = id ? inlineResults.fullTextOf(id) : undefined;
  if (text === undefined) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      text = inlineResults.resultAt(
        editor.document.uri.toString(),
        editor.selection.active.line,
      );
    }
  }
  if (text === undefined) {
    text = inlineResults.latest();
  }
  if (text === undefined) {
    void vscode.window.setStatusBarMessage(
      "Clojure Pulse: no evaluation result to copy",
      3000,
    );
    return;
  }
  await vscode.env.clipboard.writeText(text);
  void vscode.window.setStatusBarMessage("Clojure Pulse: result copied", 2000);
}

/** Basename of a filesystem path (portable — no node:path import needed). */
function basename(fsPath: string): string {
  const parts = fsPath.split(/[\\/]/);
  return parts[parts.length - 1] || fsPath;
}

async function replMenu(registry: ReplRegistry): Promise<void> {
  const active = registry.active;
  const connected = registry.sessions.filter(
    (session) => session.state === "connected",
  );
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(output) Show REPL output", action: "show" },
      ...(connected.length > 1
        ? [{ label: "$(target) Switch active REPL", action: "switch" }]
        : []),
      { label: "$(add) Add REPL configuration", action: "add" },
      ...(active
        ? [{ label: "$(debug-disconnect) Disconnect", action: "disconnect" }]
        : []),
    ],
    { placeHolder: active ? `nREPL actions — active: ${active.name}` : "nREPL actions" },
  );
  switch (choice?.action) {
    case "show":
      await showReplOutput(registry, active?.name);
      break;
    case "switch":
      await setActiveRepl(registry);
      break;
    case "add":
      await addReplConfig();
      break;
    case "disconnect":
      if (active) {
        await stopSession(active);
      }
      break;
  }
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

  // Single cursor: fold the relative-indentation shift (Enter right before a
  // multiline form carries its body along) into the same atomic edit — one
  // operation, one undo step. Leaving it to the async listener would put the
  // shift in a separate undo entry, since this edit's default trailing undo
  // stop blocks merging. The listener stays out of the way on its own: a
  // multi-part edit raises a multi-change event (it bails), and a shift-free
  // newline re-derives the same empty plan.
  let shiftEdits: { line: number; deltaCols: number }[] = [];
  if (
    edits.length === 1 &&
    vscode.workspace
      .getConfiguration("clojurePulse")
      .get<boolean>("maintainIndentation", true)
  ) {
    const edit = edits[0];
    const inserted = "\n" + " ".repeat(edit.indent);
    const postText =
      text.slice(0, doc.offsetAt(edit.range.start)) +
      inserted +
      text.slice(doc.offsetAt(edit.range.end));
    shiftEdits =
      planShift(postText, {
        range: {
          start: {
            line: edit.range.start.line,
            character: edit.range.start.character,
          },
          end: { line: edit.range.end.line, character: edit.range.end.character },
        },
        text: inserted,
      }) ?? [];
  }

  const applied = await editor.edit((builder) => {
    for (const edit of edits) {
      builder.replace(edit.range, "\n" + " ".repeat(edit.indent));
    }
    // Shift lines come back in post-edit coordinates; the newline edit adds
    // one line (minus any lines a multi-line selection removed) above them.
    const lineDelta = 1 - (edits[0].range.end.line - edits[0].range.start.line);
    for (const shift of shiftEdits) {
      const preLine = shift.line - lineDelta;
      if (shift.deltaCols > 0) {
        builder.insert(new vscode.Position(preLine, 0), " ".repeat(shift.deltaCols));
      } else {
        builder.delete(new vscode.Range(preLine, 0, preLine, -shift.deltaCols));
      }
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
