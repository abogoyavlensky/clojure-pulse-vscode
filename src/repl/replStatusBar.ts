import * as vscode from "vscode";
import { ReplConnectionInfo } from "./connectionManager";

export interface ReplStatusView {
  text: string;
  tooltip: string;
  command: string;
}

/** What the status bar summarises: the eval target, and what else exists. */
export interface ReplStatusState {
  /** The session evaluations go to, when there is one. */
  active?: { name: string; info?: ReplConnectionInfo };
  /** A REPL is coming up, though none is active yet. */
  busy: boolean;
  /** How many REPLs the manager knows about at all. */
  total: number;
}

/**
 * Pure mapping from the REPL manager's state to what the status-bar item
 * should render. Kept free of any `vscode` calls so it is trivially
 * unit-testable.
 */
export function replStatusPresentation(state: ReplStatusState): ReplStatusView {
  if (state.active) {
    const where = state.active.info
      ? `${state.active.info.host}:${state.active.info.port}`
      : "";
    return {
      text: `$(plug) nREPL ${state.active.name}${where ? ` ${where}` : ""}`,
      tooltip: `Clojure Pulse: evaluating in "${state.active.name}"${
        where ? ` at ${where}` : ""
      } — click for REPL actions`,
      command: "clojurePulse.replMenu",
    };
  }
  if (state.busy) {
    return {
      text: "$(loading~spin) nREPL",
      tooltip: "Clojure Pulse: a REPL is starting…",
      command: "clojurePulse.replMenu",
    };
  }
  if (state.total > 0) {
    return {
      text: "$(debug-disconnect) nREPL",
      tooltip: "Clojure Pulse: no active REPL — click to start one",
      command: "clojurePulse.startRepl",
    };
  }
  return {
    text: "$(debug-disconnect) nREPL",
    tooltip: "Clojure Pulse: no REPL configured — click to add one",
    command: "clojurePulse.addReplConfig",
  };
}

export interface ReplStatusBar {
  update(state: ReplStatusState): void;
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
    update(state) {
      const view = replStatusPresentation(state);
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
