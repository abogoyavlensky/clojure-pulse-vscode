# Publish to the Marketplace and Open VSX Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tagged release publishes its six `.vsix` files to the VS Code Marketplace and Open VSX from CI, and the docs send users to the Marketplace first.

**Tech Stack:** GitHub Actions, `@vscode/vsce` (`publish --packagePath`), `ovsx`, Mocha manifest test.

---

## Design

### Problem

Releases stop at GitHub Releases. The extension reached the Marketplace only
because the maintainer uploaded each of the six files by hand through the
web form, once per release. Open VSX has nothing, so VSCodium and Cursor users
cannot install it at all. The README still says "until the extension reaches
the VS Code Marketplace", and `package.json` has no keywords, so the listing
is hard to find by search.

### Current state

- `.github/workflows/release.yml` is one job: verify the tag, fetch clj-pulse,
  test, package five platform builds plus the universal one, checksum, and
  upload with `softprops/action-gh-release`.
- The Marketplace lists `abogoyavlensky.clojure-pulse` at 0.6.1 with all six
  targets, published manually.
- Open VSX has no `abogoyavlensky` namespace.
- `vsce` 3 names platform builds `clojure-pulse-<target>-<version>.vsix` and
  the universal one `clojure-pulse-<version>.vsix`. The existing
  `clojure-pulse-*.vsix` glob matches all six.

### Shape of the solution

Two publish steps follow the GitHub Release step in the same job:

```sh
npx vsce publish --skip-duplicate --packagePath clojure-pulse-*.vsix
npx ovsx publish --skip-duplicate --packagePath clojure-pulse-*.vsix
```

`ovsx publish` takes a single positional file; several files need
`--packagePath`, same as `vsce`.

Each tool reads the target platform from the manifest inside each file, so
one command publishes all six and no per-target loop is needed. Tokens come
from repo secrets `VSCE_PAT` and `OVSX_PAT`, exposed as the environment
variables both tools read by default.

Order matters: the GitHub Release is the source of truth and exists even if a
registry is down. A re-run of the job rebuilds, re-uploads the release assets
(`action-gh-release` updates an existing release), and `--skip-duplicate`
turns an already-published version into a no-op instead of a failure. The
first `ovsx publish` creates the extension on Open VSX.

An Open VSX failure fails the job, the same as a Marketplace failure. That
surfaces an expired token instead of silently dropping VSCodium users.

`ovsx` becomes a devDependency, pinned like `@vscode/vsce`, so the release
path does not depend on whatever `npx --yes` resolves that day.

### Prerequisites the maintainer does by hand

These are not tasks; the plan assumes they are done before the first tagged
release after this lands.

1. **Azure DevOps token.** At `https://dev.azure.com/<org>/_usersSettings/tokens`:
   organization "All accessible organizations", scope "Marketplace: Manage",
   expiry at most one year. Verify with `npx vsce verify-pat abogoyavlensky`.
   Store: `gh secret set VSCE_PAT`.
2. **Open VSX.** Sign in at open-vsx.org with GitHub, sign the publisher
   agreement, create the namespace `abogoyavlensky`, create an access token.
   Verify with `npx ovsx verify-pat abogoyavlensky`. Store:
   `gh secret set OVSX_PAT`.
3. Note both expiry dates somewhere visible. The job starts failing on the
   day a token expires.

### Listing

- **Description** (`package.json`, the README's bold line, and the GitHub
  repo description, all the same sentence):
  "Clojure in VS Code with a bundled native language server. Instant start,
  inline evaluation, REPLs, and tests."
- **Keywords:** `clojure`, `clojurescript`, `lsp`, `repl`, `nrepl`, `let-go`.
  The manifest test asserts `clojure` is among them so the search terms cannot
  vanish silently.
- **No pre-release channel.** Every tag is a stable release on both
  registries.

### Docs

