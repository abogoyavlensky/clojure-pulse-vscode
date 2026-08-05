/**
 * The REPL Commands view in the sidebar: one row per configured command.
 * Settings-driven, unlike the registry-driven REPL view — the provider
 * re-reads the parsed setting on every paint, and the configuration listener
 * calls `refresh()` when the setting changes. Presentation is the pure
 * `presentCustomCommand`, so this class only maps it onto VS Code's tree API.
 *
 * A row's click opens the *edit form*; running is the inline play action
 * only, so a misclick can never evaluate stateful code.
 */

import * as vscode from "vscode";
import { CustomReplCommand, presentCustomCommand } from "./customCommands";

/** What the tree needs from the extension: the parsed, warned-about setting. */
export interface CustomCommandsTreeSource {
  readCommands: () => CustomReplCommand[];
}

/** A tree row. Commands accept this or a plain name, hence the `name` field. */
export interface CustomCommandTreeNode {
  name: string;
}

export class CustomCommandsTreeProvider
  implements vscode.TreeDataProvider<CustomCommandTreeNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly source: CustomCommandsTreeSource) {}

  /** Repaints the view — called when the setting changes. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: CustomCommandTreeNode): vscode.TreeItem {
    const command = this.source
      .readCommands()
      .find((candidate) => candidate.name === node.name);
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    if (!command) {
      return item; // removed between the repaint and this call
    }
    const view = presentCustomCommand(command);
    item.label = view.label;
    item.description = view.description;
    item.tooltip = view.tooltip;
    item.contextValue = view.contextValue;
    item.iconPath = new vscode.ThemeIcon("code");
    item.command = {
      command: "clojurePulse.editCustomReplCommand",
      title: "Edit Custom REPL Command",
      arguments: [{ name: command.name }],
    };
    return item;
  }

  getChildren(node?: CustomCommandTreeNode): Thenable<CustomCommandTreeNode[]> {
    // Flat list: a command has no children.
    return Promise.resolve(
      node
        ? []
        : this.source.readCommands().map((command) => ({ name: command.name })),
    );
  }
}
