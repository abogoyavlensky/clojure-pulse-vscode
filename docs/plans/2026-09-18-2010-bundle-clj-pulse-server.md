# Bundle the clj-pulse Server Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: completed 2026-09-18**

**Goal:** Ship the clj-pulse language server inside platform-specific `.vsix` builds so a user installs one extension and gets the language features with nothing else on their machine.

**Tech Stack:** TypeScript VS Code extension, `@vscode/vsce` `--target` packaging, bash fetch script (`curl`, `sha256sum`, `tar`, `unzip`), GitHub Actions, Mocha tests via `@vscode/test-cli`.

---

## Design

### Problem

The extension runs whatever `clj-pulse` it finds on `PATH`. Installing is a
two-step affair (extension, then `brew install` or a manual download), the
first thing a new user sees is a "not found" warning, and the extension and
server versions drift apart: every feature that needs a newer server grows a
"needs clj-pulse X or newer" branch (see `CLOJUREDOCS_MIN_SERVER` in
`src/clojureDocs.ts`).

### Shape of the solution

clj-pulse's release CI already publishes one archive per target. The
extension's release CI downloads the pinned version of each, verifies it
against clj-pulse's `checksums.txt`, unpacks the binary into `server/`, and
packages one `.vsix` per platform with `vsce package --target`. VS Code unpacks
each extension into its own versioned folder, so the binary ends up at
`<extensions>/abogoyavlensky.clojure-pulse-<ver>-<target>/server/clj-pulse`
and is created, replaced and removed with the extension. The extension finds
it with `context.asAbsolutePath`, the same way it finds
`data/clojuredocs.json` today.

A **universal** `.vsix` with no `server/` directory is also published. It
behaves exactly as the extension does today: `clj-pulse` from `PATH`.

Targets, and the clj-pulse archive each one carries:

| vsce target | clj-pulse asset |
|---|---|
| `darwin-arm64` | `clj-pulse-aarch64-apple-darwin.tar.gz` |
| `darwin-x64` | `clj-pulse-x86_64-apple-darwin.tar.gz` |
| `linux-arm64` | `clj-pulse-aarch64-unknown-linux-gnu.tar.gz` |
| `linux-x64` | `clj-pulse-x86_64-unknown-linux-gnu.tar.gz` |
| `win32-x64` | `clj-pulse-x86_64-pc-windows-msvc.zip` |
| universal (no `--target`) | none |

No Alpine targets. Marketplace and Open VSX publishing stay out of scope;
release assets go to GitHub Releases as today.

### Resolution order

`clojurePulse.server.path` changes its default from `"clj-pulse"` to `""`.

1. **Explicit.** A non-empty setting is the user's choice. A path is used
   verbatim; a bare name is searched on `PATH`. The bundle is ignored. This
   keeps `"clj-pulse"` meaning "my PATH copy" and is what a clj-pulse
   developer sets to run a local build.
2. **Bundled.** With an empty setting, `server/clj-pulse` (`.exe` on Windows)
   inside the extension folder wins when it exists and is executable.
3. **PATH.** Otherwise `clj-pulse` is searched on `PATH`, as today.
4. **Warning.** Otherwise today's "not found" warning with the install link.

Empty is the only way to tell "never set" from "chose PATH" without
inspecting configuration scopes. Existing users who never touched the setting
get the bundle on upgrade; users who set `"clj-pulse"` by hand keep PATH.

### Execute bit

Zip extraction does not always preserve the execute bit. At activation, on
non-Windows, the extension runs `chmod 755` on the bundled file when it
exists, ignoring failures (a read-only install is fine when the bit is
already set). Resolution then checks executability as it does for PATH
entries, so a bundle that still cannot run falls through to PATH instead of
crashing the client.

### Failure message

When a resolved server fails to spawn, the output channel and the status-bar
error name the file that failed. For the bundled server it adds that
`clojurePulse.server.path` overrides it, which is the escape hatch on hosts
that forbid executing files from the home directory. Today's message is only
"failed to start the language server".

