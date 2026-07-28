import * as vscode from "vscode";
import { ReplConnectionInfo } from "./connectionManager";

export interface ReplStatusView {
  text: string;
  tooltip: string;
  command: string;
}

/** What the status bar summarises: the eval target, and what else exists. */
export interface ReplStatusState {
  /** The session evaluations go to, when there is one. An unnamed session
   *  (the ad-hoc flow) is identified by its address alone. */
  active?: { name?: string; info?: ReplConnectionInfo };
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
    // A session named after its own address (ad-hoc) must not print it twice.
    const parts = [state.active.name, where === state.active.name ? "" : where];
    return {
      text: `$(plug) nREPL ${parts.filter(Boolean).join(" ")}`.trimEnd(),
      tooltip: `Clojure Pulse: evaluating in ${
        state.active.name ? `"${state.active.name}"` : "the REPL"
      }${where ? ` at ${where}` : ""} — click for REPL actions`,
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
  // Nothing configured yet: the connect flow is the way in, since it also
  // offers an ad-hoc host:port connection to a REPL that is already running.
  return {
    text: "$(debug-disconnect) nREPL",
    tooltip: "Clojure Pulse: not connected — click to connect to a running nREPL",
    command: "clojurePulse.connectRepl",
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
