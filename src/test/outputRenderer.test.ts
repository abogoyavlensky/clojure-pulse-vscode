import * as assert from "assert";
import { attachTranscriptRenderer, formatEntry } from "../repl/outputRenderer";
import { Transcript } from "../repl/transcript";

/** Minimal stand-in for `vscode.OutputChannel`'s append/clear surface. */
function fakeSink() {
  const appended: string[] = [];
  let clears = 0;
  return {
    append(text: string) {
      appended.push(text);
    },
    clear() {
      clears += 1;
      appended.length = 0;
    },
    text: () => appended.join(""),
    clears: () => clears,
  };
}

suite("formatEntry", () => {
  test("banner and info are commented out, one prefix per line", () => {
    assert.strictEqual(
      formatEntry({ kind: "banner", text: "Connected to nREPL at x:1" }),
      ";; Connected to nREPL at x:1\n",
    );
    assert.strictEqual(
      formatEntry({ kind: "info", text: "line one\nline two" }),
      ";; line one\n;; line two\n",
    );
  });

  test("in entries are raw code with a trailing newline", () => {
    assert.strictEqual(formatEntry({ kind: "in", text: "(+ 1 2)" }), "(+ 1 2)\n");
  });

  test("values are prefixed with the eval arrow", () => {
    assert.strictEqual(formatEntry({ kind: "value", text: "42" }), "=> 42\n");
  });

  test("out and err chunks are appended raw", () => {
    assert.strictEqual(
      formatEntry({ kind: "out", text: "printed\n" }),
      "printed\n",
    );
    assert.strictEqual(formatEntry({ kind: "err", text: "boom" }), "boom");
  });

  test("a multi-line banner keeps Clojure comments on every line", () => {
    assert.strictEqual(
      formatEntry({ kind: "banner", text: "a\nb" }),
      ";; a\n;; b\n",
    );
  });

  test("a trailing newline in an info does not leave a bare comment line", () => {
    assert.strictEqual(formatEntry({ kind: "info", text: "done\n" }), ";; done\n");
  });
});

suite("attachTranscriptRenderer", () => {
  test("replays existing entries on attach", () => {
    const transcript = new Transcript();
    transcript.append({ kind: "info", text: "before" });
    const sink = fakeSink();

    attachTranscriptRenderer(transcript, sink);

    assert.strictEqual(sink.text(), ";; before\n");
  });

  test("mirrors later appends", () => {
    const transcript = new Transcript();
    const sink = fakeSink();
    attachTranscriptRenderer(transcript, sink);

    transcript.append({ kind: "in", text: "(+ 1 2)" });
    transcript.append({ kind: "value", text: "3" });

    assert.strictEqual(sink.text(), "(+ 1 2)\n=> 3\n");
  });

  test("clears the sink when the transcript clears", () => {
    const transcript = new Transcript();
    const sink = fakeSink();
    attachTranscriptRenderer(transcript, sink);
    transcript.append({ kind: "value", text: "1" });

    transcript.clear();

    assert.strictEqual(sink.clears(), 1);
    assert.strictEqual(sink.text(), "");
  });

  test("appends after a clear still land", () => {
    const transcript = new Transcript();
    const sink = fakeSink();
    attachTranscriptRenderer(transcript, sink);
    transcript.clear();
    transcript.append({ kind: "value", text: "7" });

    assert.strictEqual(sink.text(), "=> 7\n");
  });
});
