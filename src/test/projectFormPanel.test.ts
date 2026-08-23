import * as assert from "assert";
import {
  ProjectFormLoadMessage,
  ProjectFormPanel,
  ProjectFormPanelHost,
} from "../projectFormPanel";

/** A `WebviewPanel` the test can post into and close on the user's behalf. */
interface FakePanel {
  host: ProjectFormPanelHost;
  posted: ProjectFormLoadMessage[];
  reveals: number;
  disposes: number;
  send(message: unknown): void;
  closeTab(): void;
}

function fakePanel(): FakePanel {
  let onMessage: ((message: unknown) => void) | undefined;
  let onDispose: (() => void) | undefined;
  const panel: FakePanel = {
    posted: [],
    reveals: 0,
    disposes: 0,
    send: (message) => onMessage?.(message),
    closeTab: () => onDispose?.(),
    host: {
      title: "",
      webview: {
        html: "",
        postMessage: (message: unknown) => {
          panel.posted.push(message as ProjectFormLoadMessage);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (listener) => {
          onMessage = listener;
        },
      },
      reveal: () => {
        panel.reveals++;
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

interface Harness {
  form: ProjectFormPanel;
  panels: FakePanel[];
  panel: () => FakePanel;
  /** The raw settings value `updateEntries` mutations are applied to. */
  entries: unknown[];
  written: unknown[][];
  confirmations: string[];
  confirm: boolean;
  updateError?: Error;
}

function harness(entries: unknown[] = []): Harness {
  const state: Harness = {
    form: undefined as unknown as ProjectFormPanel,
    panels: [],
    panel: () => state.panels[state.panels.length - 1],
    entries,
    written: [],
    confirmations: [],
    confirm: true,
  };
  state.form = new ProjectFormPanel({
    createPanel: () => {
      const panel = fakePanel();
      state.panels.push(panel);
      return panel.host;
    },
    readEntries: () => state.entries,
    // The mutation runs against the entries as they are *now*, like the real
    // updateEntries reads inside the write chain.
    updateEntries: async (update) => {
      if (state.updateError) {
        throw state.updateError;
      }
      const next = update(state.entries);
      state.written.push(next);
      state.entries = next;
    },
    confirmRemove: (path) => {
      state.confirmations.push(path);
      return Promise.resolve(state.confirm);
    },
  });
  return state;
}

const NODE = {
  path: "apps/x",
  kind: "deps",
  enabled: false,
  cmd: "clojure -A:dev -Spath",
};

suite("ProjectFormPanel", () => {
  test("add mode saves a new entry with explicit enabled; blank cmd omitted", async () => {
    const h = harness([{ path: "libs/y" }]);
    h.form.open({ kind: "add" });
    await h.form.submit({ path: "./apps/new/", classpathEnabled: true, classpathCommand: " " });
    assert.deepStrictEqual(h.entries, [
      { path: "libs/y" },
      { path: "apps/new", classpathEnabled: true },
    ]);
    assert.strictEqual(h.panel().disposes, 1);
  });

  test("a toggle landing after the form opened survives the form's save", async () => {
    const h = harness([]);
    h.form.open({ kind: "edit", project: NODE });
    // Another write path (the inline toggle) changes settings meanwhile.
    h.entries = [{ path: "libs/y", classpathEnabled: true }];
    await h.form.submit({ path: "apps/x", classpathEnabled: true, classpathCommand: "" });
    assert.deepStrictEqual(h.entries, [
      { path: "libs/y", classpathEnabled: true },
      { path: "apps/x", classpathEnabled: true },
    ]);
  });

  test("edit mode pre-fills override, placeholder, and read-only path", () => {
    const h = harness([{ path: "apps/x", classpathCommand: "make cp" }]);
    h.form.open({ kind: "edit", project: NODE });
    h.panel().send({ type: "ready" });
    const [msg] = h.panel().posted;
    assert.strictEqual(msg.mode, "edit");
    assert.strictEqual(msg.values.path, "apps/x");
    assert.strictEqual(msg.values.classpathEnabled, false);
    assert.strictEqual(msg.values.classpathCommand, "make cp");
    assert.strictEqual(msg.commandPlaceholder, "clojure -A:dev -Spath");
    assert.strictEqual(msg.hasEntry, true);
    assert.strictEqual(msg.commandDisabled, false);
  });

  test("no node cmd: placeholder falls back to the per-kind default", () => {
    const h = harness([]);
    h.form.open({ kind: "edit", project: { path: "apps/l", kind: "lein", enabled: true } });
    h.panel().send({ type: "ready" });
    assert.strictEqual(h.panel().posted[0].commandPlaceholder, "lein classpath");
  });

  test("blanking a previously-set command removes the key", async () => {
    const h = harness([
      { path: "apps/x", classpathEnabled: true, classpathCommand: "make cp", note: "keep" },
    ]);
    h.form.open({ kind: "edit", project: NODE });
    await h.form.submit({ path: "apps/x", classpathEnabled: true, classpathCommand: "" });
    assert.deepStrictEqual(h.entries, [
      { path: "apps/x", classpathEnabled: true, note: "keep" },
    ]);
  });

  test("lgx renders the command field disabled", () => {
    const h = harness([]);
    h.form.open({ kind: "edit", project: { path: "tool", kind: "lgx", enabled: true } });
    h.panel().send({ type: "ready" });
    const [msg] = h.panel().posted;
    assert.strictEqual(msg.commandDisabled, true);
    assert.strictEqual(msg.commandPlaceholder, "");
  });

  test("remove: shown state gates it, confirm then update without the entry", async () => {
    const h = harness([{ path: "apps/x", classpathEnabled: true }, { path: "libs/y" }]);
    h.form.open({ kind: "edit", project: NODE });
    await h.form.requestRemove();
    assert.deepStrictEqual(h.confirmations, ["apps/x"]);
    assert.deepStrictEqual(h.entries, [{ path: "libs/y" }]);
    assert.strictEqual(h.panel().disposes, 1);
  });

  test("remove is refused without an entry, and declined confirms write nothing", async () => {
    const h = harness([]);
    h.form.open({ kind: "edit", project: NODE });
    await h.form.requestRemove();
    assert.deepStrictEqual(h.confirmations, []);
    assert.deepStrictEqual(h.written, []);

    h.entries = [{ path: "apps/x" }];
    h.confirm = false;
    h.form.open({ kind: "edit", project: NODE });
    await h.form.requestRemove();
    assert.deepStrictEqual(h.confirmations, ["apps/x"]);
    assert.deepStrictEqual(h.written, []);
  });

  test("add-mode validation blocks bad and duplicate-entry paths, form stays open", async () => {
    const h = harness([{ path: "apps/x" }]);
    h.form.open({ kind: "add" });
    h.panel().send({ type: "ready" });

    await h.form.submit({ path: "../out", classpathEnabled: true, classpathCommand: "" });
    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 0);
    let last = h.panel().posted[h.panel().posted.length - 1];
    assert.ok(last.errors.path);

    await h.form.submit({ path: "./apps/x/", classpathEnabled: true, classpathCommand: "" });
    assert.deepStrictEqual(h.written, []);
    last = h.panel().posted[h.panel().posted.length - 1];
    assert.ok(last.errors.path);
  });

  test("a failed update reports into the form instead of closing it", async () => {
    const h = harness([]);
    h.updateError = new Error("settings write failed");
    h.form.open({ kind: "add" });
    h.panel().send({ type: "ready" });
    await h.form.submit({ path: "apps/new", classpathEnabled: true, classpathCommand: "" });
    const last = h.panel().posted[h.panel().posted.length - 1];
    assert.strictEqual(last.errors.form, "settings write failed");
    assert.strictEqual(h.panel().disposes, 0);
  });

  test("reopening reuses the tab and reposts", () => {
    const h = harness([]);
    h.form.open({ kind: "add" });
    h.panel().send({ type: "ready" });
    h.form.open({ kind: "edit", project: NODE });
    assert.strictEqual(h.panels.length, 1);
    assert.strictEqual(h.panel().reveals, 1);
    const last = h.panel().posted[h.panel().posted.length - 1];
    assert.strictEqual(last.mode, "edit");
  });

  test("webview messages drive save and cancel", async () => {
    const h = harness([]);
    h.form.open({ kind: "add" });
    h.panel().send({
      type: "save",
      values: { path: "apps/new", classpathEnabled: false, classpathCommand: "make cp" },
    });
    await h.form.settled();
    assert.deepStrictEqual(h.entries, [
      { path: "apps/new", classpathEnabled: false, classpathCommand: "make cp" },
    ]);

    h.form.open({ kind: "add" });
    h.panel().send({ type: "cancel" });
    // The save closed the first tab; cancel closed the reopened one.
    assert.strictEqual(h.panels.length, 2);
    assert.strictEqual(h.panel().disposes, 1);
  });
});
