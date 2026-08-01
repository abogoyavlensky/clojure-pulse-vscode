# Strip ANSI Escape Codes from REPL Output Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ANSI escape sequences from server and nREPL output so the REPL output channel shows clean text instead of raw `ESC[1m` garbage.

**Tech Stack:** TypeScript, VS Code extension API, Mocha (`@vscode/test-cli`).

---

## Design

### Problem

The REPL pane is a VS Code output channel created with the `clojure` language id
(`src/extension.ts:237`), so the transcript gets Clojure syntax highlighting and
search for free. Output channels never interpret ANSI escape codes, so colored
output — the let-go startup banner, malli's `dev-mode started` notice — renders
as literal `ESC[1m` / `ESC[38;5;45m` sequences (see `screenshots/`).

Rendering real colors is impossible in an output channel; the agreed fix is to
strip ANSI sequences so those lines appear as clean readable text. The
alternative (a pseudoterminal-based view with native ANSI rendering) was
considered and rejected: it would abandon the valid-Clojure transcript design.

### Where ANSI text enters the transcript

There are exactly two ingestion points, both `kind: "out"`/`"err"`:

1. **Spawned server output** — `ReplSession.startProcess`
   (`src/repl/replSession.ts:200`): `proc.onOutput` appends raw process chunks.
2. **nREPL out/err messages** — `ConnectionManager` (`src/repl/connectionManager.ts`):
   every message funnels through `collectEvalMessage` (evals/load-file) or
   `onOutOfBandMessage`, both of which call `appendEvalMessage`. `collectEvalMessage`
   also accumulates `msg.err` into the eval outcome, which feeds inline results —
   so stripping must happen before *both* uses.

### Approach

Strip at ingestion, per stream, so the `Transcript` — "the pane's content as
data" — holds clean text and every consumer (output channel, inline results,
anything future) benefits.

A new pure module `src/repl/ansi.ts` exports:

- `stripAnsi(text: string): string` — removes complete ANSI sequences using
  this pattern (CSI sequences including colors/cursor movement, and OSC
  sequences terminated by BEL or ST):

  ```ts
  const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
  ```

- `class AnsiStripper` with `strip(chunk: string): string` — stateful,
  one instance per stream. Process and nREPL output arrive in arbitrarily
  split chunks, so a sequence can straddle a chunk boundary (`ESC[3` then
  `8;5;45m`); a naive per-chunk regex would leak the halves. The stripper
  prepends any held-back tail to the incoming chunk, strips complete
  sequences, then holds back a chunk-final *incomplete* escape sequence
  (a trailing `ESC`, or `ESC[`/`ESC]` plus a valid unfinished body) until
  the next chunk. Text that is not part of an escape sequence is never
  held back or reordered.

No new dependency — the pattern is the standard ansi-regex shape, inlined.

### Stripper placement

- **`ReplSession.startProcess`**: one `AnsiStripper` per spawned process,
  a local in `startProcess` captured by the `proc.onOutput` closure. A
  restart calls `startProcess` again and naturally gets a fresh stripper.
- **`ConnectionManager`**: two instance fields (one for `out`, one for `err`
  — they are distinct streams), re-created on each `connect()`. Incoming
  messages are sanitized once at the entry points (`collectEvalMessage`,
  `onOutOfBandMessage`) by replacing `msg.out`/`msg.err` with stripped copies
  before any use, so the transcript and the eval outcome both see clean text
  and no message is passed through a stateful stripper twice.

`in`, `value`, `info`, and `banner` entries are untouched — they are
extension-generated or pr-str'd values, never colored.

### Testing

Unit tests in the existing pure-module style (`src/test/ansi.test.ts`),
plus small additions to the existing `connectionManager` and `replSession`
tests asserting that colored chunks land in the transcript clean. Run with
`make test` (wraps `npm test` in xvfb on Linux).

## File Structure

- **Create** `src/repl/ansi.ts` — pure ANSI stripping: `stripAnsi` and `AnsiStripper`. No vscode imports.
- **Create** `src/test/ansi.test.ts` — unit tests for both exports.
- **Modify** `src/repl/replSession.ts` — wrap process output through a per-process `AnsiStripper`.
- **Modify** `src/repl/connectionManager.ts` — sanitize `msg.out`/`msg.err` at message entry points.
- **Modify** `src/test/replSession.test.ts`, `src/test/connectionManager.test.ts` — one regression test each.

## Tasks

### Task 1: `ansi.ts` — stripAnsi and AnsiStripper

**Files:**
- Create: `src/repl/ansi.ts`
- Test: `src/test/ansi.test.ts`

