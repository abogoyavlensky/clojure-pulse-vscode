/**
 * The REPL view in the sidebar: one row per configured REPL. Presentation is a
 * pure function of a session's config and state
 * so it can be unit-tested; `ReplTreeProvider` only maps that onto VS Code's
 * tree API and repaints when the registry changes.
 */

import * as vscode from "vscode";
import { ReplConnectionInfo } from "./connectionManager";
import { ReplConfig } from "./replConfig";
import { ReplSessionState } from "./replSession";

/** What presentation needs from a session — the real one satisfies it. */
export interface SessionView {
  readonly name: string;
  readonly config: ReplConfig;
  readonly state: ReplSessionState;
  readonly connectionInfo: ReplConnectionInfo | undefined;
}

/** What the tree needs from the registry. */
export interface ReplTreeSource {
  readonly sessions: SessionView[];
  readonly active: SessionView | undefined;
  onDidChange(listener: () => void): void;
}

export interface ReplTreeItemView {
  label: string;
  description: string;
  /** `ThemeIcon` id. */
  icon: string;
  tooltip: string;
  /** Drives which inline actions the view shows (see package.json menus). */
  contextValue: string;
}

/** A tree row. Commands accept this or a plain name, hence the `name` field. */
export interface ReplTreeNode {
  name: string;
}

export function presentSession(
  session: SessionView,
  options: { isActive: boolean },
): ReplTreeItemView {
  return {
    label: session.name,
    description: describeState(session),
    icon: iconFor(session, options.isActive),
    tooltip: tooltipFor(session),
    contextValue: contextValueFor(session),
  };
}

function describeState(session: SessionView): string {
  switch (session.state) {
    case "stopped":
      return "stopped";
    case "starting":
      return "starting";
    case "connecting":
      return "connecting";
    case "connected":
      return session.connectionInfo
        ? `connected :${session.connectionInfo.port}`
        : "connected";
  }
}

function iconFor(session: SessionView, isActive: boolean): string {
  if (session.state === "starting" || session.state === "connecting") {
    return "loading~spin";
  }
  if (session.state === "stopped") {
    return "debug-disconnect";
  }
  // Connected: the eval target is the filled one.
  return isActive ? "circle-filled" : "circle-outline";
}

function tooltipFor(session: SessionView): string {
  if (session.config.type === "create") {
    return `${session.name} — ${session.config.command}`;
  }
  const { host, port } = session.config;
  return typeof port === "number"
    ? `${session.name} — ${host}:${port}`
    : `${session.name} — ${host}, port from ${port}`;
}

function contextValueFor(session: SessionView): string {
  if (session.config.type === "create") {
    return session.state === "stopped" ? "replCreateStopped" : "replCreateRunning";
  }
  return session.state === "stopped" ? "replConnectStopped" : "replConnectConnected";
}

export class ReplTreeProvider implements vscode.TreeDataProvider<ReplTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly source: ReplTreeSource) {
    source.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: ReplTreeNode): vscode.TreeItem {
    const session = this.source.sessions.find((s) => s.name === node.name);
    const item = new vscode.TreeItem(
      node.name,
      vscode.TreeItemCollapsibleState.None,
    );
    if (!session) {
      return item; // removed between the repaint and this call
    }
    const view = presentSession(session, {
      isActive: this.source.active?.name === session.name,
    });
    item.label = view.label;
    item.description = view.description;
    item.tooltip = view.tooltip;
    item.iconPath = new vscode.ThemeIcon(view.icon);
    item.contextValue = view.contextValue;
    item.command = {
      command: "clojurePulse.showReplOutput",
      title: "Show REPL Output",
      arguments: [session.name],
    };
    return item;
  }

  getChildren(node?: ReplTreeNode): Thenable<ReplTreeNode[]> {
    // Flat list: a REPL has no children.
    return Promise.resolve(
      node ? [] : this.source.sessions.map((session) => ({ name: session.name })),
    );
  }
}
