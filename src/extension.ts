import * as fs from "fs";
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
  EvalOutcome,
} from "./repl/connectionManager";
import {
  createCommandHint,
  defaultCreateCommand,
  detectProjectKind,
  parseReplConfigurations,
} from "./repl/replConfig";
import { removeEntry } from "./repl/replConfigEdit";
import { ReplFormPanel } from "./repl/replFormPanel";
import {
  CustomReplCommand,
  parseCustomReplCommands,
  presentCustomCommand,
  removeCommandEntry,
} from "./repl/customCommands";
import { CustomCommandFormPanel } from "./repl/customCommandFormPanel";
import {
  CustomCommandsTreeProvider,
  CustomCommandTreeNode,
} from "./repl/customCommandsTree";
import {
  CommandStatusBar,
  createCommandStatusBar,
} from "./repl/commandStatusBar";
import { createStatusSlot } from "./repl/statusSlot";
import { ReplRegistry } from "./repl/replRegistry";
import { ReplSession, ReplSessionLike } from "./repl/replSession";
import { ReplTreeNode, ReplTreeProvider } from "./repl/replTree";
import { createReplStatusBar, ReplStatusState } from "./repl/replStatusBar";
import { InlineResultsManager } from "./repl/inlineResults";
import {
  buildStatusHover,
  testStatusOf,
  TestRunStatus,
  TestStatusManager,
} from "./repl/testStatus";
import {
  createTestStatusBar,
  testRunCounts,
  TestStatusBar,
} from "./repl/testStatusBar";
import {
  formAtCursor,
  nsBefore,
  testAtCursor,
  TestAtCursor,
  testsInText,
} from "./repl/forms";

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
  replForm: ReplFormPanel;
  testStatus: TestStatusManager;
  testStatusBar: TestStatusBar;
  commandStatusBar: CommandStatusBar;
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
  const testStatus = new TestStatusManager({
    passIcon: vscode.Uri.joinPath(context.extensionUri, "images", "test-pass.svg"),
    failIcon: vscode.Uri.joinPath(context.extensionUri, "images", "test-fail.svg"),
  });
  // One verdict slot for test runs and custom commands alike: whichever ran
  // last owns the display. The REPL connection item (99) stays separate.
  const runSlot = createStatusSlot({ name: "Clojure Pulse Run", priority: 98 });
  const testStatusBar = createTestStatusBar(runSlot);
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

  // The one way REPLs are configured: an editor tab, for both adding and
  // editing. Everything it touches is injected, so the panel itself stays a
  // dumb renderer over the pure rules in replConfigEdit.ts.
  const replForm = new ReplFormPanel({
    createPanel: () => {
      const panel = vscode.window.createWebviewPanel(
        "clojurePulse.replForm",
        "Add REPL",
        vscode.ViewColumn.Active,
        // Worth a little memory: an in-progress edit survives tabbing away.
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "images",
        "repl-icon.svg",
      );
      return panel;
    },
    readEntries: rawReplConfigurations,
    writeEntries: writeReplConfigurations,
    defaultCommand: () => {
      const kind = detectProjectKind(rootFileNames());
      return { command: defaultCreateCommand({ kind }), hint: createCommandHint(kind) };
    },
    confirmDelete: (name) => confirmDeleteConfig(name),
  });

  // The custom commands pane and form, siblings of the REPL manager's: the
  // same editor-tab form pattern over the pure rules in customCommands.ts.
  const commandForm = new CustomCommandFormPanel({
    createPanel: () => {
      const panel = vscode.window.createWebviewPanel(
        "clojurePulse.customCommandForm",
        "Add REPL Command",
        vscode.ViewColumn.Active,
        // Worth a little memory: an in-progress edit survives tabbing away.
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "images",
        "repl-icon.svg",
      );
      return panel;
    },
    readEntries: rawCustomReplCommands,
    writeEntries: writeCustomReplCommands,
    confirmDelete: (name) => confirmDeleteCustomCommand(name),
  });
  const commandsTree = new CustomCommandsTreeProvider({
    readCommands: customReplCommands,
  });
  const commandBar = createCommandStatusBar(runSlot);
  logCustomCommandWarnings();

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
    testStatus,
    testStatusBar,
    // So a form left open closes with the extension.
    replForm,
    commandForm,
    commandBar,
    vscode.window.registerTreeDataProvider("clojurePulse.replManager", tree),
    vscode.window.registerTreeDataProvider(
      "clojurePulse.customCommands",
      commandsTree,
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("clojurePulse.replConfigurations")) {
        applyReplConfigs(registry);
      }
      if (event.affectsConfiguration("clojurePulse.customReplCommands")) {
        logCustomCommandWarnings();
        commandsTree.refresh();
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
      replForm.open({ kind: "add" }),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.editReplConfig",
      (arg?: unknown) => editReplConfig(registry, replForm, arg),
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
    vscode.commands.registerCommand("clojurePulse.runTestAtCursor", () =>
      runTestAtCursor(registry, inlineResults, testStatus, testStatusBar),
    ),
    vscode.commands.registerCommand("clojurePulse.runNsTests", () =>
      runNsTests(registry, testStatus, testStatusBar),
    ),
    vscode.commands.registerCommand("clojurePulse.rerunLastTest", () =>
      rerunLastTest(registry, inlineResults, testStatus, testStatusBar),
    ),
    vscode.commands.registerCommand("clojurePulse.clearInlineResults", () =>
      inlineResults.clearAll(),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.copyEvalResult",
      (id?: string) => copyEvalResult(inlineResults, id),
    ),
    vscode.commands.registerCommand("clojurePulse.replMenu", () =>
      replMenu(registry, replForm),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.runCustomReplCommand",
      (arg?: unknown) => runCustomReplCommand(registry, commandBar, arg),
    ),
    vscode.commands.registerCommand("clojurePulse.addCustomReplCommand", () =>
      commandForm.open({ kind: "add" }),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.editCustomReplCommand",
      (arg?: unknown) => editCustomReplCommand(commandForm, arg),
    ),
    vscode.commands.registerCommand(
      "clojurePulse.deleteCustomReplCommand",
      (arg?: unknown) => deleteCustomReplCommand(arg),
    ),
  );
  return {
    repls: registry,
    inlineResults,
    replForm,
    testStatus,
    testStatusBar,
    commandStatusBar: commandBar,
  };
}

