/**
 * The token VS Code's Toggle Line Comment inserts in Clojure files.
 *
 * The contributed `language-configuration.json` stays the source of truth for
 * the default `;`: at that value nothing is registered, so there is only ever
 * one place the default lives. Picking `;;` registers a language configuration
 * carrying `comments` alone — VS Code merges it over the file property by
 * property, leaving brackets, pairs and the word pattern untouched.
 */

export type LineCommentToken = ";" | ";;";

export const DEFAULT_LINE_COMMENT: LineCommentToken = ";";

/** The setting's value, or the default for anything unexpected. */
export function lineCommentToken(raw: unknown): LineCommentToken {
  return raw === ";" || raw === ";;" ? raw : DEFAULT_LINE_COMMENT;
}

export interface LineCommentApplier {
  /** Applies the token, replacing any earlier registration. */
  apply(token: LineCommentToken): void;
  dispose(): void;
}

/** `register` is the seam over `vscode.languages.setLanguageConfiguration`. */
export function createLineCommentApplier(
  register: (token: LineCommentToken) => { dispose(): void },
): LineCommentApplier {
  let current: { dispose(): void } | undefined;
  const clear = (): void => {
    current?.dispose();
    current = undefined;
  };
  return {
    apply: (token) => {
      clear();
      if (token !== DEFAULT_LINE_COMMENT) {
        current = register(token);
      }
    },
    dispose: clear,
  };
}
