import * as assert from "assert";
import { PendingClojureDocsRequest } from "../clojureDocsRequest";

const uri = "file:///demo.clj";

function holder() {
  let now = 0;
  const pending = new PendingClojureDocsRequest(() => now, 1000);
  return {
    pending,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

suite("PendingClojureDocsRequest", () => {
  test("an empty holder hands out nothing", () => {
    const { pending } = holder();
    assert.strictEqual(pending.take(uri, 1, 2), undefined);
    assert.strictEqual(pending.lastTaken, undefined);
  });

  test("a recorded request is handed out once at its position", () => {
    const { pending } = holder();
    pending.record({ uri, line: 1, character: 2 });
    const taken = pending.take(uri, 1, 2);
    assert.strictEqual(taken?.uri, uri);
    assert.strictEqual(taken?.line, 1);
    assert.strictEqual(taken?.character, 2);
    assert.strictEqual(taken?.symbol, undefined);
    assert.strictEqual(taken?.at, 0);
    assert.strictEqual(pending.take(uri, 1, 2), undefined, "consumed by the first take");
  });

  test("a take elsewhere leaves the request for a later matching take", () => {
    const { pending } = holder();
    pending.record({ uri, line: 1, character: 2 });
    assert.strictEqual(pending.take(uri, 1, 3), undefined);
    assert.strictEqual(pending.take("file:///other.clj", 1, 2), undefined);
    assert.ok(pending.take(uri, 1, 2));
  });

  test("a stale request is dropped", () => {
    const { pending, advance } = holder();
    pending.record({ uri, line: 1, character: 2 });
    advance(1001);
    assert.strictEqual(pending.take(uri, 1, 2), undefined);
    pending.record({ uri, line: 1, character: 2 });
    advance(1000);
    assert.ok(pending.take(uri, 1, 2), "exactly the TTL is still fresh");
  });

  test("a second record replaces the first", () => {
    const { pending } = holder();
    pending.record({ uri, line: 1, character: 2 });
    pending.record({ uri, line: 5, character: 0 });
    assert.strictEqual(pending.take(uri, 1, 2), undefined);
    assert.strictEqual(pending.take(uri, 5, 0)?.line, 5);
  });

  test("a symbol is carried through", () => {
    const { pending } = holder();
    pending.record({ uri, line: 1, character: 2, symbol: "clojure.core/mapv" });
    assert.strictEqual(pending.take(uri, 1, 2)?.symbol, "clojure.core/mapv");
  });

  test("lastTaken tracks only requests actually handed out", () => {
    const { pending, advance } = holder();
    pending.record({ uri, line: 1, character: 2 });
    pending.take(uri, 9, 9);
    assert.strictEqual(pending.lastTaken, undefined, "a miss hands nothing out");
    const taken = pending.take(uri, 1, 2);
    assert.strictEqual(pending.lastTaken, taken);
    pending.record({ uri, line: 3, character: 3 });
    advance(5000);
    pending.take(uri, 3, 3);
    assert.strictEqual(pending.lastTaken, taken, "a stale drop is not a take");
  });
});
