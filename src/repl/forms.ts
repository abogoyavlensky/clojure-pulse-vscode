// Form boundaries for REPL evaluation — pure text functions, no vscode
// imports. A small recursive-descent reader walks forms left to right with
// the same robustness rules as the `Scanner` in ../indent.ts (brackets inside
// strings, regexes, char literals and line comments never count; mismatched
// closers are skipped; unbalanced code yields no form rather than a garbage
// range).
//
// `formAtCursor` resolves what "Evaluate Current Form" should send, and
// `bracketPairAtCursor` the bracket pair of that same form (what the editor
// highlights, so the highlight never disagrees with eval), in priority order:
//   1. (selections are handled by the command, not here)
//   2. cursor inside an atom token or immediately after its last char → token
//   3. closing bracket / string quote immediately before cursor → that form
//   4. cursor immediately before a token's first char → that token
//      (rules run in order, so in the sandwich `(foo)|bar` the preceding
//      form wins)
//   5. cursor in whitespace inside a list → the innermost enclosing form
//   6. cursor in top-level whitespace → the previous top-level form
//
// Reader prefixes (`'`, `` ` ``, `~`, `~@`, `@`, `#'`, `^meta`, dispatch `#`)
// belong to the form they precede; a `#_` discard marker is excluded from the
// resolved range so evaluating a discarded form yields its actual value.

/** Half-open [start, end) offsets of a form in the scanned text. */
export interface FormRange {
  start: number;
  end: number;
}

/** One fully read form: prefixes + base. */
interface ReadForm {
  /** Start including reader prefixes (and any `#_` markers). */
  start: number;
  /** Start with leading `#_` markers stripped (== start when none). */
  innerStart: number;
  /** Start of the base form after all prefixes. */
  baseStart: number;
  end: number;
  /** Offset of the opening bracket char, or null for atom bases. */
  bracketOffset: number | null;
  /** Offset of the matching closing bracket (set iff bracketOffset is). */
  closerOffset: number | null;
}

type ReadResult =
  | { kind: "form"; form: ReadForm }
  /** Next non-trivia char is a closing bracket (not consumed). */
  | { kind: "closer"; offset: number }
  /** Reached the scan limit with nothing but trivia. */
  | { kind: "end" }
  /** A form started but never completed (unclosed bracket/string). */
  | { kind: "unbalanced" };

const WHITESPACE = " \t\r\n,";
const CLOSERS: Record<string, true> = { ")": true, "]": true, "}": true };
const MATCHING: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
/** Code units that end an atom token. `'` and `#` stay inside (`foo'`, `x#`). */
const ATOM_DELIMITERS = WHITESPACE + ';()[]{}"`~@^\\';

function isLetter(c: string): boolean {
  return /\p{L}/u.test(c);
}

/** Skips whitespace, commas and `;` line comments. */
function skipTrivia(text: string, pos: number, limit: number): number {
  while (pos < limit) {
    const c = text[pos];
    if (WHITESPACE.includes(c)) {
      pos++;
    } else if (c === ";") {
      while (pos < limit && text[pos] !== "\n") {
        pos++;
      }
    } else {
      return pos;
    }
  }
  return pos;
}

