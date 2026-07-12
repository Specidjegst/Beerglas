import { describe, expect, it } from "vitest";
import { computeWinners, splitPot, type ResultEntry } from "../src/game/simulation.js";

const r = (
  player: string,
  pouredMl: number,
  submissionIndex: number,
  overflow = false,
): ResultEntry => ({ player, pouredMl, overflow, submissionIndex });

describe("computeWinners", () => {
  it("picks the single closest pour", () => {
    const { winners, bestScore } = computeWinners(
      [r("A", 995, 0), r("B", 1030, 1), r("C", 890, 2), r("D", 0, 3), r("E", 1100, 4)],
      1000,
    );
    expect(winners.map((w) => w.player)).toEqual(["A"]);
    expect(bestScore).toBe(5);
  });

  it("splits a 2-way tie, ordered by submissionIndex (earliest first)", () => {
    const { winners, bestScore } = computeWinners(
      [r("A", 1010, 3), r("B", 990, 1), r("C", 900, 0)],
      1000,
    );
    expect(bestScore).toBe(10);
    // B submitted earlier (index 1) than A (index 3) -> B first (gets remainder)
    expect(winners.map((w) => w.player)).toEqual(["B", "A"]);
  });

  it("ranks overflow as the worst result", () => {
    const { winners } = computeWinners(
      [r("A", 1499, 0, true), r("B", 0, 1), r("C", 700, 2)],
      1500,
    );
    // A hit 1499 but overflowed -> worst; B is 1500 off, C is 800 off -> C wins
    expect(winners.map((w) => w.player)).toEqual(["C"]);
  });

  it("makes everyone a winner if all overflow", () => {
    const { winners } = computeWinners([r("A", 0, 1, true), r("B", 0, 0, true)], 500);
    expect(winners.map((w) => w.player)).toEqual(["B", "A"]);
  });
});

describe("splitPot", () => {
  it("splits evenly after the fee when divisible", () => {
    const winners = [r("A", 1000, 0), r("B", 1000, 1)];
    const split = splitPot(500_000_000n, winners);
    expect(split.feeLamports).toBe(20_000_000n);
    expect(split.payouts).toEqual([
      { player: "A", lamports: 240_000_000n },
      { player: "B", lamports: 240_000_000n },
    ]);
    // conservation: fee + payouts == pot
    const total = split.feeLamports + split.payouts.reduce((s, p) => s + p.lamports, 0n);
    expect(total).toBe(500_000_000n);
  });

  it("gives the integer remainder to the earliest submissionIndex", () => {
    // computeWinners returns winners sorted by submissionIndex; B(idx 0) first.
    const { winners } = computeWinners([r("A", 990, 1), r("B", 1010, 0)], 1000);
    const split = splitPot(10_001n, winners);
    expect(split.feeLamports).toBe(400n); // 10001 * 400 / 10000 floored
    // distributable 9601 -> share 4800, remainder 1 to B (earliest)
    expect(split.payouts).toEqual([
      { player: "B", lamports: 4_801n },
      { player: "A", lamports: 4_800n },
    ]);
    const total = split.feeLamports + split.payouts.reduce((s, p) => s + p.lamports, 0n);
    expect(total).toBe(10_001n);
  });

  it("pays a single winner the full pot minus fee", () => {
    const split = splitPot(250_000_000n, [r("X", 500, 4)]);
    expect(split.feeLamports).toBe(10_000_000n);
    expect(split.payouts).toEqual([{ player: "X", lamports: 240_000_000n }]);
  });
});
