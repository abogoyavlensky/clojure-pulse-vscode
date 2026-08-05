import * as assert from "assert";
import {
  CustomCommandFormLoadMessage,
  CustomCommandFormPanel,
  CustomCommandFormPanelHost,
} from "../repl/customCommandFormPanel";

/** A `WebviewPanel` the test can post into and close on the user's behalf. */
interface FakePanel {
  host: CustomCommandFormPanelHost;
  posted: CustomCommandFormLoadMessage[];
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
          panel.posted.push(message as CustomCommandFormLoadMessage);
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
  form: CustomCommandFormPanel;
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
    form: undefined as unknown as CustomCommandFormPanel,
    panels: [],
    panel: () => state.panels[state.panels.length - 1],
    entries,
    written: [],
    confirmations: [],
    confirm: true,
  };
  state.form = new CustomCommandFormPanel({
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
    confirmDelete: (name) => {
      state.confirmations.push(name);
      state.onConfirm?.();
      return Promise.resolve(state.confirm);
    },
  });
  return state;
}

/** The last `load` message the panel posted. */
function loaded(panel: FakePanel): CustomCommandFormLoadMessage {
  const message = panel.posted[panel.posted.length - 1];
  assert.ok(message, "expected the panel to have posted a load message");
  return message;
}

const reset = { name: "reset", code: "(user/reset)" };

