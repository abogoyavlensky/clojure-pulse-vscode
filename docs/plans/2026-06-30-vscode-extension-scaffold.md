# Clojure Pulse — VS Code Extension Scaffold Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Scaffold a minimal, best-practice TypeScript VS Code extension named **Clojure Pulse** that is (1) a self-contained Clojure language contribution and (2) a thin LSP client for the `clj-pulse` server, with a status-bar indicator of server state.

**Tech Stack:** TypeScript (strict), esbuild, `vscode-languageclient` ^9, `@vscode/test-cli` + `@vscode/test-electron` (Mocha), ESLint (flat config), `@vscode/vsce`, GitHub Actions.

---

## Design

### Approach

A standard VS Code extension that does two jobs:

1. **Self-contained Clojure language support** — contributes the `clojure` language id, file associations (`.clj .cljs .cljc .edn .bb .lg`), a `language-configuration.json` (brackets, comments, auto-close, indent), and a vendored MIT TextMate grammar (`source.clojure`) for syntax highlighting. Works with zero other extensions installed.
2. **Thin LSP client for `clj-pulse`** — resolves the `clj-pulse` binary (from a setting or `PATH`), starts a `LanguageClient` over stdio, and lets the server provide completion/hover/definition/signature-help/document & workspace symbols/references/rename/code-actions/diagnostics. The client adds the few things the server cannot do for itself: a **`jar:` content provider** (so go-to-definition into libraries and `clojure.core` opens real source) and a **status-bar indicator** of the server lifecycle.

**Positioning:** Clojure Pulse is a standalone, self-contained Clojure extension — not a Calva companion. It deliberately owns the `clojure` language id and is built to be used *without* Calva; the long-term direction is a complete, powerful Clojure extension that replaces Calva entirely.

The server already advertises its LSP capabilities and self-registers file watchers (`workspace/didChangeWatchedFiles`) and the `jar` content-provider experimental capability, so the client stays thin. The server's `initialize` result carries `serverInfo { name, version }`, which the status bar surfaces in its tooltip (no `--version` shell-out needed).

### Key decisions

- **Bundler: esbuild** — current official VS Code recommendation. `src/*.ts` → `dist/extension.js`. Type-checking is a separate `tsc --noEmit` pass (esbuild does not type-check). Tests compile via `tsc` to `out/` (the `@vscode/test-cli` convention).
- **Identifiers:** extension id `clojure-pulse`, displayName **"Clojure Pulse"**, publisher `abogoyavlensky`, settings/commands namespaced `clojurePulse.*`. License **MIT**. Engine `vscode ^1.85.0`.
- **Settings (the "simple json config"):**
  - `clojurePulse.server.path` — string, default `"clj-pulse"`. A bare name is resolved on `PATH`; a value containing a path separator is used as-is.
  - `clojurePulse.server.args` — string[], default `[]`. Extra args appended to the server command.
  - `clojurePulse.trace.server` — `off` | `messages` | `verbose`, default `off`. Standard LSP trace setting.
- **Server resolution** (`serverPath.ts`, pure & unit-tested): setting takes precedence; bare names are looked up across `PATH` entries; returns either a resolved command or a structured "not found" error. On error the extension does **not** crash — it shows an actionable notification (with an "Install clj-pulse" link to the repo) and sets the status bar to an error state, so `Restart` works after the user fixes the setting.
- **`jar:` navigation** (`jarContentProvider.ts`): registers a `TextDocumentContentProvider` for the `jar` scheme that calls the server's clojure-lsp-compatible request `clojure/dependencyContents` with `{ uri }` and returns the string body. Built around an injected `sendRequest` function so it is unit-testable without a live server.
- **Status bar** (`statusBar.ts`): a left-aligned `StatusBarItem` (sits by the git branch / diagnostics, per the agreed mockup) driven by the client's `onDidChangeState`. A pure `statusPresentation(state)` function maps lifecycle → `{ text, tooltip, background }`:
  - Starting → `$(loading~spin) clj-pulse` — "Starting…"
  - Running → `$(pulse) clj-pulse` — tooltip shows resolved path + `serverInfo.version`
  - Stopped → `$(circle-slash) clj-pulse` — "Stopped — click to restart"
  - Error / not found → `$(error) clj-pulse` with `statusBarItem.errorBackground` — tooltip points to output
  Clicking the item runs `clojurePulse.showOutput`. Visible whenever the extension is active.
