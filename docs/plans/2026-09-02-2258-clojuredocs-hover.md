# ClojureDocs in the Editor Hover Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the ClojureDocs entry in VS Code's native editor hover, opened focused so the arrow keys scroll it, with examples syntax-highlighted by the user's theme, replacing the webview panel.

**Tech Stack:** TypeScript VS Code extension (`vscode.languages.registerHoverProvider`, `MarkdownString`, built-in `editor.action.showHover` / `editor.action.hideHover` / `vscode.executeHoverProvider`), mocha via `@vscode/test-cli`. The clj-pulse server and its `clojurePulse/clojureDocs` request are unchanged.

**Repo:** `/home/agent/Projects/clojure-pulse-vscode`, branch `feature/clojuredocs` (the panel version is already committed and pushed there). Follows `docs/plans/2026-09-02-0819-clojuredocs-offline.md`.

---

## Design

### Approach

The extension registers its own `HoverProvider` for Clojure. It answers only a one-shot request that the Show ClojureDocs command records first; every other hover, from the mouse or from `Ctrl+K Ctrl+I`, gets nothing from it. The command records the request and runs `editor.action.showHover` with `{ focus: "autoFocusImmediately" }`, so the popup opens focused: Up/Down scroll, PageUp/PageDown and Alt+Up/Down page, Home/End jump, Escape returns to the editor. These are VS Code's own keybindings under the `editorHoverFocused` context. Examples are fenced ```` ```clojure ```` blocks, which VS Code tokenizes with the real grammar and theme. VS Code merges every provider's part into one popup: the clj-pulse part (arglists, docstring) renders first, ours below it.

Why a recorded request: `provideHover` cannot tell a keypress from the mouse resting, and the API that would let a hover expand on demand (`editorHoverVerbosityLevel`) is still proposed and unusable by a published extension. The request is keyed by document and position, consumed once, and expires after one second, so a stale request cannot leak into an unrelated hover.

### Verified facts (VS Code source, `hoverActions.ts`, `languageFeatureRegistry`)

- `editor.action.showHover` accepts `{ focus: "noAutoFocus" | "focusIfVisible" | "autoFocusImmediately" }`; a plain `true` also means auto-focus. Default is `focusIfVisible`, which is why the built-in binding takes two presses. Older VS Code ignores the argument, so the engine stays at `^1.85.0`.
- When a hover is already visible, `showHover` focuses it instead of re-querying. `editor.action.hideHover` hides it. The command hides before every show, so see-also navigation re-queries.
- Providers with equal selector scores render later-registered first. The LSP client registers its hover provider when the server starts, after activation, so ours (registered during `activate`, before `start()`) renders below the server's part. Server restarts re-register the LSP provider later again, keeping the order.
- `vscode.executeHoverProvider(uri, position)` returns every provider's `Hover[]`; the end-to-end test uses it to read our markdown.

### Components

- `src/clojureDocsRequest.ts` (new, pure): `PendingClojureDocsRequest` holding at most one request `{ uri, line, character, symbol?, at }`. `record(request)` replaces any previous one. `take(uri, line, character)` returns the request once when uri and position match and `now() - at <= ttlMs`, clearing it either way when it is stale or matched; a non-matching fresh request stays. `lastTaken` is the request most recently handed out (`undefined` before any), so the end-to-end test can prove the command drove VS Code to query our provider. Clock and TTL injected (`Date.now`, 1000 ms).
- `src/clojureDocs.ts` (modified): keep `ClojureDocsEntry`, `ClojureDocsResult`, `ClojureDocsParams`, `CLOJUREDOCS_REQUEST`, `CLOJUREDOCS_MIN_SERVER`, `describeClojureDocsFailure`, `noEntryMessage`. Replace `renderClojureDocsHtml` and `escapeHtml` with `buildClojureDocsMarkdown(entry): string`.
- `src/clojureDocsHover.ts` (new): `createClojureDocsHoverProvider(deps)` returning a `vscode.HoverProvider`. Deps: `pending`, `lookup(params)`, `serverVersion()`, and `notify` (`{ info(message), warn(message) }`, so tests can observe messages). `provideHover` takes the pending request for the document and position; none → `undefined`. Otherwise it sends `{ symbol }` when the request carries one, else `{ textDocument: { uri }, position }`. `entry: null` → `notify.info(noEntryMessage(result.symbol))`, `undefined`. Lookup failure → `notify.warn(describeClojureDocsFailure(error, serverVersion()))`, `undefined`. Success → `new vscode.Hover(markdown)` where `markdown = new vscode.MarkdownString(buildClojureDocsMarkdown(entry))` with `isTrusted = { enabledCommands: ["clojurePulse.showClojureDocs"] }`.
- `src/extension.ts` (modified): the `ClojureDocsPanel` wiring goes; the provider is registered in `activate` before `start()` runs; the command takes an optional symbol argument; `ExtensionApi` gains `clojureDocsRequests: PendingClojureDocsRequest` for the end-to-end test.
- Removed: `src/clojureDocsPanel.ts`, `src/test/clojureDocsPanel.test.ts`.

