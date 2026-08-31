// The formatting-engine contract behind `clojurePulse.formatting.engine`.
// Engines are pure (text in, edits out) and import nothing from `vscode`,
// so their cores stay unit-testable — the same split `indent.ts` and
// `maintainIndent.ts` follow. The extension wiring picks the engine from
// settings and maps `FormatEdit`s onto `vscode.TextEdit`s.

/** Set line `line`'s leading whitespace to `indent` spaces. */
export interface LineIndent {
  kind: "line";
  line: number;
  indent: number;
}

/** Replace `text[startOffset..endOffset)` with `text`. */
export interface SliceReplace {
  kind: "slice";
  startOffset: number;
  endOffset: number;
  text: string;
}

export type FormatEdit = LineIndent | SliceReplace;

export type EngineKind = "cljfmt" | "structural";

export interface FormattingEngine {
  /** Target indent column for a new line whose cursor sits at `offset`, or
   *  `null` inside a string/regex (insert a plain newline). */
  indentAt(text: string, offset: number): number | null;
  /** Edits formatting the whole document; `[]` when already formatted and
   *  `null` when the text cannot be formatted (broken buffer — do nothing). */
  formatDocument(text: string): FormatEdit[] | null;
  /** Edits formatting lines `startLine..=endLine` (or, for engines that
   *  format whole forms, the top-level forms intersecting them). */
  formatRange(text: string, startLine: number, endLine: number): FormatEdit[] | null;
}
