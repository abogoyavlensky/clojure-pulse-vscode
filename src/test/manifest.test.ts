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
  commands: { command: string; title: string }[];
  menus: { commandPalette: { command: string; when?: string }[] };
  keybindings: { command: string; key: string }[];
}

function contributes(): Contributes {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
  return (JSON.parse(raw) as { contributes: Contributes }).contributes;
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
  "clojurePulse.evalFile",
  "clojurePulse.copyEvalResult",
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

  test("the language server commands say which server they mean", () => {
    const titles = new Map(contributes().commands.map((x) => [x.command, x.title]));
    assert.strictEqual(titles.get("clojurePulse.restart"), "Restart Language Server");
    assert.strictEqual(titles.get("clojurePulse.showOutput"), "Show Language Server Output");
  });
});