/** The workspace root's file names, which the prefilled command follows. */
function rootFileNames(): string[] {
  const root = workspaceRoot();
  if (!root) {
    return [];
  }
  try {
    return fs.readdirSync(root);
  } catch {
    return [];
  }
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
  const session = await sessionFor(registry, arg, async () => {
    // Nothing configured at all: this command has exactly one useful
    // continuation, so it takes it. Only reachable when no name was given —
    // a keybinding with `"args": "dev"` still gets the not-found error.
    if (registry.sessions.length === 0) {
      await vscode.commands.executeCommand("clojurePulse.addReplConfig");
      return undefined;
    }
    return pickSession(
      registry,
      (candidate) => candidate.state === "stopped",
      "Start a REPL",
      "Every configured REPL is already running.",
    );
  });
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

/** A connect quick-pick row: a REPL, or the offer to configure one. */
interface ConnectPick extends vscode.QuickPickItem {
  session?: ReplSessionLike;
}

/**
 * Connects a configured REPL. Without an argument, offers the `connect`
 * configurations that are not already up — and, when there are none, the form
 * that would make one, rather than a dead end.
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

  const candidates = registry.sessions.filter(
    (session) => session.config.type === "connect" && session.state === "stopped",
  );
  // The session travels on the item rather than being looked up by label: a
  // REPL may legitimately be named anything, the offer to add one included.
  const items: ConnectPick[] =
    candidates.length > 0
      ? candidates.map((session) => ({
          label: session.name,
          description: describeSession(session),
          session,
        }))
      : [
          {
            label: "$(add) Add a REPL configuration…",
            description: "nothing is configured to connect to yet",
          },
        ];
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: "Connect to an nREPL server",
  });
  if (!choice) {
    return;
  }
  if (!choice.session) {
    await vscode.commands.executeCommand("clojurePulse.addReplConfig");
    return;
  }
  await runSessionStart(choice.session);
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

/** Opens the form on an existing configuration, resolved like every other
 *  REPL command: a tree row, a keybinding's name, or a quick pick. */
async function editReplConfig(
  registry: ReplRegistry,
  form: ReplFormPanel,
  arg?: unknown,
): Promise<void> {
  const session = await sessionFor(registry, arg, () =>
    pickSession(
      registry,
      () => true,
      "Edit which REPL configuration?",
      "No REPLs are configured yet.",
    ),
  );
  if (session) {
    form.open({ kind: "edit", name: session.name });
  }
}

async function deleteReplConfig(
  registry: ReplRegistry,
  arg?: unknown,
): Promise<void> {
  const session = await sessionFor(registry, arg, () =>
    pickSession(
      registry,
      () => true,
      "Delete which REPL configuration?",
      "No REPLs are configured yet.",
    ),
  );
  if (!session) {
    return;
  }
  if (!(await confirmDeleteConfig(session.name))) {
    return;
  }
  await writeReplConfigurations(
    removeEntry(rawReplConfigurations(), session.name),
  );
}

/** The one confirmation both delete routes — the row's and the form's — show. */
async function confirmDeleteConfig(name: string): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    `Delete the REPL configuration "${name}"?`,
    { modal: true },
    "Delete",
  );
  return confirmed === "Delete";
}