### The markdown (the shape tests pin)

```
**ClojureDocs: clojure.core/map** · Available since 1.0 · [clojuredocs.org](https://clojuredocs.org/clojure.core/map)

**Examples**

```clojure
(map inc [1 2 3])
;;=> (2 3 4)
```

```clojure
(map + [1 2] [3 4])
```

**See also** [clojure.core/mapv](command:clojurePulse.showClojureDocs?%5B%22clojure.core%2Fmapv%22%5D) · [clojure.core/pmap](command:…)
```

- The header names the var because after a see-also click the server's part still describes the symbol under the cursor while ours describes the target.
- "Available since" is omitted when `added` is absent. Without examples the Examples section is replaced by the line `No examples on ClojureDocs yet.` The See also line is omitted when empty.
- Arglists and docstring are not repeated; the server's part shows them.
- A fence is one backtick longer than the longest backtick run inside the example, so any example body renders verbatim.
- Command URIs: `command:clojurePulse.showClojureDocs?` + `encodeURIComponent(JSON.stringify([fqn]))`.

### The command

`clojurePulse.showClojureDocs(symbol?: unknown)`:

1. No active editor or not a Clojure document → information message "Open a Clojure file and place the cursor on a symbol."
2. A symbol argument counts only when it is a non-empty string; anything else (a keybinding with odd args) is treated as absent. Without one, no word range at the cursor → "Place the cursor on a symbol."
3. No client → "clj-pulse is not running."
4. `await executeCommand("editor.action.hideHover")`, then `pending.record({ uri, line, character, symbol })` with the cursor position, then `await executeCommand("editor.action.showHover", { focus: "autoFocusImmediately" })`.

The command returns once the hover is triggered; results and errors surface from the provider. A see-also link runs the same command with the target fqn while the cursor has not moved, so the new request records at the same position and the hidden-then-shown hover carries the target's examples.

### Error handling

| Situation | Behaviour |
|---|---|
| Not a Clojure editor / no word | Information message from the command |
| Server not running | Information message from the command |
| Server too old (`-32601`) or data error | Warning from the provider via `describeClojureDocsFailure` |
| No entry | Information message from the provider naming the resolved symbol |
| Hover requested without a recorded request | Provider returns nothing; the popup shows only the server's part |

### Testing

- `src/test/clojureDocsRequest.test.ts`: record/take matching, one-shot consumption, expiry, replacement, position mismatch.
- `src/test/clojureDocs.test.ts`: markdown builder cases replace the HTML cases; failure and no-entry message tests stay.
- `src/test/clojureDocsHover.test.ts`: the provider with a fake lookup and a recording `notify`: no request → `undefined` and no lookup; position request → lookup params carry `textDocument`/`position`, hover markdown contains the header and an example, `isTrusted` enables the command; symbol request → lookup params are `{ symbol }`; `entry: null` → info message, `undefined`; rejection → warning, `undefined`; a second call without a new request → `undefined`.
- `src/test/clojureDocs.e2e.test.ts` (gated on `CLJ_PULSE_E2E_BIN`): records a request through `ExtensionApi.clojureDocsRequests`, calls `vscode.executeHoverProvider`, asserts one part contains `ClojureDocs: clojure.core/map` and `(map inc`, and that the aliased `str/join` yields `ClojureDocs: clojure.string/join`; then runs the real command with the cursor on `map` and asserts `clojureDocsRequests.lastTaken` is the request at that position, which proves the command recorded it and VS Code's hover pipeline queried our provider. Rendering is proven by the `executeHoverProvider` path; the focus argument has no observable API and stays covered by the VS Code source check in the Design. Run against `target/debug/clj-pulse`.
- `make check` green; `npm run package` still includes `data/clojuredocs.json`.

