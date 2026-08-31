import * as assert from "assert";
import { configuredValue } from "../configValue";

suite("configuredValue", () => {
  test("an untouched setting reads as undefined", () => {
    // The contributed default must never be sent as an explicit override:
    // the server merges the editor layer over .clj-pulse/config.edn, so a
    // default would silently beat the project file.
    assert.strictEqual(configuredValue<boolean>({}), undefined);
    assert.strictEqual(configuredValue<boolean>(undefined), undefined);
  });

  test("a user-set value is returned, including a falsy one", () => {
    assert.strictEqual(configuredValue<boolean>({ globalValue: false }), false);
    assert.strictEqual(configuredValue<string>({ globalValue: "" }), "");
  });

  test("narrower scopes win over wider ones", () => {
    assert.strictEqual(
      configuredValue<string>({ globalValue: "g", workspaceValue: "w" }),
      "w",
    );
    assert.strictEqual(
      configuredValue<string>({
        globalValue: "g",
        workspaceValue: "w",
        workspaceFolderValue: "f",
      }),
      "f",
    );
  });

  test("a language-specific value wins within the same scope", () => {
    assert.strictEqual(
      configuredValue<string>({ workspaceValue: "w", workspaceLanguageValue: "wl" }),
      "wl",
    );
  });
});
