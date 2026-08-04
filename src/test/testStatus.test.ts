import * as assert from "assert";
import * as vscode from "vscode";
import {
  buildStatusHover,
  testStatusOf,
  TestStatusManager,
} from "../repl/testStatus";

suite("testStatusOf", () => {
  test("clean summary is a pass", () => {
    assert.strictEqual(
      testStatusOf({ value: "{:test 1, :pass 2, :fail 0, :error 0, :type :summary}" }),
      "pass",
    );
  });

  test("failing summary is a fail", () => {
    assert.strictEqual(
      testStatusOf({ value: "{:test 1, :pass 0, :fail 1, :error 0, :type :summary}" }),
      "fail",
    );
  });

  test("an eval error is a fail regardless of value", () => {
    assert.strictEqual(testStatusOf({ err: "boom" }), "fail");
    assert.strictEqual(testStatusOf({ err: "boom", value: "nil" }), "fail");
  });
});

suite("buildStatusHover", () => {
  test("pass shows the summary value", () => {
    assert.strictEqual(
      buildStatusHover("pass", { value: "{:test 1, :pass 1, :fail 0, :error 0}" }),
      "{:test 1, :pass 1, :fail 0, :error 0}",
    );
  });

  test("fail combines out and err, trimmed", () => {
    assert.strictEqual(
      buildStatusHover("fail", {
        out: "FAIL in (my-test)\nexpected: (= 1 2)\n",
        err: "boom\n",
        value: "{:fail 1}",
      }),
      "FAIL in (my-test)\nexpected: (= 1 2)\n\nboom",
    );
  });

  test("fail with only out omits the err block", () => {
    assert.strictEqual(
      buildStatusHover("fail", { out: "FAIL in (t)\n" }),
      "FAIL in (t)",
    );
  });

  test("fail with nothing captured falls back to the value", () => {
    assert.strictEqual(buildStatusHover("fail", { value: "{:fail 1}" }), "{:fail 1}");
  });
});

suite("TestStatusManager races", () => {
  let manager: TestStatusManager;

  setup(() => {
    manager = new TestStatusManager({
      passIcon: vscode.Uri.file("/dev/null"),
      failIcon: vscode.Uri.file("/dev/null"),
    });
  });

  teardown(() => {
    manager.dispose();
  });

  async function openTestDoc(): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument({
      language: "clojure",
      content: "(ns races)\n(deftest my-test\n  (is true))",
    });
    return vscode.window.showTextDocument(doc);
  }

  const DEFTEST_RANGE = new vscode.Range(1, 0, 2, 12);

  test("report resolves the pending mark of the current run", async () => {
    const editor = await openTestDoc();
    manager.beginRun();
    const id = manager.track(editor.document, DEFTEST_RANGE);
    assert.deepStrictEqual(manager.marks(), []); // pending renders nothing
    manager.report(id, "pass", "{:pass 1}");
    assert.strictEqual(manager.marks().length, 1);
    assert.strictEqual(manager.marks()[0].status, "pass");
    assert.strictEqual(manager.marks()[0].line, 1);
  });

  test("a later beginRun supersedes an unresolved run", async () => {
    const editor = await openTestDoc();
    manager.beginRun();
    const staleId = manager.track(editor.document, DEFTEST_RANGE);
    manager.beginRun();
    const freshId = manager.track(editor.document, DEFTEST_RANGE);
    manager.report(staleId, "fail", "stale");
    assert.deepStrictEqual(manager.marks(), [], "a stale run must paint nothing");
    manager.report(freshId, "pass", "fresh");
    assert.strictEqual(manager.marks().length, 1);
    assert.strictEqual(manager.marks()[0].status, "pass");
  });

  test("two tracked marks of one run resolve independently", async () => {
    const editor = await openTestDoc();
    manager.beginRun();
    const first = manager.track(editor.document, new vscode.Range(1, 0, 1, 16));
    const second = manager.track(editor.document, DEFTEST_RANGE);
    manager.report(second, "fail", "boom");
    assert.strictEqual(manager.marks().length, 1, "the unresolved one stays invisible");
    assert.strictEqual(manager.marks()[0].status, "fail");
    manager.report(first, "pass", "{:pass 1}");
    assert.deepStrictEqual(
      manager.marks().map((mark) => mark.status),
      ["pass", "fail"],
    );
  });

  test("beginRun wipes every mark of the previous run", async () => {
    const editor = await openTestDoc();
    manager.beginRun();
    const first = manager.track(editor.document, new vscode.Range(1, 0, 1, 16));
    const second = manager.track(editor.document, DEFTEST_RANGE);
    manager.report(first, "pass", "{:pass 1}");
    manager.report(second, "fail", "boom");
    assert.strictEqual(manager.marks().length, 2);

    manager.beginRun();
    assert.deepStrictEqual(manager.marks(), []);
    manager.report(first, "pass", "late");
    manager.report(second, "pass", "late");
    assert.deepStrictEqual(manager.marks(), [], "superseded ids paint nothing");
  });

  test("an edit overlapping the deftest during the run drops the mark", async () => {
    const editor = await openTestDoc();
    manager.beginRun();
    const id = manager.track(editor.document, DEFTEST_RANGE);
    await editor.edit((edit) => {
      edit.replace(new vscode.Range(1, 9, 1, 16), "renamed-test");
    });
    manager.report(id, "pass", "late");
    assert.deepStrictEqual(manager.marks(), []);
  });

  test("an edit above the deftest shifts the mark instead", async () => {
    const editor = await openTestDoc();
    manager.beginRun();
    const id = manager.track(editor.document, DEFTEST_RANGE);
    await editor.edit((edit) => {
      edit.insert(new vscode.Position(0, 0), ";; note\n");
    });
    manager.report(id, "fail", "still valid");
    assert.strictEqual(manager.marks().length, 1);
    assert.strictEqual(manager.marks()[0].line, 2);
  });

  test("closing the document during the run drops the mark", async () => {
    const editor = await openTestDoc();
    const uri = editor.document.uri.toString();
    manager.beginRun();
    const id = manager.track(editor.document, DEFTEST_RANGE);
    const closed = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.toString() === uri) {
          sub.dispose();
          resolve();
        }
      });
    });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await closed;
    manager.report(id, "pass", "late");
    assert.deepStrictEqual(manager.marks(), []);
  });
});
