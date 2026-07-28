import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  configEntryName,
  defaultCreateCommand,
  parseReplConfigurations,
  readNreplPort,
  readPortFile,
  resolvePortFilePath,
  resolvePortSync,
  validatePortInput,
} from "../repl/replConfig";

suite("parseReplConfigurations", () => {
  test("accepts a create entry and defaults cwd to the workspace root", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "dev", type: "create", command: "clojure -M:nrepl" },
    ]);

    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(configs, [
      { name: "dev", type: "create", command: "clojure -M:nrepl", cwd: "." },
    ]);
  });

  test("keeps an explicit cwd", () => {
    const { configs } = parseReplConfigurations([
      { name: "api", type: "create", command: "clj -M:repl", cwd: "modules/api" },
    ]);
    assert.strictEqual(
      configs[0].type === "create" ? configs[0].cwd : undefined,
      "modules/api",
    );
  });

  test("accepts a connect entry and defaults host to localhost", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "staging", type: "connect", port: 7888 },
    ]);

    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(configs, [
      { name: "staging", type: "connect", host: "localhost", port: 7888 },
    ]);
  });

  test("accepts a port-file path as the port", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "local", type: "connect", port: ".nrepl-port" },
    ]);

    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(
      configs[0].type === "connect" ? configs[0].port : undefined,
      ".nrepl-port",
    );
  });

  test("returns nothing for missing or non-array settings", () => {
    assert.deepStrictEqual(parseReplConfigurations(undefined), {
      configs: [],
      warnings: [],
    });
    const notArray = parseReplConfigurations({ name: "dev" });
    assert.deepStrictEqual(notArray.configs, []);
    assert.strictEqual(notArray.warnings.length, 1);
  });

  test("skips non-object items with a warning", () => {
    const { configs, warnings } = parseReplConfigurations([
      "dev",
      { name: "ok", type: "connect", port: 7888 },
    ]);
    assert.strictEqual(configs.length, 1);
    assert.strictEqual(configs[0].name, "ok");
    assert.strictEqual(warnings.length, 1);
  });

  test("rejects entries without a usable name", () => {
    const { configs, warnings } = parseReplConfigurations([
      { type: "connect", port: 7888 },
      { name: "  ", type: "connect", port: 7888 },
    ]);
    assert.deepStrictEqual(configs, []);
    assert.strictEqual(warnings.length, 2);
    assert.ok(warnings.every((w) => /name/i.test(w)), warnings.join(" | "));
  });

  test("rejects an unknown type", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "dev", type: "spawn", command: "clj" },
    ]);
    assert.deepStrictEqual(configs, []);
    assert.strictEqual(warnings.length, 1);
    assert.ok(/type/i.test(warnings[0]), warnings[0]);
    assert.ok(warnings[0].includes("dev"), warnings[0]);
  });

  test("rejects a create entry without a command", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "dev", type: "create" },
    ]);
    assert.deepStrictEqual(configs, []);
    assert.ok(/command/i.test(warnings[0]), warnings[0]);
  });

  test("rejects a connect entry without a port", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "dev", type: "connect" },
    ]);
    assert.deepStrictEqual(configs, []);
    assert.ok(/port/i.test(warnings[0]), warnings[0]);
  });

  test("rejects out-of-range and non-integer numeric ports", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "a", type: "connect", port: 0 },
      { name: "b", type: "connect", port: 70000 },
      { name: "c", type: "connect", port: 12.5 },
      { name: "d", type: "connect", port: "" },
    ]);
    assert.deepStrictEqual(configs, []);
    assert.strictEqual(warnings.length, 4);
  });

  test("skips duplicate names, keeping the first", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "dev", type: "connect", port: 7888 },
      { name: "dev", type: "connect", port: 7889 },
    ]);
    assert.strictEqual(configs.length, 1);
    assert.strictEqual(
      configs[0].type === "connect" ? configs[0].port : undefined,
      7888,
    );
    assert.ok(/duplicate/i.test(warnings[0]), warnings[0]);
  });

  test("keeps valid entries alongside invalid ones", () => {
    const { configs, warnings } = parseReplConfigurations([
      { name: "broken", type: "create" },
      { name: "dev", type: "create", command: "clj -M:nrepl" },
    ]);
    assert.deepStrictEqual(
      configs.map((c) => c.name),
      ["dev"],
    );
    assert.strictEqual(warnings.length, 1);
  });
});

suite("configEntryName", () => {
  test("reads the name the parser would use", () => {
    assert.strictEqual(configEntryName({ name: "dev" }), "dev");
    assert.strictEqual(configEntryName({ name: "  dev  " }), "dev");
  });

  test("has no name for entries the parser would skip", () => {
    assert.strictEqual(configEntryName({ name: "   " }), undefined);
    assert.strictEqual(configEntryName({ name: 7 }), undefined);
    assert.strictEqual(configEntryName({}), undefined);
    assert.strictEqual(configEntryName("dev"), undefined);
    assert.strictEqual(configEntryName(null), undefined);
  });

  test("matches what a hand-edited entry contributes to the tree", () => {
    const { configs } = parseReplConfigurations([
      { name: "  dev  ", type: "connect", port: 7888 },
    ]);
    assert.strictEqual(configs[0].name, configEntryName({ name: "  dev  " }));
  });
});

