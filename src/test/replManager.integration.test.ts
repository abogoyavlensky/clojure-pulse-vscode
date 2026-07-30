import * as assert from "assert";
import * as vscode from "vscode";
import { InlineResultsManager } from "../repl/inlineResults";
import { defaultCreateCommand } from "../repl/replConfig";
import { ReplFormPanel } from "../repl/replFormPanel";
import { ReplRegistry } from "../repl/replRegistry";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";
/** The spawn test drives a POSIX shell command; skip it on Windows. */
const POSIX = process.platform !== "win32";

interface ExtensionApi {
  repls: ReplRegistry;
  inlineResults: InlineResultsManager;
  replForm: ReplFormPanel;
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(condition(), `timed out waiting for ${what}`);
}

/** Writes the REPL configurations and waits for the registry to catch up. */
async function setConfigurations(
  api: ExtensionApi,
  entries: unknown[],
): Promise<void> {
  await vscode.workspace
    .getConfiguration("clojurePulse")
    .update(
      "replConfigurations",
      entries.length > 0 ? entries : undefined,
      // The test host has no workspace folder, so the workspace target the
      // add-config command uses is unavailable here.
      vscode.ConfigurationTarget.Global,
    );
  const names = entries
    .map((entry) => (entry as { name?: string }).name)
    .filter((name): name is string => typeof name === "string");
  await waitUntil(
    () => names.every((name) => api.repls.get(name) !== undefined),
    5000,
    `sessions ${names.join(", ")} to appear`,
  );
}

async function selectAndEval(code: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: "clojure",
    content: code,
  });
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(0, 0, 0, doc.lineAt(0).text.length);
  await vscode.commands.executeCommand("clojurePulse.evalSelection");
}

const evals = (server: FakeNrepl) => server.received.filter((m) => m.op === "eval");

