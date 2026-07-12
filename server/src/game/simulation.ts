/**
 * Pure, deterministic pour simulation + winner logic.
 *
 * All rates are constant for a given pressure, so the overflow moment can be
 * computed analytically instead of by stepping a clock. The same scoring and
 * winner/tie/remainder rules are implemented on-chain in `program/`; this
 * copy exists for display, pre-checks and tests and MUST stay identical.
 */

import {
  BASE_RATE_ML_S,
  FEE_BPS,
  FOAM_OVERFLOW_WEIGHT,
  FOAM_PRESSURE_EXP,
  FOAM_RATE_BASE,
  OVERFLOW_SENTINEL,
  OVERFLOW_THRESHOLD_ML,
} from "./constants.js";

export interface PourOutcome {
  /** Beer poured in ml (integer, capped at the overflow moment). */
  pouredMl: number;
  /** Foam in ml (integer, capped at the overflow moment). */
  foamMl: number;
  overflow: boolean;
}

/** Effective beer rate in ml/s for a given keg pressure. */
export function pourRateMlS(pressure: number): number {
  return BASE_RATE_ML_S * pressure;
}

/** Effective foam growth rate in ml/s for a given keg pressure. */
export function foamRateMlS(pressure: number): number {
  return FOAM_RATE_BASE * Math.pow(pressure, FOAM_PRESSURE_EXP);
}

/**
 * Exact time (in ms) at which `fill + 0.7 * foam` reaches the overflow
 * threshold. Rates are constant, so this is a simple division.
 */
export function overflowTimeMs(pressure: number): number {
  const effectiveRate = pourRateMlS(pressure) + FOAM_OVERFLOW_WEIGHT * foamRateMlS(pressure);
  return (OVERFLOW_THRESHOLD_ML / effectiveRate) * 1000;
}

/**
 * Simulate a single pour of `durationMs` at `pressure`.
 * If the duration reaches or exceeds the analytic overflow time, the attempt
 * ends exactly at the overflow moment and is flagged as overflow.
 */
export function simulatePour(pressure: number, durationMs: number): PourOutcome {
  const safeDuration = Math.max(0, durationMs);
  const tOverflowMs = overflowTimeMs(pressure);
  const overflow = safeDuration >= tOverflowMs;
  const effectiveSeconds = (overflow ? tOverflowMs : safeDuration) / 1000;
  return {
    pouredMl: Math.round(pourRateMlS(pressure) * effectiveSeconds),
    foamMl: Math.round(foamRateMlS(pressure) * effectiveSeconds),
    overflow,
  };
}

/**
 * Score = |poured - target|, lower is better. Overflow is the worst possible
 * score (matches the on-chain treatment of OVERFLOW_SENTINEL).
 */
export function scoreOf(pouredMl: number, targetMl: number, overflow: boolean): number {
  if (overflow || pouredMl === OVERFLOW_SENTINEL) return OVERFLOW_SENTINEL;
  return Math.abs(pouredMl - targetMl);
}

export interface ResultEntry {
  player: string;
  /** Raw poured ml (not the sentinel; use `overflow` for overflow attempts). */
  pouredMl: number;
  overflow: boolean;
  /** 0-based order in which the result was submitted (tie remainder goes to the smallest). */
  submissionIndex: number;
}

export interface WinnersResult {
  /** All players sharing the best score, sorted by submissionIndex ascending. */
  winners: ResultEntry[];
  bestScore: number;
}

/**
 * Compute the winner set: lowest score wins; ties share the win. Winners are
 * returned sorted by submissionIndex so that index 0 receives any lamport
 * remainder of the split — identical to the on-chain rule.
 */
export function computeWinners(results: ResultEntry[], targetMl: number): WinnersResult {
  if (results.length === 0) throw new Error("computeWinners: empty results");
  let bestScore = Number.POSITIVE_INFINITY;
  for (const r of results) {
    const s = scoreOf(r.pouredMl, targetMl, r.overflow);
    if (s < bestScore) bestScore = s;
  }
  const winners = results
    .filter((r) => scoreOf(r.pouredMl, targetMl, r.overflow) === bestScore)
    .sort((a, b) => a.submissionIndex - b.submissionIndex);
  return { winners, bestScore };
}

/** Exact integer fee in lamports: pot * feeBps / 10_000 (floor). */
export function feeOf(potLamports: bigint, feeBps: number = FEE_BPS): bigint {
  return (potLamports * BigInt(feeBps)) / 10_000n;
}

export interface PotSplit {
  feeLamports: bigint;
  /** Base share per winner (floor of the even split). */
  shareLamports: bigint;
  /** Aligned with `winners` input order; remainder already added to the first entry. */
  payouts: { player: string; lamports: bigint }[];
}

/**
 * Split the pot: fee first (exact bps, floor), then an even split among the
 * winners. The integer remainder goes to the winner with the smallest
 * submissionIndex — callers must pass winners sorted by submissionIndex
 * (as returned by computeWinners).
 */
export function splitPot(
  potLamports: bigint,
  winners: ResultEntry[],
  feeBps: number = FEE_BPS,
): PotSplit {
  if (winners.length === 0) throw new Error("splitPot: no winners");
  const feeLamports = feeOf(potLamports, feeBps);
  const distributable = potLamports - feeLamports;
  const n = BigInt(winners.length);
  const share = distributable / n;
  const remainder = distributable - share * n;
  const payouts = winners.map((w, i) => ({
    player: w.player,
    lamports: i === 0 ? share + remainder : share,
  }));
  return { feeLamports, shareLamports: share, payouts };
}
