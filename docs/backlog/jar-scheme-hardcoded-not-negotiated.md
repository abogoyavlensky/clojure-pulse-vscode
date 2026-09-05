# The `jar` scheme is hardcoded twice instead of read from the server

**Status: open**

## Problem

clj-pulse advertises the schemes it serves content for, in its `initialize`
result (`clj-pulse/src/server.rs:1994`):

```rust
experimental: Some(serde_json::json!({
    "textDocumentContentProvider": { "schemes": ["jar"] }
})),
```

Nothing reads it. The extension hardcodes `jar` in the two places that matter
instead:

- `src/extension.ts:188` — `registerTextDocumentContentProvider("jar", …)`,
  which is what makes a dependency's source openable at all.
- `src/client.ts:26` — the `jar` entry in `CLOJURE_DOCUMENT_SELECTOR`, which is
  what routes language features into that document.

The two agree today, so nothing is broken. They agree by coincidence, not by
construction: a server that served, say, `zipfile:` would advertise it and the
extension would ignore it.

## Why it is left alone

The duplication costs nothing until a second scheme exists, and none is
planned. Reading the capability would also mean deciding what to do when it is
absent or lists something unexpected — a server too old to advertise it still
serves jar content, so the extension would need the `jar` fallback anyway and
would end up with more code, not less.

The capability's real value is on the other side of the split. Both halves of
this feature are inherently client-side (see the "Library navigation" work in
`docs/plans/2026-09-04-2217-lsp-in-jar-sources.md`): LSP gives a server no say
in which documents a client routes to it, so every editor that wants language
features inside a dependency has to wire up its own content provider and its
own selector. If that wiring is ever worth centralizing, the server growing
dynamic registration for a jar-inclusive selector — text synchronization
included, since a client sends no `didOpen` for a document outside its
selector — is the shape to build, and this advertised capability is the hook it
would negotiate through. That is a much larger change resting on
dynamic-registration support that clients vary in.
