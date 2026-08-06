import * as vscode from "vscode";

// One status-bar item shared by every verdict presenter (test runs, custom
// REPL commands): whichever ran last owns the display. Tokens are ordered
// globally across all sharers, so a superseded run's late update or clear is
// a no-op no matter which presenter issued it — the guard both bars carried
// per-item now spans them.

/** What one render of the slot carries; presenters map their runs onto it. */
export interface StatusSlotView {
  text: string;
  tooltip: string;
  /** Theme color id for `item.color` (e.g. "testing.iconPassed"). */
  color?: string;
  /** Theme color id for `item.backgroundColor`. Failures use the sanctioned
   *  "statusBarItem.errorBackground", which brings its own foreground —
   *  never combined with `color`. */
  backgroundColor?: string;
  command: string;
}

export interface StatusSlot {
  /** Shows `view`, superseding whatever is displayed. Returns the token the
   *  run's update/clear must present. */
  show(view: StatusSlotView): string;
  /** Re-renders for `token`'s run. A no-op for superseded tokens. */
  update(token: string, view: StatusSlotView): void;
  /** Hides the item — for runs abandoned before a verdict. A no-op for
   *  superseded tokens. */
  clear(token: string): void;
  /** The rendered view, for tests; undefined while hidden. */
  current(): StatusSlotView | undefined;
  dispose(): void;
}

export function createStatusSlot(options: {
  name: string;
  /** Higher sits further left; 98 is just right of the REPL item's 99. */
  priority: number;
}): StatusSlot {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    options.priority,
  );
  item.name = options.name;
  let currentToken: string | undefined;
  let view: StatusSlotView | undefined;
  let nextToken = 1;

  const render = (next: StatusSlotView | undefined): void => {
    view = next;
    if (!next) {
      item.hide();
      return;
    }
    item.text = next.text;
    item.tooltip = next.tooltip;
    item.command = next.command;
    item.color = next.color ? new vscode.ThemeColor(next.color) : undefined;
    item.backgroundColor = next.backgroundColor
      ? new vscode.ThemeColor(next.backgroundColor)
      : undefined;
    item.show();
  };

  return {
    show(next) {
      currentToken = `slot-${nextToken++}`;
      render(next);
      return currentToken;
    },
    update(token, next) {
      if (token !== currentToken) {
        return;
      }
      render(next);
    },
    clear(token) {
      if (token !== currentToken) {
        return;
      }
      render(undefined);
    },
    current() {
      return view;
    },
    dispose() {
      item.dispose();
    },
  };
}
