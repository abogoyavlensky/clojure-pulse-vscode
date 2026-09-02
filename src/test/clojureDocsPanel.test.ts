import * as assert from "assert";
import { ClojureDocsParams, ClojureDocsResult } from "../clojureDocs";
import { ClojureDocsPanel, ClojureDocsPanelHost } from "../clojureDocsPanel";

/** A `WebviewPanel` the test can post into and close on the user's behalf. */
interface FakePanel {
  host: ClojureDocsPanelHost;
  reveals: number;
  /** `preserveFocus` of the last reveal. */
  preservedFocus: boolean | undefined;
  disposes: number;
  send(message: unknown): void;
  closeTab(): void;
}

function fakePanel(): FakePanel {
  let onMessage: ((message: unknown) => void) | undefined;
  let onDispose: (() => void) | undefined;
  const panel: FakePanel = {
    reveals: 0,
    preservedFocus: undefined,
    disposes: 0,
    send: (message) => onMessage?.(message),
    closeTab: () => onDispose?.(),
    host: {
      title: "",
      webview: {
        html: "",
        onDidReceiveMessage: (listener) => {
          onMessage = listener;
        },
      },
      reveal: (_viewColumn, preserveFocus) => {
        panel.reveals++;
        panel.preservedFocus = preserveFocus;
      },
      dispose: () => {
        panel.disposes++;
      },
      onDidDispose: (listener) => {
        onDispose = listener;
      },
    },
  };
  return panel;
}

function entryFor(fqn: string): ClojureDocsResult {
  const [ns, name] = fqn.split("/");
  return {
    symbol: fqn,
    entry: {
      ns,
      name,
      doc: `doc of ${fqn}`,
      arglists: ["[x]"],
      examples: [`(${name} 1)`],
      seeAlsos: [],
      url: `https://clojuredocs.org/${fqn}`,
    },
  };
}

const atCursor: ClojureDocsParams = {
  textDocument: { uri: "file:///demo.clj" },
  position: { line: 1, character: 2 },
};

