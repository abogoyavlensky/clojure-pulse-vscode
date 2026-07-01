// Structural indent computation for Clojure — the client-side mirror of
// clj-pulse's `handlers/indent.rs`. Both implement the identical rule and
// scanner algorithm (Clojure Sublimed's default):
//
//   indent = (column just after the open delimiter) + offset
//   offset = 1  iff the delimiter is `(` / `#(` and the first form inside is
//               a symbol
//
// Vectors, maps, sets and non-symbol-headed lists align to their first
// element; a cursor inside a string/regex gets no indent (never change string
// content); top level is column 0.
//
// The scanner is a per-code-unit state machine over the text *before* the
// cursor: a stack of open delimiters, skipping comments, strings, regexes and
// char literals. Prefix-only ⇒ robust to unbalanced mid-edit code. It is
// deliberately incremental (one code unit at a time) so the
// maintain-relative-indentation feature can reuse it for forward scans with
// per-line inspection.

/** One unclosed open delimiter to the left of the scan position. */
export interface Frame {
  /** UTF-16 column just after the opener token (after `(`, `[`, `#{`, …). */
  colAfter: number;
  /** `(` / `#(` — the only frames eligible for the symbol-head offset. */
  parenLike: boolean;
  /** The closer that ends this frame; a mismatched closer (`]` against `(`)
   *  is ignored rather than popping the wrong frame — mid-edit code is
   *  routinely malformed and must not collapse the context to top level. */
  closer: string;
  /** Offset of the opener token's first code unit (`#` for `#(` / `#{`). */
  openOffset: number;
  /** Line the opener token starts on. */
  openLine: number;
  /** Whether the first form inside is a symbol; undefined until one is seen. */
  firstFormSymbol?: boolean;
}

const enum Mode {
  Code,
  Comment,
  Str,
  StrEscape,
  CharLiteral,
  /** Just consumed a `#`, deciding what it introduces. */
  Dispatch,
}

/** Whether a token starting with `c` (followed by `next`) reads as a symbol.
 *  Keywords, numbers, strings, quotes/derefs/metadata and reader macros do
 *  not; `+`/`-` do unless they start a number literal (`-5`). */
function symbolStart(c: string, next: string | undefined): boolean {
  if (c === "+" || c === "-") {
    return !(next !== undefined && next >= "0" && next <= "9");
  }
  if ("*!_?<>=&%$./|".includes(c)) {
    return true;
  }
  return /\p{L}/u.test(c);
}

/**
 * Incremental Clojure structure scanner. Feed it code units left to right via
 * `advance`; inspect `stack` / `inString` / `line` / `col` at any point.
 */
export class Scanner {
  readonly stack: Frame[] = [];
  /** Line/column (UTF-16 units) of the next unread code unit. */
  line = 0;
  col = 0;
  private mode = Mode.Code;
  /** Offset of the `#` that switched us into Dispatch mode. */
  private dispatchOffset = 0;

  /** True when the scan position is inside a string or regex literal. */
  get inString(): boolean {
    return this.mode === Mode.Str || this.mode === Mode.StrEscape;
  }

  /** Records the first form of the innermost open frame (no-op once seen). */
  private markFirstForm(isSymbol: boolean): void {
    const top = this.stack[this.stack.length - 1];
    if (top && top.firstFormSymbol === undefined) {
      top.firstFormSymbol = isSymbol;
    }
  }

  private push(parenLike: boolean, closer: string, openOffset: number): void {
    this.markFirstForm(false);
    this.stack.push({
      // The opener's last code unit is at `this.col`, so the column just
      // after the opener token is `col + 1` (dispatch openers `#(`/`#{`
      // reach here on their second unit).
      colAfter: this.col + 1,
      parenLike,
      closer,
      openOffset,
      openLine: this.line,
      firstFormSymbol: undefined,
    });
  }

  private handleCode(c: string, next: string | undefined, offset: number): void {
    switch (c) {
      case " ":
      case "\t":
      case ",":
      case "\n":
      case "\r":
        break;
      case ";":
        this.mode = Mode.Comment;
        break;
      case '"':
        this.markFirstForm(false);
        this.mode = Mode.Str;
        break;
      case "\\":
        // Char literal: `\(`, `\newline`, `\\`. Consuming one unit is
        // enough — any literal-name tail is made of plain ident chars.
        this.markFirstForm(false);
        this.mode = Mode.CharLiteral;
        break;
      case "#":
        this.mode = Mode.Dispatch;
        this.dispatchOffset = offset;
        break;
      case "(":
        this.push(true, ")", offset);
        break;
      case "[":
        this.push(false, "]", offset);
        break;
      case "{":
        this.push(false, "}", offset);
        break;
      case ")":
      case "]":
      case "}": {
        const top = this.stack[this.stack.length - 1];
        if (top && top.closer === c) {
          this.stack.pop();
        }
        break;
      }
      default:
        this.markFirstForm(symbolStart(c, next));
    }
  }