### Version pin

`package.json` gains a top-level `"cljPulseVersion": "0.5.4"`. It sits next
to the extension's own `version`, is read with `node -p` by CI and Make, and
a manifest test asserts it is a semver. Bumping it is part of the release
checklist. The extension keeps its `serverInfo.version` min-version checks
for users of the universal build.

### Fetch script

`scripts/fetch-server.sh <vsce-target>` is the one place that knows the
target-to-asset mapping. It reads the pin from `package.json`, downloads the
asset and `checksums.txt` from
`https://github.com/abogoyavlensky/clj-pulse/releases/download/v<pin>/`,
verifies the hash (`sha256sum` on Linux, `shasum -a 256` on macOS, which
lacks `sha256sum`), and extracts the binary into a fresh `server/` directory
(deleting any previous contents first). `server/` is gitignored and never
committed.

### Release job

One job builds all six `.vsix` files in sequence: fetch the target's server,
`vsce package --target <t>`, delete `server/`, next target; then the universal
build with no `server/`; then one upload. A failure anywhere fails the whole
release, so a release is never half published. `vsce` names platform builds
`clojure-pulse-<ver>@<target>.vsix`, so the existing `clojure-pulse-*.vsix`
globs still match.

### CI runs the end-to-end tests

`src/test/lspJar.e2e.test.ts` and `src/test/clojureDocs.e2e.test.ts` skip
themselves unless `CLJ_PULSE_E2E_BIN` is set, so CI has never run them. Both
`ci.yml` and `release.yml` now fetch `linux-x64` first and export
`CLJ_PULSE_E2E_BIN=$PWD/server/clj-pulse`. Every PR then proves the extension
works with the exact server it ships.

The jar test's fixture (`src/test/fixtures/jar-project`) is a bare
`{:paths ["src"]}` deps.edn; its `.cpcache` is gitignored, so on a clean
runner clj-pulse resolves the classpath by running `clojure -Spath`. Both
workflows therefore install Temurin 21 (`actions/setup-java`) and the Clojure
CLI (`DeLaGuardo/setup-clojure`) before the tests. The ClojureDocs e2e test
needs neither.

### Local workflow

- `make fetch-server` fetches the host platform's server into `server/`
  (`uname -s`/`uname -m` mapped to a vsce target).
- `make package` now fetches and builds the host-platform `.vsix`, so
  `make install-extension` gives the bundled experience.
- `make package-universal` builds the no-binary `.vsix`.
- `make clean` also removes `server/`.

### Remote hosts

`extensionKind: ["workspace"]` in `package.json`. The server has to run where
the files are, so the extension runs on the remote host under Remote-SSH,
WSL and dev containers. Marketplace installs pick the remote host's build
automatically; with GitHub-only distribution the user installs the `.vsix`
that matches the *remote* host's platform into the remote extension host.
The README says so.

### Testing strategy

- Unit (`src/test/serverPath.test.ts`): each rule of the resolution order,
  using temp directories for the bundle and PATH.
- Unit (`src/test/statusBar.test.ts`): tooltip marks a bundled server.
- Manifest (`src/test/manifest.test.ts`): pin is semver, `extensionKind`,
  `server.path` default.
- End to end: the existing e2e suites, now run in CI against the fetched
  binary.
- Manual: `make install-extension` on this machine; the status-bar tooltip
  shows `v0.5.4` and `(bundled)`.

---

## File Structure

- Modify: `src/serverPath.ts` — resolution gains an optional bundled
  candidate and reports where the command came from.
- Modify: `src/extension.ts` — computes the bundled path, sets the execute
  bit, passes the candidate to resolution, richer spawn-failure message.
- Modify: `src/statusBar.ts` — tooltip shows `(bundled)`.
- Modify: `src/test/serverPath.test.ts`, `src/test/statusBar.test.ts`,
  `src/test/manifest.test.ts` — tests for the above.