## File Structure

- Create `src/clojureDocsRequest.ts` — the pending one-shot request. Test `src/test/clojureDocsRequest.test.ts`.
- Modify `src/clojureDocs.ts` — `buildClojureDocsMarkdown` replaces the HTML renderer. Test `src/test/clojureDocs.test.ts`.
- Create `src/clojureDocsHover.ts` — the hover provider factory. Test `src/test/clojureDocsHover.test.ts`.
- Modify `src/extension.ts` — provider registration, command, `ExtensionApi` hook; panel wiring removed.
- Delete `src/clojureDocsPanel.ts`, `src/test/clojureDocsPanel.test.ts`.
- Modify `src/test/clojureDocs.e2e.test.ts` — hover-based assertions.
- Modify `README.md`, `CHANGELOG.md`, `docs/plans/2026-09-02-0819-clojuredocs-offline.md` (superseded note).

---

### Task 1: The pending request

**Files:**
- Create: `src/clojureDocsRequest.ts`
- Test: `src/test/clojureDocsRequest.test.ts`

- [ ] **Step 1: Write the failing tests**
  Mocha tdd suite with an injected clock (`let now = 0; new PendingClojureDocsRequest(() => now, 1000)`). Cases: `take` on an empty holder is `undefined`; a recorded request is returned by a matching `take` and a second `take` is `undefined`; a `take` at another position or uri returns `undefined` and leaves the request for a later matching `take`; after `now` advances past the TTL a matching `take` is `undefined`; a second `record` replaces the first; `symbol` is carried through; `lastTaken` is `undefined` before any take, equals the request after a matching take, and is unchanged by a non-matching or stale take.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests 2>&1 | grep 'error TS'`
  Expected: `Cannot find module '../clojureDocsRequest'`.

- [ ] **Step 3: Implement**
  `export interface ClojureDocsRequest { uri: string; line: number; character: number; symbol?: string; at: number }` and `PendingClojureDocsRequest` with `record(request: Omit<ClojureDocsRequest, "at">): void`, `take(uri: string, line: number, character: number): ClojureDocsRequest | undefined`, and a readonly `lastTaken: ClojureDocsRequest | undefined` getter, per the Design. No `vscode` import.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -g "PendingClojureDocsRequest"`
  Expected: all passing.

- [ ] **Step 5: Commit**
  `git add src/clojureDocsRequest.ts src/test/clojureDocsRequest.test.ts && git commit -m "Add the one-shot ClojureDocs hover request"`

### Task 2: Markdown builder

**Files:**
- Modify: `src/clojureDocs.ts`
- Test: `src/test/clojureDocs.test.ts`

- [ ] **Step 1: Rewrite the renderer tests**
  Replace the `renderClojureDocsHtml` suite with a `buildClojureDocsMarkdown` suite using the same `full` and `minimal` fixtures (drop the HTML-escaping angle brackets from the fixtures, add an example containing a triple backtick). Cases: header line `**ClojureDocs: clojure.core/map** · Available since 1.0 · [clojuredocs.org](https://clojuredocs.org/clojure.core/map)`; `**Examples**` followed by one ```` ```clojure ```` fence per example with the body verbatim; the example containing three backticks is wrapped in a four-backtick fence; the See also line holds `[clojure.core/mapv](command:clojurePulse.showClojureDocs?%5B%22clojure.core%2Fmapv%22%5D)`; the minimal entry has no "Available since", the line `No examples on ClojureDocs yet.`, and no See also; no arglists or docstring text appears. Keep the failure and no-entry suites.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests 2>&1 | grep 'error TS'`
  Expected: `buildClojureDocsMarkdown` not exported.