- **`.lg` (let-go)** maps to the same `clojure` language id (the server treats let-go as a Clojure dialect); one document selector and one grammar cover it.
- **`.edn` included** in associations + selector so Integrant keyword navigation from `config.edn` and EDN diagnostics work.
- **Grammar source:** vendor the MIT-licensed `clojure.tmLanguage.json` (scope `source.clojure`, e.g. from `atom/language-clojure`), with license text preserved in `syntaxes/NOTICE`.
- **Commands:** `clojurePulse.restart` (Restart Server), `clojurePulse.showOutput` (Show Output).
- **Tests are hermetic** — real logic (path resolution, status presentation, jar provider) is tested via dependency-injection seams without needing the Rust binary; one integration test asserts the extension activates resiliently when the binary is absent (error status, no throw). CI runs them headless.

### Data flow

`activate` → read settings → `resolveServerPath` → on error: status = error + notification; on success: create output channel → `createClient(command, args, channel)` → register `jar:` content provider (bound to `client.sendRequest`) → create status bar + subscribe to `client.onDidChangeState` → register `restart`/`showOutput` commands → `client.start()`. Go-to-def on a library symbol yields a `jar:` URI → VS Code calls our provider → provider sends `clojure/dependencyContents` → server returns source text → VS Code opens it read-only. `deactivate` → `client.stop()`.

### Error handling & testing strategy

- Missing/incorrect server path or spawn failure → notification + error status; extension stays loaded so `Restart` recovers. Server crashes fall back to the client's default restart policy.
- Tests (Mocha via `@vscode/test-cli`): `serverPath` resolution (fake `PATH` dirs), `statusPresentation` mapping, `jarContentProvider` with a fake `sendRequest`, and one activation smoke test (bogus server path → activation succeeds, status = error, commands registered).

### Out of scope for v1

nREPL / evaluation, structural editing, eval-status in the status bar (a natural nREPL follow-up), and any IDE feature beyond what `clj-pulse` already serves over LSP.

## File Structure

```
clojure-pulse-vscode/
├─ package.json               manifest (contributes: languages, grammars, configuration, commands), scripts, deps
├─ tsconfig.json              strict TS; outDir out/ for tests
├─ esbuild.js                 bundle src → dist/extension.js (+ --watch, --production)
├─ eslint.config.mjs          flat ESLint config
├─ .vscode-test.mjs           @vscode/test-cli config (files: out/test/**/*.test.js)
├─ .vscodeignore              keep the .vsix lean (ship dist/, syntaxes/, language-configuration.json)
├─ .gitignore                 node_modules/, dist/, out/, *.vsix
├─ language-configuration.json brackets () [] {}, line comment ;, autoclose, indent rules
├─ syntaxes/
│   ├─ clojure.tmLanguage.json vendored MIT grammar (scope source.clojure)
│   └─ NOTICE                  grammar license + attribution
├─ src/
│   ├─ extension.ts           activate/deactivate; orchestrates the pieces
│   ├─ client.ts              createClient(): builds LanguageClient (stdio, selector, trace, channel)
│   ├─ serverPath.ts          resolveServerPath(): setting/PATH resolution (pure)
│   ├─ statusBar.ts           statusPresentation() (pure) + createStatusBar()
│   ├─ jarContentProvider.ts  createJarContentProvider(sendRequest): jar: → clojure/dependencyContents
│   └─ test/
│       ├─ serverPath.test.ts
│       ├─ statusBar.test.ts
│       ├─ jarContentProvider.test.ts
│       └─ extension.test.ts  activation smoke test (missing-binary path)
├─ .vscode/
│   ├─ launch.json            F5 → Extension Development Host
│   ├─ tasks.json             esbuild watch
│   └─ extensions.json        recommended: dbaeumer.vscode-eslint
├─ .github/workflows/ci.yml   install → lint → typecheck → test (xvfb) → package
├─ README.md                  install clj-pulse, configure, features, dev, Calva coexistence note
├─ CHANGELOG.md
└─ LICENSE                    MIT
```