suite("REPL manager with several sessions", () => {
  let api: ExtensionApi;
  let a: FakeNrepl;
  let b: FakeNrepl;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    api = (await ext.activate()) as ExtensionApi;
  });

  setup(async () => {
    a = await startFakeNrepl();
    b = await startFakeNrepl();
  });

  teardown(async () => {
    for (const session of api.repls.sessions) {
      await session.stop();
    }
    // So one test's form tab cannot leak into the next.
    api.replForm.close();
    await setConfigurations(api, []);
    api.inlineResults.clearAll();
    await a.close();
    await b.close();
  });

  test("two configured REPLs run at once and evals follow the active one", async () => {
    await setConfigurations(api, [
      { name: "a", type: "connect", host: "127.0.0.1", port: a.port },
      { name: "b", type: "connect", host: "127.0.0.1", port: b.port },
    ]);

    await vscode.commands.executeCommand("clojurePulse.startRepl", "a");
    await vscode.commands.executeCommand("clojurePulse.startRepl", "b");

    assert.strictEqual(api.repls.get("a")?.state, "connected");
    assert.strictEqual(api.repls.get("b")?.state, "connected");
    assert.strictEqual(api.repls.active?.name, "b", "the last one connected is active");

    await selectAndEval("(+ 1 2)");
    assert.strictEqual(evals(b).length, 1, "the active REPL should have evaluated");
    assert.strictEqual(evals(a).length, 0, "the inactive REPL should be untouched");

    await vscode.commands.executeCommand("clojurePulse.setActiveRepl", "a");
    assert.strictEqual(api.repls.active?.name, "a");

    await selectAndEval("(+ 3 4)");
    assert.strictEqual(evals(a).length, 1, "the newly active REPL should evaluate");
    assert.strictEqual(evals(b).length, 1, "the previous one should not evaluate again");
  });

  test("each REPL keeps its own transcript", async () => {
    await setConfigurations(api, [
      { name: "a", type: "connect", host: "127.0.0.1", port: a.port },
      { name: "b", type: "connect", host: "127.0.0.1", port: b.port },
    ]);
    await vscode.commands.executeCommand("clojurePulse.startRepl", "a");
    await vscode.commands.executeCommand("clojurePulse.startRepl", "b");

    await selectAndEval("(+ 1 2)"); // goes to b, the active one

    const inEntries = (name: string) =>
      api.repls
        .get(name)!
        .transcript.entries()
        .filter((entry) => entry.kind === "in");
    assert.deepStrictEqual(
      inEntries("b").map((entry) => entry.text),
      ["(+ 1 2)"],
    );
    assert.deepStrictEqual(inEntries("a"), []);
  });

  test("stopping the active REPL clears the eval target and eval only warns", async () => {
    await setConfigurations(api, [
      { name: "a", type: "connect", host: "127.0.0.1", port: a.port },
      { name: "b", type: "connect", host: "127.0.0.1", port: b.port },
    ]);
    await vscode.commands.executeCommand("clojurePulse.startRepl", "b");
    await vscode.commands.executeCommand("clojurePulse.startRepl", "a");
    assert.strictEqual(api.repls.active?.name, "a");

    await vscode.commands.executeCommand("clojurePulse.stopRepl", "a");

    // `b` is still connected, but evaluations must not silently move there:
    // the target is chosen deliberately, never inherited.
    assert.strictEqual(api.repls.get("b")?.state, "connected");
    assert.strictEqual(api.repls.active, undefined);
    assert.strictEqual(api.repls.get("a")?.state, "stopped");
    // No target: this must warn, not throw, and reach neither server.
    await selectAndEval("(+ 1 2)");
    assert.strictEqual(evals(a).length, 0);
    assert.strictEqual(evals(b).length, 0);
  });

  test("a configuration edit while stopped applies to the next start", async () => {
    await setConfigurations(api, [
      { name: "a", type: "connect", host: "127.0.0.1", port: a.port },
    ]);
    await setConfigurations(api, [
      { name: "a", type: "connect", host: "127.0.0.1", port: b.port },
    ]);
    await waitUntil(
      () => {
        const config = api.repls.get("a")?.config;
        return config?.type === "connect" && config.port === b.port;
      },
      5000,
      "the edited configuration to apply",
    );

    await vscode.commands.executeCommand("clojurePulse.startRepl", "a");

    assert.strictEqual(api.repls.get("a")?.connectionInfo?.port, b.port);
  });

  test("starting an unknown REPL reports an error instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.startRepl", "no-such-repl");
    await vscode.commands.executeCommand("clojurePulse.stopRepl", "no-such-repl");
    await vscode.commands.executeCommand("clojurePulse.showReplOutput", "no-such-repl");
  });

  test("the add command opens an empty form with the project's command", async () => {
    await vscode.commands.executeCommand("clojurePulse.addReplConfig");

    const state = api.replForm.state;
    assert.deepStrictEqual(state?.mode, { kind: "add" });
    assert.strictEqual(state?.values.name, "");
    // The test host opens no folder, so detection falls back to deps.edn.
    assert.strictEqual(state?.values.command, defaultCreateCommand({ kind: "deps" }));
  });

  test("the edit command opens the form on that configuration", async () => {
    await setConfigurations(api, [
      { name: "a", type: "connect", host: "127.0.0.1", port: a.port },
      { name: "b", type: "create", command: "echo hi" },
    ]);

    await vscode.commands.executeCommand("clojurePulse.editReplConfig", "a");
    assert.deepStrictEqual(api.replForm.state?.mode, { kind: "edit", name: "a" });
    assert.strictEqual(api.replForm.state?.values.type, "connect");
    assert.strictEqual(api.replForm.state?.values.port, String(a.port));

    // The newest request wins: one tab, the other REPL's values.
    await vscode.commands.executeCommand("clojurePulse.editReplConfig", "b");
    assert.deepStrictEqual(api.replForm.state?.mode, { kind: "edit", name: "b" });
    assert.strictEqual(api.replForm.state?.values.command, "echo hi");
  });

  test("saving the form adds a REPL and cancelling adds nothing", async () => {
    await vscode.commands.executeCommand("clojurePulse.addReplConfig");
    const values = api.replForm.state!.values;
    // The same entry point the webview's Save button reaches — a real webview
    // cannot be scripted from a test.
    await api.replForm.submit({
      ...values,
      name: "saved",
      type: "connect",
      host: "127.0.0.1",
      port: String(a.port),
    });

    assert.strictEqual(api.replForm.state, undefined, "saving closes the form");
    await waitUntil(
      () => api.repls.get("saved") !== undefined,
      5000,
      "the saved REPL to reach the tree",
    );

    await vscode.commands.executeCommand("clojurePulse.addReplConfig");
    api.replForm.cancel();
    assert.strictEqual(api.replForm.state, undefined, "cancelling closes the form");
    assert.deepStrictEqual(
      api.repls.sessions.map((session) => session.name),
      ["saved"],
      "cancelling wrote nothing",
    );
  });

  // Deleting is not covered end to end here: both routes to it confirm with a
  // modal, and the test host refuses to show one ("DialogService: refused to
  // show dialog in tests"). What the confirmation guards is covered either
  // side of it — `removeEntry` in replConfigEdit.test.ts, and the settings
  // target in the save test above, which shares `writeReplConfigurations`.

  test("a create configuration spawns a server, connects, and is killed on stop", async function () {
    if (!POSIX) {
      this.skip();
    }
    this.timeout(20000);
    await setConfigurations(api, [
      {
        name: "spawned",
        type: "create",
        // Stands in for a real nREPL: announces the port of a server that is
        // already listening, then stays alive until it is killed.
        command: `echo "nREPL server started on port ${a.port}" && sleep 30`,
      },
    ]);

    await vscode.commands.executeCommand("clojurePulse.startRepl", "spawned");

    const session = api.repls.get("spawned");
    assert.strictEqual(session?.state, "connected");
    assert.strictEqual(session?.connectionInfo?.port, a.port);
    assert.strictEqual(api.repls.active?.name, "spawned");

    await selectAndEval("(+ 1 2)");
    assert.strictEqual(evals(a).length, 1);

    await vscode.commands.executeCommand("clojurePulse.stopRepl", "spawned");

    assert.strictEqual(session?.state, "stopped");
    assert.ok(
      session?.transcript
        .entries()
        .some((entry) => /process terminated|process exited/i.test(entry.text)),
      "expected the spawned process to be reported as terminated",
    );
  });
});