- [ ] **Step 3: Implement**
  Add `buildClojureDocsMarkdown(entry: ClojureDocsEntry): string` per the Design's markdown shape; remove `renderClojureDocsHtml` and `escapeHtml`. Fence length: count the longest run of backticks in the example and use one more, minimum three. Update the module doc comment (hover, not panel).

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -g "buildClojureDocsMarkdown|describeClojureDocsFailure|noEntryMessage"`
  Expected: all passing.

- [ ] **Step 5: Commit**
  `git add src/clojureDocs.ts src/test/clojureDocs.test.ts && git commit -m "Build ClojureDocs hover markdown"`

### Task 3: Hover provider

**Files:**
- Create: `src/clojureDocsHover.ts`
- Test: `src/test/clojureDocsHover.test.ts`

- [ ] **Step 1: Write the failing tests**
  In the VS Code host (the test imports `vscode`). Harness: a `PendingClojureDocsRequest` with a fixed clock, a scripted `lookup` recording params, `serverVersion: () => "0.4.0"`, and `notify` collecting `info`/`warn` messages. A document from `vscode.workspace.openTextDocument({ language: "clojure", content: "(map inc [1 2 3])\n" })`. Cases per the Design's Testing section: no request → `undefined`, lookup not called; recorded position request → lookup got `{ textDocument: { uri }, position: { line, character } }`, the hover's single content is a `MarkdownString` whose `value` contains `ClojureDocs: clojure.core/map` and ```` ```clojure ````, and `isTrusted` deep-equals `{ enabledCommands: ["clojurePulse.showClojureDocs"] }`; recorded symbol request → lookup got `{ symbol: "clojure.core/mapv" }`; `entry: null` → one info message containing the symbol, result `undefined`; rejected lookup with `{ code: -32601 }` → one warning containing `0.4.0`, result `undefined`; second `provideHover` with no new request → `undefined` and no second lookup.

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests 2>&1 | grep 'error TS'`
  Expected: `Cannot find module '../clojureDocsHover'`.

- [ ] **Step 3: Implement**
  `export interface ClojureDocsHoverDeps { pending: PendingClojureDocsRequest; lookup: (params: ClojureDocsParams) => Promise<ClojureDocsResult>; serverVersion: () => string | undefined; notify: { info: (message: string) => void; warn: (message: string) => void } }` and `export function createClojureDocsHoverProvider(deps): vscode.HoverProvider`, per the Design. The provider must never throw: every failure becomes a message and `undefined`.

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -g "ClojureDocs hover provider"`
  Expected: all passing.

- [ ] **Step 5: Commit**
  `git add src/clojureDocsHover.ts src/test/clojureDocsHover.test.ts && git commit -m "Add the ClojureDocs hover provider"`

### Task 4: Wire the hover, remove the panel

**Files:**
- Modify: `src/extension.ts`
- Delete: `src/clojureDocsPanel.ts`, `src/test/clojureDocsPanel.test.ts`