/** Reads the next form starting at or after `pos`, stopping at `limit`. */
function readForm(text: string, pos: number, limit: number): ReadResult {
  pos = skipTrivia(text, pos, limit);
  if (pos >= limit) {
    return { kind: "end" };
  }
  if (CLOSERS[text[pos]]) {
    return { kind: "closer", offset: pos };
  }

  const start = pos;
  let innerStart: number | null = null;

  // Reader prefixes; each iteration must advance `pos`.
  prefixes: while (pos < limit) {
    const c = text[pos];
    switch (c) {
      case "'":
      case "`":
      case "@":
        pos = skipTrivia(text, pos + 1, limit);
        break;
      case "~":
        pos++;
        if (text[pos] === "@") {
          pos++;
        }
        pos = skipTrivia(text, pos, limit);
        break;
      case "^": {
        // Metadata: `^` plus one form, then the annotated form follows.
        const meta = readForm(text, pos + 1, limit);
        if (meta.kind !== "form") {
          return { kind: "unbalanced" };
        }
        pos = skipTrivia(text, meta.form.end, limit);
        break;
      }
      case "#": {
        const c2 = text[pos + 1];
        if (c2 === "_") {
          pos = skipTrivia(text, pos + 2, limit);
          if (innerStart === null) {
            innerStart = pos;
          }
        } else if (c2 === "'") {
          pos = skipTrivia(text, pos + 2, limit);
        } else if (c2 === "?") {
          // Reader conditional `#?(...)` / `#?@(...)`; the list follows.
          pos += text[pos + 2] === "@" ? 3 : 2;
        } else if (c2 === "(" || c2 === "{" || c2 === '"') {
          pos++; // dispatch form: the bracket / regex string is the base
        } else {
          // Tagged literal (`#inst "…"`) or namespaced map (`#:ns{…}`):
          // the tag token prefixes the following form.
          pos++;
          while (pos < limit && !ATOM_DELIMITERS.includes(text[pos])) {
            pos++;
          }
          pos = skipTrivia(text, pos, limit);
        }
        break;
      }
      default:
        break prefixes;
    }
  }
  if (pos >= limit) {
    return { kind: "unbalanced" }; // prefixes with nothing to prefix
  }

  const baseStart = pos;
  const c = text[pos];
  let end: number;
  let bracketOffset: number | null = null;
  let closerOffset: number | null = null;

  if (MATCHING[c]) {
    // Bracketed base: read children until the matching closer.
    bracketOffset = pos;
    const closer = MATCHING[c];
    let p = pos + 1;
    for (;;) {
      const child = readForm(text, p, limit);
      if (child.kind === "form") {
        p = child.form.end;
      } else if (child.kind === "closer") {
        if (text[child.offset] === closer) {
          closerOffset = child.offset;
          break;
        }
        p = child.offset + 1; // mismatched stray closer: skip it
      } else {
        return { kind: "unbalanced" };
      }
    }
    end = closerOffset + 1;
  } else if (c === '"') {
    // String / regex base.
    let p = pos + 1;
    for (;;) {
      if (p >= limit) {
        return { kind: "unbalanced" };
      }
      if (text[p] === "\\") {
        p += 2;
      } else if (text[p] === '"') {
        break;
      } else {
        p++;
      }
    }
    end = p + 1;
  } else if (c === "\\") {
    // Char literal: `\(`, `\newline`, `A`.
    if (pos + 1 >= limit) {
      return { kind: "unbalanced" };
    }
    end = pos + 2;
    if (isLetter(text[pos + 1])) {
      while (end < limit && /[\p{L}\p{Nd}-]/u.test(text[end])) {
        end++;
      }
    }
  } else {
    // Atom token.
    end = pos;
    while (end < limit && !ATOM_DELIMITERS.includes(text[end])) {
      end++;
    }
  }

  return {
    kind: "form",
    form: {
      start,
      innerStart: innerStart ?? start,
      baseStart,
      end,
      bracketOffset,
      closerOffset,
    },
  };
}

/** The form's evaluable range: leading `#_` markers stripped. */
function stripped(form: ReadForm): FormRange {
  return { start: form.innerStart, end: form.end };
}

/**
 * Walks the sibling forms of one nesting level ([contentStart, contentEnd))
 * and applies the resolution rules for a cursor at `offset`. `enclosing` is
 * this level's own form (null at top level). Returns the resolved form
 * un-stripped; callers decide what part of it they need.
 */