/**
 * The configured entries exactly as settings hold them. Not
 * `parseReplConfigurations`, and not filtered: an entry this version cannot
 * read — a stray scalar, a `create` with no command — is one the parser only
 * warns about, and writing back through a filtered copy would delete it.
 */
function rawReplConfigurations(): unknown[] {
  const raw = vscode.workspace
    .getConfiguration("clojurePulse")
    .get<unknown>("replConfigurations");
  return Array.isArray(raw) ? raw : [];
}

/**
 * Saves the configurations. Workspace settings when a folder is open, so they
 * travel with the project; user settings otherwise, which is what keeps the
 * form usable in a single-file window.
 */
async function writeReplConfigurations(entries: unknown[]): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace
    .getConfiguration("clojurePulse")
    .update("replConfigurations", entries, target);
}

/** The parsed custom commands — what the pane, picks, and runs act on. */
function customReplCommands(): CustomReplCommand[] {
  return parseCustomReplCommands(
    vscode.workspace.getConfiguration("clojurePulse").get<unknown>("customReplCommands"),
  ).commands;
}

/** Logged on activation and on each settings change — not on every read,
 *  which repaints would turn into channel spam. */
function logCustomCommandWarnings(): void {
  const { warnings } = parseCustomReplCommands(
    vscode.workspace.getConfiguration("clojurePulse").get<unknown>("customReplCommands"),
  );
  for (const warning of warnings) {
    outputChannel?.appendLine(`[clojure-pulse] ${warning}`);
  }
}

/**
 * The configured entries exactly as settings hold them — unfiltered, so an
 * entry the parser only warns about survives a form edit untouched.
 */
function rawCustomReplCommands(): unknown[] {
  const raw = vscode.workspace
    .getConfiguration("clojurePulse")
    .get<unknown>("customReplCommands");
  return Array.isArray(raw) ? raw : [];
}

/** Saves the commands: workspace settings when a folder is open, so they
 *  travel with the project; user settings otherwise. */
async function writeCustomReplCommands(entries: unknown[]): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace
    .getConfiguration("clojurePulse")
    .update("customReplCommands", entries, target);
}

/** The command a run/edit/delete refers to: a keybinding's name string, a
 *  tree node, or nothing — the caller then falls back to a quick pick. */
function resolveCommandName(arg: unknown): string | undefined {
  if (typeof arg === "string" && arg.trim().length > 0) {
    return arg.trim();
  }
  const node = arg as CustomCommandTreeNode | undefined;
  return typeof node?.name === "string" ? node.name : undefined;
}

/** Quick-picks a configured command; `onEmpty` decides what no commands at
 *  all offers — the add form for run, a plain notice for edit and delete. */
