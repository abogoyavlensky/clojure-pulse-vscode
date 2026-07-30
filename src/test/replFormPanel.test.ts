import * as assert from "assert";
import { ReplFormValues } from "../repl/replConfigEdit";
import {
  ReplFormLoadMessage,
  ReplFormPanel,
  ReplFormPanelHost,
} from "../repl/replFormPanel";

const DEFAULT_COMMAND = "clojure -M:clojure-pulse/nrepl";
const HINT = "Runs through your shell.";

/** A `WebviewPanel` the test can post into and close on the user's behalf. */
interface FakePanel {
  host: ReplFormPanelHost;
  posted: ReplFormLoadMessage[];
  reveals: number;
  disposes: number;
  /** Delivers a message from the webview. */
  send(message: unknown): void;
  /** The user closing the tab. */
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
          panel.posted.push(message as ReplFormLoadMessage);
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
  form: ReplFormPanel;
  panels: FakePanel[];
  /** The current panel, which every assertion but "reuse" is about. */
  panel: () => FakePanel;
  entries: unknown[];
  written: unknown[][];
  confirmations: string[];
  /** What `confirmDelete` resolves with. */
  confirm: boolean;
  /** When set, `writeEntries` rejects with it. */
  writeError?: Error;
  /** When set, `writeEntries` waits for it — a settings write in flight. */
  writeGate?: Promise<void>;
  /** The user doing something else while the delete modal is up. */
  onConfirm?: () => void;
}

/** A promise the test releases by hand, and the release. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function harness(entries: unknown[] = []): Harness {
  const state: Harness = {
    form: undefined as unknown as ReplFormPanel,
    panels: [],
    panel: () => state.panels[state.panels.length - 1],
    entries,
    written: [],
    confirmations: [],
    confirm: true,
  };
  state.form = new ReplFormPanel({
    createPanel: () => {
      const panel = fakePanel();
      state.panels.push(panel);
      return panel.host;
    },
    readEntries: () => state.entries,
    writeEntries: async (next) => {
      await state.writeGate;
      if (state.writeError) {
        throw state.writeError;
      }
      state.written.push(next);
      state.entries = next;
    },
    defaultCommand: () => ({ command: DEFAULT_COMMAND, hint: HINT }),
    confirmDelete: (name) => {
      state.confirmations.push(name);
      state.onConfirm?.();
      return Promise.resolve(state.confirm);
    },
  });
  return state;
}

/** The last `load` message the panel posted. */
function loaded(panel: FakePanel): ReplFormLoadMessage {
  const message = panel.posted[panel.posted.length - 1];
  assert.ok(message, "expected the panel to have posted a load message");
  return message;
}

const dev = { name: "dev", type: "create", command: "clj -M:repl" };

