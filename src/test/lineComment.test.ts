import * as assert from "assert";
import {
  createLineCommentApplier,
  LineCommentToken,
  lineCommentToken,
} from "../lineComment";

/** A `register` seam that records the tokens it saw and counts disposes. */
function recorder(): {
  register: (token: LineCommentToken) => { dispose(): void };
  tokens: LineCommentToken[];
  disposes: number[];
} {
  const tokens: LineCommentToken[] = [];
  const disposes: number[] = [];
  return {
    tokens,
    disposes,
    register: (token) => {
      const index = tokens.push(token) - 1;
      disposes.push(0);
      return {
        dispose: () => {
          disposes[index] += 1;
        },
      };
    },
  };
}

suite("lineComment", () => {
  test("the setting maps to a token, defaulting anything else to \";\"", () => {
    assert.strictEqual(lineCommentToken(";"), ";");
    assert.strictEqual(lineCommentToken(";;"), ";;");
    assert.strictEqual(lineCommentToken(undefined), ";");
    assert.strictEqual(lineCommentToken(";;;"), ";");
    assert.strictEqual(lineCommentToken(42), ";");
  });

  test("the default token registers nothing", () => {
    const { register, tokens } = recorder();
    createLineCommentApplier(register).apply(";");
    assert.deepStrictEqual(tokens, []);
  });

  test("a non-default token registers once", () => {
    const { register, tokens } = recorder();
    createLineCommentApplier(register).apply(";;");
    assert.deepStrictEqual(tokens, [";;"]);
  });

  test("changing the token disposes the earlier registration", () => {
    const { register, tokens, disposes } = recorder();
    const applier = createLineCommentApplier(register);
    applier.apply(";;");
    applier.apply(";");
    assert.deepStrictEqual(tokens, [";;"]);
    assert.deepStrictEqual(disposes, [1]);
    applier.apply(";;");
    assert.deepStrictEqual(tokens, [";;", ";;"]);
    assert.deepStrictEqual(disposes, [1, 0]);
  });

  test("dispose drops the active registration", () => {
    const { register, disposes } = recorder();
    const applier = createLineCommentApplier(register);
    applier.apply(";;");
    applier.dispose();
    assert.deepStrictEqual(disposes, [1]);
  });
});
