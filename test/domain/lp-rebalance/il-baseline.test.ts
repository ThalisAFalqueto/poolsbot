import { describe, expect, it } from "vitest";
import { decideBaseline } from "../../../src/domain/lp-rebalance/il-baseline.js";

describe("decideBaseline", () => {
  it("sem baseline existente: create", () => {
    expect(decideBaseline(null, 1000n)).toBe("create");
  });

  it("liquidez igual à salva: keep", () => {
    expect(decideBaseline(1000n, 1000n)).toBe("keep");
  });

  it("liquidez diferente da salva (add/remove fora do bot): reset", () => {
    expect(decideBaseline(1000n, 2000n)).toBe("reset");
    expect(decideBaseline(2000n, 1000n)).toBe("reset");
  });
});