- Modify: `package.json` — `cljPulseVersion`, `extensionKind`, new
  `server.path` default and description.
- Create: `scripts/fetch-server.sh` — download, verify, extract.
- Modify: `.gitignore` — `server/`.
- Modify: `Makefile` — `fetch-server`, `package`, `package-universal`,
  `clean`.
- Modify: `.github/workflows/ci.yml` — fetch linux-x64, run e2e.
- Modify: `.github/workflows/release.yml` — six builds, e2e, upload.
- Modify: `README.md` — Installation, Requirements, Configuration table,
  Development, a Releasing note.

---

## Tasks

### Task 1: Resolution order in `serverPath.ts`

**Files:**
- Modify: `src/serverPath.ts`
- Test: `src/test/serverPath.test.ts`

- [x] **Step 1: Write the failing tests**
  Add tests to the `resolveServerPath` suite. Each creates temp dirs with
  `fs.mkdtempSync` and fake executables as the existing tests do (mode
  `0o755`, `.exe` suffix on win32 via `binaryName()`).
  - blank config, bundled file exists and is executable → returns
    `{ command: <bundled>, args, source: "bundled" }`, even when a PATH copy
    also exists.
  - blank config, bundled path given but the file does not exist → PATH copy,
    `source: "path"`.
  - blank config, bundled file exists but is not executable (mode `0o644`,
    skip this test on win32) → PATH copy.
  - config `"clj-pulse"`, bundled exists → PATH copy, `source: "path"`; the
    bundle is ignored.
  - explicit absolute path, bundled exists → the explicit path,
    `source: "explicit"`.
  - blank config, no bundle, empty PATH → still the structured error with
    `/not found/i`.
  Update the existing `deepStrictEqual` assertions to include `source`.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -l unit -g resolveServerPath`
  Expected: FAIL (compile error on `source` / the third argument, or
  assertion failures).

- [x] **Step 3: Implement**
  In `src/serverPath.ts`:
  - Add `source: "explicit" | "bundled" | "path"` to `ResolvedServer`.
  - Change the signature to
    `resolveServerPath(config, env = process.env, bundled?: string)`.
  - Order: trimmed config non-empty → existing explicit/PATH logic with
    `source` `"explicit"` for a path and `"path"` for a bare name. Config
    empty → if `bundled` is given and `isExecutableFile(bundled)`, return it
    with `"bundled"`; else search `DEFAULT_COMMAND` on PATH with `"path"`;
    else the error.
  - Update the doc comment to describe the order. Keep the error text.

- [x] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -l unit -g resolveServerPath`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Prefer a bundled clj-pulse over PATH when the server path is unset"`

### Task 2: Manifest changes

**Files:**
- Modify: `package.json`
- Test: `src/test/manifest.test.ts`

- [x] **Step 1: Write the failing tests**
  Extend `manifest.test.ts` (it already parses `package.json`; widen the
  parsed type as needed):
  - `cljPulseVersion` matches `/^\d+\.\d+\.\d+$/`.
  - `extensionKind` deep-equals `["workspace"]`.
  - `contributes.configuration.properties["clojurePulse.server.path"].default`
    is `""`.

- [x] **Step 2: Run the tests to verify they fail**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -l unit -g manifest`
  Expected: FAIL on the three new assertions.

- [x] **Step 3: Edit `package.json`**
  - Add `"cljPulseVersion": "0.5.4"` directly after `"version"`.
  - Add `"extensionKind": ["workspace"]` after `"engines"`.
  - `clojurePulse.server.path`: default `""`, markdownDescription:
    "Path to the `clj-pulse` language server binary. Leave empty to use the
    server bundled with the extension, falling back to `clj-pulse` on your
    `PATH`. A bare name (e.g. `clj-pulse`) is resolved from your `PATH`; an
    absolute or relative path is used as-is. Any non-empty value overrides
    the bundled server."

- [x] **Step 4: Run the tests to verify they pass**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -l unit -g manifest`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Pin clj-pulse 0.5.4 and make the server path default to the bundle"`

