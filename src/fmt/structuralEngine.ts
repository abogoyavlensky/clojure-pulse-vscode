// The structural engine: the fixed Sublimed-style rule (`indentColumnAt`)
// packaged behind the engine interface. Its "formatting" is re-indentation
// only — it never touches anything but leading whitespace. It doubles as the
// cljfmt engine's fallback for text cljfmt cannot parse.

import { Frame, indentColumnAt, Scanner } from "../indent";
import { FormatEdit, FormattingEngine } from "./engine";

/** The structural rule applied to a live scanner frame (what
 *  `indentColumnAt` computes at the end of its prefix scan). */
function frameIndent(top: Frame | undefined): number {
  if (!top) {
    return 0;
  }
  return top.colAfter + (top.parenLike && top.firstFormSymbol === true ? 1 : 0);
}

/**
 * Recomputes the leading whitespace of every code line in
 * `fromLine..=toLine`. The scanner is fed the progressively *rewritten*
 * text, so a line whose opener moved anchors its children to the new column.
 * Untouchable lines — starting inside a string, blank/space-only, or
 * tab-indented (never guess tab width) — are fed unchanged. A frame opened
 * on a tab-indented line has a column the scanner *guessed* (a tab counts as
 * one unit), so lines anchored to such a frame are left unchanged too.
 */
function reindentLines(text: string, fromLine: number, toLine: number): FormatEdit[] {
  const scanner = new Scanner();
  const edits: FormatEdit[] = [];
  const tabLines = new Set<number>();
  let offset = 0;
  let line = 0;
  for (;;) {
    const nl = text.indexOf("\n", offset);
    const end = nl === -1 ? text.length : nl;
    let feed = text.slice(offset, end);
    if (line >= fromLine && line <= toLine && !scanner.inString) {
      // A "blank" CRLF line still holds a `\r`; exclude it from content.
      const contentEnd = feed.endsWith("\r") ? feed.length - 1 : feed.length;
      let ws = 0;
      let tab = false;
      while (ws < contentEnd) {
        const c = feed[ws];
        if (c === " ") {
          ws++;
        } else {
          tab = c === "\t";
          break;
        }
      }
      const top = scanner.stack[scanner.stack.length - 1];
      if (tab) {
        tabLines.add(line);
      } else if (ws < contentEnd && !(top && tabLines.has(top.openLine))) {
        const desired = frameIndent(top);
        if (desired !== ws) {
          edits.push({ kind: "line", line, indent: desired });
        }
        feed = " ".repeat(desired) + feed.slice(ws);
      }
    }
    scanner.scan(feed, 0, feed.length);
    if (nl === -1) {
      break;
    }
    scanner.scan("\n", 0, 1);
    offset = nl + 1;
    line++;
  }
  return edits;
}

export const structuralEngine: FormattingEngine = {
  indentAt: indentColumnAt,
  formatDocument(text) {
    return reindentLines(text, 0, Number.MAX_SAFE_INTEGER);
  },
  formatRange(text, startLine, endLine) {
    return reindentLines(text, startLine, endLine);
  },
};
