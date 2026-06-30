import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveServerPath, isError } from "../serverPath";

function binaryName(): string {
  return process.platform === "win32" ? "clj-pulse.exe" : "clj-pulse";
}

suite("resolveServerPath", () => {
  test("returns an explicit path verbatim, without touching PATH", () => {
    const explicit = path.join(path.sep, "opt", "bin", "clj-pulse");
    const r = resolveServerPath({ path: explicit, args: ["--verbose"] }, { PATH: "" });
    assert.deepStrictEqual(r, { command: explicit, args: ["--verbose"] });
  });

  test("resolves a bare command name from the PATH entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clj-pulse-path-"));
    const exe = path.join(dir, binaryName());
    fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });

    const r = resolveServerPath({ path: "clj-pulse", args: [] }, { PATH: dir });

    assert.deepStrictEqual(r, { command: exe, args: [] });
  });

  test("falls back to the default command name when path is blank", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clj-pulse-default-"));
    const exe = path.join(dir, binaryName());
    fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });

    const r = resolveServerPath({ path: "  ", args: [] }, { PATH: dir });

    assert.deepStrictEqual(r, { command: exe, args: [] });
  });

  test("returns a structured error when a bare name is not on PATH", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clj-pulse-empty-"));
    const r = resolveServerPath({ path: "clj-pulse", args: [] }, { PATH: empty });

    assert.ok(isError(r));
    if (isError(r)) {
      assert.match(r.error, /not found/i);
    }
  });
});