  /**
   * Consume one UTF-16 code unit. `next` is the following unit (for number
   * lookahead), `offset` is `c`'s offset in the scanned text.
   */
  advance(c: string, next: string | undefined, offset: number): void {
    switch (this.mode) {
      case Mode.Code:
        this.handleCode(c, next, offset);
        break;
      case Mode.Comment:
        if (c === "\n") {
          this.mode = Mode.Code;
        }
        break;
      case Mode.Str:
        if (c === "\\") {
          this.mode = Mode.StrEscape;
        } else if (c === '"') {
          this.mode = Mode.Code;
        }
        break;
      case Mode.StrEscape:
        this.mode = Mode.Str;
        break;
      case Mode.CharLiteral:
        this.mode = Mode.Code;
        break;
      case Mode.Dispatch:
        this.mode = Mode.Code;
        switch (c) {
          case "(":
            this.push(true, ")", this.dispatchOffset);
            break;
          case "{":
            this.push(false, "}", this.dispatchOffset);
            break;
          case '"':
            this.markFirstForm(false);
            this.mode = Mode.Str;
            break;
          case "_":
            // Discard: transparent for bracket balance, but it *is* the
            // enclosing form's first form when leading (→ align).
            this.markFirstForm(false);
            break;
          default:
            // #' #? #foo — reader macros; the wrapped form is not a bare
            // symbol head. Reprocess `c` as plain code.
            this.markFirstForm(false);
            this.handleCode(c, next, offset);
        }
        break;
    }

    if (c === "\n") {
      this.line += 1;
      this.col = 0;
    } else {
      this.col += 1;
    }
  }

  /** Scan `text[from..to)`, advancing this scanner's state. */
  scan(text: string, from: number, to: number): void {
    const end = Math.min(to, text.length);
    for (let i = Math.max(0, from); i < end; i++) {
      this.advance(text[i], text[i + 1], i);
    }
  }
}

/**
 * Offset of the closer matching the opener whose token starts at
 * `openOffset` (`#` for `#(` / `#{`), or `null` when the form never closes or
 * `openOffset` is not actually an opener in context (inside a string or
 * comment). Closers inside skipped constructs and mismatched closers do not
 * match — same scanner, same robustness rules.
 */
export function findMatchingClose(text: string, openOffset: number): number | null {
  if (openOffset < 0 || openOffset >= text.length) {
    return null;
  }
  const scanner = new Scanner();
  scanner.scan(text, 0, openOffset);

  // The opener token is 1–2 units (`(` vs `#(`); consume units until its
  // frame appears on the stack.
  let i = openOffset;
  const tokenLimit = Math.min(openOffset + 2, text.length);
  let opened = false;
  while (i < tokenLimit && !opened) {
    scanner.advance(text[i], text[i + 1], i);
    i++;
    const top = scanner.stack[scanner.stack.length - 1];
    opened = top !== undefined && top.openOffset === openOffset;
  }
  if (!opened) {
    return null;
  }

  const targetDepth = scanner.stack.length;
  for (; i < text.length; i++) {
    scanner.advance(text[i], text[i + 1], i);
    if (scanner.stack.length < targetDepth) {
      return i;
    }
  }
  return null;
}

/** Structural facts about the start of one line, for re-indentation. */
export interface LineScanInfo {
  line: number;
  /** Opener-token offset of the innermost open frame at line start, or
   *  `null` at top level. */
  anchorOffset: number | null;
  /** Whether the line starts inside a string/regex literal (its leading
   *  whitespace is string content — never touch it). */
  startsInString: boolean;
}

/**
 * Per-line structural info for lines `fromLine..=toLine`. The whole prefix is
 * scanned (context cannot be skipped), so callers pass the smallest range
 * they need and the scan stops at its end.
 */
export function scanLineInfo(text: string, fromLine: number, toLine: number): LineScanInfo[] {
  const scanner = new Scanner();
  const infos: LineScanInfo[] = [];
  const record = () => {
    if (scanner.line >= fromLine && scanner.line <= toLine) {
      const top = scanner.stack[scanner.stack.length - 1];
      infos.push({
        line: scanner.line,
        anchorOffset: top ? top.openOffset : null,
        startsInString: scanner.inString,
      });
    }
  };
  for (let i = 0; i < text.length; i++) {
    if (scanner.line > toLine) {
      return infos;
    }
    if (scanner.col === 0) {
      record();
    }
    scanner.advance(text[i], text[i + 1], i);
  }
  // A trailing empty line (text ending in `\n`) never enters the loop.
  if (scanner.col === 0 && scanner.line <= toLine) {
    record();
  }
  return infos;
}

/**
 * The target indent column (UTF-16 units) for a new line whose cursor sits at
 * `offset`, or `null` when the position is inside a string/regex (insert a
 * plain newline — never change string content).
 */
export function indentColumnAt(text: string, offset: number): number | null {
  const scanner = new Scanner();
  scanner.scan(text, 0, offset);
  if (scanner.inString) {
    return null;
  }
  const top = scanner.stack[scanner.stack.length - 1];
  if (!top) {
    return 0;
  }
  const headOffset = top.parenLike && top.firstFormSymbol === true ? 1 : 0;
  return top.colAfter + headOffset;
}