### Task 3: Wire the bundle into activation

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/statusBar.ts`
- Test: `src/test/statusBar.test.ts`

- [x] **Step 1: Write the failing status-bar test**
  In `src/test/statusBar.test.ts`, add a `running` case with
  `detail.command` set and `detail.source: "bundled"`; the tooltip's command
  line ends with ` (bundled)`. A case with `source: "path"` (or no source)
  keeps the line as it is today.

- [x] **Step 2: Run the test to verify it fails**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -l unit -g statusPresentation`
  Expected: FAIL.

- [x] **Step 3: Implement**
  - `src/statusBar.ts`: add optional `source` to `StatusDetail` (import the
    type from `serverPath.ts`); append ` (bundled)` to the `where` line when
    `source === "bundled"`.
  - `src/extension.ts`:
    - Module-level `let bundledServerPath: string | undefined;` next to
      `clojureDocsPath`.
    - In `activate`, set it to
      `context.asAbsolutePath(path.join("server", process.platform === "win32" ? "clj-pulse.exe" : "clj-pulse"))`.
      On non-win32, if the file exists, `fs.chmodSync(bundledServerPath, 0o755)`
      inside a try/catch that logs the failure to the output channel and
      continues.
    - `readConfig()` default for `server.path` becomes `""`.
    - `start()` calls `resolveServerPath(readConfig(), process.env, bundledServerPath)`,
      logs `starting server: <command> (<source>)`, and passes `source` in
      `repaintStatus`'s detail.
    - In the `.start().catch(...)` handler, build the message: for
      `"bundled"`: `the bundled server failed to start (<command>). Set "clojurePulse.server.path" to use a different binary.`;
      otherwise `failed to start the language server (<command>)`. Use it for
      both the output line and the status-bar `error` detail.

- [x] **Step 4: Run the unit suite and lint**
  Run: `npm run lint && npm run compile-tests && xvfb-run -a npx vscode-test -l unit`
  Expected: PASS.

- [x] **Step 5: Commit**
  `git commit -m "Start the bundled clj-pulse when present and say so in the status bar"`

### Task 4: Fetch script

**Files:**
- Create: `scripts/fetch-server.sh`
- Modify: `.gitignore`

- [x] **Step 1: Write the script**
  `#!/usr/bin/env bash`, `set -euo pipefail`, executable. Usage:
  `scripts/fetch-server.sh <vsce-target>` where the target is one of
  `darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64`; anything else
  is a usage error listing them. Behaviour:
  - Read the pin: `version=$(node -p "require('./package.json').cljPulseVersion")`,
    run from the repo root (`cd "$(dirname "$0")/.."`).
  - Map the target to the asset name from the table in the design
    (`case` statement); Windows is a `.zip`, the rest `.tar.gz`.
  - `base=https://github.com/abogoyavlensky/clj-pulse/releases/download/v${version}`.
  - Download into a temp dir (`mktemp -d`, removed by a trap): the asset and
    `checksums.txt`, with `curl -fsSL --retry 3`.
  - Verify: pick the tool once, `command -v sha256sum || echo "shasum -a 256"`
    (macOS has no `sha256sum`), then
    `grep " ${asset}$" checksums.txt | $sha -c -` inside the temp dir; fail
    with a clear message if the asset is not listed or the hash differs.
  - `rm -rf server && mkdir server`, then `tar xzf` or `unzip -q` into it.
  - Confirm `server/clj-pulse` (or `server/clj-pulse.exe`) exists, `chmod 755`
    it on non-Windows assets, and print `fetched clj-pulse ${version} for ${target} -> server/`.
  Add a header comment explaining what it is for and who calls it (CI, Make).

- [x] **Step 2: Ignore the output**
  Append `server/` to `.gitignore` under the "Packaged extension" comment,
  with a comment that it holds the fetched clj-pulse binary.

