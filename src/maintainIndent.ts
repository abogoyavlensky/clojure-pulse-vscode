// Maintain relative indentation (Cursive-style): when an edit on one line
// horizontally moves code that later lines are structurally anchored to,
// those lines' leading whitespace shifts by the same delta.
//
// This is *not* reindent/format — untouched lines are never recomputed, only
// translated by the distance their anchor moved. Whole lines shift as units,
// so nested and manually-aligned code is preserved for free: every line
// between the edit and the affected form's closer is inside a form that
// moved, hence shifts by the same uniform delta.
//
// `planShift` is pure: it takes the post-edit text plus the change metadata
// and returns per-line shifts. All guards bail to "do nothing" — the feature
// must never corrupt a buffer it doesn't fully understand.

import { Scanner } from "./indent";

/** The shape of `vscode.TextDocumentContentChangeEvent` this module needs
 *  (kept structural so the core stays editor-independent and unit-testable). */
export interface ContentChange {
  /** Pre-edit range of the replaced text. */
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** Replacement text. */
  text: string;
}

export interface LineShift {
  line: number;
  /** Columns to add to (or, negative, remove from) the line's leading
   *  spaces. Already clamped so the indent never goes below column 0. */
  deltaCols: number;
}

/** Never shift more than this many lines — a safety and latency cap. */
const MAX_SHIFT_LINES = 1000;

/** Offset of `(line, character)` in `text`, or null past the end. */
function offsetAt(text: string, line: number, character: number): number | null {
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) {
      return null;
    }
    offset = nl + 1;
  }
  const target = offset + character;
  return target <= text.length ? target : null;
}

/** Offset of the `\n` ending the line containing `offset` (or text end). */
function endOfLine(text: string, offset: number): number {
  const nl = text.indexOf("\n", offset);
  return nl === -1 ? text.length : nl;
}

/** Code units that end a head token (or make it "not a simple token"). */
const HEAD_STOP = ' \t,()[]{}";';

/**
 * Offset of a list form's *first argument* (the form after the head token),
 * or `null` when the head is not a simple token or the first argument is not
 * on the same line before `eol`. Argument-aligned continuation lines sit at
 * this token's column.
 */
function firstArgOffset(text: string, openOffset: number, eol: number): number | null {
  let i = openOffset + (text[openOffset] === "#" ? 2 : 1);
  while (i < eol && (text[i] === " " || text[i] === "\t" || text[i] === ",")) {
    i++;
  }
  // A simple head token: not a collection, string, char, comment or quote.
  if (i >= eol || HEAD_STOP.includes(text[i]) || text[i] === "\\" || text[i] === "'") {
    return null;
  }
  while (i < eol && !HEAD_STOP.includes(text[i]) && text[i] !== "\\") {
    i++;
  }
  while (i < eol && (text[i] === " " || text[i] === "\t" || text[i] === ",")) {
    i++;
  }
  if (i >= eol || text[i] === ";") {
    return null;
  }
  return i;
}

/**
 * Computes the per-line indentation shifts a single content change calls
 * for. Returns `[]` when nothing needs to move and `null` when the planner
 * bails (edit in a string/comment, affected form never closes, form too
 * large) — both mean "apply no edit", the distinction is only for tests.
 *
 * The change's *tail* — everything that followed the replaced range on its
 * line — lands at a new column; if the tail contains openers of forms that
 * extend past the edited line, every line through the outermost such form's
 * closer shifts by the tail's column delta.
 */
