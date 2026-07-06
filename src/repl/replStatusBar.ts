import * as vscode from "vscode";
import { ReplState, ReplConnectionInfo } from "./connectionManager";

export interface ReplStatusView {
  text: string;
  tooltip: string;
  command: string;
}

/**
 * Pure mapping from REPL connection state to what the status-bar item should
 * render. Kept free of any `vscode` calls so it is trivially unit-testable.
 */
export function replStatusPresentation(
  state: ReplState,
  info?: ReplConnectionInfo,
): ReplStatusView {
  switch (state) {
    case "disconnected":
      return {
        text: "$(debug-disconnect) nREPL",
        tooltip: "Clojure Pulse: not connected — click to connect to a running nREPL",
        command: "clojurePulse.connectRepl",
      };
    case "connecting":
      return {
        text: "$(loading~spin) nREPL",
        tooltip: "Clojure Pulse: connecting to nREPL…",
        command: "clojurePulse.replMenu",
      };
    case "connected": {
      const where = info ? ` ${info.host}:${info.port}` : "";
      return {
        text: `$(plug) nREPL${where}`,
        tooltip: `Clojure Pulse: connected to nREPL at${where || " unknown"} — click for REPL actions`,
        command: "clojurePulse.replMenu",
      };
    }
  }
}

export interface ReplStatusBar {
  update(state: ReplState, info?: ReplConnectionInfo): void;
  dispose(): void;
}

/** Sits just right of the clj-pulse server item (priority 100). */
export function createReplStatusBar(): ReplStatusBar {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99,
  );
  item.name = "Clojure Pulse REPL";

  return {
    update(state, info) {
      const view = replStatusPresentation(state, info);
      item.text = view.text;
      item.tooltip = view.tooltip;
      item.command = view.command;
      item.show();
    },
    dispose() {
      item.dispose();
    },
  };
}