async function pickCustomCommand(
  placeHolder: string,
  onEmpty: "add-form" | "message",
): Promise<string | undefined> {
  const commands = customReplCommands();
  if (commands.length === 0) {
    if (onEmpty === "add-form") {
      await vscode.commands.executeCommand("clojurePulse.addCustomReplCommand");
    } else {
      vscode.window.showInformationMessage(
        "No custom REPL commands configured yet.",
      );
    }
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(
    commands.map((command) => ({
      label: command.name,
      description: presentCustomCommand(command).description,
    })),
    { placeHolder },
  );
  return choice?.label;
}

/** Resolves the command an action should act on, or reports why it cannot. */
async function customCommandFor(
  arg: unknown,
  pick: () => Promise<string | undefined>,
): Promise<CustomReplCommand | undefined> {
  const name = resolveCommandName(arg) ?? (await pick());
  if (name === undefined) {
    return undefined;
  }
  const command = customReplCommands().find((candidate) => candidate.name === name);
  if (!command) {
    void vscode.window.showErrorMessage(
      `Clojure Pulse: no custom REPL command named "${name}" — check clojurePulse.customReplCommands.`,
    );
    return undefined;
  }
  return command;
}

/**
 * Runs a custom command against the active REPL. Silent by design: no output
 * panel reveal, no notifications — the status bar spinner-then-verdict is the
 * feedback, and the transcript records everything for the click-through.
 */
async function runCustomReplCommand(
  registry: ReplRegistry,
  bar: CommandStatusBar,
  arg?: unknown,
): Promise<void> {
  const command = await customCommandFor(arg, () =>
    pickCustomCommand("Run which REPL command?", "add-form"),
  );
  if (!command) {
    return;
  }
  // Before running(): with nothing connected the warning prompt is the
  // feedback, and the status bar must not flash a spinner for a non-run.
  const session = activeSession(registry);
  if (!session) {
    return;
  }
  const token = bar.running(command.name);
  try {
    const outcome = await session.eval(command.code);
    bar.finish(token, {
      phase: "done",
      name: command.name,
      status: outcome.err === undefined ? "ok" : "err",
      value: outcome.value,
    });
  } catch {
    // A thrown eval (connection dropped mid-run) is a failure like any other.
    bar.finish(token, { phase: "done", name: command.name, status: "err" });
  }
}

async function editCustomReplCommand(
  form: CustomCommandFormPanel,
  arg?: unknown,
): Promise<void> {
  const command = await customCommandFor(arg, () =>
    pickCustomCommand("Edit which REPL command?", "message"),
  );
  if (command) {
    form.open({ kind: "edit", name: command.name });
  }
}

async function deleteCustomReplCommand(arg?: unknown): Promise<void> {
  const command = await customCommandFor(arg, () =>
    pickCustomCommand("Delete which REPL command?", "message"),
  );
  if (!command) {
    return;
  }
  if (!(await confirmDeleteCustomCommand(command.name))) {
    return;
  }
  await writeCustomReplCommands(
    removeCommandEntry(rawCustomReplCommands(), command.name),
  );
}

/** The one confirmation both delete routes — the row's and the form's — show. */
async function confirmDeleteCustomCommand(name: string): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    `Delete the custom REPL command "${name}"?`,
    { modal: true },
    "Delete",
  );
  return confirmed === "Delete";
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
  // With nothing configured to start, the useful offer is the connect flow,
  // which can reach a running server without any settings at all.
  const startable = registry.sessions.some((session) => session.state === "stopped");
  const action = startable ? "Start REPL" : "Connect";
  void vscode.window
    .showWarningMessage("No REPL is connected.", action)
    .then((choice) => {
      if (choice === "Start REPL") {
        return startRepl(registry);
      }
      return choice === "Connect" ? connectRepl(registry) : undefined;
    });
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

/**
 * Runs the top-level `deftest` at (or right after) the cursor. The cursor is
 * the only editor-bound part; the run itself is `runSingleTest`, shared with
 * the rerun command.
 */
async function runTestAtCursor(
  registry: ReplRegistry,
  inlineResults: InlineResultsManager,
  testStatus: TestStatusManager,
  statusBar: TestStatusBar,
): Promise<void> {
  const session = activeSession(registry);
  if (!session) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const text = editor.document.getText();
  const found = testAtCursor(text, editor.document.offsetAt(editor.selection.active));
  if (!found) {
    void vscode.window.setStatusBarMessage(
      "Clojure Pulse: no deftest found at cursor",
      3000,
    );
    return;
  }
  await runSingleTest(session, editor.document, found, inlineResults, testStatus, statusBar);
}

/**
 * What the last test command meant, semantically — enough to re-resolve it
 * against the document's current content. A single test is identified by
 * namespace + name (a buffer can hold several ns forms with same-named
 * tests), never by offset, so edits to the test file are survived. Written by
 * the document-centric cores right after they locate something to run, so a
 * command that found nothing never clobbers a valid record; a rerun re-writes
 * the same values, which keeps repeated reruns stable.
 */
type LastTestCommand =
  | { kind: "single"; uri: vscode.Uri; ns: string | undefined; testName: string }
  | { kind: "ns"; uri: vscode.Uri };