suite("ReplFormPanel", () => {
  test("opening in add mode answers ready with the project's defaults", () => {
    const h = harness();
    h.form.open({ kind: "add" });

    assert.strictEqual(h.panels.length, 1);
    assert.strictEqual(h.panel().host.title, "Add REPL");
    h.panel().send({ type: "ready" });

    const message = loaded(h.panel());
    assert.strictEqual(message.type, "load");
    assert.strictEqual(message.mode, "add");
    assert.strictEqual(message.commandHint, HINT);
    assert.deepStrictEqual(message.errors, {});
    assert.deepStrictEqual(message.values, {
      name: "",
      type: "create",
      command: DEFAULT_COMMAND,
      cwd: ".",
      host: "localhost",
      port: ".nrepl-port",
    });
    assert.deepStrictEqual(h.form.state?.mode, { kind: "add" });
  });

  test("opening in edit mode loads that entry's values", () => {
    const h = harness([{ name: "a", type: "connect", port: 7888 }, dev]);
    h.form.open({ kind: "edit", name: "dev" });

    assert.strictEqual(h.panel().host.title, "Edit REPL: dev");
    h.panel().send({ type: "ready" });

    const message = loaded(h.panel());
    assert.strictEqual(message.mode, "edit");
    assert.strictEqual(message.values.name, "dev");
    assert.strictEqual(message.values.command, "clj -M:repl");
    // The other type's fields are filled too, so switching back and forth
    // loses nothing.
    assert.strictEqual(message.values.host, "localhost");
  });

  test("editing a name with no entry behind it opens the defaults", () => {
    const h = harness([]);
    h.form.open({ kind: "edit", name: "gone" });
    assert.strictEqual(h.form.state?.values.command, DEFAULT_COMMAND);
    assert.strictEqual(h.form.state?.values.name, "");
  });

  test("saving valid values writes the entry and closes the form", async () => {
    const h = harness([{ name: "a", type: "connect", port: 7888 }]);
    h.form.open({ kind: "add" });
    await h.form.submit({
      name: "dev",
      type: "create",
      command: "clj -M:repl",
      cwd: ".",
      host: "localhost",
      port: ".nrepl-port",
    });

    assert.deepStrictEqual(h.written, [
      [{ name: "a", type: "connect", port: 7888 }, { name: "dev", type: "create", command: "clj -M:repl" }],
    ]);
    assert.strictEqual(h.panel().disposes, 1, "the tab should close exactly once");
    assert.strictEqual(h.form.state, undefined);
  });

  test("saving an edit replaces the entry it was opened on", async () => {
    const h = harness([dev]);
    h.form.open({ kind: "edit", name: "dev" });
    const values = h.form.state!.values;
    await h.form.submit({ ...values, name: "prod", command: "clj -M:prod" });

    assert.deepStrictEqual(h.written, [
      [{ name: "prod", type: "create", command: "clj -M:prod" }],
    ]);
  });

  test("a Save message from the webview saves too", async () => {
    const h = harness([]);
    h.form.open({ kind: "add" });
    h.panel().send({
      type: "save",
      values: {
        name: "dev",
        type: "create",
        command: "clj -M:repl",
        cwd: ".",
        host: "localhost",
        port: ".nrepl-port",
      },
    });
    await settle();

    assert.strictEqual(h.written.length, 1);
    assert.strictEqual(h.panel().disposes, 1);
  });

  test("saving invalid values writes nothing and posts the errors back", async () => {
    const h = harness([{ name: "dev", type: "connect", port: 7888 }]);
    h.form.open({ kind: "add" });
    const typed: ReplFormValues = {
      name: "dev",
      type: "create",
      command: "  ",
      cwd: ".",
      host: "localhost",
      port: ".nrepl-port",
    };
    await h.form.submit(typed);

    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 0, "the form stays open");
    const message = loaded(h.panel());
    assert.ok(message.errors.name, "expected a name conflict");
    assert.ok(message.errors.command, "expected a missing command");
    assert.deepStrictEqual(message.values, typed, "the user keeps what they typed");
    assert.deepStrictEqual(h.form.state?.values, typed);
  });

  test("a failed write keeps the form open and reports it above the buttons", async () => {
    const h = harness([]);
    h.writeError = new Error("settings.json is read-only");
    h.form.open({ kind: "add" });
    await h.form.submit({
      name: "dev",
      type: "create",
      command: "clj -M:repl",
      cwd: ".",
      host: "localhost",
      port: ".nrepl-port",
    });

    assert.strictEqual(h.panel().disposes, 0);
    const message = loaded(h.panel());
    assert.ok(message.errors.form?.includes("read-only"), message.errors.form);
    assert.strictEqual(message.errors.name, undefined);
  });

  test("delete confirms, removes the entry, and closes the form", async () => {
    const h = harness([{ name: "a", type: "connect", port: 7888 }, dev]);
    h.form.open({ kind: "edit", name: "dev" });
    await h.form.requestDelete();

    assert.deepStrictEqual(h.confirmations, ["dev"]);
    assert.deepStrictEqual(h.written, [[{ name: "a", type: "connect", port: 7888 }]]);
    assert.strictEqual(h.panel().disposes, 1);
    assert.strictEqual(h.form.state, undefined);
  });

  test("a declined delete writes nothing and leaves the form open", async () => {
    const h = harness([dev]);
    h.confirm = false;
    h.form.open({ kind: "edit", name: "dev" });
    await h.form.requestDelete();

    assert.deepStrictEqual(h.confirmations, ["dev"]);
    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 0);
    assert.ok(h.form.state);
  });

  test("delete does nothing in add mode", async () => {
    const h = harness([]);
    h.form.open({ kind: "add" });
    await h.form.requestDelete();

    assert.deepStrictEqual(h.confirmations, []);
    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 0);
  });

  test("cancel writes nothing and closes the form", () => {
    const h = harness([dev]);
    h.form.open({ kind: "edit", name: "dev" });
    h.panel().send({ type: "cancel" });

    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 1);
    assert.strictEqual(h.form.state, undefined);
  });

  test("a second form reuses the open panel with the new values", () => {
    const h = harness([dev]);
    h.form.open({ kind: "add" });
    h.form.open({ kind: "edit", name: "dev" });

    assert.strictEqual(h.panels.length, 1, "no second tab");
    assert.strictEqual(h.panel().reveals, 1);
    assert.strictEqual(h.panel().host.title, "Edit REPL: dev");
    // Already loaded, so it will not ask again: the new values are pushed.
    const message = loaded(h.panel());
    assert.strictEqual(message.mode, "edit");
    assert.strictEqual(message.values.name, "dev");
    assert.deepStrictEqual(h.form.state?.mode, { kind: "edit", name: "dev" });
  });

  test("a save landing after the form moved on leaves the new one alone", async () => {
    const h = harness([dev]);
    const write = gate();
    h.writeGate = write.promise;
    h.form.open({ kind: "add" });
    const saving = h.form.submit({
      name: "new",
      type: "create",
      command: "clj -M:repl",
      cwd: ".",
      host: "localhost",
      port: ".nrepl-port",
    });
    // The user reaches for the pencil on another row while the write is out.
    h.form.open({ kind: "edit", name: "dev" });
    write.release();
    await saving;

    assert.strictEqual(h.written.length, 1, "the save still went through");
    assert.strictEqual(h.panel().disposes, 0, "the form now on screen stays open");
    assert.deepStrictEqual(h.form.state?.mode, { kind: "edit", name: "dev" });
  });

  test("a failed save landing that late does not shout at the new form", async () => {
    const h = harness([dev]);
    const write = gate();
    h.writeGate = write.promise;
    h.writeError = new Error("settings.json is read-only");
    h.form.open({ kind: "add" });
    const saving = h.form.submit({
      name: "new",
      type: "create",
      command: "clj -M:repl",
      cwd: ".",
      host: "localhost",
      port: ".nrepl-port",
    });
    h.form.open({ kind: "edit", name: "dev" });
    write.release();
    await saving;

    const message = loaded(h.panel());
    assert.strictEqual(message.mode, "edit");
    assert.strictEqual(message.errors.form, undefined);
    assert.strictEqual(h.panel().disposes, 0);
  });

  test("a delete confirmed after the form moved on writes nothing", async () => {
    const other = { name: "a", type: "connect", port: 7888 };
    const h = harness([dev, other]);
    h.form.open({ kind: "edit", name: "dev" });
    h.onConfirm = () => h.form.open({ kind: "edit", name: "a" });
    await h.form.requestDelete();

    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 0);
    assert.deepStrictEqual(h.form.state?.mode, { kind: "edit", name: "a" });
  });

  test("a delete landing after the form moved on leaves the new one alone", async () => {
    const other = { name: "a", type: "connect", port: 7888 };
    const h = harness([dev, other]);
    const write = gate();
    h.writeGate = write.promise;
    h.form.open({ kind: "edit", name: "dev" });
    const deleting = h.form.requestDelete();
    await settle(); // past the confirmation, into the write
    h.form.open({ kind: "edit", name: "a" });
    write.release();
    await deleting;

    assert.deepStrictEqual(h.written, [[other]], "the delete still went through");
    assert.strictEqual(h.panel().disposes, 0);
    assert.deepStrictEqual(h.form.state?.mode, { kind: "edit", name: "a" });
  });

  test("the user closing the tab clears the pending form", () => {
    const h = harness([]);
    h.form.open({ kind: "add" });
    h.panel().closeTab();

    assert.strictEqual(h.form.state, undefined);
    // And the next open builds a fresh tab rather than talking to a dead one.
    h.form.open({ kind: "add" });
    assert.strictEqual(h.panels.length, 2);
  });

  test("dispose closes an open form", () => {
    const h = harness([]);
    h.form.open({ kind: "add" });
    h.form.dispose();

    assert.strictEqual(h.panel().disposes, 1);
    assert.strictEqual(h.form.state, undefined);
    h.form.dispose(); // idempotent
    assert.strictEqual(h.panel().disposes, 1);
  });
});

/** Lets an already-queued promise chain (a fired `save`) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
