import * as assert from "assert";
import * as vscode from "vscode";
import { CommandStatusBar } from "../repl/commandStatusBar";
import { ReplRegistry } from "../repl/replRegistry";
import { ReplSessionLike } from "../repl/replSession";
import { TestStatusBar } from "../repl/testStatusBar";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";
/** The one configuration these tests connect through. */
const REPL_NAME = "commands";

interface ExtensionApi {
  repls: ReplRegistry;
  commandStatusBar: CommandStatusBar;
  testStatusBar: TestStatusBar;
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

suite("Custom REPL commands", () => {
  let api: ExtensionApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    api = (await ext.activate()) as ExtensionApi;
    assert.ok(api?.repls, "activate() should expose the REPL registry");
  });

  teardown(async () => {
    // The extension is a singleton across tests; drop every session and both
    // settings so one test's state never leaks into the next.
    for (const session of api.repls.sessions) {
      await session.stop();
    }
    await setReplConfigurations(undefined);
    await setCustomCommands(undefined);
    await waitUntil(
      () => api.repls.sessions.length === 0,
      5000,
      "the configured sessions to be dropped",
    );
  });

  async function setReplConfigurations(entries: unknown[] | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update(
        "replConfigurations",
        entries,
        // The test host opens no folder, so workspace settings are unavailable.
        vscode.ConfigurationTarget.Global,
      );
  }

  async function setCustomCommands(entries: unknown[] | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("customReplCommands", entries, vscode.ConfigurationTarget.Global);
  }

  /** Brings up the configured REPL that points at `server`. */
  async function connect(server: FakeNrepl): Promise<ReplSessionLike> {
    await setReplConfigurations([
      { name: REPL_NAME, type: "connect", host: "127.0.0.1", port: server.port },
    ]);
    await waitUntil(
      () => api.repls.get(REPL_NAME) !== undefined,
      5000,
      `the "${REPL_NAME}" session to appear`,
    );

    await vscode.commands.executeCommand("clojurePulse.startRepl", REPL_NAME);
    const session = api.repls.get(REPL_NAME);
    assert.ok(session, `expected a session named "${REPL_NAME}"`);
    assert.strictEqual(session.state, "connected");
    return session;
  }

  test("registers the custom command commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "clojurePulse.runCustomReplCommand",
      "clojurePulse.addCustomReplCommand",
      "clojurePulse.editCustomReplCommand",
      "clojurePulse.deleteCustomReplCommand",
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test("running by name sends the code verbatim, with no ns param", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      await setCustomCommands([{ name: "reset", code: "(user/reset)" }]);

      await vscode.commands.executeCommand("clojurePulse.runCustomReplCommand", "reset");

      const evalMsg = server.received.find((m) => m.op === "eval");
      assert.ok(evalMsg, "expected an eval op");
      assert.strictEqual(evalMsg.code, "(user/reset)");
      assert.strictEqual(evalMsg.ns, undefined, "runs carry no ns param");

      // The run's only immediate feedback: the status bar verdict.
      const bar = api.commandStatusBar.current();
      assert.strictEqual(bar?.text, "$(check) reset");
    } finally {
      await server?.close();
    }
  });

  test("a failing eval resolves the status bar to the failure state", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        reply({ session: msg.session, err: "boom" });
        reply({ session: msg.session, status: ["done"] });
      });
      await setCustomCommands([{ name: "reset", code: "(user/reset)" }]);

      await vscode.commands.executeCommand("clojurePulse.runCustomReplCommand", "reset");

      const bar = api.commandStatusBar.current();
      assert.strictEqual(bar?.text, "$(error) reset — failed");
    } finally {
      await server?.close();
    }
  });

  test("an unknown name sends nothing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      await setCustomCommands([{ name: "reset", code: "(user/reset)" }]);

      await vscode.commands.executeCommand(
        "clojurePulse.runCustomReplCommand",
        "missing",
      );

      assert.ok(
        !server.received.some((m) => m.op === "eval"),
        "an unknown command must not evaluate anything",
      );
    } finally {
      await server?.close();
    }
  });

  test("test and command verdicts share one status slot, last run wins", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      await setCustomCommands([{ name: "reset", code: "(user/reset)" }]);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);
      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      // The slot shows the test verdict first…
      assert.strictEqual(
        api.testStatusBar.current()?.text,
        "$(testing-passed-icon) my-test",
      );

      await vscode.commands.executeCommand("clojurePulse.runCustomReplCommand", "reset");

      // …and the newer command run replaces it: one slot, read by both bars.
      assert.strictEqual(api.commandStatusBar.current()?.text, "$(check) reset");
      assert.deepStrictEqual(
        api.testStatusBar.current(),
        api.commandStatusBar.current(),
      );
    } finally {
      await server?.close();
    }
  });

  test("a tree node argument runs its command", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      await setCustomCommands([{ name: "stop", code: "(user/stop)" }]);

      await vscode.commands.executeCommand("clojurePulse.runCustomReplCommand", {
        name: "stop",
      });

      const evalMsg = server.received.find((m) => m.op === "eval");
      assert.strictEqual(evalMsg?.code, "(user/stop)");
    } finally {
      await server?.close();
    }
  });
});
