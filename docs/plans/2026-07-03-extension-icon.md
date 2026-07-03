# Extension Marketplace Icon — Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the extension a proper Marketplace/in-product icon: derive a spec-compliant `images/icon.png` from the high-res source, wire it into the manifest, ensure it ships inside the `.vsix`, and show it in the README.

**Tech Stack:** Pure Node ESM build script (Node's built-in `zlib` for PNG decode/encode — no new dependencies), `package.json` `icon` field, `.vscodeignore`, `@vscode/vsce` for packaging.

---

## Design

### Background & findings

The source lives at `docs/images/icon.png`: a **1254×1254**, opaque **RGB (PNG color type 2)** image of a blue/green hexagon "pulse" mark on a **solid dark-navy background** (measured corner RGB ≈ `3, 21, 44`, uniform across all four corners). It has **no alpha channel** and no baked checkerboard — it is clean and ready to use as-is, only the wrong size and in the wrong place.

Two facts drive this plan:

1. **VS Code icon requirements.** The Marketplace icon must be a **PNG** (SVG is not allowed) and **at least 128×128**; `vsce` refuses to package a smaller one. We ship **256×256** — it exceeds the minimum and stays crisp on hi-DPI/retina Marketplace and Extensions-sidebar rendering, at a trivial file size. A solid dark background reads well on both light and dark VS Code UI, so no transparency work is needed.
2. **`docs/**` is excluded from the package.** `.vscodeignore` strips `docs/**`, so an icon referenced from `docs/` would be **absent from the `.vsix`** and fail to display. The packaged icon must live outside `docs/` — we put it at top-level **`images/`** (note: distinct from the git-ignored `.images/`), which is not ignored and therefore included.

### Approach

- **Keep** `docs/images/icon.png` as the untouched high-res **source of truth** (kept out of the package by the existing `docs/**` ignore — good, it's a 1 MB+ file).
- **Generate** `images/icon.png` (256×256, opaque RGB) from that source with a small, committed, reproducible **pure-Node script** (`scripts/build-icon.mjs`) plus a `make icon` target. The user is iterating on the artwork, so a one-command regenerate is worth the ~40 lines; no new npm dependency is added.
- **Reference** it via `"icon": "images/icon.png"` in `package.json`, keep the build script out of the package, and confirm inclusion with `vsce ls` before building.
- **Display** the logo in the README header (via the repo's raw GitHub URL, which renders on both GitHub and the Marketplace).

### Key decisions

- **256×256, not 128×128.** Both are spec-compliant (≥128); 256 is sharper on hi-DPI at negligible cost. *(Surfaced for veto: drop to 128 if a smaller asset is preferred.)*
- **Pure-Node PNG pipeline, zero new deps.** Decode with `zlib.inflateSync` + manual scanline **un-filtering that supports filter types 0–4** — this is essential: the source uses filters 1/2/4, so a naive read of the inflated bytes yields garbage. Re-encode with per-row filter 0 + `zlib.deflateSync`. Avoids pulling in `sharp`/ImageMagick (neither is available here anyway).
- **Area-average (box) downscale.** ~4.9× reduction, averaging each ~5×5 source block per output pixel — clean anti-aliasing without a resampling library.
- **Emit opaque RGB.** Source is opaque; output stays color type 2. Decoder also accepts color type 6 (RGBA) defensively in case future artwork carries alpha, but no compositing logic is added until needed (YAGNI).
- **Source stays in `docs/`, output in `images/`.** Separates the heavy editable master from the light shipped asset, and rides the existing ignore rules (`docs/**` out, `images/**` in).

### File structure

- **Create** `scripts/build-icon.mjs` — reads `docs/images/icon.png`, decodes (inflate + un-filter, color types 2/6), area-average downscales to 256×256, re-encodes as opaque RGB PNG, writes `images/icon.png`. Run with `node scripts/build-icon.mjs`.
- **Create** `images/icon.png` — generated 256×256 packaged icon (committed artifact).
- **Modify** `Makefile` — add a `.PHONY` `icon` target that runs the script.
- **Modify** `package.json` — add top-level `"icon": "images/icon.png"`.
- **Modify** `.vscodeignore` — add `scripts/**` so the build script isn't packaged (leave `images/` un-ignored so the icon ships).
- **Modify** `README.md` — add the logo to the header.

---

## File Structure

```
docs/images/icon.png     # source of truth, 1254x1254 (unchanged, not packaged)
images/icon.png          # NEW generated 256x256 packaged icon
scripts/build-icon.mjs   # NEW pure-Node generator (not packaged)
Makefile                 # + `icon` target
package.json             # + "icon" field
.vscodeignore            # + scripts/**
README.md                # + header logo
```

---

## Task 1: Icon build script and 256×256 asset

**Files:**
- Create: `scripts/build-icon.mjs`
- Create: `images/icon.png` (generated output)
- Modify: `Makefile`

- [ ] **Step 1: Write `scripts/build-icon.mjs`**
  Pure-Node ESM, no imports beyond `node:fs` and `node:zlib`. Responsibilities:
  1. Read `docs/images/icon.png`; walk PNG chunks to get `IHDR` (width, height, bit depth 8, color type) and concatenate all `IDAT` data.
  2. `zlib.inflateSync` the IDAT stream, then **un-filter each scanline** supporting filter types **0 (None), 1 (Sub), 2 (Up), 3 (Average), 4 (Paeth)** — the source uses 1/2/4, so this is mandatory. Support color type 2 (RGB) and 6 (RGBA); throw a clear error on anything else.
  3. **Area-average downscale** to 256×256: for each output pixel, average all source pixels in its `[x·W/256, (x+1)·W/256) × [y·H/256, (y+1)·H/256)` block (RGB; ignore/drop alpha).
  4. **Encode** an opaque RGB PNG: signature + `IHDR` (256×256, bit depth 8, color type 2) + `IDAT` (`zlib.deflateSync` of scanlines each prefixed with a `0` filter byte) + `IEND`, with correct CRC32 per chunk.
  5. Write `images/icon.png` (create the `images/` dir if missing) and log the output path and dimensions.

- [ ] **Step 2: Add the `make icon` target to `Makefile`**
  Add `icon` to the `.PHONY` list and a target following the existing `## description` convention:
  ```
  icon: ## Regenerate images/icon.png (256x256) from docs/images/icon.png
  	node scripts/build-icon.mjs
  ```

- [ ] **Step 3: Generate the asset**
  Run: `make icon`
  Expected: prints the written path; `images/icon.png` now exists.

- [ ] **Step 4: Verify the output is a valid 256×256 PNG**
  Run: `node -e "const b=require('fs').readFileSync('images/icon.png');console.log('sig ok:',b.slice(1,4).toString()==='PNG','w:',b.readUInt32BE(16),'h:',b.readUInt32BE(20),'colortype:',b[25])"`
  Expected: `sig ok: true w: 256 h: 256 colortype: 2`

- [ ] **Step 5: Eyeball the result**
  Open `images/icon.png` and confirm the hexagon is centered, sharp, on the solid dark-navy background with no fringing.

## Task 2: Wire the icon into the manifest and packaging

**Files:**
- Modify: `package.json`
- Modify: `.vscodeignore`

- [ ] **Step 1: Add the `icon` field to `package.json`**
  Add a top-level `"icon": "images/icon.png"` (place it near `"license"`/`"author"`, before `"repository"` or wherever it reads cleanly). Do not touch other fields.

- [ ] **Step 2: Keep the build script out of the package**
  In `.vscodeignore`, add a `scripts/**` line (alongside the existing ignores). Leave `images/` un-ignored so the icon ships. Confirm `.vscodeignore` still excludes `docs/**`.

- [ ] **Step 3: Verify the package file list**
  Run: `npx @vscode/vsce ls`
  Expected: the list **includes `images/icon.png`** and **excludes** everything under `docs/` and `scripts/`.

## Task 3: Show the logo in the README header

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the logo to the header**
  Under the `# Clojure Pulse` title, add a small centered logo using an absolute raw URL so it renders on GitHub and the Marketplace:
  ```html
  <img src="https://raw.githubusercontent.com/abogoyavlensky/clojure-pulse-vscode/master/docs/images/icon.png" alt="Clojure Pulse icon" width="128" />
  ```
  Keep it minimal; don't restructure the existing intro prose. Use /writing-clearly if any surrounding text is touched.

- [ ] **Step 2: Verify it renders**
  Confirm the Markdown preview shows the icon and the link resolves (the URL points at the committed source path on `master`).

## Task 4: Verify the packaged `.vsix` and commit

**Files:** none (verification + commit)

- [ ] **Step 1: Build the package**
  Run: `make package`
  Expected: builds `clojure-pulse-0.0.1.vsix` with no icon-related errors or warnings.

- [ ] **Step 2: Confirm the icon is inside the `.vsix`**
  Run: `unzip -l clojure-pulse-0.0.1.vsix | grep -E "images/icon.png|docs/"`
  Expected: `extension/images/icon.png` is listed; **no** `docs/` entries appear.

- [ ] **Step 3: Clean the build artifact**
  Run: `make clean` (removes the `.vsix`; it's git-ignored anyway).

- [ ] **Step 4: Commit**
  `git add scripts/build-icon.mjs images/icon.png Makefile package.json .vscodeignore README.md`
  `git commit -m "feat: add extension marketplace icon"`