- [x] **Step 3: Verify against the real release**
  Run: `scripts/fetch-server.sh linux-x64 && ./server/clj-pulse --version`
  Expected: prints the fetched line, then `clj-pulse 0.5.4` (or similar).
  Run: `scripts/fetch-server.sh win32-x64 && ls server/`
  Expected: `clj-pulse.exe`.
  Run: `scripts/fetch-server.sh linux-386; echo $?`
  Expected: usage error, non-zero exit.
  Run: `git status --short`
  Expected: `server/` does not appear.

- [x] **Step 4: Commit**
  `git commit -m "Add scripts/fetch-server.sh to download and verify the pinned clj-pulse"`

### Task 5: Makefile

**Files:**
- Modify: `Makefile`

- [x] **Step 1: Add the targets**
  - A `HOST_TARGET` variable: `uname -s`/`uname -m` mapped to
    `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (Windows is not
    a supported dev host for this Makefile; leave it out).
  - `fetch-server: ## Download the pinned clj-pulse for this machine into server/`
    → `scripts/fetch-server.sh $(HOST_TARGET)`.
  - `package: fetch-server ## Build the .vsix for this machine, with clj-pulse bundled`
    → `npx vsce package --target $(HOST_TARGET)`. `VSIX` becomes
    `clojure-pulse-$(VERSION)@$(HOST_TARGET).vsix` so `install-extension`
    keeps working.
  - `package-universal: ## Build the .vsix without a bundled server (uses clj-pulse from PATH)`
    → `rm -rf server && npm run package`.
  - `clean` also removes `server`.
  - Add the new names to `.PHONY`.

- [x] **Step 2: Verify**
  Run: `make package && ls *.vsix`
  Expected: `clojure-pulse-0.5.2@linux-x64.vsix` (version as in package.json).
  Run: `unzip -l clojure-pulse-*@linux-x64.vsix | grep server/`
  Expected: `extension/server/clj-pulse` listed.
  Run: `make package-universal && unzip -l clojure-pulse-0.5.2.vsix | grep -c server/`
  Expected: `0`.

- [x] **Step 3: Commit**
  `git commit -m "Make package builds the host-platform vsix with clj-pulse bundled"`

> Deviation: vsce 3.9.2 names platform builds `clojure-pulse-<target>-<version>.vsix`
> (e.g. `clojure-pulse-linux-x64-0.5.2.vsix`), not `<version>@<target>` as the
> plan assumed. `VSIX` in the Makefile, the README and the release glob follow
> the real name; `clojure-pulse-*.vsix` still matches.

### Task 6: CI and release workflows

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

- [x] **Step 1: ci.yml**
  After "Install dependencies" add
  `- name: Fetch clj-pulse` → `run: scripts/fetch-server.sh linux-x64`,
  then `actions/setup-java@v4` (`distribution: temurin`, `java-version: 21`)
  and `DeLaGuardo/setup-clojure@13.4` (`cli: latest`), with a comment that
  the jar e2e fixture resolves its classpath through `clojure -Spath`.
  Warm it explicitly so a resolution failure is its own step, not a test
  timeout: `- name: Resolve e2e fixture classpath` →
  `run: cd src/test/fixtures/jar-project && clojure -Spath > /dev/null`.
  Change the Test step to export `CLJ_PULSE_E2E_BIN: ${{ github.workspace }}/server/clj-pulse`
  via `env:`. Add a step after it:
  `- name: End-to-end (jar)` → `run: xvfb-run -a npx vscode-test -l jar-e2e`
  with the same `env`. (The `unit` label already picks up
  `clojureDocs.e2e.test.js`, which needs no workspace folder.)
  Change "Package extension" to `npx --yes @vscode/vsce package --target linux-x64`
  and keep the artifact upload.