- [ ] **Step 1: Replace the wiring**
  In `activate`: create `const clojureDocsRequests = new PendingClojureDocsRequest()` and register `vscode.languages.registerHoverProvider({ language: "clojure" }, createClojureDocsHoverProvider({ pending: clojureDocsRequests, lookup: (params) => { const running = client; if (!running) return Promise.reject(new Error("clj-pulse is not running.")); return running.sendRequest<ClojureDocsResult>(CLOJUREDOCS_REQUEST, params); }, serverVersion: () => client?.initializeResult?.serverInfo?.version, notify: { info: (m) => void vscode.window.showInformationMessage(m), warn: (m) => void vscode.window.showWarningMessage(m) } }))` in the first `context.subscriptions.push` block, before `start()` is called, with a comment on why the order matters (the server's part renders above ours). Replace the panel block and the command with `registerCommand("clojurePulse.showClojureDocs", (symbol?: unknown) => showClojureDocs(clojureDocsRequests, symbol))`. Rewrite `showClojureDocs` per the Design's command steps. Remove the `ClojureDocsPanel` import. Add `clojureDocsRequests` to `ExtensionApi` and to the object `activate` returns.

- [ ] **Step 2: Delete the panel**
  Run: `git rm -q src/clojureDocsPanel.ts src/test/clojureDocsPanel.test.ts`

- [ ] **Step 3: Full check**
  Run: `make check`
  Expected: lint clean, compile clean, all suites passing (the panel suite is gone; the e2e suite skips without `CLJ_PULSE_E2E_BIN`).

- [ ] **Step 4: Commit**
  `git add -A src && git commit -m "Show ClojureDocs in the editor hover instead of a panel"`

### Task 5: End-to-end test against the real server

**Files:**
- Modify: `src/test/clojureDocs.e2e.test.ts`

- [ ] **Step 1: Rewrite the assertions**
  Keep the suite setup (server path, activate, restart, teardown). Get the API from `vscode.extensions.getExtension("abogoyavlensky.clojure-pulse")?.exports as ExtensionApi`. Open the same temp file. Helper `docsPart(line, character): Promise<string | undefined>`: `api.clojureDocsRequests.record({ uri, line, character })`, then `vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(line, character))`, flatten `contents` to strings (`MarkdownString.value`), return the one containing `ClojureDocs:`. Poll up to 60 s until `docsPart(1, 1)` is defined (the server may still be starting); assert it contains `ClojureDocs: clojure.core/map` and `(map inc`. Assert `docsPart(2, 1)` contains `ClojureDocs: clojure.string/join`. Assert that a call without a recorded request returns no part containing `ClojureDocs:`. Finally set the selection on `map`, `await vscode.commands.executeCommand("clojurePulse.showClojureDocs")`, then poll up to 10 s until `api.clojureDocsRequests.lastTaken` is a request whose uri and position are the cursor's and whose `symbol` is undefined; assert that. That proves the command recorded the request and VS Code's hover pipeline queried our provider for it.

- [ ] **Step 2: Run it**
  Run: `npm run compile-tests && npm run compile && CLJ_PULSE_E2E_BIN=/home/agent/Projects/clj-pulse/target/debug/clj-pulse xvfb-run -a npx vscode-test -g "end to end"`
  Expected: 1 passing. (Build the server first with `cd /home/agent/Projects/clj-pulse && cargo build` if `target/debug/clj-pulse` is missing.)

- [ ] **Step 3: Commit**
  `git add src/test/clojureDocs.e2e.test.ts && git commit -m "Assert the ClojureDocs hover end to end"`

### Task 6: Docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/plans/2026-09-02-0819-clojuredocs-offline.md`

- [ ] **Step 1: README**
  Use /writing-clearly. Feature bullet: "**Show ClojureDocs** on a symbol opens its ClojureDocs entry (community examples, see-also links) in the editor hover, focused, so the arrow keys scroll it". Rewrite the `## ClojureDocs` section: the popup opens focused; Up/Down scroll, PageUp/PageDown page, Escape returns to the editor; examples are syntax-highlighted; see-also links load the target's examples in the same popup; the ordinary hover (`Ctrl+K Ctrl+I`) is unchanged and mouse hovers never grow; keep the data, offline, server-version, keybinding, and license paragraphs. Commands entry: "in the editor hover".

- [ ] **Step 2: CHANGELOG**
  Update the Unreleased entry: hover instead of panel, opened focused with keyboard scrolling, highlighted examples, see-also in place, ordinary hover unchanged.

- [ ] **Step 3: Previous plan record**
  Append to `docs/plans/2026-09-02-0819-clojuredocs-offline.md`: "> Superseded in part by `docs/plans/2026-09-02-2258-clojuredocs-hover.md`: the webview panel was replaced by the editor hover."

- [ ] **Step 4: Commit**
  `git commit -am "Document the ClojureDocs hover"`

### Task 7: Final verification and push

**Files:** none

- [ ] **Step 1: Everything green**
  Run: `make check && npm run package && unzip -l clojure-pulse-*.vsix | grep clojuredocs.json`
  Expected: lint, compile, all tests green; the vsix lists `extension/data/clojuredocs.json`.

- [ ] **Step 2: End to end once more**
  Run: `CLJ_PULSE_E2E_BIN=/home/agent/Projects/clj-pulse/target/debug/clj-pulse xvfb-run -a npx vscode-test -g "end to end"`
  Expected: 1 passing.

- [ ] **Step 3: Push**
  Run: `git push origin feature/clojuredocs`
  Expected: the branch updates on origin; working tree clean.
