import * as assert from "assert";
import * as vscode from "vscode";
import { ConnectionManager } from "../repl/connectionManager";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

interface ExtensionApi {
  replManager: ConnectionManager;
}

suite("REPL commands", () => {
  let api: ExtensionApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    api = (await ext.activate()) as ExtensionApi;
    assert.ok(api?.replManager, "activate() should expose replManager");
  });

  teardown(async () => {
    await api.replManager.disconnect();
  });

  test("registers the REPL commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "clojurePulse.connectRepl",
      "clojurePulse.disconnectRepl",
      "clojurePulse.evalSelection",
      "clojurePulse.replMenu",
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test("evalSelection without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.evalSelection");
  });

  test("the REPL view resolves in the panel", async () => {
    await vscode.commands.executeCommand("clojurePulse.replView.focus");
  });

  test("connect + evalSelection round-trips through a running nREPL", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await api.replManager.connect({ host: "127.0.0.1", port: server.port });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(+ 20 22)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 0, doc.lineAt(0).text.length);

      await vscode.commands.executeCommand("clojurePulse.evalSelection");

      const entries = api.replManager.transcript.entries();
      const inEntry = entries.find((e) => e.kind === "in");
      const valueEntry = entries.find((e) => e.kind === "value");
      assert.strictEqual(inEntry?.text, "(+ 20 22)");
      assert.strictEqual(valueEntry?.text, "42");
    } finally {
      await server?.close();
    }
  });
});
