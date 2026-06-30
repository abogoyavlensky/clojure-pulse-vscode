import * as assert from "assert";
import * as vscode from "vscode";
import { createJarContentProvider } from "../jarContentProvider";

suite("createJarContentProvider", () => {
  test("returns dependency contents for a jar: uri via clojure/dependencyContents", async () => {
    const calls: Array<{ method: string; param: unknown }> = [];
    const provider = createJarContentProvider((method, param) => {
      calls.push({ method, param });
      return Promise.resolve("(ns clojure.core)");
    });

    const uri = vscode.Uri.parse("jar:file:///deps/clojure.jar!/clojure/core.clj");
    const content = await provider.provideTextDocumentContent(uri, dummyToken());

    assert.strictEqual(content, "(ns clojure.core)");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "clojure/dependencyContents");
    assert.deepStrictEqual(calls[0].param, { uri: uri.toString() });
  });
});

function dummyToken(): vscode.CancellationToken {
  return new vscode.CancellationTokenSource().token;
}
