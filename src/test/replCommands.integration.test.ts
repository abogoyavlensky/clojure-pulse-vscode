import * as assert from "assert";
import * as vscode from "vscode";
import { InlineResultsManager } from "../repl/inlineResults";
import { ReplRegistry } from "../repl/replRegistry";
import { ReplSessionLike } from "../repl/replSession";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

interface ExtensionApi {
  repls: ReplRegistry;
  inlineResults: InlineResultsManager;
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
    api.inlineResults.clearAll();
  });

  /** Connects an unsaved session to `server`, the way the ad-hoc flow does. */
  async function connect(server: FakeNrepl): Promise<ReplSessionLike> {
    const session = api.repls.addAdHoc({ host: "127.0.0.1", port: server.port });
    await session.start();
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

  test("an ad-hoc session disappears when it disconnects", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);
      assert.strictEqual(api.repls.active?.name, session.name);

      await vscode.commands.executeCommand("clojurePulse.disconnectRepl");

      assert.strictEqual(api.repls.active, undefined);
      assert.deepStrictEqual(api.repls.sessions, []);
    } finally {
      await server?.close();
    }
  });
});
