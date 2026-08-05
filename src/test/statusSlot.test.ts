import * as assert from "assert";
import { createStatusSlot, StatusSlot, StatusSlotView } from "../repl/statusSlot";

function view(text: string, overrides: Partial<StatusSlotView> = {}): StatusSlotView {
  return {
    text,
    tooltip: `tip: ${text}`,
    command: "clojurePulse.showReplOutput",
    ...overrides,
  };
}

suite("StatusSlot", () => {
  let slot: StatusSlot;

  setup(() => {
    slot = createStatusSlot({ name: "Test Slot", priority: 98 });
  });

  teardown(() => {
    slot.dispose();
  });

  test("show renders the view and returns a token", () => {
    slot.show(view("running"));
    assert.deepStrictEqual(slot.current(), view("running"));
  });

  test("update with the current token re-renders", () => {
    const token = slot.show(view("running"));
    slot.update(token, view("done", { color: "testing.iconPassed" }));
    assert.deepStrictEqual(
      slot.current(),
      view("done", { color: "testing.iconPassed" }),
    );
  });

  test("a second show supersedes the first, whoever issued it", () => {
    const stale = slot.show(view("first"));
    slot.show(view("second"));
    slot.update(stale, view("first done"));
    assert.strictEqual(slot.current()?.text, "second");
    slot.clear(stale);
    assert.strictEqual(slot.current()?.text, "second");
  });

  test("update and clear for a fresh token still work after a stale one", () => {
    const stale = slot.show(view("old"));
    const fresh = slot.show(view("new"));
    slot.update(stale, view("old done"));
    slot.update(fresh, view("new done", { backgroundColor: "statusBarItem.errorBackground" }));
    assert.deepStrictEqual(
      slot.current(),
      view("new done", { backgroundColor: "statusBarItem.errorBackground" }),
    );
  });

  test("clear with the current token hides the item", () => {
    const token = slot.show(view("running"));
    slot.clear(token);
    assert.strictEqual(slot.current(), undefined);
  });

  test("dispose is idempotent", () => {
    slot.show(view("running"));
    slot.dispose();
    slot.dispose();
  });
});
