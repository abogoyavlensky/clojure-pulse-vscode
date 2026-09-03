// Indent on paste: a pasted multi-line Clojure form keeps its internal
// layout but lands at the columns the paste position calls for.
//
// This mirrors VS Code's own auto-indent-on-paste (`editor/contrib/
// indentation`), which never runs for Clojure because the language ships no
// indentation rules — here the formatting engine's `indentAt` is the oracle
// instead. The first pasted line moves to the engine's column when it lands
// on otherwise-blank indentation; every later line shifts by one uniform
// delta derived from a single reference line, so hand-aligned map values and
// nested forms survive untouched. Re-indenting each line separately would be
// a reformat, which `editor.formatOnPaste` already offers.
//
// `planPaste` is pure. All guards bail to "no change" (`null`): a paste must
// never corrupt a buffer the planner does not fully understand.

import { LineScanInfo, Scanner, scanLineInfo } from "./indent";

export interface PasteContext {
  /** Full pre-paste document text. */
  text: string;
  /** Offsets of the replaced selection (`start === end` for a caret). */
  start: number;
  end: number;
  /** Clipboard text, any line endings. */
  clipboard: string;
}

export interface PastePlan {
  /** Adjusted clipboard lines; the caller joins them with the document EOL. */
  lines: string[];
  /** Spaces to delete immediately before `start` (0 = none). */
  deleteBefore: number;
}

export type IndentAt = (text: string, offset: number) => number | null;

/** Leading whitespace of a line: its space count, and whether a tab follows
 *  (a tab-indented line is never touched — never guess tab width). */
function leading(line: string): { spaces: number; tab: boolean } {
  let i = 0;
  while (i < line.length && line[i] === " ") {
    i++;
  }
  return { spaces: i, tab: line[i] === "\t" };
}

/** Whether a line holds no code at all (empty or whitespace only). */
function blank(line: string): boolean {
  return line.trim() === "";
}

/** Whether the line holding `offset` is tab-indented. A frame opened on such
 *  a line sits at a column the scanner *guessed* (a tab counts as one unit),
 *  so lines anchored to it must not move either — the same rule the
 *  structural engine's re-indentation follows. */
function tabIndentedAt(text: string, offset: number): boolean {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return leading(text.slice(start, offset + 1)).tab;
}

/**
 * The indentation the pasted text should get, or `null` when it should be
 * inserted exactly as copied. Line endings are dropped: the caller joins
 * `lines` with the document's own EOL.
 */
export function planPaste(ctx: PasteContext, indentAt: IndentAt): PastePlan | null {
  const { text, start, end, clipboard } = ctx;
  if (start < 0 || start > end || end > text.length) {
    return null;
  }
  const original = clipboard.split(/\r\n|\r|\n/);
  const lines = original.slice();

  // Inside a string or regex the paste is string content, not code.
  const scanner = new Scanner();
  scanner.scan(text, 0, start);
  if (scanner.inString) {
    return null;
  }

  // The first line moves only when it lands on blank indentation of its own
  // — a mid-line paste is inserted exactly as copied, as VS Code does.
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const cursorCol = start - lineStart;
  const first = leading(lines[0]);
  let deleteBefore = 0;
  if (/^ *$/.test(text.slice(lineStart, start)) && !blank(lines[0]) && !first.tab) {
    const target = indentAt(text, start);
    if (target === null) {
      return null;
    }
    const body = lines[0].slice(first.spaces);
    if (target >= cursorCol) {
      lines[0] = " ".repeat(target - cursorCol) + body;
    } else {
      // The caret already sits past the target column; the caller deletes
      // the excess indentation immediately before the paste.
      deleteBefore = cursorCol - target;
      lines[0] = body;
    }
  }

  shiftBodyLines(ctx, lines, deleteBefore, indentAt);

  if (deleteBefore === 0 && lines.every((line, i) => line === original[i])) {
    return null;
  }
  return { lines, deleteBefore };
}

/**
 * Shifts lines after the first by the delta one reference line calls for —
 * the first later line that is real code (not blank, not tab-indented, not
 * string content). Its target column comes from the engine, reading the
 * document as it will look once the paste lands; the difference from its
 * copied column moves every other line with it. No reference line (a form
 * whose every later line is string content, say) means no shift at all.
 */
function shiftBodyLines(
  ctx: PasteContext,
  lines: string[],
  deleteBefore: number,
  indentAt: IndentAt,
): void {
  if (lines.length < 2) {
    return;
  }
  const pasteStart = ctx.start - deleteBefore;
  const postText =
    ctx.text.slice(0, pasteStart) + lines.join("\n") + ctx.text.slice(ctx.end);

  // Line numbers and offsets of the pasted lines inside that text.
  let firstLine = 0;
  for (let i = 0; i < ctx.start; i++) {
    if (ctx.text[i] === "\n") {
      firstLine++;
    }
  }
  const offsets = [pasteStart];
  for (let i = 1; i < lines.length; i++) {
    offsets.push(offsets[i - 1] + lines[i - 1].length + 1);
  }
  const infos = new Map<number, LineScanInfo>();
  for (const info of scanLineInfo(postText, firstLine + 1, firstLine + lines.length - 1)) {
    infos.set(info.line, info);
  }
  const shiftable = (i: number): boolean => {
    const info = infos.get(firstLine + i);
    return (
      info !== undefined &&
      !info.startsInString &&
      !blank(lines[i]) &&
      !leading(lines[i]).tab &&
      !(info.anchorOffset !== null && tabIndentedAt(postText, info.anchorOffset))
    );
  };

  let delta: number | null = null;
  for (let i = 1; i < lines.length && delta === null; i++) {
    if (!shiftable(i)) {
      continue;
    }
    const target = indentAt(postText, offsets[i]);
    if (target !== null) {
      delta = target - leading(lines[i]).spaces;
    }
  }
  if (delta === null || delta === 0) {
    return;
  }
  for (let i = 1; i < lines.length; i++) {
    if (!shiftable(i)) {
      continue;
    }
    const spaces = leading(lines[i]).spaces;
    // A left shift stops at column 0 rather than eating code.
    const shifted = Math.max(spaces + delta, 0);
    lines[i] = " ".repeat(shifted) + lines[i].slice(spaces);
  }
}
