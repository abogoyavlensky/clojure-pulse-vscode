import { defineConfig } from "@vscode/test-cli";

const mocha = {
  ui: "tdd",
  timeout: 20000,
};

export default defineConfig([
  {
    label: "unit",
    files: "out/test/**/*.test.js",
    mocha,
  },
  {
    // The jar end-to-end test is the one test that needs a workspace folder:
    // clj-pulse indexes the folders the client sends in `initialize` and
    // resolves their classpath, so with no folder open there is no classpath
    // and nothing to navigate into. The `unit` run above cannot exclude it —
    // `files` globs are unioned and `ignore` comes only from the CLI — so the
    // test skips itself there on the missing folder, and does its real work
    // here, where a project is open.
    label: "jar-e2e",
    files: "out/test/lspJar.e2e.test.js",
    workspaceFolder: "src/test/fixtures/jar-project",
    mocha,
  },
]);