- [ ] **Step 1: Write the failing tests**
  Cover `stripAnsi`:
  - plain text without escapes is returned unchanged
  - SGR sequences are removed: `"\x1b[1mbold\x1b[0m"` → `"bold"`
  - 256-color sequences are removed: `"\x1b[38;5;45mmalli:\x1b[0m dev-mode"` → `"malli: dev-mode"`
  - non-color CSI (e.g. cursor movement `"\x1b[2K\x1b[1Gtext"`) → `"text"`
  - OSC sequences (`"\x1b]0;title\x07text"`) → `"text"`

  Cover `AnsiStripper.strip`:
  - a sequence split across two chunks: `strip("a\x1b[3")` returns `"a"`, then `strip("8;5;45mb")` returns `"b"`
  - a chunk ending in a lone `ESC` holds it back until the next chunk completes it
  - a held tail that turns out not to be an escape sequence is emitted, not dropped
  - chunks with no escapes pass through unchanged

- [ ] **Step 2: Run tests to verify they fail**
  Run: `make test`
  Expected: FAIL — cannot find module `../repl/ansi`

- [ ] **Step 3: Implement `src/repl/ansi.ts`**
  Use the `ANSI_PATTERN` regex from the design verbatim. `AnsiStripper`
  keeps a `pending` string; `strip` concatenates `pending + chunk`, removes
  complete sequences, then detects a trailing incomplete escape (a suffix
  matching an unfinished CSI/OSC body or a bare `ESC`) and stores it back
  into `pending`, returning the rest. Module docstring in the style of the
  other `src/repl` modules: what it is for and why it is stateful.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `make test`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "Add ANSI escape-sequence stripping module"`

### Task 2: Strip spawned-process output in ReplSession

**Files:**
- Modify: `src/repl/replSession.ts`
- Test: `src/test/replSession.test.ts`

- [ ] **Step 1: Write the failing test**
  In the existing `replSession` test setup (fake process), emit an output
  chunk containing ANSI codes (e.g. the let-go banner fragment
  `"\x1b[1mlet-go\x1b[0m 1.12.2\n"`) and assert the transcript's `out`
  entry text is `"let-go 1.12.2\n"`. Also emit a sequence split across two
  chunks (`"a\x1b[3"` then `"8;5;45mb"`) and assert the transcript ends up
  with `"a"` then `"b"` — this proves one persistent stripper spans chunks,
  not a fresh one per chunk.

- [ ] **Step 2: Run test to verify it fails**
  Run: `make test`
  Expected: FAIL — transcript entry still contains `\x1b[1m`

- [ ] **Step 3: Implement**
  In `startProcess` (`src/repl/replSession.ts:196`), create a local
  `AnsiStripper` and pass process output through it before appending:
  the `proc.onOutput` handler appends `stripper.strip(text)`. Skip
  appending when the stripped chunk is empty (a chunk that was entirely
  a held-back escape fragment).

- [ ] **Step 4: Run test to verify it passes**
  Run: `make test`
  Expected: PASS

- [ ] **Step 5: Commit**
  `git commit -m "Strip ANSI codes from spawned nREPL server output"`

### Task 3: Strip nREPL out/err in ConnectionManager

**Files:**
- Modify: `src/repl/connectionManager.ts`
- Test: `src/test/connectionManager.test.ts`

- [ ] **Step 1: Write the failing test**
  Using the existing fake nREPL client/server setup, deliver an eval `out`
  message containing ANSI codes and assert the transcript `out` entry is
  clean. Also deliver an `err` message with ANSI codes and assert both the
  transcript `err` entry and the resolved `EvalOutcome.err` are clean.
  Finally, deliver two `out` messages that split one escape sequence across
  them and assert the halves do not leak — this proves the `out` stripper
  is a persistent per-connection instance, not created per message.

- [ ] **Step 2: Run test to verify it fails**
  Run: `make test`
  Expected: FAIL — entries still contain escape sequences

- [ ] **Step 3: Implement**
  Add two `AnsiStripper` fields to `ConnectionManager` (out and err),
  re-created inside `connect()` so a reconnect starts with clean state.
  Add a private `sanitizeMessage(msg)` returning a copy of the message with
  `out`/`err` passed through the matching stripper; call it once at the top
  of `collectEvalMessage` and `onOutOfBandMessage` and use the sanitized
  message throughout (including the `appendEvalMessage` call and the
  `outcome.err` accumulation), so each message is stripped exactly once.

- [ ] **Step 4: Run test to verify it passes**
  Run: `make test`
  Expected: PASS

- [ ] **Step 5: Run the full check**
  Run: `make check`
  Expected: lint, compile, and tests all pass

- [ ] **Step 6: Commit**
  `git commit -m "Strip ANSI codes from nREPL out/err output"`