suite("validatePortInput", () => {
  test("accepts a usable port number", () => {
    assert.strictEqual(validatePortInput("7888"), undefined);
    assert.strictEqual(validatePortInput(" 1 "), undefined);
    assert.strictEqual(validatePortInput("65535"), undefined);
  });

  test("rejects a number the configuration would then throw away", () => {
    assert.ok(validatePortInput("0"));
    assert.ok(validatePortInput("70000"));
  });

  test("accepts a port file path", () => {
    assert.strictEqual(validatePortInput(".nrepl-port"), undefined);
    assert.strictEqual(validatePortInput("target/nrepl.port"), undefined);
  });

  test("rejects an empty value", () => {
    assert.ok(validatePortInput("   "));
  });
});

suite("defaultCreateCommand", () => {
  test("POSIX quotes the -Sdeps map with single quotes", () => {
    const command = defaultCreateCommand("darwin");
    assert.strictEqual(
      command,
      'clojure -Sdeps \'{:aliases {:clojure-pulse/nrepl {:extra-deps {nrepl/nrepl {:mvn/version "1.7.0"}} :main-opts ["-m" "nrepl.cmdline"]}}}\' -M:clojure-pulse/nrepl',
    );
  });

  test("win32 quotes the -Sdeps map with escaped double quotes", () => {
    const command = defaultCreateCommand("win32");
    assert.ok(command.includes('-Sdeps "{:aliases'), command);
    assert.ok(command.includes('{:mvn/version \\"1.7.0\\"}'), command);
    assert.ok(command.includes('[\\"-m\\" \\"nrepl.cmdline\\"]'), command);
    assert.ok(!command.includes("'"), command);
  });

  test("both platforms inject the namespaced alias and start nrepl.cmdline", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const command = defaultCreateCommand(platform);
      assert.ok(command.includes(":clojure-pulse/nrepl"), platform);
      assert.ok(command.includes("-M:clojure-pulse/nrepl"), platform);
      assert.ok(command.includes("nrepl.cmdline"), platform);
      assert.ok(!command.includes("--interactive"), platform);
    }
  });
});

suite("port resolution", () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "repl-config-test-"));
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("readPortFile reads a full path", () => {
    const file = path.join(dir, ".nrepl-port");
    fs.writeFileSync(file, "7888\n");
    assert.strictEqual(readPortFile(file), 7888);
  });

  test("readPortFile returns undefined for a missing or invalid file", () => {
    assert.strictEqual(readPortFile(path.join(dir, "nope")), undefined);
    const file = path.join(dir, "garbage");
    fs.writeFileSync(file, "not-a-port");
    assert.strictEqual(readPortFile(file), undefined);
  });

  test("readPortFile rejects out-of-range contents", () => {
    const file = path.join(dir, "big");
    fs.writeFileSync(file, "70000");
    assert.strictEqual(readPortFile(file), undefined);
  });

  test("readPortFile rejects contents with trailing junk", () => {
    const junk = path.join(dir, "junk");
    fs.writeFileSync(junk, "7888abc");
    assert.strictEqual(readPortFile(junk), undefined);
    const fractional = path.join(dir, "fractional");
    fs.writeFileSync(fractional, "7888.5");
    assert.strictEqual(readPortFile(fractional), undefined);
  });

  test("readNreplPort still reads <dir>/.nrepl-port", () => {
    fs.writeFileSync(path.join(dir, ".nrepl-port"), "7888\n");
    assert.strictEqual(readNreplPort(dir), 7888);
    assert.strictEqual(readNreplPort(path.join(dir, "missing")), undefined);
  });

  test("resolvePortSync passes a numeric port through", () => {
    assert.strictEqual(resolvePortSync(7888, dir), 7888);
  });

  test("resolvePortSync reads a workspace-relative port file", () => {
    fs.writeFileSync(path.join(dir, ".nrepl-port"), "7891\n");
    assert.strictEqual(resolvePortSync(".nrepl-port", dir), 7891);
  });

  test("resolvePortSync reads an absolute port file without the workspace root", () => {
    const file = path.join(dir, "other.port");
    fs.writeFileSync(file, "7892");
    assert.strictEqual(resolvePortSync(file, undefined), 7892);
  });

  test("resolvePortSync returns undefined for a missing file", () => {
    assert.strictEqual(resolvePortSync(".nrepl-port", dir), undefined);
  });

  test("resolvePortFilePath names the file a string port resolves to", () => {
    assert.strictEqual(
      resolvePortFilePath(".nrepl-port", dir),
      path.join(dir, ".nrepl-port"),
    );
    assert.strictEqual(resolvePortFilePath(7888, dir), undefined);
  });
});