## Tasks

### Task 1: Project scaffold & build tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.js`, `eslint.config.mjs`, `.vscode-test.mjs`, `.vscodeignore`, `.gitignore`, `LICENSE`, `CHANGELOG.md`
- Create: `.vscode/launch.json`, `.vscode/tasks.json`, `.vscode/extensions.json`
- Create: `src/extension.ts` (no-op `activate`/`deactivate`)

- [x] **Step 1: Write `package.json`**
  Manifest with `name: "clojure-pulse"`, `displayName: "Clojure Pulse"`, `publisher: "abogoyavlensky"`, `version: "0.0.1"`, `license: "MIT"`, `engines.vscode: "^1.85.0"`, `main: "./dist/extension.js"`, `categories: ["Programming Languages", "Linters"]`. `activationEvents: ["onLanguage:clojure", "workspaceContains:**/deps.edn", "workspaceContains:**/project.clj", "workspaceContains:**/lgx.edn"]`. Empty `contributes: {}` for now. Scripts: `"compile": "tsc --noEmit && node esbuild.js"`, `"watch": "node esbuild.js --watch"`, `"package-build": "tsc --noEmit && node esbuild.js --production"`, `"vscode:prepublish": "npm run package-build"`, `"compile-tests": "tsc -p . --outDir out"`, `"lint": "eslint src"`, `"pretest": "npm run compile-tests && npm run compile && npm run lint"`, `"test": "vscode-test"`, `"package": "vsce package"`. Dependencies: `vscode-languageclient: "^9.0.1"`. devDependencies: `@types/vscode: "^1.85.0"`, `@types/node`, `@types/mocha`, `typescript`, `esbuild`, `eslint`, `@eslint/js`, `typescript-eslint`, `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce`.

- [x] **Step 2: Write `tsconfig.json`**
  `target: ES2022`, `module: Node16`, `moduleResolution: Node16`, `lib: ["ES2022"]`, `strict: true`, `outDir: "out"`, `rootDir: "src"`, `sourceMap: true`. Include `src`.

- [x] **Step 3: Write `esbuild.js`**
  Bundle `src/extension.ts` → `dist/extension.js`, `platform: "node"`, `format: "cjs"`, `external: ["vscode"]`, `sourcemap: true`. Honor `--production` (minify, no sourcemap) and `--watch` flags.

- [x] **Step 4: Write tooling configs**
  `eslint.config.mjs` (flat config: `@eslint/js` recommended + `typescript-eslint` recommended, scoped to `src/**/*.ts`). `.vscode-test.mjs` exporting `defineConfig({ files: "out/test/**/*.test.js" })`. `.vscodeignore` excluding `src/`, `out/`, `node_modules/`, `.vscode*`, `esbuild.js`, `tsconfig.json`, `**/*.map`, `.github/`, `docs/`. `.gitignore` for `node_modules/`, `dist/`, `out/`, `*.vsix`.

- [x] **Step 5: Write `.vscode/` debug configs**
  `launch.json` with an `extensionHost` config (`--extensionDevelopmentPath=${workspaceFolder}`, preLaunchTask the watch build). `tasks.json` running `npm: watch` as background. `extensions.json` recommending `dbaeumer.vscode-eslint`.

- [x] **Step 6: Write `LICENSE` (MIT, © 2026 Andrey Bogoyavlenskiy), `CHANGELOG.md` (Unreleased section), and no-op `src/extension.ts`**
  `export function activate(context) {}` and `export function deactivate() {}` with `vscode` imported.

- [x] **Step 7: Install and compile**
  Run: `npm install && npm run compile`
  Expected: installs cleanly; `dist/extension.js` produced; no type errors.

- [x] **Step 8: Commit**
  `git commit -m "chore: scaffold VS Code extension build tooling"`

### Task 2: Clojure language contribution

