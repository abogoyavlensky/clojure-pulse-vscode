import * as assert from "assert";
import * as vscode from "vscode";
import { ClojureDocsParams, ClojureDocsResult } from "../clojureDocs";
import { createClojureDocsHoverProvider } from "../clojureDocsHover";
import { PendingClojureDocsRequest } from "../clojureDocsRequest";

const mapEntry: ClojureDocsResult = {
  symbol: "clojure.core/map",
  entry: {
    ns: "clojure.core",
    name: "map",
    arglists: ["[f coll]"],
    examples: ["(map inc [1 2 3])"],
    seeAlsos: ["clojure.core/mapv"],
    url: "https://clojuredocs.org/clojure.core/map",
  },
};

function harness(lookup: (params: ClojureDocsParams) => Promise<ClojureDocsResult>) {
  const pending = new PendingClojureDocsRequest(() => 0, 1000);
  const calls: ClojureDocsParams[] = [];
  const info: string[] = [];
  const warn: string[] = [];
  const provider = createClojureDocsHoverProvider({
    pending,
    lookup: (params) => {
      calls.push(params);
      return lookup(params);
    },
    serverVersion: () => "0.4.0",
    notify: {
      info: (message) => {
        info.push(message);
      },
      warn: (message) => {
        warn.push(message);
      },
    },
  });
  return { pending, provider, calls, info, warn };
}

const token = new vscode.CancellationTokenSource().token;

async function openDoc(): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({
    language: "clojure",
    content: "(map inc [1 2 3])\n",
  });
}

function markdownOf(hover: vscode.Hover | null | undefined): vscode.MarkdownString {
  assert.ok(hover, "expected a hover");
  assert.strictEqual(hover.contents.length, 1);
  const content = hover.contents[0];
  assert.ok(content instanceof vscode.MarkdownString, "expected a MarkdownString");
  return content;
}

suite("ClojureDocs hover provider", () => {
  test("answers nothing without a recorded request", async () => {
    const h = harness(async () => mapEntry);
    const doc = await openDoc();
    const hover = await h.provider.provideHover(doc, new vscode.Position(0, 1), token);
    assert.strictEqual(hover, undefined);
    assert.strictEqual(h.calls.length, 0);
  });

  test("a recorded position request looks the word up and renders the entry", async () => {
    const h = harness(async () => mapEntry);
    const doc = await openDoc();
    h.pending.record({ uri: doc.uri.toString(), line: 0, character: 1 });
    const hover = await h.provider.provideHover(doc, new vscode.Position(0, 1), token);
    assert.deepStrictEqual(h.calls, [
      { textDocument: { uri: doc.uri.toString() }, position: { line: 0, character: 1 } },
    ]);
    const markdown = markdownOf(hover);
    assert.match(markdown.value, /ClojureDocs: clojure\.core\/map/);
    assert.match(markdown.value, /```clojure/);
    assert.deepStrictEqual(markdown.isTrusted, {
      enabledCommands: ["clojurePulse.showClojureDocs"],
    });
  });

  test("a recorded symbol request looks the var up by name", async () => {
    const h = harness(async () => mapEntry);
    const doc = await openDoc();
    h.pending.record({ uri: doc.uri.toString(), line: 0, character: 1, symbol: "clojure.core/mapv" });
    await h.provider.provideHover(doc, new vscode.Position(0, 1), token);
    assert.deepStrictEqual(h.calls, [{ symbol: "clojure.core/mapv" }]);
  });

  test("no entry reports an information message and shows nothing", async () => {
    const h = harness(async () => ({ symbol: "clojure.core/frob", entry: null }));
    const doc = await openDoc();
    h.pending.record({ uri: doc.uri.toString(), line: 0, character: 1 });
    const hover = await h.provider.provideHover(doc, new vscode.Position(0, 1), token);
    assert.strictEqual(hover, undefined);
    assert.strictEqual(h.info.length, 1);
    assert.match(h.info[0], /clojure\.core\/frob/);
    assert.strictEqual(h.warn.length, 0);
  });

  test("a failing lookup reports a warning naming the server requirement", async () => {
    const h = harness(() => Promise.reject({ code: -32601, message: "Method not found" }));
    const doc = await openDoc();
    h.pending.record({ uri: doc.uri.toString(), line: 0, character: 1 });
    const hover = await h.provider.provideHover(doc, new vscode.Position(0, 1), token);
    assert.strictEqual(hover, undefined);
    assert.strictEqual(h.warn.length, 1);
    assert.match(h.warn[0], /0\.4\.0/);
    assert.strictEqual(h.info.length, 0);
  });

  test("the request is consumed by the first query", async () => {
    const h = harness(async () => mapEntry);
    const doc = await openDoc();
    h.pending.record({ uri: doc.uri.toString(), line: 0, character: 1 });
    assert.ok(await h.provider.provideHover(doc, new vscode.Position(0, 1), token));
    assert.strictEqual(
      await h.provider.provideHover(doc, new vscode.Position(0, 1), token),
      undefined,
    );
    assert.strictEqual(h.calls.length, 1);
  });
});