/** In-memory and per-window, like Cursive's re-run action: a restart clears it. */
let lastTestCommand: LastTestCommand | undefined;

/** The first visible editor showing `doc`, if any. Inline decorations need an
 *  editor to paint on, and a rerun's document may not be open in any pane. */
function visibleEditorFor(doc: vscode.TextDocument): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((editor) => editor.document === doc);
}

/**
 * Runs one `deftest` of a document: re-evaluates the form in its namespace so
 * the buffer's current version is what runs, then executes it via
 * clojure.test. Two evals share one inline decoration — pending through both,
 * resolved with the runner's summary map — painted only when some visible
 * editor shows the document. The detailed report streams to the REPL's output
 * channel without stealing focus; the gutter mark's hover and the status bar
 * carry the verdict.
 */
async function runSingleTest(
  session: ReplSessionLike,
  doc: vscode.TextDocument,
  found: TestAtCursor,
  inlineResults: InlineResultsManager,
  testStatus: TestStatusManager,
  statusBar: TestStatusBar,
): Promise<void> {
  const text = doc.getText();
  const range = new vscode.Range(
    doc.positionAt(found.range.start),
    doc.positionAt(found.range.end),
  );
  const nsName = nsBefore(text, found.range.start);
  lastTestCommand = { kind: "single", uri: doc.uri, ns: nsName, testName: found.name };
  if (!inlineEnabled()) {
    session.showOutput();
  }
  const editor = visibleEditorFor(doc);
  const id =
    inlineEnabled() && editor ? inlineResults.markPending(editor, range) : undefined;
  // This command supersedes the previous test report: wipe the gutter and
  // track the deftest about to run. Paths below that abandon the run simply
  // never resolve the pending mark — but must clear the status bar's
  // spinner, which otherwise persists.
  testStatus.beginRun();
  const runId = testStatus.track(doc, range);
  const barToken = statusBar.running(found.name);
  try {
    if (nsName !== undefined) {
      // The namespace-not-found status is JVM-only — let-go's nREPL neither
      // sends it nor honors the eval `ns` param. A find-ns probe detects an
      // unloaded namespace on both runtimes; loading the buffer is what the
      // old error hint told the user to do by hand.
      // Qualified, so a session ns that shadows or excludes core names
      // cannot break the probe.
      const probe = await session.eval(
        `(clojure.core/some? (clojure.core/find-ns '${nsName}))`,
      );
      if (probe.err !== undefined) {
        // An unreadable probe means nothing below can be trusted to target
        // the right namespace; surface it instead of guessing.
        if (id) {
          inlineResults.resolve(id, probe);
        }
        statusBar.clear(barToken);
        return;
      }
      if (probe.value === "false") {
        const onDisk = doc.uri.scheme === "file";
        const loaded = await session.loadFile(doc.getText(), {
          filePath: onDisk ? doc.uri.fsPath : undefined,
          fileName: onDisk ? basename(doc.uri.fsPath) : undefined,
        });
        if (loaded.err !== undefined) {
          // The file itself does not compile; that error wins.
          if (id) {
            inlineResults.resolve(id, loaded);
          }
          statusBar.clear(barToken);
          return;
        }
      }
      // On let-go the current namespace is process-global and this switch is
      // the only ns targeting there is. The ns param matters on the JVM: it
      // scopes the eval to the (now known to exist) namespace so the
      // session's own *ns* binding is left untouched.
      const switched = await session.eval(`(in-ns '${nsName})`, { ns: nsName });
      if (switched.err !== undefined || switched.namespaceNotFound) {
        if (id) {
          inlineResults.resolve(id, switched);
        }
        statusBar.clear(barToken);
        return;
      }
    }
    const defined = await session.eval(doc.getText(range), {
      ...docSourceParams(doc, range.start),
      ns: nsName,
    });
    if (defined.err !== undefined || defined.namespaceNotFound) {
      // A test that failed to compile (or a namespace the server still
      // rejects) must not run; the decoration shows why.
      if (id) {
        inlineResults.resolve(id, defined);
      }
      statusBar.clear(barToken);
      return;
    }
    const result = await runTestVar(session, testStatus, runId, found.name, nsName);
    if (id) {
      inlineResults.resolve(id, result.outcome);
    }
    statusBar.finish(barToken, {
      phase: "done",
      name: found.name,
      status: result.status,
      fail: result.fail,
      error: result.error,
    });
  } catch (err: unknown) {
    if (id) {
      inlineResults.fail(id, err instanceof Error ? err.message : String(err));
    }
    statusBar.clear(barToken);
    reportEvalError(err);
  }
}