/** A panel over a fake host and a scripted lookup. */
function harness(lookup: (params: ClojureDocsParams) => Promise<ClojureDocsResult>) {
  const panels: FakePanel[] = [];
  const errors: unknown[] = [];
  const calls: ClojureDocsParams[] = [];
  const panel = new ClojureDocsPanel({
    createPanel: () => {
      const p = fakePanel();
      panels.push(p);
      return p.host;
    },
    lookup: (params) => {
      calls.push(params);
      return lookup(params);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { panel, panels, errors, calls };
}

suite("ClojureDocsPanel", () => {
  test("show opens one panel titled by the resolved var", async () => {
    const h = harness(async () => entryFor("clojure.core/map"));
    const result = await h.panel.show(atCursor);
    assert.strictEqual(result.symbol, "clojure.core/map");
    assert.strictEqual(h.panels.length, 1);
    assert.strictEqual(h.panels[0].host.title, "clojure.core/map");
    assert.match(h.panels[0].host.webview.html, /clojure\.core\/map/);
    assert.deepStrictEqual(h.calls, [atCursor]);
  });

  test("a second show reuses the panel and reveals it without taking focus", async () => {
    const h = harness(async () => entryFor("clojure.core/map"));
    await h.panel.show(atCursor);
    await h.panel.show(atCursor);
    assert.strictEqual(h.panels.length, 1);
    assert.strictEqual(h.panels[0].reveals, 1);
    assert.strictEqual(h.panels[0].preservedFocus, true);
  });

  test("a lookup finishing after the tab was closed does not reopen it", async () => {
    const deferred: Array<(result: ClojureDocsResult) => void> = [];
    let call = 0;
    // Only the second lookup is slow; the first and third answer at once.
    const h = harness(() => {
      call++;
      if (call !== 2) {
        return Promise.resolve(entryFor("clojure.core/map"));
      }
      return new Promise<ClojureDocsResult>((resolve) => {
        deferred.push(resolve);
      });
    });
    await h.panel.show(atCursor);
    const pending = h.panel.show({ symbol: "clojure.core/mapv" });
    h.panels[0].closeTab();
    deferred[0](entryFor("clojure.core/mapv"));
    const result = await pending;
    assert.strictEqual(result.symbol, "clojure.core/mapv");
    assert.strictEqual(h.panels.length, 1, "closing must not be undone by a late answer");
    // The next explicit request opens a fresh panel as usual.
    await h.panel.show(atCursor);
    assert.strictEqual(h.panels.length, 2);
  });

  test("no entry opens nothing and returns the result", async () => {
    const h = harness(async () => ({ symbol: "clojure.core/frob", entry: null }));
    const result = await h.panel.show(atCursor);
    assert.strictEqual(result.entry, null);
    assert.strictEqual(h.panels.length, 0);
  });

  test("a see-also click looks the var up by symbol and re-renders in place", async () => {
    const h = harness(async (params) =>
      "symbol" in params ? entryFor(params.symbol) : entryFor("clojure.core/map"),
    );
    await h.panel.show(atCursor);
    h.panels[0].send({ type: "lookup", symbol: "clojure.core/mapv" });
    await h.panel.settled();
    assert.deepStrictEqual(h.calls[1], { symbol: "clojure.core/mapv" });
    assert.strictEqual(h.panels.length, 1);
    assert.strictEqual(h.panels[0].host.title, "clojure.core/mapv");
    assert.match(h.panels[0].host.webview.html, /clojure\.core\/mapv/);
  });

  test("a see-also lookup that fails reports through onError and keeps the page", async () => {
    let fail = false;
    const h = harness(async () => {
      if (fail) {
        throw new Error("boom");
      }
      return entryFor("clojure.core/map");
    });
    await h.panel.show(atCursor);
    const before = h.panels[0].host.webview.html;
    fail = true;
    h.panels[0].send({ type: "lookup", symbol: "clojure.core/mapv" });
    await h.panel.settled();
    assert.strictEqual(h.errors.length, 1);
    assert.match(String((h.errors[0] as Error).message), /boom/);
    assert.strictEqual(h.panels[0].host.webview.html, before);
  });

  test("show itself rejects when the lookup fails", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    await assert.rejects(() => h.panel.show(atCursor), /boom/);
    assert.strictEqual(h.panels.length, 0);
  });

  test("unknown messages are ignored", async () => {
    const h = harness(async () => entryFor("clojure.core/map"));
    await h.panel.show(atCursor);
    h.panels[0].send({ type: "other" });
    h.panels[0].send(null);
    await h.panel.settled();
    assert.strictEqual(h.calls.length, 1);
  });

  test("closing the tab makes the next show open a fresh panel", async () => {
    const h = harness(async () => entryFor("clojure.core/map"));
    await h.panel.show(atCursor);
    h.panels[0].closeTab();
    await h.panel.show(atCursor);
    assert.strictEqual(h.panels.length, 2);
  });

  test("a slower earlier lookup cannot overwrite a newer one", async () => {
    const deferred: Array<(result: ClojureDocsResult) => void> = [];
    const h = harness(
      () =>
        new Promise<ClojureDocsResult>((resolve) => {
          deferred.push(resolve);
        }),
    );
    const first = h.panel.show(atCursor);
    const second = h.panel.show({ symbol: "clojure.core/mapv" });
    deferred[1](entryFor("clojure.core/mapv"));
    await second;
    deferred[0](entryFor("clojure.core/map"));
    await first;
    assert.strictEqual(h.panels.length, 1);
    assert.strictEqual(h.panels[0].host.title, "clojure.core/mapv");
    assert.doesNotMatch(h.panels[0].host.webview.html, /doc of clojure\.core\/map</);
  });

  test("dispose closes the panel", async () => {
    const h = harness(async () => entryFor("clojure.core/map"));
    await h.panel.show(atCursor);
    h.panel.dispose();
    assert.strictEqual(h.panels[0].disposes, 1);
  });
});