- [x] **Step 2: release.yml**
  Same fetch and test changes as `ci.yml`. Replace the "Package extension"
  step with one shell step that loops:
  ```sh
  for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64; do
    scripts/fetch-server.sh "$target"
    npx vsce package --target "$target"
    rm -rf server
  done
  npx vsce package
  ```
  Keep the checksum and `softprops/action-gh-release@v2` steps; the
  `clojure-pulse-*.vsix` glob already matches the `@target` names. Add a
  comment above the loop explaining the all-or-nothing intent.

- [x] **Step 3: Validate the YAML**
  Run: `node -e "require('js-yaml')" 2>/dev/null || npx --yes js-yaml .github/workflows/ci.yml > /dev/null && npx --yes js-yaml .github/workflows/release.yml > /dev/null && echo ok`
  Expected: `ok`.
  Then run the release loop locally once, minus the upload:
  `for t in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64; do scripts/fetch-server.sh $t && npx vsce package --target $t && rm -rf server; done && npx vsce package && ls *.vsix`
  Expected: six `.vsix` files.
  Run: `rm -f *.vsix`.

- [x] **Step 4: Commit**
  `git commit -m "Release one vsix per platform with clj-pulse bundled; run e2e tests in CI"`

### Task 7: README

**Files:**
- Modify: `README.md`

- [x] **Step 1: Installation and Requirements**
  Use /writing-clearly.
  - **Installation:** the release page lists one `.vsix` per platform plus a
    universal one. Table of file suffix → platform (`@darwin-arm64` Apple
    Silicon, `@darwin-x64` Intel Mac, `@linux-x64`, `@linux-arm64`,
    `@win32-x64`, no suffix = universal). Platform builds include clj-pulse;
    nothing else to install. Keep the `code --install-extension` and UI
    steps. Drop the "Then install the clj-pulse server" sentence.
  - **Requirements:** VS Code 1.97 or newer. A platform build needs nothing
    else. The universal build needs clj-pulse on `PATH` (or a path in
    `clojurePulse.server.path`); keep the brew/mise/download snippet under
    that heading, introduced as the fallback.
  - Note under Requirements that the extension runs on the remote host in
    Remote-SSH, WSL and dev containers, so install the `.vsix` that matches
    the remote machine's platform there (Extensions view → **⋯** → **Install
    from VSIX…** while connected).

- [x] **Step 2: Configuration**
  Update the intro sentence and the `clojurePulse.server.path` row: default
  `""`, "empty uses the bundled server, then `clj-pulse` on `PATH`; any
  non-empty value overrides the bundle". Keep the JSON example but show the
  override use case.

- [x] **Step 3: Development**
  - Tasks: mention `make fetch-server`, that `make package` bundles the
    host platform's server, and `make package-universal`.
  - "Install it on your own projects": the produced file is now
    `clojure-pulse-<version>@<platform>.vsix`.
  - Add a short **Releasing** subsection: bump `version`, bump
    `cljPulseVersion` to the clj-pulse release to ship, commit, `make tag`.
    One sentence on the pin: an extension release always carries exactly
    that server.

- [x] **Step 4: Review the diff for accuracy**
  Run: `git diff README.md`
  Check every command and file name against Tasks 4 to 6.

- [x] **Step 5: Commit**
  `git commit -m "Document the bundled clj-pulse server and per-platform installs"`

### Task 8: Full check and manual verification

- [x] **Step 1: Full suite**
  Run: `make check`
  Expected: lint, compile and tests pass.

- [x] **Step 2: E2E against the fetched binary**
  Run: `scripts/fetch-server.sh linux-x64 && CLJ_PULSE_E2E_BIN=$PWD/server/clj-pulse xvfb-run -a npx vscode-test -l jar-e2e`
  Expected: PASS, not skipped.