**Files:**
- Create: `language-configuration.json`, `syntaxes/clojure.tmLanguage.json`, `syntaxes/NOTICE`
- Modify: `package.json` (add `contributes.languages` + `contributes.grammars`)

- [x] **Step 1: Write `language-configuration.json`**
  `comments.lineComment: ";"`, brackets/`autoClosingPairs`/`surroundingPairs` for `()` `[]` `{}` and `"`, and word-pattern/indentation suitable for Lisp. Keep `"` out of auto-closing inside strings via the standard `notIn` rules.

- [x] **Step 2: Vendor the TextMate grammar**
  Download the MIT-licensed `clojure.tmLanguage.json` (scope `source.clojure`) into `syntaxes/`. Verify `scopeName` is `source.clojure`. Add `syntaxes/NOTICE` with the upstream license text and source URL.

- [x] **Step 3: Add `contributes.languages` and `contributes.grammars` to `package.json`**
  One language: `{ id: "clojure", aliases: ["Clojure", "clojure"], extensions: [".clj", ".cljs", ".cljc", ".edn", ".bb", ".lg"], configuration: "./language-configuration.json" }`. One grammar: `{ language: "clojure", scopeName: "source.clojure", path: "./syntaxes/clojure.tmLanguage.json" }`.

- [x] **Step 4: Verify in the Extension Development Host**
  Run: `npm run compile`, then launch via F5 (or `code --extensionDevelopmentPath=.`), open a `.clj` and a `.lg` file.
  Expected: syntax highlighting renders; typing `(` auto-closes `)`; `;` line comment toggles. No "language already registered" hard error.

- [x] **Step 5: Commit**
  `git commit -m "feat: contribute Clojure language, file associations, and grammar"`

### Task 3: Server-path resolution

**Files:**
- Create: `src/serverPath.ts`
- Test: `src/test/serverPath.test.ts`

- [x] **Step 1: Write the failing test**
  Test `resolveServerPath({ path, args }, env)`: (a) a `path` containing a separator returns that command verbatim; (b) a bare `"clj-pulse"` resolves to the first matching executable across `env.PATH` dirs (create a temp dir with a dummy executable); (c) an unresolvable bare name returns a structured `{ error }`. Use `os.tmpdir()` fixtures.

- [x] **Step 2: Run test to verify it fails**
  Run: `npm test`
  Expected: FAIL — `resolveServerPath` not implemented / module not found.

- [x] **Step 3: Write minimal implementation**
  `resolveServerPath(config, env)`: if `config.path` contains a path separator, return `{ command: config.path, args }`. Otherwise scan `env.PATH` split on `path.delimiter`, return the first existing file (honor `PATHEXT` on win32 minimally or accept exact match), else `{ error: "clj-pulse not found on PATH" }`. Pure — no `vscode` import.

