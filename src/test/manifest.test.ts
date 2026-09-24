import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

/**
 * Pins the command palette surface. The palette is the part of the manifest
 * users meet by name, and it grows one entry at a time unless something says
 * what it is supposed to be. "Visible" means contributed under `commands` and
 * not hidden by a `commandPalette` entry with `"when": "false"`.
 */

const REPO_ROOT = path.join(__dirname, "..", "..");

interface Contributes {
  commands: { command: string; title: string; category: string }[];
  menus: { commandPalette: { command: string; when?: string }[] };
  keybindings: { command: string; key: string }[];
  configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> };
}

interface Manifest {
  keywords?: string[];
  cljPulseVersion?: string;
  extensionKind?: string[];
  contributes: Contributes;
}

function manifest(): Manifest {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as Manifest;
}

function contributes(): Contributes {
  return manifest().contributes;
}

const PALETTE = [
  "clojurePulse.restart",
  "clojurePulse.showOutput",
  "clojurePulse.startRepl",
  "clojurePulse.stopRepl",
  "clojurePulse.restartRepl",
  "clojurePulse.addReplConfig",
  "clojurePulse.editReplConfig",
  "clojurePulse.setActiveRepl",
  "clojurePulse.showReplOutput",
  "clojurePulse.evalCurrentForm",
  "clojurePulse.evalTopForm",
  "clojurePulse.evalFile",
  "clojurePulse.copyEvalResult",
  "clojurePulse.clearStatusBar",
  "clojurePulse.runTestAtCursor",
  "clojurePulse.runNsTests",
  "clojurePulse.rerunLastTest",
  "clojurePulse.runCustomReplCommand",
  "clojurePulse.addCustomReplCommand",
  "clojurePulse.editCustomReplCommand",
  "clojurePulse.refreshExternalLibraries",
  "clojurePulse.showClojureDocs",
];

suite("manifest", () => {
  test("the command palette shows exactly the commands users reach for by name", () => {
    const c = contributes();
    const hidden = new Set(
      c.menus.commandPalette.filter((m) => m.when === "false").map((m) => m.command),
    );
    const visible = c.commands.map((x) => x.command).filter((id) => !hidden.has(id));
    assert.deepStrictEqual(visible.sort(), [...PALETTE].sort());
  });

  test("keybinding-only commands are bound but not contributed", () => {
    const c = contributes();
    const contributed = new Set(c.commands.map((x) => x.command));
    const bound = new Set(c.keybindings.map((k) => k.command));
    for (const id of ["clojurePulse.newline", "clojurePulse.clearInlineResults"]) {
      assert.ok(bound.has(id), `${id} should have a default keybinding`);
      assert.ok(!contributed.has(id), `${id} should not be listed under commands`);
    }
  });

  test("the clear status bar command has its palette label", () => {
    const command = contributes().commands.find((c) => c.command === "clojurePulse.clearStatusBar");
    assert.ok(command, "expected the Clear status bar command");
    assert.strictEqual(command.title, "Clear status bar");
    assert.strictEqual(command.category, "Clojure Pulse");
  });

  test("the line comment setting offers ; and ;; with ; as default", () => {
    const setting = contributes().configuration.properties["clojurePulse.lineComment"];
    assert.ok(setting, "expected the clojurePulse.lineComment setting");
    assert.deepStrictEqual(setting.enum, [";", ";;"]);
    assert.strictEqual(setting.default, ";");
  });

  test("the language server commands say which server they mean", () => {
    const titles = new Map(contributes().commands.map((x) => [x.command, x.title]));
    assert.strictEqual(titles.get("clojurePulse.restart"), "Restart Language Server");
    assert.strictEqual(titles.get("clojurePulse.showOutput"), "Show Language Server Output");
  });

  test("the listing keeps its search keywords", () => {
    assert.ok(manifest().keywords?.includes("clojure"), "expected clojure among the keywords");
  });

  test("the clj-pulse pin is a plain semver, read by CI and Make with node -p", () => {
    assert.match(manifest().cljPulseVersion ?? "", /^\d+\.\d+\.\d+$/);
  });

  test("the extension runs where the files are, so the bundled server can too", () => {
    assert.deepStrictEqual(manifest().extensionKind, ["workspace"]);
  });

  test("the server path defaults to empty, which means the bundled server", () => {
    const setting = contributes().configuration.properties["clojurePulse.server.path"];
    assert.ok(setting, "expected the clojurePulse.server.path setting");
    assert.strictEqual(setting.default, "");
  });
});