- [x] **Step 3: Install and inspect**
  Run: `make install-extension`, reload VS Code, open a `.clj` file, hover the
  `clj-pulse` status-bar item.
  Expected: tooltip shows `v0.5.4`, the `.../server/clj-pulse` path and
  `(bundled)`. Then set `"clojurePulse.server.path": "clj-pulse"` in user
  settings, run **Clojure Pulse: Restart**, and confirm the tooltip now
  shows the PATH copy without `(bundled)`. Remove the setting afterwards.

> Deviation: this machine has no `code` CLI, so `make install-extension`
> stops at the (successful) package step and the tooltip could not be
> inspected. In its place, a throwaway test in the VS Code test host
> (extension path = repo root with `server/clj-pulse` present, blank
> `server.path`) confirmed via `/proc/*/cmdline` that the process the
> extension spawned was the bundled file, and that it answered a hover.
> The status-bar text itself is covered by the unit tests. The GUI check
> (tooltip shows `v0.5.4` and `(bundled)`, then the PATH copy after setting
> `"clj-pulse"`) is still worth doing on a machine with VS Code.

- [x] **Step 4: Backlog**
  Use /backlog to add an entry for musl Linux builds of clj-pulse (removes
  the glibc floor on old distros; a clj-pulse change), status open, one
  commit of its own.

Follow-ups outside this repo, not part of the plan: delete the stale
`editors/vscode` scaffold in clj-pulse.

---

## Completion summary

Implemented, in eight commits on `package-clj-pulse`:

- `resolveServerPath` gained a `bundled` candidate and a `source`
  (`explicit` | `bundled` | `path`); blank config prefers an executable
  bundle, then `PATH`. Ten unit tests.
- `package.json`: `cljPulseVersion: "0.5.4"`, `extensionKind: ["workspace"]`,
  `server.path` default `""`. Three manifest tests.
- Activation computes the bundle path, sets its execute bit (non-Windows),
  passes it to resolution, logs the source, marks `(bundled)` in the tooltip,
  and names the failing file (plus the override setting for the bundle) when a
  spawn fails.
- `scripts/fetch-server.sh <vsce-target>`: download, checksum, extract into
  `server/` (gitignored). Verified against the real 0.5.4 release for
  linux-x64 and win32-x64.
- Makefile: `fetch-server`, `package` (host platform, bundled),
  `package-universal`, `clean` removes `server/`.
- CI and release workflows fetch linux-x64, install Temurin 21 + Clojure CLI,
  warm the fixture classpath, run both e2e suites, and (release) build five
  platform `.vsix` files plus the universal one in a single step.
- README: per-platform install table, requirements, remote-host note,
  configuration, dev tasks, Releasing section.
- Backlog: `docs/backlog/bundled-linux-server-needs-glibc-2-39.md`.

Verification: `make check` green (865 passing); jar and ClojureDocs e2e pass
against the fetched 0.5.4 binary; the release loop run locally produced six
`.vsix` files, five containing `extension/server/clj-pulse[.exe]` and the
universal one containing none; a test-host check confirmed the bundled file
is what gets spawned with a blank setting.

Codex reviews: no must-fix findings on any task. Task 2's review flagged that
the manifest default landed before activation was wired — expected sequencing,
resolved by Task 3.

Deviations:

- Task 5: vsce 3.9.2 names platform builds `clojure-pulse-<target>-<version>.vsix`,
  not `<version>@<target>`. Makefile `VSIX`, README and the release glob use
  the real name.
- Task 8: no `code` CLI here; the manual tooltip check was replaced by a
  test-host check of the spawned process. GUI inspection still pending on a
  machine with VS Code.

Issues found along the way: the Linux 0.5.4 binary requires glibc 2.39, so
the bundle will not load on Ubuntu 22.04 / Debian 12 / Alpine and the user
gets the "bundled server failed to start" message rather than a PATH
fallback. Recorded in the backlog (a clj-pulse build change).

What the plan could have specified better: the vsce output filename should
have been checked against the installed vsce version rather than assumed, and
the glibc floor of the Linux archive should have been measured at planning
time — it changes who the platform build actually serves.