function resolveIn(
  text: string,
  contentStart: number,
  contentEnd: number,
  enclosing: ReadForm | null,
  offset: number,
): ReadForm | null {
  let prev: ReadForm | null = null;
  let p = contentStart;
  for (;;) {
    // Decide gaps from the next form's *start* before parsing it, so
    // incomplete code after the cursor cannot block the earlier rules
    // (e.g. rule 6 with an unfinished form further down the buffer).
    const nextStart = skipTrivia(text, p, contentEnd);
    if (nextStart >= contentEnd || nextStart > offset) {
      // Cursor sits in trivia: enclosing form (rule 5) or the previous
      // form at this level (rule 6).
      return enclosing ?? prev;
    }
    const result = readForm(text, nextStart, contentEnd);
    if (result.kind === "closer") {
      p = result.offset + 1; // stray closer at this level: skip
      continue;
    }
    if (result.kind === "unbalanced" || result.kind === "end") {
      return null; // the cursor's own form never completes
    }
    const form = result.form;
    if (form.end < offset) {
      prev = form;
      p = form.end;
      continue;
    }
    if (form.end === offset) {
      return form; // rules 2 (after token) and 3 (after closer)
    }
    if (form.start >= offset) {
      if (form.start === offset) {
        return form; // rule 4 (immediately before a token)
      }
      // Cursor in the trivia gap before this form: rules 5 / 6.
      return enclosing ?? prev;
    }
    // form.start < offset < form.end — the cursor is inside this form.
    if (form.bracketOffset === null || offset <= form.bracketOffset) {
      // Atom base (rule 2), or inside the prefix run: the whole form.
      return form;
    }
    return resolveIn(text, form.bracketOffset + 1, form.closerOffset!, form, offset);
  }
}

/** The form the resolution rules pick for a cursor at `offset`, un-stripped. */
function readFormAtCursor(text: string, offset: number): ReadForm | null {
  const clamped = Math.max(0, Math.min(offset, text.length));
  return resolveIn(text, 0, text.length, null, clamped);
}

/**
 * The form "Evaluate Current Form" should send for a cursor at `offset`, or
 * null when there is none (blank text, or unbalanced code the reader cannot
 * trust).
 */
export function formAtCursor(text: string, offset: number): FormRange | null {
  const form = readFormAtCursor(text, offset);
  return form === null ? null : stripped(form);
}

/** Offsets of the opening and closing bracket of the form at the cursor. */
export interface BracketPair {
  open: number;
  close: number;
}

/**
 * The bracket pair of the form `formAtCursor` resolves — always the base
 * form's own brackets, whatever reader prefixes or `#_` markers precede it —
 * or null when that form is an atom or a string, or nothing resolves. This is
 * what the editor highlights, so the highlight shows what eval will send.
 */
export function bracketPairAtCursor(text: string, offset: number): BracketPair | null {
  const form = readFormAtCursor(text, offset);
  if (form === null || form.bracketOffset === null) {
    return null;
  }
  return { open: form.bracketOffset, close: form.closerOffset! };
}

/**
 * The number of `#_` markers in a form's reader-prefix run. `readForm`
 * records the first one via `innerStart`, wherever it sits in the run
 * (`^:m #_old` included); the rest are counted from there, skipping any
 * interleaved `^meta`.
 */
function discardMarkers(text: string, form: ReadForm): number {
  if (form.innerStart === form.start) {
    return 0;
  }
  let count = 1;
  let p = form.innerStart;
  while (p < form.baseStart) {
    const c = text[p];
    if (c === "#" && text[p + 1] === "_") {
      count++;
      p = skipTrivia(text, p + 2, form.baseStart);
    } else if (c === "^") {
      const meta = readForm(text, p + 1, form.baseStart);
      if (meta.kind !== "form") {
        break;
      }
      p = skipTrivia(text, meta.form.end, form.baseStart);
    } else {
      break; // a quote-like prefix between markers: degenerate, stop counting
    }
  }
  return count;
}

