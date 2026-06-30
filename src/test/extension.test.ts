import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";

suite("extension activation", () => {
  suiteSetup(async () => {
    // Point at a binary that cannot exist so activation exercises the resilient
    // "server not found" path instead of trying to spawn a real server.
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update(
        "server.path",
        "clj-pulse-does-not-exist-xyzzy",
        vscode.ConfigurationTarget.Global,
      );
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", undefined, vscode.ConfigurationTarget.Global);
  });

  test("activates without throwing when the server binary is missing", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("registers its commands", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext?.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("clojurePulse.restart"),
      "clojurePulse.restart should be registered",
    );
    assert.ok(
      commands.includes("clojurePulse.showOutput"),
      "clojurePulse.showOutput should be registered",
    );
  });

  test("restart recovers after a failed server start", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext?.activate();

    // An explicit (separator-bearing) bad path bypasses PATH resolution, so the
    // client actually attempts — and fails — to spawn a server.
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update(
        "server.path",
        path.join(path.sep, "nonexistent", "clj-pulse"),
        vscode.ConfigurationTarget.Global,
      );

    // First restart spins up a client whose start() rejects asynchronously.
    await vscode.commands.executeCommand("clojurePulse.restart");
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Second restart must not throw while stopping the failed client.
    await vscode.commands.executeCommand("clojurePulse.restart");
  });
});
