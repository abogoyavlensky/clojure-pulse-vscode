// The cljfmt engine: byte-identical cljfmt indentation via the bundled
// cljfmt-js build. The Enter hot path formats a small *window* instead of
// the whole top-level form — cljfmt's indent rules only consult a bounded
// number of ancestors (`[:inner n]`, config-scanned `maxInner`), so a probe
// over `maxInner + 1` enclosing forms sees everything the rules can ask for.
//
// cljfmt's cost grows steeply with form size (~40 ms at 25 lines, ~700 ms at
// 300), so depth alone is not enough: a shallow-but-huge form (a big
// `(comment …)` block) would still be reformatted whole. `WINDOW_CAP` bounds
// the slice — an oversized window shrinks to deeper ancestors, trading the
// outer forms' (almost always irrelevant) deep `:inner` rules for a bounded
// keystroke; when even the innermost form is oversized, the structural rule
// answers. Every other failure (unbalanced text, parse errors, a probe that
// loses the placeholder) falls back to the structural rule too — the Enter
// path never errors.
//
// Probe mechanics: the window text gets a newline + placeholder symbol at
// the cursor, is reformatted with every text-mutating option forced off
// (indentation only, so line count is preserved), and the placeholder
// line's leading whitespace plus the window opener's real column is the
// answer. The indent is correct under cljfmt's own assumption that the
// window's earlier lines are cljfmt-clean — formatters converge buffers.

import {
  Config,
  mergeConfig,
  NsContext,
  readConfig,
  reformatString,
} from "@abogoyavlensky/cljfmt-js";
import { findMatchingClose, Scanner } from "../indent";
import { FormattingEngine } from "./engine";
import { structuralEngine } from "./structuralEngine";

/** Max window slice size (UTF-16 units) the Enter probe will hand to
 *  cljfmt — ~30 ms worst case on the extension host. */
export const WINDOW_CAP = 2000;

/** Everything that could rewrite text (not just leading whitespace) is
 *  forced off, so the probe's output has the input's exact line structure. */
const PROBE_OVERRIDES = readConfig(
  `{:remove-surrounding-whitespace? false
    :remove-consecutive-blank-lines? false
    :insert-missing-whitespace? false
    :remove-trailing-whitespace? false
    :remove-multiple-non-indenting-spaces? false
    :split-keypairs-over-multiple-lines? false
    :sort-ns-references? false
    :normalize-newlines-at-file-end? false
    :remove-blank-lines-in-forms? false
    :align-map-columns? false
    :align-form-columns? false
    :align-binding-columns? false
    :align-single-column-lines? false}`,
);

export interface ConfigWindowLookup {
  config: Config;
  /** Deepest `[:inner n]` the config can reach (min 2). */
  maxInner: number;
}

export interface ProbeWindow {
  /** Offset of the window form's opener token (`#` for `#(` / `#{`). */
  start: number;
  /** One past the window form's closer. */
  end: number;
}

/**
 * The enclosing form the Enter probe reformats: the ancestor `maxInner`
 * levels above the cursor's parent form, shrunk to deeper (smaller)
 * ancestors while the slice exceeds `cap`. `null` when no enclosing form
 * fits — every candidate is unclosed (mid-edit) or oversized.
 */
export function selectWindow(
  text: string,
  offset: number,
  maxInner: number,
  cap: number,
): ProbeWindow | null {
  const scanner = new Scanner();
  scanner.scan(text, 0, offset);
  const stack = scanner.stack;
  for (let i = Math.max(0, stack.length - (maxInner + 1)); i < stack.length; i++) {
    const start = stack[i].openOffset;
    const close = findMatchingClose(text, start);
    if (close === null) {
      continue;
    }
    const end = close + 1;
    if (end - start <= cap) {
      return { start, end };
    }
  }
  return null;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      n++;
    }
  }
  return n;
}

export function createCljfmtEngine(
  lookup: ConfigWindowLookup,
  nsContext?: NsContext,
): FormattingEngine {
  function probeIndent(text: string, offset: number): number | null {
    const win = selectWindow(text, offset, lookup.maxInner, WINDOW_CAP);
    if (win === null) {
      return null;
    }
    // Mirror the Enter command's whitespace eating: the new line's tail
    // starts after any spaces/tabs at the cursor.
    let tailStart = offset;
    while (
      tailStart < text.length &&
      (text[tailStart] === " " || text[tailStart] === "\t")
    ) {
      tailStart++;
    }
    const windowText = text.slice(win.start, win.end);
    let placeholder = "__cljp__";
    for (let n = 0; windowText.includes(placeholder); n++) {
      placeholder = `__cljp${n}__`;
    }
    const before = text.slice(win.start, offset);
    // The space keeps the placeholder a token of its own — `'`, `#` and
    // most symbol characters would otherwise fuse it with the tail's first
    // token and hand cljfmt a different form.
    const probe =
      before + "\n" + placeholder + " " + text.slice(tailStart, win.end);
    const out = reformatString(probe, mergeConfig(lookup.config, PROBE_OVERRIDES), nsContext);
    // Indentation-only reformatting preserves line structure, so the
    // placeholder's line index is known instead of searched for.
    const line = out.split("\n")[countNewlines(before) + 1];
    if (line === undefined) {
      return null;
    }
    const indent = /^ */.exec(line)![0].length;
    if (!line.startsWith(placeholder, indent)) {
      return null;
    }
    const openerLineStart = text.lastIndexOf("\n", win.start - 1) + 1;
    return indent + (win.start - openerLineStart);
  }

  return {
    indentAt(text, offset) {
      const scanner = new Scanner();
      scanner.scan(text, 0, offset);
      if (scanner.inString) {
        return null;
      }
      if (scanner.stack.length === 0) {
        return 0;
      }
      let probed: number | null = null;
      try {
        probed = probeIndent(text, offset);
      } catch {
        probed = null;
      }
      return probed ?? structuralEngine.indentAt(text, offset);
    },
    // Whole-file and range formatting arrive with the format providers.
    formatDocument() {
      return null;
    },
    formatRange() {
      return null;
    },
  };
}