/**
 * Reads the next child form that is not discarded. A child with n `#_`
 * markers discards its own base plus the next n-1 live forms —
 * `(deftest #_#_old also-old actual …)` defines `actual` — so all of them
 * are skipped. Iterative, so arbitrarily many discarded siblings cannot
 * overflow the stack.
 */
function readLiveChild(text: string, pos: number, limit: number): ReadResult {
  let pending = 0; // live forms still owed to earlier discard markers
  for (;;) {
    const result = readForm(text, pos, limit);
    if (result.kind !== "form") {
      return result;
    }
    const markers = discardMarkers(text, result.form);
    if (markers === 0) {
      if (pending === 0) {
        return result;
      }
      pending--; // consumed by an outstanding discard
    } else {
      pending += markers - 1; // the form's own base is the first discard
    }
    pos = result.form.end;
  }
}

/**
 * Where an evaluable range for the form starts, or null when a quote-like
 * prefix (`'`, `` ` ``, `~`, `@`, `#'`) means evaluating it would not run
 * the base form. `#_` markers and `^meta` are fine — evaluation still runs
 * the base — but the range starts after the last discard marker (and any
 * meta a marker discards along with), since a sent `#_` would discard the
 * very form being evaluated.
 */
function evaluableStart(text: string, form: ReadForm): number | null {
  let p = form.start;
  let start = form.start;
  while (p < form.baseStart) {
    const c = text[p];
    if (c === "#" && text[p + 1] === "_") {
      p = skipTrivia(text, p + 2, form.baseStart);
      start = p;
    } else if (c === "^") {
      const meta = readForm(text, p + 1, form.baseStart);
      if (meta.kind !== "form") {
        return null;
      }
      p = skipTrivia(text, meta.form.end, form.baseStart);
    } else {
      return null;
    }
  }
  return start;
}

/** A resolved `deftest` for "Run Test at Cursor". */
export interface TestAtCursor {
  /** Range of the whole deftest form (leading `#_` markers stripped). */
  range: FormRange;
  /** The bare test name, e.g. `"my-test"` — no namespace, no metadata. */
  name: string;
}

/**
 * The top-level `deftest` form the cursor is in — or, when the cursor sits in
 * top-level whitespace, the one ending right before it (matching
 * `formAtCursor`'s rule 6, so "right after the closing paren" works too).
 *
 * The resolved form must be a `(deftest …)` list, head bare or qualified
 * (`t/deftest`, `clojure.test/deftest`). Leading `#_` markers are fine — the
 * range strips them like `formAtCursor` does — and so is `^meta` on the list,
 * but a quote-like prefix (`'`, `` ` ``, `#'`) means the form would not
 * define a test var, so it does not resolve. Null when the cursor's form is
 * not a deftest, the name is missing, or the code is unbalanced — never a
 * silent fallback to an earlier deftest.
 */
export function testAtCursor(text: string, offset: number): TestAtCursor | null {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let prev: ReadForm | null = null;
  let target: ReadForm | null = null;
  let p = 0;
  for (;;) {
    // As in resolveIn: decide gaps from the next form's start before parsing
    // it, so unbalanced code after the cursor cannot block resolution.
    const nextStart = skipTrivia(text, p, text.length);
    if (nextStart >= text.length || nextStart > clamped) {
      target = prev;
      break;
    }
    const result = readForm(text, nextStart, text.length);
    if (result.kind === "closer") {
      p = result.offset + 1; // stray top-level closer: skip
      continue;
    }
    if (result.kind !== "form") {
      return null; // the cursor's own form never completes
    }
    if (result.form.end < clamped) {
      prev = result.form;
      p = result.form.end;
      continue;
    }
    target = result.form; // start <= offset <= end: the containing form
    break;
  }

  return target === null ? null : resolveDeftest(text, target);
}

