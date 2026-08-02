import * as assert from "assert";
import * as vscode from "vscode";
import { InlineResultsManager } from "../repl/inlineResults";
import { ReplRegistry } from "../repl/replRegistry";
import { ReplSessionLike } from "../repl/replSession";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";
/** The one configuration these tests connect through. */
const REPL_NAME = "commands";

interface ExtensionApi {
  repls: ReplRegistry;
  inlineResults: InlineResultsManager;
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

suite("REPL commands", () => {
  let api: ExtensionApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    api = (await ext.activate()) as ExtensionApi;
    assert.ok(api?.repls, "activate() should expose the REPL registry");
  });

  teardown(async () => {
    // The extension is a singleton across tests; drop every session so one
    // test's connection and results do not leak into the next.
    for (const session of api.repls.sessions) {
      await session.stop();
    }
    await setConfigurations(undefined);
    await waitUntil(
      () => api.repls.sessions.length === 0,
      5000,
      "the configured sessions to be dropped",
    );
    api.inlineResults.clearAll();
  });

  async function setConfigurations(entries: unknown[] | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update(
        "replConfigurations",
        entries,
        // The test host opens no folder, so workspace settings are unavailable.
        vscode.ConfigurationTarget.Global,
      );
  }

  /** Brings up the configured REPL that points at `server`. */
  async function connect(server: FakeNrepl): Promise<ReplSessionLike> {
    await setConfigurations([
      { name: REPL_NAME, type: "connect", host: "127.0.0.1", port: server.port },
    ]);
    // Settings reach the registry through a configuration event.
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

  test("registers the REPL commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "clojurePulse.connectRepl",
      "clojurePulse.disconnectRepl",
      "clojurePulse.startRepl",
      "clojurePulse.stopRepl",
      "clojurePulse.addReplConfig",
      "clojurePulse.editReplConfig",
      "clojurePulse.deleteReplConfig",
      "clojurePulse.setActiveRepl",
      "clojurePulse.showReplOutput",
      "clojurePulse.evalSelection",
      "clojurePulse.replMenu",
      "clojurePulse.evalCurrentForm",
      "clojurePulse.evalFile",
      "clojurePulse.runTestAtCursor",
      "clojurePulse.clearInlineResults",
      "clojurePulse.copyEvalResult",
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test("evalSelection without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.evalSelection");
  });

