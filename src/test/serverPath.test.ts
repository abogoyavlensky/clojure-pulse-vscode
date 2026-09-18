import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveServerPath, isError } from "../serverPath";

function binaryName(): string {
  return process.platform === "win32" ? "clj-pulse.exe" : "clj-pulse";
}

/** A temp dir holding a fake executable `clj-pulse`; returns both. */
function fakeServer(prefix: string, mode = 0o755): { dir: string; exe: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const exe = path.join(dir, binaryName());
  fs.writeFileSync(exe, "#!/bin/sh\n", { mode });
  return { dir, exe };
}

suite("resolveServerPath", () => {
  test("returns an explicit path verbatim, without touching PATH", () => {
    const explicit = path.join(path.sep, "opt", "bin", "clj-pulse");
    const r = resolveServerPath({ path: explicit, args: ["--verbose"] }, { PATH: "" });
    assert.deepStrictEqual(r, { command: explicit, args: ["--verbose"], source: "explicit" });
  });

  test("resolves a bare command name from the PATH entries", () => {
    const { dir, exe } = fakeServer("clj-pulse-path-");

    const r = resolveServerPath({ path: "clj-pulse", args: [] }, { PATH: dir });

    assert.deepStrictEqual(r, { command: exe, args: [], source: "path" });
  });

  test("falls back to the default command name when path is blank", () => {
    const { dir, exe } = fakeServer("clj-pulse-default-");

    const r = resolveServerPath({ path: "  ", args: [] }, { PATH: dir });

    assert.deepStrictEqual(r, { command: exe, args: [], source: "path" });
  });

  test("returns a structured error when a bare name is not on PATH", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clj-pulse-empty-"));
    const r = resolveServerPath({ path: "clj-pulse", args: [] }, { PATH: empty });

    assert.ok(isError(r));
    if (isError(r)) {
      assert.match(r.error, /not found/i);
    }
  });

  test("blank config prefers the bundled server over a PATH copy", () => {
    const onPath = fakeServer("clj-pulse-path-");
    const bundled = fakeServer("clj-pulse-bundle-");

    const r = resolveServerPath({ path: "", args: ["--x"] }, { PATH: onPath.dir }, bundled.exe);

    assert.deepStrictEqual(r, { command: bundled.exe, args: ["--x"], source: "bundled" });
  });

  test("blank config falls back to PATH when the bundled file is missing", () => {
    const onPath = fakeServer("clj-pulse-path-");
    const missing = path.join(os.tmpdir(), "clj-pulse-no-such-bundle", binaryName());

    const r = resolveServerPath({ path: "", args: [] }, { PATH: onPath.dir }, missing);

    assert.deepStrictEqual(r, { command: onPath.exe, args: [], source: "path" });
  });

  test("blank config falls back to PATH when the bundled file is not executable", function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const onPath = fakeServer("clj-pulse-path-");
    const bundled = fakeServer("clj-pulse-bundle-", 0o644);

    const r = resolveServerPath({ path: "", args: [] }, { PATH: onPath.dir }, bundled.exe);

    assert.deepStrictEqual(r, { command: onPath.exe, args: [], source: "path" });
  });

  test("a bare name in config ignores the bundle and uses PATH", () => {
    const onPath = fakeServer("clj-pulse-path-");
    const bundled = fakeServer("clj-pulse-bundle-");

    const r = resolveServerPath({ path: "clj-pulse", args: [] }, { PATH: onPath.dir }, bundled.exe);

    assert.deepStrictEqual(r, { command: onPath.exe, args: [], source: "path" });
  });

  test("an explicit path in config ignores the bundle", () => {
    const bundled = fakeServer("clj-pulse-bundle-");
    const explicit = path.join(path.sep, "opt", "bin", "clj-pulse");

    const r = resolveServerPath({ path: explicit, args: [] }, { PATH: "" }, bundled.exe);

    assert.deepStrictEqual(r, { command: explicit, args: [], source: "explicit" });
  });

  test("blank config with no bundle and an empty PATH is still the not-found error", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clj-pulse-empty-"));

    const r = resolveServerPath({ path: "", args: [] }, { PATH: empty });

    assert.ok(isError(r));
    if (isError(r)) {
      assert.match(r.error, /not found/i);
    }
  });
});
