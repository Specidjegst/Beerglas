import { describe, expect, it } from "vitest";
import { feeOf } from "../src/game/simulation.js";
import { FEE_BPS } from "../src/game/constants.js";

describe("operator fee (4% = 400 bps, exact lamport integers)", () => {
  it("uses 400 bps", () => {
    expect(FEE_BPS).toBe(400);
  });

  it("is exactly 4% for divisible pots", () => {
    // 5 players x 0.05 SOL
    expect(feeOf(250_000_000n)).toBe(10_000_000n);
    // 5 players x 0.1 SOL
    expect(feeOf(500_000_000n)).toBe(20_000_000n);
    // 5 players x 0.5 SOL
    expect(feeOf(2_500_000_000n)).toBe(100_000_000n);
  });

  it("floors on non-divisible pots (integer division, no rounding up)", () => {
    expect(feeOf(1n)).toBe(0n); // 0.04 lamports -> 0
    expect(feeOf(24n)).toBe(0n); // 0.96 -> 0
    expect(feeOf(25n)).toBe(1n); // exactly 1
    expect(feeOf(10_001n)).toBe(400n); // 400.04 -> 400
    expect(feeOf(1_000_000_001n)).toBe(40_000_000n);
  });

  it("matches pot * 400 / 10000 for arbitrary values", () => {
    const pots = [3n, 999n, 123_456_789n, 987_654_321_012n];
    for (const pot of pots) {
      expect(feeOf(pot)).toBe((pot * 400n) / 10_000n);
    }
  });
});
