/**
 * ANSI escape-sequence stripping for REPL output. VS Code output channels
 * never interpret escape codes, so colored server banners would render as
 * literal `ESC[1m` garbage; everything headed for the transcript is cleaned
 * here first.
 *
 * `AnsiStripper` exists because output arrives in arbitrarily split chunks:
 * a sequence can straddle a boundary (`ESC[3` then `8;5;45m`), which a
 * per-chunk regex would leak. The stripper holds a chunk-final incomplete
 * sequence back until the next chunk completes it.
 *
 * Pure (no `vscode` import).
 */

/** Complete CSI sequences (colors, cursor movement) and OSC sequences
 *  terminated by BEL or ST. */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- matching escape codes is the point
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** A trailing sequence still missing its final byte (or terminator): a bare
 *  `ESC`, an unfinished CSI body, or an unterminated OSC body. */
// eslint-disable-next-line no-control-regex -- matching escape codes is the point
const INCOMPLETE_TAIL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;

/** Removes every complete ANSI escape sequence from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Strips ANSI sequences from a chunked stream. One instance per stream —
 * the held-back tail belongs to the stream it was read from.
 */
export class AnsiStripper {
  private pending = "";

  /** The chunk with sequences removed; a chunk-final incomplete sequence is
   *  held back and prepended to the next call. */
  strip(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    const stripped = text.replace(ANSI_PATTERN, "");
    const tail = INCOMPLETE_TAIL.exec(stripped);
    if (tail) {
      this.pending = tail[0];
      return stripped.slice(0, tail.index);
    }
    return stripped;
  }
}
