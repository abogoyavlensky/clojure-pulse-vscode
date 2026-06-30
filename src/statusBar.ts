import * as vscode from "vscode";

/** High-level server status shown to the user, decoupled from the LSP State enum. */
export type ServerStatus = "starting" | "running" | "stopped" | "error";

export interface ServerInfo {
  name?: string;
  version?: string;
}

export interface StatusDetail {
  serverInfo?: ServerInfo;
  /** The resolved server command, shown in the tooltip when running. */
  command?: string;
  /** A short reason, shown in the tooltip for the error state. */
  message?: string;
}

export interface StatusView {
  text: string;
  tooltip: string;
  error: boolean;
}

/**
 * Pure mapping from a server status to what the status-bar item should render.
 * Kept free of any `vscode` calls so it is trivially unit-testable.
 */
export function statusPresentation(
  status: ServerStatus,
  detail: StatusDetail = {},
): StatusView {
  switch (status) {
    case "starting":
      return {
        text: "$(loading~spin) clj-pulse",
        tooltip: "Clojure Pulse: starting the language server…",
        error: false,
      };
    case "running": {
      const version = detail.serverInfo?.version ? ` v${detail.serverInfo.version}` : "";
      const where = detail.command ? `\n${detail.command}` : "";
      return {
        text: "$(pulse) clj-pulse",
        tooltip: `Clojure Pulse: running${version}${where}`,
        error: false,
      };
    }
    case "stopped":
      return {
        text: "$(circle-slash) clj-pulse",
        tooltip: "Clojure Pulse: server stopped — click to view output",
        error: false,
      };
    case "error":
      return {
        text: "$(error) clj-pulse",
        tooltip: `Clojure Pulse: ${detail.message ?? "server unavailable"} — click to view output`,
        error: true,
      };
  }
}

export interface StatusBar {
  update(status: ServerStatus, detail?: StatusDetail): void;
  dispose(): void;
}

/**
 * Creates a left-aligned status-bar item (sitting by the git/diagnostics area)
 * that clicking opens the server output channel.
 */
export function createStatusBar(): StatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.name = "Clojure Pulse";
  item.command = "clojurePulse.showOutput";

  return {
    update(status, detail) {
      const view = statusPresentation(status, detail);
      item.text = view.text;
      item.tooltip = view.tooltip;
      item.backgroundColor = view.error
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : undefined;
      item.show();
    },
    dispose() {
      item.dispose();
    },
  };
}