/** One test var's run: its verdict, the counts a caller sums, and the raw
 *  outcome for the single-test command's inline decoration. */
interface TestVarResult {
  status: TestRunStatus;
  fail: number;
  error: number;
  outcome: EvalOutcome;
}

/**
 * Runs one already-defined test var and resolves its gutter mark. Shared by
 * both test commands: the single-test one wraps it in probe/define, the
 * namespace one calls it per deftest in buffer order.
 *
 * `run-test-var` (Clojure 1.11+) prints the report and returns the summary
 * map. The fallback serves let-go, whose compiler resolves both branches
 * eagerly — so it may only reference vars that exist there too:
 * `*report-counters*` is a set!-able map on let-go with the same keys as
 * clojure.test's summary, and its test vars hold plain functions. A test that
 * throws becomes `:error 1` (let-go accepts the JVM catch syntax). On a
 * pre-1.11 JVM (unsupported) the fallback's set! throws a clear error.
 */
async function runTestVar(
  session: ReplSessionLike,
  testStatus: TestStatusManager,
  markId: string,
  name: string,
  nsName: string | undefined,
): Promise<TestVarResult> {
  const runner =
    `(let [v #'${name}] ` +
    `(if-let [f (resolve 'clojure.test/run-test-var)] (f v) ` +
    `(do (set! clojure.test/*report-counters* {:test 1 :pass 0 :fail 0 :error 0}) ` +
    `(try ((deref v)) (catch Exception e ` +
    `(set! clojure.test/*report-counters* (update clojure.test/*report-counters* :error inc)) ` +
    `(println "ERROR in test:" e))) ` +
    `clojure.test/*report-counters*)))`;
  const outcome = await session.eval(runner, { ns: nsName });
  const status = testStatusOf(outcome);
  testStatus.report(markId, status, buildStatusHover(status, outcome));
  const counts = testRunCounts(outcome.value);
  return { status, fail: counts?.fail ?? 0, error: counts?.error ?? 0, outcome };
}

/**
 * Runs every top-level `deftest` in the buffer, in order. The buffer is
 * loaded first — "run all tests" means "test this buffer" — which refreshes
 * helpers and every deftest and guarantees the enumerated vars exist; then
 * each test runs through the same single-var runner, so the gutter fills in
 * progressively and the behavior is identical on the JVM and let-go. A test
 * that reports an error still only fails its own mark: the run continues, as
 * a test runner should. Note that `:once` fixtures therefore run once per
 * test, not once per namespace.
 *
 * Bulk runs paint no inline decorations, so an error that aborts the run
 * (a load failure, an in-ns failure) surfaces as a notification instead.
 */
async function runNsTests(
  registry: ReplRegistry,
  testStatus: TestStatusManager,
  statusBar: TestStatusBar,
): Promise<void> {
  const session = activeSession(registry);
  if (!session) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  await runTestsInDocument(session, editor.document, testStatus, statusBar);
}

/** The document-centric body of Run Tests in Namespace, shared with the
 *  rerun command: the active editor chooses the document above; here only
 *  the document matters. */
