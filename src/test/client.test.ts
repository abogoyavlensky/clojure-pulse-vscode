/**
 * The document selector decides which documents VS Code routes to the language
 * server at all. Without the `jar` entry a dependency's source — opened through
 * the `jar:` content provider — matches nothing, so VS Code sends no LSP
 * request for it and go to definition, hover and completion all resolve to
 * nothing inside it.
 */
import * as assert from "assert";
import { CLOJURE_DOCUMENT_SELECTOR } from "../client";

suite("Clojure document selector", () => {
  test("routes both file and jar documents for the clojure language", () => {
    assert.deepStrictEqual(
      [...CLOJURE_DOCUMENT_SELECTOR],
      [
        { scheme: "file", language: "clojure" },
        { scheme: "jar", language: "clojure" },
      ],
    );
  });
});
