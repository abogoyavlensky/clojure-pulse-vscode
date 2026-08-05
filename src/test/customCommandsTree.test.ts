import * as assert from "assert";
import * as vscode from "vscode";
import { CustomReplCommand } from "../repl/customCommands";
import {
  CustomCommandsTreeProvider,
  CustomCommandTreeNode,
} from "../repl/customCommandsTree";

function provider(commands: CustomReplCommand[]): {
  tree: CustomCommandsTreeProvider;
  set: (next: CustomReplCommand[]) => void;
} {
  let current = commands;
  const tree = new CustomCommandsTreeProvider({ readCommands: () => current });
  return {
    tree,
    set: (next) => {
      current = next;
    },
  };
}

const reset: CustomReplCommand = { name: "reset", code: "(user/reset)" };
const restart: CustomReplCommand = {
  name: "restart",
  code: "(do\n  (user/stop)\n  (user/start))",
};

suite("CustomCommandsTreeProvider", () => {
  test("lists one node per command, in settings order", async () => {
    const { tree } = provider([reset, restart]);
    const nodes = await tree.getChildren();
    assert.deepStrictEqual(nodes, [{ name: "reset" }, { name: "restart" }]);
  });

  test("a node has no children", async () => {
    const { tree } = provider([reset]);
    assert.deepStrictEqual(await tree.getChildren({ name: "reset" }), []);
  });

  test("renders a command's presentation onto the tree item", () => {
    const { tree } = provider([reset, restart]);
    const item = tree.getTreeItem({ name: "restart" });

    assert.strictEqual(item.label, "restart");
    assert.strictEqual(item.description, "(do");
    assert.strictEqual(item.tooltip, restart.code);
    assert.strictEqual(item.contextValue, "customReplCommand");
    assert.deepStrictEqual(item.iconPath, new vscode.ThemeIcon("code"));
  });

  test("clicking a row opens the edit form, not the runner", () => {
    const { tree } = provider([reset]);
    const item = tree.getTreeItem({ name: "reset" });

    assert.strictEqual(item.command?.command, "clojurePulse.editCustomReplCommand");
    assert.deepStrictEqual(item.command?.arguments, [{ name: "reset" }]);
  });

  test("a node whose command vanished renders bare instead of throwing", () => {
    const { tree, set } = provider([reset]);
    set([]);
    const item = tree.getTreeItem({ name: "reset" });
    assert.strictEqual(item.label, "reset");
    assert.strictEqual(item.contextValue, undefined);
  });

  test("refresh fires onDidChangeTreeData", () => {
    const { tree } = provider([reset]);
    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    tree.refresh();
    assert.strictEqual(fired, 1);
  });

  test("getChildren re-reads the commands after a refresh", async () => {
    const { tree, set } = provider([reset]);
    set([reset, restart]);
    tree.refresh();
    const nodes = (await tree.getChildren()) as CustomCommandTreeNode[];
    assert.deepStrictEqual(
      nodes.map((node) => node.name),
      ["reset", "restart"],
    );
  });
});