suite("CustomCommandFormPanel", () => {
  test("opening in add mode answers ready with empty values", () => {
    const h = harness();
    h.form.open({ kind: "add" });

    assert.strictEqual(h.panels.length, 1);
    assert.strictEqual(h.panel().host.title, "Add REPL Command");
    h.panel().send({ type: "ready" });

    const message = loaded(h.panel());
    assert.strictEqual(message.type, "load");
    assert.strictEqual(message.mode, "add");
    assert.deepStrictEqual(message.errors, {});
    assert.deepStrictEqual(message.values, { name: "", code: "" });
    assert.deepStrictEqual(h.form.state?.mode, { kind: "add" });
  });

  test("opening in edit mode loads that entry's values", () => {
    const h = harness([{ name: "a", code: "(a)" }, reset]);
    h.form.open({ kind: "edit", name: "reset" });

    assert.strictEqual(h.panel().host.title, "Edit REPL Command: reset");
    h.panel().send({ type: "ready" });

    const message = loaded(h.panel());
    assert.strictEqual(message.mode, "edit");
    assert.deepStrictEqual(message.values, { name: "reset", code: "(user/reset)" });
  });

  test("editing a name with no entry behind it opens empty", () => {
    const h = harness([]);
    h.form.open({ kind: "edit", name: "gone" });
    assert.deepStrictEqual(h.form.state?.values, { name: "", code: "" });
  });

  test("saving valid values writes the entry and closes the form", async () => {
    const h = harness([{ name: "a", code: "(a)" }]);
    h.form.open({ kind: "add" });
    await h.form.submit({ name: "reset", code: "(user/reset)" });

    assert.deepStrictEqual(h.written, [
      [{ name: "a", code: "(a)" }, { name: "reset", code: "(user/reset)" }],
    ]);
    assert.strictEqual(h.panel().disposes, 1, "the tab should close exactly once");
    assert.strictEqual(h.form.state, undefined);
  });

  test("saving an edit replaces the entry it was opened on", async () => {
    const h = harness([reset]);
    h.form.open({ kind: "edit", name: "reset" });
    await h.form.submit({ name: "restart", code: "(user/restart)" });

    assert.deepStrictEqual(h.written, [[{ name: "restart", code: "(user/restart)" }]]);
  });

  test("a Save message from the webview saves too", async () => {
    const h = harness([]);
    h.form.open({ kind: "add" });
    h.panel().send({ type: "save", values: { name: "reset", code: "(user/reset)" } });
    await settle();

    assert.strictEqual(h.written.length, 1);
    assert.strictEqual(h.panel().disposes, 1);
  });

  test("saving invalid values writes nothing and posts the errors back", async () => {
    const h = harness([reset]);
    h.form.open({ kind: "add" });
    const typed = { name: "reset", code: "  " };
    await h.form.submit(typed);

    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 0, "the form stays open");
    const message = loaded(h.panel());
    assert.ok(message.errors.name, "expected a name conflict");
    assert.ok(message.errors.code, "expected missing code");
    assert.deepStrictEqual(message.values, typed, "the user keeps what they typed");
    assert.deepStrictEqual(h.form.state?.values, typed);
  });

  test("a failed write keeps the form open and reports it above the buttons", async () => {
    const h = harness([]);
    h.writeError = new Error("settings.json is read-only");
    h.form.open({ kind: "add" });
    await h.form.submit({ name: "reset", code: "(user/reset)" });

    assert.strictEqual(h.panel().disposes, 0);
    const message = loaded(h.panel());
    assert.ok(message.errors.form?.includes("read-only"), message.errors.form);
    assert.strictEqual(message.errors.name, undefined);
  });

  test("delete confirms, removes the entry, and closes the form", async () => {
    const h = harness([{ name: "a", code: "(a)" }, reset]);
    h.form.open({ kind: "edit", name: "reset" });
    await h.form.requestDelete();

    assert.deepStrictEqual(h.confirmations, ["reset"]);
    assert.deepStrictEqual(h.written, [[{ name: "a", code: "(a)" }]]);
    assert.strictEqual(h.panel().disposes, 1);
    assert.strictEqual(h.form.state, undefined);
  });

  test("a declined delete writes nothing and leaves the form open", async () => {
    const h = harness([reset]);
    h.confirm = false;
    h.form.open({ kind: "edit", name: "reset" });
    await h.form.requestDelete();

    assert.deepStrictEqual(h.confirmations, ["reset"]);
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
    const h = harness([reset]);
    h.form.open({ kind: "edit", name: "reset" });
    h.panel().send({ type: "cancel" });

    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 1);
    assert.strictEqual(h.form.state, undefined);
  });

  test("a second form reuses the open panel with the new values", () => {
    const h = harness([reset]);
    h.form.open({ kind: "add" });
    h.form.open({ kind: "edit", name: "reset" });

    assert.strictEqual(h.panels.length, 1, "no second tab");
    assert.strictEqual(h.panel().reveals, 1);
    assert.strictEqual(h.panel().host.title, "Edit REPL Command: reset");
    // Already loaded, so it will not ask again: the new values are pushed.
    const message = loaded(h.panel());
    assert.strictEqual(message.mode, "edit");
    assert.strictEqual(message.values.name, "reset");
    assert.deepStrictEqual(h.form.state?.mode, { kind: "edit", name: "reset" });
  });

  test("a save landing after the form moved on leaves the new one alone", async () => {
    const h = harness([reset]);
    const write = gate();
    h.writeGate = write.promise;
    h.form.open({ kind: "add" });
    const saving = h.form.submit({ name: "new", code: "(new)" });
    // The user reaches for another row while the write is out.
    h.form.open({ kind: "edit", name: "reset" });
    write.release();
    await saving;

    assert.strictEqual(h.written.length, 1, "the save still went through");
    assert.strictEqual(h.panel().disposes, 0, "the form now on screen stays open");
    assert.deepStrictEqual(h.form.state?.mode, { kind: "edit", name: "reset" });
  });

  test("a failed save landing that late does not shout at the new form", async () => {
    const h = harness([reset]);
    const write = gate();
    h.writeGate = write.promise;
    h.writeError = new Error("settings.json is read-only");
    h.form.open({ kind: "add" });
    const saving = h.form.submit({ name: "new", code: "(new)" });
    h.form.open({ kind: "edit", name: "reset" });
    write.release();
    await saving;

    const message = loaded(h.panel());
    assert.strictEqual(message.mode, "edit");
    assert.strictEqual(message.errors.form, undefined);
    assert.strictEqual(h.panel().disposes, 0);
  });

  test("a delete confirmed after the form moved on writes nothing", async () => {
    const other = { name: "a", code: "(a)" };
    const h = harness([reset, other]);
    h.form.open({ kind: "edit", name: "reset" });
    h.onConfirm = () => h.form.open({ kind: "edit", name: "a" });
    await h.form.requestDelete();

    assert.deepStrictEqual(h.written, []);
    assert.strictEqual(h.panel().disposes, 0);
    assert.deepStrictEqual(h.form.state?.mode, { kind: "edit", name: "a" });
  });

  test("a delete landing after the form moved on leaves the new one alone", async () => {
    const other = { name: "a", code: "(a)" };
    const h = harness([reset, other]);
    const write = gate();
    h.writeGate = write.promise;
    h.form.open({ kind: "edit", name: "reset" });
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
