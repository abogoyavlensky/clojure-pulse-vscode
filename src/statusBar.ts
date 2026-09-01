import * as vscode from "vscode";

/** High-level server status shown to the user, decoupled from the LSP State enum. */
export type ServerStatus = "starting" | "running" | "stopped" | "error";

export interface ServerInfo {
  name?: string;
  version?: string;
}

/** Which lint engines the server has live, from `clojurePulse/lintStatus`. */
export interface LintStatus {
  engine: "kondo+native" | "native";
  /** The clj-kondo version, when the server found one. */
  version?: string;
  /** Whether a clj-kondo dependency-cache scan is running right now. */
  warming?: boolean;
}

export interface StatusDetail {
  serverInfo?: ServerInfo;
  /** The resolved server command, shown in the tooltip when running. */
  command?: string;
  /** A short reason, shown in the tooltip for the error state. */
  message?: string;
  /**
   * The lint engine, shown as an extra tooltip line when running. Absent for
   * servers older than the clj-kondo bridge, which never send the
   * notification - the tooltip then reads exactly as it always did.
   */
  lint?: LintStatus;
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
      const lint = detail.lint ? `\n${lintLine(detail.lint)}` : "";
      return {
        text: "$(pulse) clj-pulse",
        tooltip: `Clojure Pulse: running${version}${where}${lint}`,
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

/**
 * The tooltip's lint line. Warming is a suffix, never a state change: the item
 * keeps its normal icon, because a cache scan degrades nothing while it runs.
 */
function lintLine(lint: LintStatus): string {
  const engine =
    lint.engine === "kondo+native"
      ? `clj-kondo + native${lint.version ? ` (${lint.version})` : ""}`
      : "native lints only";
  const warming = lint.warming ? " - warming dependency cache…" : "";
  return `Linting: ${engine}${warming}`;
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
