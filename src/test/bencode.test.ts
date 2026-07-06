import * as assert from "assert";
import { encode, decodeBuffer } from "../nrepl/bencode";

suite("bencode encode", () => {
  test("encodes a flat message object", () => {
    const buf = encode({ op: "clone", id: "1" });
    assert.strictEqual(buf.toString("utf8"), "d2:op5:clone2:id1:1e");
  });

  test("encodes integers", () => {
    assert.strictEqual(encode(42).toString("utf8"), "i42e");
    assert.strictEqual(encode(-7).toString("utf8"), "i-7e");
  });

  test("encodes string arrays", () => {
    const buf = encode({ status: ["done", "error"] });
    assert.strictEqual(buf.toString("utf8"), "d6:statusl4:done5:erroree");
  });

  test("omits keys with undefined values", () => {
    const buf = encode({ op: "eval", session: undefined, code: "1" });
    assert.strictEqual(buf.toString("utf8"), "d2:op4:eval4:code1:1e");
  });

  test("uses byte length for multibyte UTF-8 strings", () => {
    // "λ" is 2 bytes in UTF-8
    assert.strictEqual(encode("λx").toString("utf8"), "3:λx");
  });
});

suite("bencode decodeBuffer", () => {
  const enc = (s: string) => Buffer.from(s, "utf8");

  test("decodes integers", () => {
    const { decoded, rest } = decodeBuffer(enc("i42e"));
    assert.deepStrictEqual(decoded, [42]);
    assert.strictEqual(rest.length, 0);
  });

  test("decodes strings including multibyte UTF-8", () => {
    const { decoded } = decodeBuffer(encode("λx"));
    assert.deepStrictEqual(decoded, ["λx"]);
  });

  test("decodes lists", () => {
    const { decoded } = decodeBuffer(enc("l4:done5:errore"));
    assert.deepStrictEqual(decoded, [["done", "error"]]);
  });

  test("decodes nested dicts", () => {
    const { decoded } = decodeBuffer(
      enc("d8:versionsd7:clojured5:major1:1eee"),
    );
    assert.deepStrictEqual(decoded, [
      { versions: { clojure: { major: "1" } } },
    ]);
  });

  test("keeps a partial trailing message in rest untouched", () => {
    const full = enc("d2:op5:clonee");
    const partial = enc("d2:id");
    const { decoded, rest } = decodeBuffer(Buffer.concat([full, partial]));
    assert.deepStrictEqual(decoded, [{ op: "clone" }]);
    assert.deepStrictEqual(rest, partial);
  });

  test("decodes two concatenated messages in one buffer", () => {
    const buf = Buffer.concat([
      encode({ id: "1", value: "3" }),
      encode({ id: "1", status: ["done"] }),
    ]);
    const { decoded, rest } = decodeBuffer(buf);
    assert.deepStrictEqual(decoded, [
      { id: "1", value: "3" },
      { id: "1", status: ["done"] },
    ]);
    assert.strictEqual(rest.length, 0);
  });

  test("returns everything as rest when nothing is complete", () => {
    const partial = enc("d2:op5:cl");
    const { decoded, rest } = decodeBuffer(partial);
    assert.deepStrictEqual(decoded, []);
    assert.deepStrictEqual(rest, partial);
  });
});
