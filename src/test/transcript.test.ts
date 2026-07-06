import * as assert from "assert";
import { Transcript, TranscriptEntry } from "../repl/transcript";

suite("Transcript", () => {
  test("append stores typed entries and fires the listener", () => {
    const transcript = new Transcript();
    const seen: TranscriptEntry[] = [];
    transcript.onDidAppend((entry) => seen.push(entry));

    transcript.append({ kind: "banner", text: "Connected" });
    transcript.append({ kind: "out", text: "hi\n" });

    assert.deepStrictEqual(transcript.entries(), [
      { kind: "banner", text: "Connected" },
      { kind: "out", text: "hi\n" },
    ]);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[1].kind, "out");
  });

  test("drops the oldest entries beyond the cap", () => {
    const transcript = new Transcript(3);
    for (let i = 1; i <= 5; i++) {
      transcript.append({ kind: "out", text: String(i) });
    }
    assert.deepStrictEqual(
      transcript.entries().map((e) => e.text),
      ["3", "4", "5"],
    );
  });

  test("reports evictions to append listeners so live views stay in sync", () => {
    const transcript = new Transcript(2);
    const evictions: number[] = [];
    transcript.onDidAppend((_entry, evicted) => evictions.push(evicted));
    transcript.append({ kind: "out", text: "1" });
    transcript.append({ kind: "out", text: "2" });
    transcript.append({ kind: "out", text: "3" });
    assert.deepStrictEqual(evictions, [0, 0, 1]);
  });

  test("entries returns a snapshot, not the live array", () => {
    const transcript = new Transcript();
    transcript.append({ kind: "info", text: "a" });
    const snapshot = transcript.entries();
    transcript.append({ kind: "info", text: "b" });
    assert.strictEqual(snapshot.length, 1);
  });

  test("clear empties and notifies", () => {
    const transcript = new Transcript();
    transcript.append({ kind: "err", text: "boom" });
    let cleared = false;
    transcript.onDidClear(() => {
      cleared = true;
    });
    transcript.clear();
    assert.deepStrictEqual(transcript.entries(), []);
    assert.strictEqual(cleared, true);
  });
});
