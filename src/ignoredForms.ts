import * as vscode from "vscode";

/**
 * Minimal slice of `LanguageClient.sendRequest` for the custom
 * `clojurePulse/ignoredForms` request, injected so the decorator can be
 * unit-tested without a live server. Resolves to the server's range payload.
 */
export type SendRanges = (uri: string) => Thenable<unknown>;

/**
 * Maps the server's `clojurePulse/ignoredForms` payload (an array of LSP
 * `{ start, end }` ranges) into `vscode.Range[]`. Defensive: a non-array or a
 * malformed entry is dropped rather than thrown, so a bad response degrades to
 * "nothing dimmed" instead of breaking the editor.
 */
export function toRanges(raw: unknown): vscode.Range[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ranges: vscode.Range[] = [];
  for (const entry of raw) {
    const r = entry as {
      start?: { line?: unknown; character?: unknown };
      end?: { line?: unknown; character?: unknown };
    };
    const sl = r?.start?.line;
    const sc = r?.start?.character;
    const el = r?.end?.line;
    const ec = r?.end?.character;
    if (
      typeof sl === "number" &&
      typeof sc === "number" &&
      typeof el === "number" &&
      typeof ec === "number"
    ) {
      ranges.push(new vscode.Range(sl, sc, el, ec));
    }
  }
  return ranges;
}

/** Owns the dim decoration and applies it to an editor on demand. */
export interface IgnoredFormDecorator {
  /** Requests the ignored-form ranges for `editor` and dims them. */
  refresh(editor: vscode.TextEditor): Promise<void>;
  dispose(): void;
}

/**
 * Dims `#_` discard forms and `(comment …)` blocks with a `opacity: 0.5`
 * decoration — which composites above the grammar, semantic tokens, and
 * bracket-pair colorization, so the whole form (brackets included) fades
 * uniformly. Ranges come from the server via `sendRanges`.
 */
export function createIgnoredFormDecorator(
  sendRanges: SendRanges,
): IgnoredFormDecorator {
  const decorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: "none; opacity: 0.5",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  return {
    async refresh(editor: vscode.TextEditor): Promise<void> {
      try {
        const raw = await sendRanges(editor.document.uri.toString());
        editor.setDecorations(decorationType, toRanges(raw));
      } catch {
        // A server error / no running client should clear the dim, not throw.
        editor.setDecorations(decorationType, []);
      }
    },
    dispose(): void {
      decorationType.dispose();
    },
  };
}
