# GitHub Release for the .vsix Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the packaged `clojure-pulse-<version>.vsix` as a GitHub Release asset whenever a version tag is pushed, so users can install the extension before it reaches the VS Code Marketplace.

**Tech Stack:** GitHub Actions, `@vscode/vsce` (already a devDependency), `softprops/action-gh-release@v2`

---

## Design

A new workflow, `.github/workflows/release.yml`, mirrors the house release pattern from `clj-pulse/.github/workflows/release.yml`, simplified to a single job because a `.vsix` is one platform-independent artifact (no build matrix, no Homebrew).

**Release flow for the maintainer:** bump `version` in `package.json`, commit, then `git tag v0.0.1 && git push origin v0.0.1`. The workflow does the rest.

**Workflow shape** — one job, triggered by `push` on `tags: ["*"]`, with `permissions: contents: write`:

1. **Version guard (first step):** strip a leading `v` from the tag and compare to `package.json`'s `version` (read with `node -p`). Fail fast on mismatch so a release never carries a `.vsix` that reports a different version than its tag.
2. **Checks:** the same steps as `ci.yml` — `npm ci`, `npm run lint`, `npm run compile`, `xvfb-run -a npm test`. A tagged release must not skip what every PR runs.
3. **Package:** `npm run package` (the pinned devDependency `vsce`, reproducible against the lockfile — deliberately not `npx --yes @vscode/vsce` as `ci.yml` uses; `ci.yml` itself stays untouched).
4. **Checksums:** `sha256sum clojure-pulse-*.vsix > checksums.txt`.
5. **Release:** `softprops/action-gh-release@v2` with `generate_release_notes: true`, uploading `clojure-pulse-*.vsix` and `checksums.txt`. Release notes are auto-generated; `CHANGELOG.md` remains the human-curated record.

**README:** add an "Install from GitHub Releases" section — download the `.vsix` from the latest release, then either `code --install-extension clojure-pulse-<version>.vsix` or use "Extensions: Install from VSIX…" in VS Code. Without this the release asset is undiscoverable.

**Out of scope:** VS Code Marketplace / OpenVSX publishing, changelog-driven release notes, pre-release channels.

## File Structure

- Create: `.github/workflows/release.yml` — the tag-triggered release workflow (guard → checks → package → checksums → release).
- Modify: `README.md` — installation instructions pointing at GitHub Releases.

No source or test changes; verification is by YAML review, a local dry-run of the guard/package commands, and the real tag push at the end.

### Task 1: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [x] **Step 1: Write the workflow**
  Model it on `ci.yml` (checkout@v4, setup-node@v4 with node 20 + npm cache) plus the release pieces from the design. Structure:
  - `on: push: tags: ["*"]`, `permissions: contents: write`, single `release` job on `ubuntu-latest`.
  - Version-guard step (the tag/manifest comparison must agree exactly with the local dry-run in Step 2):
    ```yaml
    - name: Verify tag matches package.json version
      env:
        TAG: ${{ github.ref_name }}
      run: |
        version=$(node -p "require('./package.json').version")
        if [ "${TAG#v}" != "$version" ]; then
          echo "Tag $TAG does not match package.json version $version" >&2
          exit 1
        fi
    ```
  - Then: `npm ci`, `npm run lint`, `npm run compile`, `xvfb-run -a npm test`, `npm run package`, `sha256sum clojure-pulse-*.vsix > checksums.txt`.
  - Final step: `softprops/action-gh-release@v2` with `generate_release_notes: true` and `files:` listing `clojure-pulse-*.vsix` and `checksums.txt`.

- [x] **Step 2: Dry-run the guard and packaging locally**
  Run: `TAG=v0.0.1; version=$(node -p "require('./package.json').version"); [ "${TAG#v}" = "$version" ] && echo MATCH || echo MISMATCH`
  Expected: `MATCH`
  Run: `npm run package`
  Expected: exits 0 and produces `clojure-pulse-0.0.1.vsix` (gitignored).

- [x] **Step 3: Lint the workflow file**
  Run: `actionlint .github/workflows/release.yml` if `actionlint` is available; otherwise validate the YAML parses: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8'))"` (js-yaml is in `node_modules` via devDependencies; fall back to `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"` if not)
  Expected: no errors.

- [x] **Step 4: Commit**
  `git commit -m "Add release workflow publishing the .vsix to GitHub Releases"`

### Task 2: README install instructions

**Files:**
- Modify: `README.md`

- [x] **Step 1: Add an "Install from GitHub Releases" section**
  Read `README.md` first and place the section where installation naturally belongs (near the top, before or within any existing install/setup section, matching the README's existing heading style). Content: download `clojure-pulse-<version>.vsix` from https://github.com/abogoyavlensky/clojure-pulse-vscode/releases/latest, then install with `code --install-extension clojure-pulse-<version>.vsix`, or in VS Code via the Extensions panel → "…" menu → "Install from VSIX…". Note this is the install path until the extension is on the VS Code Marketplace. Use /writing-clearly.

- [x] **Step 2: Commit**
  `git commit -m "Document installing the extension from GitHub Releases"`

### Task 3: Cut the first release

- [ ] **Step 1: Merge to master**
  The working branch (`publish-ci-artifcats`) merges via the normal PR flow first; the tag must point at the master commit containing the workflow.

- [ ] **Step 2: Tag and push**
  Run: `git checkout master && git pull` first, so the tag lands on the merged master commit (after a squash merge, the feature branch's HEAD is not the released commit).
  Run: `git tag v0.0.1 && git push origin v0.0.1`
  Expected: the Release workflow starts on GitHub.

- [ ] **Step 3: Verify the release**
  Run: `run_id=$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId') && gh run watch "$run_id" --exit-status`, then `gh release view v0.0.1`
  Expected: workflow green (exit 0); release `v0.0.1` exists with `clojure-pulse-0.0.1.vsix` and `checksums.txt` attached and auto-generated notes.
