import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CommandStatusBar } from "../repl/commandStatusBar";
import { InlineResultsManager } from "../repl/inlineResults";
import { ReplRegistry } from "../repl/replRegistry";
import { ReplSessionLike } from "../repl/replSession";
import { TestStatusManager } from "../repl/testStatus";
import { TestStatusBar } from "../repl/testStatusBar";
import { startFakeNrepl, FakeNrepl } from "./fakeNreplServer";

const EXTENSION_ID = "abogoyavlensky.clojure-pulse";
/** The one configuration these tests connect through. */
const REPL_NAME = "commands";

interface ExtensionApi {
  repls: ReplRegistry;
  inlineResults: InlineResultsManager;
  testStatus: TestStatusManager;
  testStatusBar: TestStatusBar;
  commandStatusBar: CommandStatusBar;
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(condition(), `timed out waiting for ${what}`);
}

suite("REPL commands", () => {
  let api: ExtensionApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be present`);
    api = (await ext.activate()) as ExtensionApi;
    assert.ok(api?.repls, "activate() should expose the REPL registry");
  });

  teardown(async () => {
    // The extension is a singleton across tests; drop every session so one
    // test's connection and results do not leak into the next.
    for (const session of api.repls.sessions) {
      await session.stop();
    }
    await setConfigurations(undefined);
    await setReloadBeforeRun(undefined);
    await waitUntil(
      () => api.repls.sessions.length === 0,
      5000,
      "the configured sessions to be dropped",
    );
    api.inlineResults.clearAll();
  });

  async function setConfigurations(entries: unknown[] | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update(
        "replConfigurations",
        entries,
        // The test host opens no folder, so workspace settings are unavailable.
        vscode.ConfigurationTarget.Global,
      );
  }

  async function setReloadBeforeRun(value: string | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration("clojurePulse")
      .update("test.reloadBeforeRun", value, vscode.ConfigurationTarget.Global);
  }

  /** Brings up the configured REPL that points at `server`. */
  async function connect(server: FakeNrepl): Promise<ReplSessionLike> {
    await setConfigurations([
      { name: REPL_NAME, type: "connect", host: "127.0.0.1", port: server.port },
    ]);
    // Settings reach the registry through a configuration event.
    await waitUntil(
      () => api.repls.get(REPL_NAME) !== undefined,
      5000,
      `the "${REPL_NAME}" session to appear`,
    );

    await vscode.commands.executeCommand("clojurePulse.startRepl", REPL_NAME);
    const session = api.repls.get(REPL_NAME);
    assert.ok(session, `expected a session named "${REPL_NAME}"`);
    assert.strictEqual(session.state, "connected");
    return session;
  }

  test("registers the REPL commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "clojurePulse.connectRepl",
      "clojurePulse.disconnectRepl",
      "clojurePulse.startRepl",
      "clojurePulse.stopRepl",
      "clojurePulse.restartRepl",
      "clojurePulse.addReplConfig",
      "clojurePulse.editReplConfig",
      "clojurePulse.deleteReplConfig",
      "clojurePulse.setActiveRepl",
      "clojurePulse.showReplOutput",
      "clojurePulse.evalSelection",
      "clojurePulse.replMenu",
      "clojurePulse.evalCurrentForm",
      "clojurePulse.evalFile",
      "clojurePulse.runTestAtCursor",
      "clojurePulse.runNsTests",
      "clojurePulse.rerunLastTest",
      "clojurePulse.clearInlineResults",
      "clojurePulse.copyEvalResult",
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test("rerunLastTest before any test command sends nothing", async () => {
    // Deliberately placed before the first test that runs a test command:
    // the last-test record is module state in the extension host and
    // survives across tests, so "no prior run" only exists here.
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      await vscode.commands.executeCommand("clojurePulse.rerunLastTest");

      assert.ok(
        !server.received.some((m) => m.op === "eval" || m.op === "load-file"),
        "with no last test command there is nothing to send",
      );
    } finally {
      await server?.close();
    }
  });

  test("evalSelection without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.evalSelection");
  });

  test("evalCurrentForm without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");
  });

  test("evalCurrentForm evaluates the form at the cursor in its namespace", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns scratch)\n(+ 1 2)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      // Cursor at the end of line 1, right after the closing paren.
      editor.selection = new vscode.Selection(1, 7, 1, 7);

      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");

      const entries = session.transcript.entries();
      assert.ok(
        entries.some((e) => e.kind === "in" && e.text === "(+ 1 2)"),
        "expected an in entry for the form",
      );
      assert.ok(entries.some((e) => e.kind === "value" && e.text === "42"));
      const evalMsg = server.received.find((m) => m.op === "eval");
      assert.strictEqual(evalMsg?.ns, "scratch");
      assert.strictEqual(api.inlineResults.latest(), "42");
    } finally {
      await server?.close();
    }
  });

  test("Escape clears inline results (hasResults toggles)", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns scratch)\n(+ 1 2)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(1, 7, 1, 7);

      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");
      assert.strictEqual(api.inlineResults.hasResults(), true);

      // The Escape keybinding is bound to this command; invoke it directly.
      await vscode.commands.executeCommand("clojurePulse.clearInlineResults");
      assert.strictEqual(api.inlineResults.hasResults(), false);
    } finally {
      await server?.close();
    }
  });

  test("evalCurrentForm with no form at the cursor sends nothing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "   ",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 0, 0);

      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");

      assert.ok(!server.received.some((m) => m.op === "eval"));
    } finally {
      await server?.close();
    }
  });

  test("evalFile sends the buffer through the load-file op", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns scratch)\n(+ 1 2)",
      });
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand("clojurePulse.evalFile");

      const loadMsg = server.received.find((m) => m.op === "load-file");
      assert.ok(loadMsg, "expected a load-file op");
      assert.ok(String(loadMsg.file).includes("(+ 1 2)"));
    } finally {
      await server?.close();
    }
  });

  // Evaluate File never reveals the output panel, so the shared status slot is
  // its only immediate feedback. The slot is shared with test runs and custom
  // commands — within a test, the last run of any kind is this command's.
  test("evalFile reports a successful load in the status bar", async () => {
    let server: FakeNrepl | undefined;
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "pulse-evalfile-")),
      "verdict.clj",
    );
    try {
      server = await startFakeNrepl();
      await connect(server);
      fs.writeFileSync(file, "(ns verdict)\n(+ 1 2)");

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("clojurePulse.evalFile");

      const view = api.commandStatusBar.current();
      assert.ok(view, "expected a status bar verdict for the load");
      assert.strictEqual(view.text, "$(check) verdict.clj");
      assert.strictEqual(view.backgroundColor, undefined);
    } finally {
      await server?.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  test("evalFile reports a failed load in the status bar", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      // Only load-file matters now; the handshake is already done.
      server.respond((msg, reply) => {
        if (msg.op === "load-file") {
          reply({ session: msg.session, err: "Syntax error: EOF while reading" });
        }
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns broken)\n(+ 1",
      });
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand("clojurePulse.evalFile");

      const view = api.commandStatusBar.current();
      assert.ok(view, "expected a status bar verdict for the failed load");
      assert.ok(view.text.endsWith("— failed"), view.text);
      assert.strictEqual(view.backgroundColor, "statusBarItem.errorBackground");
      assert.ok(view.tooltip.includes("Syntax error"), view.tooltip);
    } finally {
      await server?.close();
    }
  });

  test("evalFile never reveals the output channel, and evalCurrentForm keeps focus", async () => {
    let server: FakeNrepl | undefined;
    const inline = vscode.workspace.getConfiguration("clojurePulse");
    try {
      server = await startFakeNrepl();
      const session = await connect(server);
      // Spy on the live session the commands resolve through, so this sees
      // exactly what the extension does at runtime.
      const reveals: Array<boolean | undefined> = [];
      const original = session.showOutput.bind(session);
      session.showOutput = (preserveFocus?: boolean) => {
        reveals.push(preserveFocus);
        original(preserveFocus);
      };

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns quiet)\n(+ 1 2)",
      });
      const editor = await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand("clojurePulse.evalFile");
      assert.deepStrictEqual(reveals, [], "Evaluate File must stay silent");

      // Inline results carry the value, so the panel stays shut here too.
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");
      assert.deepStrictEqual(reveals, [], "inline results mean no reveal");

      // With them off the channel is the only place a value lands — revealed,
      // but never taking focus from the editor.
      await inline.update("inlineEvalResults", false, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand("clojurePulse.evalCurrentForm");
      assert.deepStrictEqual(reveals, [true], "reveal without stealing focus");
    } finally {
      await inline.update(
        "inlineEvalResults",
        undefined,
        vscode.ConfigurationTarget.Global,
      );
      await server?.close();
    }
  });

  test("showReplOutput reveals a session's channel without throwing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);
      await vscode.commands.executeCommand(
        "clojurePulse.showReplOutput",
        session.name,
      );
    } finally {
      await server?.close();
    }
  });

  test("connect + evalSelection round-trips through a running nREPL", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(+ 20 22)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(0, 0, 0, doc.lineAt(0).text.length);

      await vscode.commands.executeCommand("clojurePulse.evalSelection");

      const entries = session.transcript.entries();
      const inEntry = entries.find((e) => e.kind === "in");
      const valueEntry = entries.find((e) => e.kind === "value");
      assert.strictEqual(inEntry?.text, "(+ 20 22)");
      assert.strictEqual(valueEntry?.text, "42");
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");
  });

  test("runTestAtCursor redefines the deftest then runs it in its namespace", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      // Cursor inside the deftest body.
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      // Reload what changed on disk → probe (ns already loaded here) → align
      // the ns for let-go → define → run. let-go's nREPL ignores the eval
      // `ns` param, so the explicit in-ns eval is what puts the definition in
      // the file's namespace there.
      const evals = server.received.filter((m) => m.op === "eval");
      assert.strictEqual(
        evals.length,
        5,
        "expected reload + probe + in-ns + define + run",
      );
      assert.ok(String(evals[0].code).includes("clj-reload.core/reload"));
      assert.ok(String(evals[1].code).includes("find-ns 'my.app-test"));
      assert.strictEqual(evals[2].code, "(in-ns 'my.app-test)");
      // The ns param keeps the JVM session's own *ns* binding untouched.
      assert.strictEqual(evals[2].ns, "my.app-test");
      assert.strictEqual(evals[3].code, "(deftest my-test\n  (is true))");
      assert.strictEqual(evals[3].ns, "my.app-test");
      assert.ok(String(evals[4].code).includes("run-test-var"));
      assert.ok(String(evals[4].code).includes("#'my-test"));
      // The fallback must reference only vars that exist on let-go too, whose
      // compiler resolves both branches eagerly.
      assert.ok(String(evals[4].code).includes("clojure.test/*report-counters*"));
      assert.ok(!String(evals[4].code).includes("*initial-report-counters*"));
      assert.strictEqual(evals[4].ns, "my.app-test");
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor outside a deftest sends nothing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(defn helper [] 1)",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(1, 8, 1, 8);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      assert.ok(!server.received.some((m) => m.op === "eval"));
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor auto-loads the file when the namespace is missing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      // The find-ns probe reports the namespace missing until a load-file
      // arrives (the status-based namespace-not-found signal is JVM-only —
      // let-go never sends it, so the command must not rely on it).
      let loaded = false;
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("find-ns")) {
          reply({ session: msg.session, value: loaded ? "true" : "false" });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        if (msg.op === "load-file") {
          loaded = true;
        }
        reply({ session: msg.session, value: "42" });
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const ops = server.received
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, [
        "eval",
        "eval",
        "load-file",
        "eval",
        "eval",
        "eval",
      ]);
      const loadMsg = server.received.find((m) => m.op === "load-file");
      assert.ok(String(loadMsg?.file).includes("(deftest my-test"));
      const evals = server.received.filter((m) => m.op === "eval");
      assert.ok(String(evals[0].code).includes("clj-reload.core/reload"));
      assert.strictEqual(evals[2].code, "(in-ns 'my.app-test)");
      assert.strictEqual(evals[3].code, "(deftest my-test\n  (is true))");
      assert.strictEqual(evals[3].ns, "my.app-test");
      assert.ok(String(evals[4].code).includes("run-test-var"));
      assert.strictEqual(evals[4].ns, "my.app-test");
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor stops when the auto-load itself fails", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("find-ns")) {
          reply({ session: msg.session, value: "false" });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        if (msg.op === "load-file") {
          reply({ session: msg.session, err: "file does not compile" });
        }
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const ops = server.received
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, ["eval", "eval", "load-file"]);
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor does not run the test when defining it fails", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      // Probe and in-ns succeed; only the deftest define itself errors.
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("deftest")) {
          reply({ session: msg.session, err: "boom" });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        reply({ session: msg.session, value: "true" });
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const evals = server.received.filter((m) => m.op === "eval");
      assert.ok(
        !evals.some((m) => String(m.code).includes("run-test-var")),
        "the failed define must stop the run",
      );
      // The pending gutter mark never resolves — no verdict is painted.
      assert.deepStrictEqual(api.testStatus.marks(), []);
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor paints a green gutter mark on a passing run", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const marks = api.testStatus.marks();
      assert.strictEqual(marks.length, 1);
      assert.strictEqual(marks[0].status, "pass");
      assert.strictEqual(marks[0].line, 1);
      assert.strictEqual(marks[0].uri, doc.uri.toString());
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor paints a red mark with the failure report on hover", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("run-test-var")) {
          reply({ session: msg.session, out: "FAIL in (my-test)\nexpected: (= 1 2)\n" });
          reply({
            session: msg.session,
            value: "{:test 1, :pass 0, :fail 1, :error 0, :type :summary}",
          });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        reply({ session: msg.session, value: "true" });
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is (= 1 2)))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const marks = api.testStatus.marks();
      assert.strictEqual(marks.length, 1);
      assert.strictEqual(marks[0].status, "fail");
      assert.ok(marks[0].hover.includes("FAIL in (my-test)"));
    } finally {
      await server?.close();
    }
  });

  test("a new test command wipes the previous run's marks", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const first = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns first-ns)\n(deftest first-test (is true))",
      });
      let editor = await vscode.window.showTextDocument(first);
      editor.selection = new vscode.Selection(1, 12, 1, 12);
      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");
      assert.strictEqual(api.testStatus.marks().length, 1);

      const second = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns second-ns)\n(deftest second-test (is true))",
      });
      editor = await vscode.window.showTextDocument(second);
      editor.selection = new vscode.Selection(1, 12, 1, 12);
      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const marks = api.testStatus.marks();
      assert.strictEqual(marks.length, 1, "only the last command's report remains");
      assert.strictEqual(marks[0].uri, second.uri.toString());
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor aborts when the reload fails", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("clj-reload.core/reload")) {
          reply({
            session: msg.session,
            value:
              '{:failed app.core, :message "Syntax error compiling at (src/app/core.clj:3:1).: boom"}',
          });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        reply({ session: msg.session, value: "true" });
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      // A namespace that does not compile makes every later eval meaningless.
      const ops = server.received
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, ["eval"]);
      assert.strictEqual(api.testStatusBar.current(), undefined);
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor runs on without clj-reload on the classpath", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("clj-reload.core/reload")) {
          reply({ session: msg.session, value: ":clojure-pulse/no-reload" });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        reply({ session: msg.session, value: "true" });
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      const evals = server.received.filter((m) => m.op === "eval");
      assert.ok(String(evals[0].code).includes("clj-reload.core/reload"));
      assert.ok(
        evals.some((m) => String(m.code).includes("run-test-var")),
        "a missing clj-reload must not stop the run",
      );
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor sends no reload at all when the setting is none", async () => {
    let server: FakeNrepl | undefined;
    try {
      await setReloadBeforeRun("none");
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      assert.ok(
        !server.received.some((m) => String(m.code ?? "").includes("clj-reload")),
        "none means no reload traffic",
      );
      const evals = server.received.filter((m) => m.op === "eval");
      assert.strictEqual(evals.length, 4, "the old probe + in-ns + define + run");
    } finally {
      await server?.close();
    }
  });

  test("runTestAtCursor saves dirty Clojure files before it reloads", async () => {
    let server: FakeNrepl | undefined;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clojure-pulse-reload-"));
    const file = path.join(dir, "core.clj");
    fs.writeFileSync(file, "(ns app.core)\n(defn add [a b] (+ a b))\n");
    try {
      server = await startFakeNrepl();
      await connect(server);
      // clj-reload reads from disk, so an unsaved edit would be invisible
      // to it — the save has to land before the reload eval goes out.
      let dirtyAtReload: boolean | undefined;
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("clj-reload.core/reload")) {
          dirtyAtReload = source.isDirty;
        }
        reply({ session: msg.session, value: "true" });
        reply({ session: msg.session, status: ["done"] });
      });

      const source = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const sourceEditor = await vscode.window.showTextDocument(source);
      await sourceEditor.edit((edit) => {
        edit.insert(new vscode.Position(1, 0), ";; edited\n");
      });
      assert.ok(source.isDirty, "the edit should leave the document dirty");

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);

      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      assert.strictEqual(dirtyAtReload, false, "the file must be on disk by then");
    } finally {
      await server?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runNsTests without a connection warns instead of throwing", async () => {
    await vscode.commands.executeCommand("clojurePulse.runNsTests");
  });

  test("runNsTests loads the buffer then runs every deftest in order", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content:
          "(ns my.app-test)\n(deftest first-test\n  (is true))\n" +
          "(defn helper [] 1)\n(deftest second-test\n  (is true))\n",
      });
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand("clojurePulse.runNsTests");

      // What changed on disk is reloaded first, then the buffer is loaded
      // once, the namespace aligned once (let-go ignores the eval `ns`
      // param), then one runner eval per deftest.
      const ops = server.received
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, ["eval", "load-file", "eval", "eval", "eval"]);
      const loadMsg = server.received.find((m) => m.op === "load-file");
      assert.ok(String(loadMsg?.file).includes("(deftest second-test"));
      const evals = server.received.filter((m) => m.op === "eval");
      assert.ok(String(evals[0].code).includes("clj-reload.core/reload"));
      assert.strictEqual(evals[1].code, "(in-ns 'my.app-test)");
      assert.strictEqual(evals[1].ns, "my.app-test");
      assert.ok(String(evals[2].code).includes("#'first-test"));
      assert.strictEqual(evals[2].ns, "my.app-test");
      assert.ok(String(evals[3].code).includes("#'second-test"));
      assert.strictEqual(evals[3].ns, "my.app-test");

      // One gutter mark per deftest, on its own first line.
      const marks = api.testStatus.marks();
      assert.strictEqual(marks.length, 2);
      assert.deepStrictEqual(
        marks.map((mark) => ({ line: mark.line, status: mark.status })),
        [
          { line: 1, status: "pass" },
          { line: 4, status: "pass" },
        ],
      );
      assert.ok(marks.every((mark) => mark.uri === doc.uri.toString()));

      const bar = api.testStatusBar.current();
      assert.ok(bar?.text.includes("my.app-test"), `unexpected bar: ${bar?.text}`);
      assert.ok(bar?.text.includes("testing-passed-icon"));
    } finally {
      await server?.close();
    }
  });

  test("runNsTests marks the failing test and sums the counts in the status bar", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "eval" && String(msg.code).includes("#'second-test")) {
          reply({ session: msg.session, out: "FAIL in (second-test)\nexpected: (= 1 2)\n" });
          reply({
            session: msg.session,
            value: "{:test 1, :pass 0, :fail 1, :error 0, :type :summary}",
          });
          reply({ session: msg.session, status: ["done"] });
          return;
        }
        reply({
          session: msg.session,
          value: "{:test 1, :pass 1, :fail 0, :error 0, :type :summary}",
        });
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content:
          "(ns my.app-test)\n(deftest first-test\n  (is true))\n" +
          "(deftest second-test\n  (is (= 1 2)))\n",
      });
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand("clojurePulse.runNsTests");

      const marks = api.testStatus.marks();
      assert.strictEqual(marks.length, 2);
      assert.deepStrictEqual(
        marks.map((mark) => mark.status),
        ["pass", "fail"],
      );
      assert.ok(marks[1].hover.includes("FAIL in (second-test)"));

      const bar = api.testStatusBar.current();
      assert.ok(bar?.text.includes("testing-failed-icon"), `unexpected bar: ${bar?.text}`);
      assert.ok(bar?.text.includes("my.app-test — 1 fail"), `unexpected bar: ${bar?.text}`);
    } finally {
      await server?.close();
    }
  });

  test("runNsTests with no deftests in the buffer sends nothing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(defn helper [] 1)\n#_(deftest skipped (is true))",
      });
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand("clojurePulse.runNsTests");

      assert.ok(
        !server.received.some((m) => m.op === "eval" || m.op === "load-file"),
        "a buffer with no runnable deftests must not load or eval anything",
      );
    } finally {
      await server?.close();
    }
  });

  test("runNsTests stops when the load itself fails", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);
      server.respond((msg, reply) => {
        if (msg.op === "load-file") {
          reply({ session: msg.session, err: "file does not compile" });
        }
        reply({ session: msg.session, status: ["done"] });
      });

      const doc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest first-test\n  (is true))\n",
      });
      await vscode.window.showTextDocument(doc);

      await vscode.commands.executeCommand("clojurePulse.runNsTests");

      const ops = server.received
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, ["eval", "load-file"]);
      // The pending marks never resolve, and the status bar is cleared.
      assert.deepStrictEqual(api.testStatus.marks(), []);
      assert.strictEqual(api.testStatusBar.current(), undefined);
    } finally {
      await server?.close();
    }
  });

  test("rerunLastTest repeats the last single-test run from another file", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const testDoc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(testDoc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);
      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      // Switch to a business-logic buffer; the rerun must not need the test
      // file to be active — that is the point of the command.
      const other = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app)\n(defn add [a b] (+ a b))",
      });
      await vscode.window.showTextDocument(other);

      const before = server.received.length;
      await vscode.commands.executeCommand("clojurePulse.rerunLastTest");

      const evals = server.received
        .slice(before)
        .filter((m) => m.op === "eval");
      assert.strictEqual(
        evals.length,
        5,
        "reload + probe + in-ns + define + run again",
      );
      assert.ok(String(evals[0].code).includes("clj-reload.core/reload"));
      assert.strictEqual(evals[3].code, "(deftest my-test\n  (is true))");
      assert.ok(String(evals[4].code).includes("#'my-test"));

      // Focus never left the business-logic buffer.
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        other.uri.toString(),
      );

      // The verdict lands on the test file and in the status bar as usual.
      const marks = api.testStatus.marks();
      assert.strictEqual(marks.length, 1);
      assert.strictEqual(marks[0].uri, testDoc.uri.toString());
      assert.strictEqual(marks[0].status, "pass");
      const bar = api.testStatusBar.current();
      assert.ok(bar?.text.includes("my-test"), `unexpected bar: ${bar?.text}`);
      assert.ok(bar?.text.includes("testing-passed-icon"));
    } finally {
      await server?.close();
    }
  });

  test("rerunLastTest repeats the last namespace run", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const testDoc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content:
          "(ns my.app-test)\n(deftest first-test\n  (is true))\n" +
          "(deftest second-test\n  (is true))\n",
      });
      await vscode.window.showTextDocument(testDoc);
      await vscode.commands.executeCommand("clojurePulse.runNsTests");

      const other = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app)\n(defn add [a b] (+ a b))",
      });
      await vscode.window.showTextDocument(other);

      const before = server.received.length;
      await vscode.commands.executeCommand("clojurePulse.rerunLastTest");

      const ops = server.received
        .slice(before)
        .filter((m) => m.op === "eval" || m.op === "load-file")
        .map((m) => m.op);
      assert.deepStrictEqual(ops, ["eval", "load-file", "eval", "eval", "eval"]);

      const marks = api.testStatus.marks();
      assert.strictEqual(marks.length, 2);
      assert.ok(marks.every((mark) => mark.uri === testDoc.uri.toString()));
      const bar = api.testStatusBar.current();
      assert.ok(bar?.text.includes("my.app-test"), `unexpected bar: ${bar?.text}`);
      assert.ok(bar?.text.includes("testing-passed-icon"));
    } finally {
      await server?.close();
    }
  });

  test("rerunLastTest after renaming the deftest sends nothing", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      await connect(server);

      const testDoc = await vscode.workspace.openTextDocument({
        language: "clojure",
        content: "(ns my.app-test)\n(deftest my-test\n  (is true))",
      });
      const editor = await vscode.window.showTextDocument(testDoc);
      editor.selection = new vscode.Selection(2, 4, 2, 4);
      await vscode.commands.executeCommand("clojurePulse.runTestAtCursor");

      // The recorded identity is namespace + name; renaming breaks it.
      await editor.edit((edit) => {
        edit.replace(new vscode.Range(1, 9, 1, 16), "other-test");
      });

      const before = server.received.length;
      await vscode.commands.executeCommand("clojurePulse.rerunLastTest");

      assert.ok(
        !server.received.slice(before).some((m) => m.op === "eval"),
        "a renamed deftest must not be guessed at",
      );
    } finally {
      await server?.close();
    }
  });

  test("disconnecting stops the REPL and clears the eval target", async () => {
    let server: FakeNrepl | undefined;
    try {
      server = await startFakeNrepl();
      const session = await connect(server);
      assert.strictEqual(api.repls.active?.name, session.name);

      await vscode.commands.executeCommand("clojurePulse.disconnectRepl");

      assert.strictEqual(api.repls.active, undefined);
      // The row stays: it is a configuration, and configurations do not come
      // and go with their connections.
      assert.strictEqual(api.repls.get(session.name)?.state, "stopped");
    } finally {
      await server?.close();
    }
  });
});