  test("evalCurrentForm without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");
  });

  test("evalCurrentForm evaluates the form at the cursor in its namespace", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns scratch)\n(+ 1 2)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      // Cursor at the end of line 1, right after the closing paren.
      editor.selection = new vscode.Selection(1, 7, 1, 7);

      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");

      const entries = session.transcript.entries();
      assert.ok(
        entries.some((e) => e.kind === "in" && e.text === "(+ 1 2)"),
        "expected an in entry for the form",
      );
      assert.ok(entries.some((e) => e.kind === "value" && e.text === "42"));
      const evalMsg = server.received.find((m) => m.op === "eval");
      assert.strictEqual(evalMsg?.ns, "scratch");
      assert.strictEqual(api.inlineResults.latest(), "42");
    } finally {
      await server?.close();
    }
  });

  test("Escape clears inline results (hasResults toggles)", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns scratch)\n(+ 1 2)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(1, 7, 1, 7);

      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");
      assert.strictEqual(api.inlineResults.hasResults(), true);

      // The Escape keybinding is bound to this command; invoke it directly.
      await vscode.commands.executeCommand("clojurePulse.clearInlineResults");
      assert.strictEqual(api.inlineResults.hasResults(), false);
    } finally {
      await server?.close();
    }
  });

  test("evalCurrentForm with no form at the cursor sends nothing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "   ",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 0, 0);

      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");

      assert.ok(!server.received.some((m) => m.op === "eval"));
    } finally {
      await server?.close();
    }
  });

  test("evalFile sends the buffer through the load-file op", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns scratch)\n(+ 1 2)",
      });
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand("clojurePulse.evalFile");

      const loadMsg = server.received.find((m) => m.op === "load-file");
      assert.ok(loadMsg, "expected a load-file op");
      assert.ok(String(loadMsg.file).includes("(+ 1 2)"));
    } finally {
      await server?.close();
    }
  });

  test("showReplOutput reveals a session's channel without throwing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);
      await vscode.commands.executeCommand(
        "clojurePulse.showReplOutput",
        session.name,
      );
    } finally {
      await server?.close();
    }
  });

  test("connect + evalSelection round-trips through a running nREPL", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(+ 20 22)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 0, doc.lineAt(0).text.length);

      await vscode.commands.executeCommand("clojurePulse.evalSelection");

      const entries = session.transcript.entries();
      const inEntry = entries.find((e) => e.kind === "in");
      const valueEntry = entries.find((e) => e.kind === "value");
      assert.strictEqual(inEntry?.text, "(+ 20 22)");
      assert.strictEqual(valueEntry?.text, "42");
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");
  });

  test("runTestAtCursor redefines the deftest then runs it in its namespace", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      // Cursor inside the deftest body.
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const evals = server.received.filter((m) => m.op === "eval");
      assert.strictEqual(evals.length, 2, "expected define + run evals");
      assert.strictEqual(evals[0].code, "(deftest my-test\n  (is true))");
      assert.strictEqual(evals[0].ns, "my.app-test");
      assert.ok(String(evals[1].code).includes("run-test-var"));
      assert.ok(String(evals[1].code).includes("#'my-test"));
      // The fallback must reference only vars that exist on let-go too, whose
      // compiler resolves both branches eagerly.
      assert.ok(String(evals[1].code).includes("clojure.test/*report-counters*"));
      assert.ok(!String(evals[1].code).includes("*initial-report-counters*"));
      assert.strictEqual(evals[1].ns, "my.app-test");
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor outside a deftest sends nothing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(defn helper [] 1)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(1, 8, 1, 8);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      assert.ok(!server.received.some((m) => m.op === "eval"));
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor auto-loads the file when the namespace is missing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      // Evals fail with namespace-not-found until a load-file arrives, as a
      // real nREPL does for a namespace that was never loaded.
      let loaded = false;
      server.respond((msg, reply) => {
        if (msg.op === "eval" && !loaded) {
          reply({ session: msg.session, status: ["done", "namespace-not-found"] });
          return;
        }
        if (msg.op === "load-file") {
          loaded = true;
        }
        reply({ session: msg.session, value: "42" });
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const ops = server.received
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, ["eval", "load-file", "eval", "eval"]);
      const loadMsg = server.received.find((m) => m.op === "load-file");
      assert.ok(String(loadMsg?.file).includes("(deftest my-test"));
      const evals = server.received.filter((m) => m.op === "eval");
      assert.strictEqual(evals[1].code, "(deftest my-test\n  (is true))");
      assert.strictEqual(evals[1].ns, "my.app-test");
      assert.ok(String(evals[2].code).includes("run-test-var"));
      assert.strictEqual(evals[2].ns, "my.app-test");
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor stops when the auto-load itself fails", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "eval") {
          reply({ session: msg.session, status: ["done", "namespace-not-found"] });
          return;
        }
        if (msg.op === "load-file") {
          reply({ session: msg.session, err: "file does not compile" });
        }
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const ops = server.received
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, ["eval", "load-file"]);
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor does not run the test when defining it fails", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "eval") {
          reply({ session: msg.session, err: "boom" });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        reply({ status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const evals = server.received.filter((m) => m.op === "eval");
      assert.strictEqual(evals.length, 1, "the failed define must stop the run");
    } finally {
      await server?.close();
    }
  });

  test("disconnecting stops the REPL and clears the eval target", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);
      assert.strictEqual(api.repls.active?.name, session.name);

      await vscode.commands.executeCommand("clojurePulse.disconnectRepl");

      assert.strictEqual(api.repls.active, undefined);
      // The row stays: it is a configuration, and configurations do not come
      // and go with their connections.
      assert.strictEqual(api.repls.get(session.name)?.state, "stopped");
    } finally {
      await server?.close();
    }
  });
});