export function planShift(postText: string, change: ContentChange): LineShift[] | null {
  const text = change.text;
  let newlines = 0;
  let lastLineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      newlines++;
      lastLineStart = i + 1;
    }
  }
  const newCol =
    newlines > 0 ? text.length - lastLineStart : change.range.start.character + text.length;
  const delta = newCol - change.range.end.character;
  if (delta === 0) {
    return [];
  }
  const tailLine = change.range.start.line + newlines;
  const tailOffset = offsetAt(postText, tailLine, newCol);
  if (tailOffset === null) {
    return null;
  }

  const scanner = new Scanner();
  scanner.scan(postText, 0, tailOffset);
  if (scanner.inString || scanner.inComment) {
    // The moved tail is string/comment content; no code columns changed.
    return null;
  }

  // Alignment extension: when the edit sits in the head of an enclosing list
  // whose opener did not move but whose first argument did (a head symbol
  // grew or shrank), lines sitting exactly at the first argument's old
  // column are argument-aligned and follow it.
  const eol = endOfLine(postText, tailOffset);
  const lineStartOffset = tailOffset - newCol;
  const enclosing = scanner.stack[scanner.stack.length - 1];
  const enclosingDepth = scanner.stack.length;
  let alignment: { anchorOffset: number; oldCol: number } | null = null;
  if (
    enclosing !== undefined &&
    enclosing.parenLike &&
    enclosing.openOffset < tailOffset &&
    enclosing.openLine === tailLine
  ) {
    const argOffset = firstArgOffset(postText, enclosing.openOffset, eol);
    if (argOffset !== null && argOffset >= tailOffset) {
      alignment = {
        anchorOffset: enclosing.openOffset,
        oldCol: argOffset - lineStartOffset - delta,
      };
    }
  }

  // Openers at/after the tail position moved by `delta`. Anything opened
  // earlier kept its column, so only frames with openOffset >= tailOffset
  // (a suffix of the stack) are affected; the shallowest one — or the whole
  // enclosing form when alignment is active — bounds the shift region.
  scanner.scan(postText, tailOffset, eol);
  const firstAffected = scanner.stack.findIndex((f) => f.openOffset >= tailOffset);
  if (firstAffected === -1 && alignment === null) {
    return [];
  }
  const targetDepth = alignment !== null ? enclosingDepth : firstAffected + 1;

  // Continue to that closer, recording each line start on the way. An
  // unclosed form means a mid-typing state — never shift on a guess.
  const lineStarts: {
    line: number;
    offset: number;
    startsInString: boolean;
    anchorOffset: number | null;
    anchorLine: number;
  }[] = [];
  let closeLine: number | null = null;
  for (let i = eol; i < postText.length; i++) {
    if (scanner.line > tailLine + MAX_SHIFT_LINES) {
      return null;
    }
    if (scanner.col === 0) {
      const top = scanner.stack[scanner.stack.length - 1];
      lineStarts.push({
        line: scanner.line,
        offset: i,
        startsInString: scanner.inString,
        anchorOffset: top ? top.openOffset : null,
        anchorLine: top ? top.openLine : -1,
      });
    }
    scanner.advance(postText[i], postText[i + 1], i);
    if (scanner.stack.length < targetDepth) {
      closeLine = scanner.line;
      break;
    }
  }
  if (closeLine === null) {
    return null;
  }

  // Top-down cascade: a line shifts by the amount its anchor moved — the
  // full delta for anchors on the edited line's moved tail, the anchor
  // line's own (clamped) shift for anchors on already-shifted lines, and
  // the delta for argument-aligned direct children of the enclosing form.
  const lineShift = new Map<number, number>();
  const shifts: LineShift[] = [];
  for (const start of lineStarts) {
    if (start.line > closeLine) {
      break;
    }
    // Leading whitespace inside a multiline string is string content.
    if (start.startsInString) {
      continue;
    }
    const lineEnd = endOfLine(postText, start.offset);
    let wsEnd = start.offset;
    let tab = false;
    while (wsEnd < lineEnd) {
      const ch = postText[wsEnd];
      if (ch === " ") {
        wsEnd++;
      } else {
        tab = ch === "\t";
        break;
      }
    }
    // Never guess tab width; never touch empty lines.
    if (tab || wsEnd === lineEnd) {
      continue;
    }
    const leading = wsEnd - start.offset;

    let shift = 0;
    if (start.anchorOffset !== null) {
      if (alignment !== null && start.anchorOffset === alignment.anchorOffset) {
        shift = leading === alignment.oldCol ? delta : 0;
      } else if (start.anchorLine === tailLine && start.anchorOffset >= tailOffset) {
        shift = delta;
      } else if (start.anchorLine > tailLine) {
        shift = lineShift.get(start.anchorLine) ?? 0;
      }
    }
    const effective = shift < 0 ? Math.max(shift, -leading) : shift;
    if (effective !== 0) {
      lineShift.set(start.line, effective);
      shifts.push({ line: start.line, deltaCols: effective });
    }
  }
  return shifts;
}
