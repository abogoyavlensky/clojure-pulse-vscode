// A broken cljfmt config is *state* — formatting silently runs on defaults
// until the file parses again — so it lives in the status bar for as long
// as it lasts, not in a dismissable notification. (The save that breaks the
// file is an *event*; the wiring shows a one-shot warning for that, and
// nothing is ever surfaced from the formatting path itself.)
//
// This is a dedicated item, not the shared verdict slot in
// `repl/statusSlot.ts`: that slot is last-writer-wins for transient run
// verdicts, and a test verdict must not hide a persistent config warning.

import * as vscode from "vscode";
import { ConfigLookup } from "./configDiscovery";

export interface ConfigStatusView {
  text: string;
  tooltip: string;
}

export interface ConfigStatus {
  /** Called from every config lookup: shows the item while the lookup
   *  carries a parse error, hides it otherwise (`undefined` = not using
   *  cljfmt configs at all — structural engine, untitled buffer). */
  report(lookup: ConfigLookup | undefined): void;
  /** The rendered view, for tests; `undefined` while hidden. */
  current(): ConfigStatusView | undefined;
  /** Path of the errored config file the item's click opens. */
  target(): string | undefined;
  dispose(): void;
}

export function createConfigStatus(): ConfigStatus {
  const item = vscode.window.createStatusBarItem(
    "clojurePulse.cljfmtConfig",
    vscode.StatusBarAlignment.Left,
    // Just right of the REPL (99) and verdict (98) items.
    97,
  );
  item.name = "cljfmt Config";
  item.command = "clojurePulse.openCljfmtConfig";
  item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  let view: ConfigStatusView | undefined;
  let errorPath: string | undefined;

  return {
    report(lookup) {
      if (lookup?.error !== undefined && lookup.path !== undefined) {
        errorPath = lookup.path;
        view = {
          text: "$(warning) cljfmt config",
          tooltip:
            `${lookup.path}\n${lookup.error}\n` +
            "Formatting uses the defaults until the file parses. Click to open.",
        };
        item.text = view.text;
        item.tooltip = view.tooltip;
        item.show();
      } else {
        view = undefined;
        errorPath = undefined;
        item.hide();
      }
    },
    current: () => view,
    target: () => errorPath,
    dispose: () => item.dispose(),
  };
}