- [x] **Step 4: Run test to verify it passes**
  Run: `npm test`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "feat: resolve clj-pulse from setting or PATH"`

### Task 4: LSP client, activation, and commands

**Files:**
- Create: `src/client.ts`
- Modify: `src/extension.ts`, `package.json` (add `contributes.configuration` + `contributes.commands`)
- Test: `src/test/extension.test.ts`

- [x] **Step 1: Add `contributes.configuration` and `contributes.commands` to `package.json`**
  Configuration (title "Clojure Pulse"): `clojurePulse.server.path` (string, default `"clj-pulse"`), `clojurePulse.server.args` (array of string, default `[]`), `clojurePulse.trace.server` (enum `off`/`messages`/`verbose`, default `off`). Commands: `clojurePulse.restart` ("Clojure Pulse: Restart Server"), `clojurePulse.showOutput` ("Clojure Pulse: Show Output").

- [x] **Step 2: Write `src/client.ts`**
  `createClient(command, args, outputChannel): LanguageClient` — `ServerOptions` = `{ command, args, transport: TransportKind.stdio }`; `clientOptions` = `{ documentSelector: [{ scheme: "file", language: "clojure" }], outputChannel, traceOutputChannel: outputChannel }`. Construct `new LanguageClient("clojurePulse", "Clojure Pulse", serverOptions, clientOptions)`.

- [x] **Step 3: Write `src/extension.ts` orchestration**
  In `activate`: read `clojurePulse` config, call `resolveServerPath`. On error → show a warning notification with an "Install clj-pulse" item linking to the repo, set status (Task 5 hook) to error, and return without throwing. On success → create an output channel, `createClient`, register `restart` (stop → re-`activate` logic / recreate client) and `showOutput` (reveal channel) commands, push everything to `context.subscriptions`, and `client.start()`. `deactivate` → `client?.stop()`. Keep the client reference module-scoped.

- [x] **Step 4: Write the activation smoke test**
  `extension.test.ts`: set `clojurePulse.server.path` to a guaranteed-missing path, activate the extension via `vscode.extensions.getExtension("abogoyavlensky.clojure-pulse")?.activate()`, assert it resolves without throwing and that `clojurePulse.restart` / `clojurePulse.showOutput` appear in `vscode.commands.getCommands(true)`.

- [x] **Step 5: Run tests**
  Run: `npm test`
  Expected: PASS — activation resilient with a missing binary; commands registered.

- [x] **Step 6: Commit**
  `git commit -m "feat: start clj-pulse LSP client with restart and output commands"`

### Task 5: Status-bar indicator

**Files:**
- Create: `src/statusBar.ts`
- Modify: `src/extension.ts`
- Test: `src/test/statusBar.test.ts`

- [x] **Step 1: Write the failing test**
  Test the pure `statusPresentation(state, serverInfo?)`: for each `State` (Starting/Running/Stopped) and an explicit error case, assert the returned `text` (codicon + "clj-pulse"), `tooltip`, and whether an error background is set. Running with `serverInfo` includes the version in the tooltip.

- [x] **Step 2: Run test to verify it fails**
  Run: `npm test`
  Expected: FAIL — `statusPresentation` not implemented.

- [x] **Step 3: Write minimal implementation**
  `statusPresentation(state, serverInfo?)` returns `{ text, tooltip, error: boolean }` per the Design mapping. `createStatusBar(onClick)` creates a left-aligned `StatusBarItem` (priority placing it near git/diagnostics), wires `command` to `clojurePulse.showOutput`, and exposes `update(state, serverInfo?)` applying `statusPresentation` (sets `backgroundColor` to `statusBarItem.errorBackground` when `error`) and `setError(message)`. Show the item immediately.

- [x] **Step 4: Wire into `extension.ts`**
  Create the status bar in `activate`; on the missing-binary error path call `setError`. On success, subscribe to `client.onDidChangeState` and call `update(e.newState, client.initializeResult?.serverInfo)`; also `update` once after `start()`.

- [x] **Step 5: Run tests**
  Run: `npm test`
  Expected: PASS.

- [x] **Step 6: Commit**
  `git commit -m "feat: show clj-pulse server status in the status bar"`

### Task 6: Jar content provider for library navigation

**Files:**
- Create: `src/jarContentProvider.ts`
- Modify: `src/extension.ts`
- Test: `src/test/jarContentProvider.test.ts`

- [x] **Step 1: Write the failing test**
  Test `createJarContentProvider(sendRequest)`: `provideTextDocumentContent(uri)` calls the injected `sendRequest("clojure/dependencyContents", { uri: uri.toString() })` and returns its resolved string. Use a fake `sendRequest` returning `"(ns clojure.core)"` and assert the body is returned and the request args are correct.

- [x] **Step 2: Run test to verify it fails**
  Run: `npm test`
  Expected: FAIL — `createJarContentProvider` not implemented.

- [x] **Step 3: Write minimal implementation**
  `createJarContentProvider(sendRequest)` returns a `TextDocumentContentProvider` whose `provideTextDocumentContent(uri)` returns `sendRequest("clojure/dependencyContents", { uri: uri.toString() })`. In `extension.ts`, after `client.start()`, register it via `vscode.workspace.registerTextDocumentContentProvider("jar", createJarContentProvider((m, p) => client.sendRequest(m, p)))` and push to subscriptions.

- [x] **Step 4: Run tests**
  Run: `npm test`
  Expected: PASS.

- [x] **Step 5: Manual verification (optional, needs the real binary)**
  With `clj-pulse` on `PATH` and a `deps.edn` project open, go-to-definition on a `clojure.core` symbol (e.g. `map`).
  Expected: a read-only `jar:` document opens with the source.

- [x] **Step 6: Commit**
  `git commit -m "feat: open jar: library sources via clojure/dependencyContents"`

### Task 7: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [x] **Step 1: Write the workflow**
  Trigger on push + pull_request. Job on `ubuntu-latest`: checkout, `actions/setup-node` (Node 20, npm cache), `npm ci`, `npm run lint`, `npm run compile`, run tests headless under xvfb (`xvfb-run -a npm test`), then `npx @vscode/vsce package` to confirm the `.vsix` builds. Upload the `.vsix` as an artifact.

- [x] **Step 2: Verify the commands locally**
  Run: `npm ci && npm run lint && npm run compile && npm test && npm run package`
  Expected: all succeed; a `clojure-pulse-0.0.1.vsix` is produced.

- [x] **Step 3: Commit**
  `git commit -m "ci: lint, compile, test, and package the extension"`

### Task 8: README, CHANGELOG, and docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [x] **Step 1: Write `README.md`** (use /writing-clearly)
  Sections: what it is (Clojure Pulse + clj-pulse LSP), install `clj-pulse` (brew / mise / PATH, linking the clj-pulse repo), configure (`clojurePulse.server.path` and friends with a `settings.json` example), features (highlighting + the LSP feature list + jar navigation + status bar), development (clone, `npm install`, F5), and a short "standalone" note: Clojure Pulse is self-contained and meant to be used on its own — it owns the `clojure` language id, so uninstall/disable Calva (or other Clojure language extensions) to avoid a duplicate registration.

- [x] **Step 2: Update `CHANGELOG.md`**
  Add a `0.0.1` entry summarizing the initial scaffold: language contribution, LSP client, jar navigation, status bar.

- [x] **Step 3: Commit**
  `git commit -m "docs: document install, configuration, and usage"`

---

## Implementation Summary

**Status: ✅ Completed 2026-07-01.** All 8 tasks implemented, tested, and committed.

### What shipped
- A TypeScript VS Code extension bundled with esbuild (engine `vscode ^1.85`).
- Self-contained Clojure language support: `language-configuration.json` plus a
  vendored MIT TextMate grammar (`source.clojure`, converted from
  atom/language-clojure) covering `.clj/.cljs/.cljc/.edn/.bb/.lg`.
- A thin `clj-pulse` LSP client over stdio with `clojurePulse.server.path` /
  `server.args` / `trace.server` settings and `Restart Server` / `Show Output`
  commands.
- `serverPath.ts` (setting/PATH resolution), `statusBar.ts` (lifecycle
  indicator), and `jarContentProvider.ts` (`jar:` → `clojure/dependencyContents`
  for library / `clojure.core` navigation).
- 13 hermetic tests (unit + activation) run headless via `@vscode/test-cli`
  under xvfb, and a GitHub Actions CI pipeline (lint → compile → test → package).

### Notable decisions / deviations
- The status-bar click opens the output channel (per the design); tooltips were
  worded to match.
- Tests use dependency-injection seams, so no real `clj-pulse` binary is needed.
  The optional real-binary jar-navigation check (Task 6, Step 5) is deferred to
  a manual F5 run.
- `.vscodeignore` was hardened to keep `.tmp/`, `.claude/`, `AGENTS.md`, and
  `CLAUDE.md` out of the packaged `.vsix`.

### Codex review findings addressed
- Task 3: probe a Windows command exactly as given before appending PATHEXT
  variants (avoids false "not found" for an explicit `clj-pulse.exe`).
- Task 4: drop the failed client and make `stop()` resilient so `Restart`
  always recovers from a bad server path; added a regression test.

### Verification
- `npm run lint`, `npm run compile`, `xvfb-run -a npm test` (13 passing), and
  `npx @vscode/vsce package` (clean 10-file vsix) all pass.