- `README.md` Installation: install from the Marketplace (search "Clojure
  Pulse") or Open VSX for VSCodium and Cursor; GitHub Releases remain the
  manual fallback, linked to the getting-started page.
- `docs/getting-started.md`: drop "until the extension reaches the VS Code
  Marketplace"; lead with Marketplace and Open VSX; keep the `.vsix` table
  under a "Manual install" heading; the remote-host paragraph says VS Code
  picks the matching build automatically for Marketplace installs, and the
  manual route is for offline hosts.
- `docs/development.md` Releasing: say the workflow also publishes to both
  registries, name the two secrets, and note token expiry.

### Verification

No unit tests beyond the manifest assertion. The real check is the next
tagged release: the job publishes, the Marketplace version list shows six
targets for the new version, and Open VSX shows the extension for the first
time with the same six targets
(`curl -s https://open-vsx.org/api/abogoyavlensky/clojure-pulse | jq '.allTargetPlatformVersions'`).

---

## File Structure

- Modify: `.github/workflows/release.yml` — two publish steps after the
  GitHub Release step.
- Modify: `package.json` — `ovsx` devDependency, `description`, `keywords`.
- Modify: `package-lock.json` — via `npm install`.
- Modify: `src/test/manifest.test.ts` — keywords assertion.
- Modify: `README.md` — tagline and Installation.
- Modify: `docs/getting-started.md` — install section.
- Modify: `docs/development.md` — Releasing section.

---

## Tasks

### Task 1: Listing metadata

**Files:**
- Modify: `package.json`
- Test: `src/test/manifest.test.ts`

- [ ] **Step 1: Write the failing test**
  In `src/test/manifest.test.ts`, add a test in the `manifest` suite that
  reads the top-level `keywords` array from `package.json` (widen the parsed
  type as needed) and asserts it includes `"clojure"`.

- [ ] **Step 2: Run the test to verify it fails**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -l unit -g manifest`
  Expected: FAIL, `keywords` is undefined.

- [ ] **Step 3: Edit `package.json`**
  - `description`: "Clojure in VS Code with a bundled native language server.
    Instant start, inline evaluation, REPLs, and tests."
  - Add `"keywords": ["clojure", "clojurescript", "lsp", "repl", "nrepl", "let-go"]`
    after `categories`.

- [ ] **Step 4: Run the test to verify it passes**
  Run: `npm run compile-tests && xvfb-run -a npx vscode-test -l unit -g manifest`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "Describe the extension for the Marketplace and add keywords"`

### Task 2: ovsx devDependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**
  Run: `npm install --save-dev ovsx`
  Expected: `ovsx` appears under `devDependencies` next to `@vscode/vsce`.

- [ ] **Step 2: Confirm both tools run from the project**
  Run: `npx vsce --version && npx ovsx --version`
  Expected: two version lines.

- [ ] **Step 3: Commit**
  `git commit -m "Add ovsx for publishing to Open VSX"`

### Task 3: Publish steps in the release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add the steps**
  After the `softprops/action-gh-release@v2` step, add:
  - `- name: Publish to the VS Code Marketplace`, `env: VSCE_PAT: ${{ secrets.VSCE_PAT }}`,
    `run: npx vsce publish --skip-duplicate --packagePath clojure-pulse-*.vsix`
  - `- name: Publish to Open VSX`, `env: OVSX_PAT: ${{ secrets.OVSX_PAT }}`,
    `run: npx ovsx publish --skip-duplicate --packagePath clojure-pulse-*.vsix`
  Above the first, a comment: the GitHub Release is the source of truth and
  goes first; each tool reads the target platform from the file's manifest,
  so one command publishes all six; `--skip-duplicate` makes a re-run of an
  already-published version a no-op.

- [ ] **Step 2: Validate the YAML**
  Run: `npx --yes js-yaml .github/workflows/release.yml > /dev/null && echo ok`
  Expected: `ok`.

- [ ] **Step 3: Duplicate-publish check against the current release**
  This is a real publish, not a dry run: any target missing from a registry
  would be uploaded. Against 0.6.1, which is fully published on the
  Marketplace, `--skip-duplicate` makes it a no-op there. Do not run the
  `ovsx` command here: Open VSX has nothing yet, so it would publish 0.6.1
  for real. Its first publish happens on the next tag.
  Run:
  ```sh
  rm -f *.vsix && gh release download v0.6.1 -p 'clojure-pulse-*.vsix' \
    && ls clojure-pulse-*.vsix | wc -l
  ```
  Expected: `6`. Then, with the tokens exported in the shell:
  ```sh
  VSCE_PAT=… npx vsce publish --skip-duplicate --packagePath clojure-pulse-*.vsix
  ```
  Expected: each file reports the version already exists and is skipped;
  exit 0. Skip this step if the tokens are not created yet, and say so in
  the hand-off. Run `rm -f *.vsix` afterwards.

- [ ] **Step 4: Commit**
  `git commit -m "Publish each release to the VS Code Marketplace and Open VSX"`

### Task 4: Docs

**Files:**
- Modify: `README.md`, `docs/getting-started.md`, `docs/development.md`

- [ ] **Step 1: README**
  Use /writing-clearly.
  - Replace the bold line under the title with the new description sentence.
    Keep the following sentence about Clojure and let-go support.
  - Installation: first sentence says install **Clojure Pulse** from the
    Marketplace, linking
    `https://marketplace.visualstudio.com/items?itemName=abogoyavlensky.clojure-pulse`,
    or from Open VSX (`https://open-vsx.org/extension/abogoyavlensky/clojure-pulse`)
    in VSCodium and Cursor. Keep the VS Code 1.97 requirement and the
    sentence about the runtime needed for a REPL. Replace the GitHub Releases
    instructions with one line: a manual `.vsix` install is described in the
    getting-started page.

- [ ] **Step 2: getting-started.md**
  - Install: Marketplace and Open VSX first, with the same two links. The
    platform build with clj-pulse inside is picked automatically.
  - Rename the current download steps to **Manual install** and keep the
    table and `code --install-extension` steps. Remove "Until the extension
    reaches the VS Code Marketplace".
  - Remote hosts: a Marketplace install picks the remote host's build by
    itself; the manual route is for hosts without registry access.

- [ ] **Step 3: development.md**
  In Releasing, after the sentence about GitHub Releases, add that the
  workflow then publishes all six files to the Marketplace and Open VSX using
  the `VSCE_PAT` and `OVSX_PAT` repo secrets, that both tokens expire (Azure
  DevOps at most yearly) and a failed publish step is the first symptom, and
  that a re-run after fixing a token is safe because of `--skip-duplicate`.

- [ ] **Step 4: Check the links**
  Run: `grep -n "marketplace.visualstudio.com\|open-vsx.org" README.md docs/getting-started.md`
  Expected: both URLs present in both files, no typos.
  Run: `grep -rn "Until the extension reaches" README.md docs/`
  Expected: no output.

- [ ] **Step 5: Commit**
  `git commit -m "Point installation docs at the Marketplace and Open VSX"`

### Task 5: Full check and hand-off notes

- [ ] **Step 1: Full suite**
  Run: `make check`
  Expected: lint, compile and tests pass.

- [ ] **Step 2: Hand-off**
  State in the final message whether the tokens were verified (Task 3 step
  3) and that the first CI publish happens on the next tag. Suggest updating
  the GitHub repo description to the new sentence, which is a settings change
  outside the repo.
