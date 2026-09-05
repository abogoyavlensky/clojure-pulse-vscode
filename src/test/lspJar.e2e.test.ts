/**
 * End to end: language features inside a dependency's source. Needs a real
 * clj-pulse named by `CLJ_PULSE_E2E_BIN` (skipped when unset, so the regular
 * suite never depends on a server build) and the `jar-e2e` test configuration,
 * which opens `src/test/fixtures/jar-project` as a workspace folder. Run it
 * with:
 *
 *   CLJ_PULSE_E2E_BIN=/path/to/clj-pulse xvfb-run -a npx vscode-test -l jar-e2e
 *
 * The workspace folder is not incidental: clj-pulse indexes the folders the
 * client sends in `initialize` and resolves their classpath from there, so
 * with no folder open there is no classpath and no jar to navigate into.
 *
 * This is the only test that proves the feature: the unit test on
 * `CLOJURE_DOCUMENT_SELECTOR` stops the selector regressing but says nothing
 * about whether the server answers for a `jar:` document. Here we navigate
 * from the project's own file into a real jar, then ask for definition and
 * hover *inside* the jar document we landed in.
 */
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

const BIN = process.env.CLJ_PULSE_E2E_BIN;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `executeDefinitionProvider` answers with either shape; we only need the URI. */
function targetUris(
  result: (vscode.Location | vscode.LocationLink)[] | undefined,
): vscode.Uri[] {
  return (result ?? []).map((item) =>
    "targetUri" in item ? item.targetUri : item.uri,
  );
}

suite("Language features in a jar end to end", () => {
  let root: vscode.WorkspaceFolder | undefined;

  suiteSetup(async function () {
    root = vscode.workspace.workspaceFolders?.[0];
    if (!BIN || !root) {
      this.skip();
    }
    this.timeout(30000);
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", BIN, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension("abogoyavlensky.clojure-pulse");
    await extension?.activate();
    // A server-path change is not applied live; restart picks it up.
    await vscode.commands.executeCommand("clojurePulse.restart");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("server.path", undefined, vscode.ConfigurationTarget.Global);
  });

  test("definition and hover resolve inside a jar source", async function () {
    // The server resolves the project's classpath before it can answer at all.
    this.timeout(180000);
    const doc = await vscode.workspace.openTextDocument(
      path.join(root!.uri.fsPath, "src", "demo.clj"),
    );
    await vscode.window.showTextDocument(doc);

    const definitionAt = (uri: vscode.Uri, line: number, character: number) =>
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        uri,
        new vscode.Position(line, character),
      );

    // From the project's own file into the jar: this leg already worked before
    // the `jar` selector entry, and it is how we get hold of a real jar URI.
    let jarUri: vscode.Uri | undefined;
    const deadline = Date.now() + 150000;
    while (!jarUri && Date.now() < deadline) {
      // `map`, on the second line of the fixture.
      jarUri = targetUris(await definitionAt(doc.uri, 1, 1)).find(
        (uri) => uri.scheme === "jar",
      );
      if (!jarUri) {
        await sleep(1000);
      }
    }
    assert.ok(jarUri, "no jar: definition for clojure.core/map within 150s");

    // The `jar:` content provider fills this in from the server.
    const jarDoc = await vscode.workspace.openTextDocument(jarUri);
    await vscode.window.showTextDocument(jarDoc);
    assert.ok(jarDoc.getText().length > 0, "the jar document came back empty");

    // Pick the position syntactically: a plain text search for a name can land
    // in a docstring or a comment, where nothing resolves and the test would
    // fail for the wrong reason. `defn` in head position always resolves and
    // always hovers, and finding it this way survives any Clojure release
    // moving code around.
    let defnLine = -1;
    for (let line = 0; line < jarDoc.lineCount; line += 1) {
      if (/^\(defn /.test(jarDoc.lineAt(line).text)) {
        defnLine = line;
        break;
      }
    }
    assert.ok(defnLine >= 0, "no `(defn ` form found in the jar document");

    // The actual assertion: the server answers for the jar document itself.
    const definition = targetUris(await definitionAt(jarUri, defnLine, 2));
    assert.ok(
      definition.length > 0,
      `no definition for \`defn\` inside ${jarUri.toString()} at line ${defnLine}`,
    );

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      jarUri,
      new vscode.Position(defnLine, 2),
    );
    const hoverTexts = (hovers ?? []).flatMap((hover) =>
      hover.contents.map((content) =>
        typeof content === "string" ? content : content.value,
      ),
    );
    assert.ok(
      hoverTexts.some((text) => text.trim().length > 0),
      `no hover for \`defn\` inside ${jarUri.toString()} at line ${defnLine}`,
    );
  });
});