/**
 * The `deftest` a read form denotes, or null when it is not one: a non-list
 * base, a quote-like prefix (which would not define a test var), a head that
 * is not `deftest` (bare or qualified), or a missing / non-symbol name.
 * Leading `#_` markers are stripped from the range, as `formAtCursor` does.
 */
function resolveDeftest(text: string, form: ReadForm): TestAtCursor | null {
  if (form.bracketOffset === null || text[form.bracketOffset] !== "(") {
    return null;
  }
  const rangeStart = evaluableStart(text, form);
  if (rangeStart === null) {
    return null;
  }
  const head = readLiveChild(text, form.bracketOffset + 1, form.closerOffset!);
  if (head.kind !== "form" || head.form.bracketOffset !== null) {
    return null;
  }
  const headToken = text.slice(head.form.baseStart, head.form.end);
  if (headToken !== "deftest" && !headToken.endsWith("/deftest")) {
    return null;
  }
  const name = readLiveChild(text, head.form.end, form.closerOffset!);
  if (name.kind !== "form" || name.form.bracketOffset !== null) {
    return null;
  }
  return {
    range: { start: rangeStart, end: form.end },
    name: text.slice(name.form.baseStart, name.form.end),
  };
}

/**
 * Every runnable top-level `deftest`, in buffer order — what "Run Tests in
 * Namespace" enumerates after loading the buffer. Discarded deftests are
 * excluded (`readLiveChild` skips them): a load-file never defines them, so
 * running one would fail on an unresolved var — and discarding a test is how
 * you disable it. Quoted deftests are excluded for the same reason. Code the
 * reader cannot finish yields the tests read before it, never a garbage range.
 */
export function testsInText(text: string): TestAtCursor[] {
  const tests: TestAtCursor[] = [];
  let p = 0;
  for (;;) {
    const result = readLiveChild(text, p, text.length);
    if (result.kind === "closer") {
      p = result.offset + 1; // stray top-level closer: skip
      continue;
    }
    if (result.kind !== "form") {
      return tests; // end of buffer, or an unbalanced tail
    }
    p = result.form.end;
    const found = resolveDeftest(text, result.form);
    if (found) {
      tests.push(found);
    }
  }
}

/**
 * True when a test-run result value — the summary map from
 * `clojure.test/run-test-var` or a deref'd `*report-counters*` — reports any
 * failures or errors. Drives revealing the REPL output channel.
 */
export function testRunFailed(value: string | undefined): boolean {
  return value !== undefined && /:(?:fail|error)\s+[1-9]/.test(value);
}

/**
 * The name in the nearest top-level `(ns …)` form that ends before `offset`
 * (pass the start of the form being evaluated), or undefined. Evaluating the
 * ns form itself therefore gets no ns param — it must run in the default
 * namespace to create its own.
 */
export function nsBefore(text: string, offset: number): string | undefined {
  let name: string | undefined;
  let p = 0;
  for (;;) {
    const result = readForm(text, p, text.length);
    if (result.kind === "closer") {
      p = result.offset + 1;
      continue;
    }
    if (result.kind !== "form" || result.form.start >= offset) {
      return name; // end/unbalanced: best effort with what was seen
    }
    const form = result.form;
    p = form.end;
    if (form.end > offset || form.bracketOffset === null) {
      continue;
    }
    // A reader prefix (`#_`, `'`, `` ` ``, …) means the ns form would not
    // actually execute — never take a namespace from it.
    if (form.baseStart !== form.start || text[form.bracketOffset] !== "(") {
      continue;
    }
    const head = readForm(text, form.bracketOffset + 1, form.closerOffset!);
    if (head.kind !== "form" || text.slice(head.form.baseStart, head.form.end) !== "ns") {
      continue;
    }
    const second = readForm(text, head.form.end, form.closerOffset!);
    if (second.kind === "form" && second.form.bracketOffset === null) {
      name = text.slice(second.form.baseStart, second.form.end);
    }
  }
}
