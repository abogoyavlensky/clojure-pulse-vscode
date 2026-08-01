import * as assert from "assert";
import { AnsiStripper, stripAnsi } from "../repl/ansi";

suite("stripAnsi", () => {
  test("plain text is returned unchanged", () => {
    assert.strictEqual(stripAnsi("nREPL server started on port 57592\n"), "nREPL server started on port 57592\n");
  });

  test("SGR bold/reset sequences are removed", () => {
    assert.strictEqual(stripAnsi("\x1b[1mbold\x1b[0m"), "bold");
  });

  test("256-color sequences are removed", () => {
    assert.strictEqual(
      stripAnsi("\x1b[38;5;45mmalli:\x1b[0m dev-mode"),
      "malli: dev-mode",
    );
  });

  test("non-color CSI sequences (erase, cursor move) are removed", () => {
    assert.strictEqual(stripAnsi("\x1b[2K\x1b[1Gtext"), "text");
  });

  test("OSC sequences are removed", () => {
    assert.strictEqual(stripAnsi("\x1b]0;title\x07text"), "text");
  });
});

suite("AnsiStripper", () => {
  test("a sequence split across two chunks is dropped whole", () => {
    const stripper = new AnsiStripper();
    assert.strictEqual(stripper.strip("a\x1b[3"), "a");
    assert.strictEqual(stripper.strip("8;5;45mb"), "b");
  });

  test("a chunk-final lone ESC is held until the next chunk completes it", () => {
    const stripper = new AnsiStripper();
    assert.strictEqual(stripper.strip("done\x1b"), "done");
    assert.strictEqual(stripper.strip("[0m!\n"), "!\n");
  });

  test("a held tail that is not an escape sequence is emitted, not dropped", () => {
    const stripper = new AnsiStripper();
    assert.strictEqual(stripper.strip("x\x1b"), "x");
    // ESC followed by a plain letter is not a CSI/OSC introducer; both
    // characters belong to the output.
    assert.strictEqual(stripper.strip("zrest"), "\x1bzrest");
  });

  test("chunks with no escapes pass through unchanged", () => {
    const stripper = new AnsiStripper();
    assert.strictEqual(stripper.strip("plain "), "plain ");
    assert.strictEqual(stripper.strip("text\n"), "text\n");
  });

  test("multiple complete sequences in one chunk are all removed", () => {
    const stripper = new AnsiStripper();
    assert.strictEqual(
      stripper.strip("\x1b[1;36mGO\x1b[0m \x1b[90mCtrl-C to quit\x1b[0m\n"),
      "GO Ctrl-C to quit\n",
    );
  });
});