async function runTestsInDocument(
  session: ReplSessionLike,
  doc: vscode.TextDocument,
  testStatus: TestStatusManager,
  statusBar: TestStatusBar,
): Promise<void> {
  const text = doc.getText();
  const tests = testsInText(text);
  if (tests.length === 0) {
    void vscode.window.setStatusBarMessage(
      "Clojure Pulse: no deftests in this file",
      3000,
    );
    return;
  }
  lastTestCommand = { kind: "ns", uri: doc.uri };

  // This command supersedes the previous report: wipe the gutter, then track
  // every deftest up front so each verdict lands on the right form as it
  // arrives. Paths below that abandon the run leave their marks pending —
  // invisible, and gone with the next test command.
  testStatus.beginRun();
  const markIds = tests.map((found) =>
    testStatus.track(
      doc,
      new vscode.Range(
        doc.positionAt(found.range.start),
        doc.positionAt(found.range.end),
      ),
    ),
  );
  // A buffer with several ns forms runs all of its tests, labeled with the
  // first one's namespace.
  const runName = nsBefore(text, tests[0].range.start) ?? "tests";
  const barToken = statusBar.running(runName);
  if (!inlineEnabled()) {
    session.showOutput();
  }

  try {
    const onDisk = doc.uri.scheme === "file";
    const loaded = await session.loadFile(text, {
      filePath: onDisk ? doc.uri.fsPath : undefined,
      fileName: onDisk ? basename(doc.uri.fsPath) : undefined,
    });
    if (loaded.err !== undefined) {
      // The file does not compile: nothing below it can be trusted to run.
      reportRunError(loaded.err);
      statusBar.clear(barToken);
      return;
    }

    let currentNs: string | undefined;
    let fail = 0;
    let error = 0;
    let anyFailed = false;
    for (const [index, found] of tests.entries()) {
      // No ns form before the test: the load defined it in the session's
      // current namespace, so send the runner unqualified.
      const testNs = nsBefore(text, found.range.start);
      if (testNs !== undefined && testNs !== currentNs) {
        // On let-go the current namespace is process-global and this switch
        // is the only ns targeting there is; the ns param scopes the eval on
        // the JVM, leaving the session's own *ns* binding untouched.
        const switched = await session.eval(`(in-ns '${testNs})`, { ns: testNs });
        if (switched.err !== undefined || switched.namespaceNotFound) {
          reportRunError(switched.err ?? `namespace ${testNs} was not found`);
          statusBar.clear(barToken);
          return;
        }
        currentNs = testNs;
      }
      const result = await runTestVar(
        session,
        testStatus,
        markIds[index],
        found.name,
        testNs,
      );
      fail += result.fail;
      error += result.error;
      anyFailed = anyFailed || result.status === "fail";
    }
    statusBar.finish(barToken, {
      phase: "done",
      name: runName,
      status: anyFailed ? "fail" : "pass",
      fail,
      error,
    });
  } catch (err: unknown) {
    statusBar.clear(barToken);
    reportEvalError(err);
  }
}

/**
 * Re-runs whatever test command ran last — Cursive's "re-run last test
 * action". The record is re-resolved against the document's *current*
 * content, so a moved or edited deftest is found again by namespace + name
 * and an ns run picks up new tests. The document is opened without showing
 * it, so focus stays wherever the user is working; when the test file is not
 * visible the status bar and REPL output carry the verdict.
 */
async function rerunLastTest(
  registry: ReplRegistry,
  inlineResults: InlineResultsManager,
  testStatus: TestStatusManager,
  statusBar: TestStatusBar,
): Promise<void> {
  const last = lastTestCommand;
  if (!last) {
    void vscode.window.setStatusBarMessage(
      "Clojure Pulse: no test command has been run yet",
      3000,
    );
    return;
  }
  const session = activeSession(registry);
  if (!session) {
    return;
  }
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(last.uri);
  } catch {
    reportRunError(`cannot open ${last.uri.fsPath} to re-run its tests`);
    return;
  }
  if (last.kind === "ns") {
    await runTestsInDocument(session, doc, testStatus, statusBar);
    return;
  }
  const text = doc.getText();
  const found = testsInText(text).find(
    (test) =>
      test.name === last.testName && nsBefore(text, test.range.start) === last.ns,
  );
  if (!found) {
    void vscode.window.setStatusBarMessage(
      `Clojure Pulse: deftest ${last.testName} no longer found in ${basename(doc.uri.fsPath)}`,
      3000,
    );
    return;
  }
  await runSingleTest(session, doc, found, inlineResults, testStatus, statusBar);
}

/** Surfaces an error that aborts a bulk test run, which has no inline
 *  decoration to carry it. First line only — the full report is in the
 *  REPL's output channel. */
function reportRunError(message: string): void {
  const firstLine =
    message.split("\n").find((line) => line.trim().length > 0)?.trim() ?? message;
  void vscode.window.showErrorMessage(`Clojure Pulse: ${firstLine}`);
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
  return docSourceParams(editor.document, position);
}

function docSourceParams(
  doc: vscode.TextDocument,
  position: vscode.Position,
): EvalOptions {
  return {
    file: doc.uri.scheme === "file" ? doc.uri.fsPath : undefined,
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

async function replMenu(registry: ReplRegistry, form: ReplFormPanel): Promise<void> {
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
      form.open({ kind: "add" });
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
