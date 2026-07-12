import { describe, expect, it } from "vitest";
import {
  foamRateMlS,
  overflowTimeMs,
  pourRateMlS,
  scoreOf,
  simulatePour,
} from "../src/game/simulation.js";
import {
  BASE_RATE_ML_S,
  FOAM_OVERFLOW_WEIGHT,
  OVERFLOW_SENTINEL,
  OVERFLOW_THRESHOLD_ML,
} from "../src/game/constants.js";

describe("pour rates", () => {
  it("pours 520 ml in 1 s at pressure 1.0", () => {
    const r = simulatePour(1.0, 1000);
    expect(r.pouredMl).toBe(520);
    expect(r.foamMl).toBe(34);
    expect(r.overflow).toBe(false);
  });

  it("scales pour rate linearly with pressure", () => {
    expect(pourRateMlS(1.3)).toBeCloseTo(676, 10);
    expect(pourRateMlS(0.8)).toBeCloseTo(416, 10);
    const r = simulatePour(1.25, 2000);
    expect(r.pouredMl).toBe(1300); // 650 ml/s * 2 s
  });

  it("foam grows with pressure^1.6", () => {
    expect(foamRateMlS(1.0)).toBeCloseTo(34, 10);
    expect(foamRateMlS(1.25)).toBeCloseTo(34 * Math.pow(1.25, 1.6), 10);
  });
});

describe("overflow", () => {
  it("computes the exact analytic overflow time", () => {
    const p = 1.0;
    const effective = BASE_RATE_ML_S * p + FOAM_OVERFLOW_WEIGHT * foamRateMlS(p);
    expect(overflowTimeMs(p)).toBeCloseTo((OVERFLOW_THRESHOLD_ML / effective) * 1000, 6);
    // sanity: at pressure 1.0 that's roughly 2.97 s
    expect(overflowTimeMs(1.0)).toBeGreaterThan(2900);
    expect(overflowTimeMs(1.0)).toBeLessThan(3050);
  });

  it("does not overflow just below the overflow time, does at/after it", () => {
    const p = 1.1;
    const t = overflowTimeMs(p);
    expect(simulatePour(p, t - 1).overflow).toBe(false);
    expect(simulatePour(p, t).overflow).toBe(true);
    expect(simulatePour(p, t + 5000).overflow).toBe(true);
  });

  it("caps the result exactly at the overflow moment", () => {
    const p = 0.95;
    const t = overflowTimeMs(p);
    const atOverflow = simulatePour(p, t);
    const wayAfter = simulatePour(p, t + 60_000);
    expect(atOverflow).toEqual(wayAfter);
    expect(atOverflow.pouredMl).toBe(Math.round(pourRateMlS(p) * (t / 1000)));
    expect(atOverflow.foamMl).toBe(Math.round(foamRateMlS(p) * (t / 1000)));
    // fill + 0.7 * foam sits on the threshold (up to integer rounding)
    const level = atOverflow.pouredMl + FOAM_OVERFLOW_WEIGHT * atOverflow.foamMl;
    expect(Math.abs(level - OVERFLOW_THRESHOLD_ML)).toBeLessThan(1.5);
  });

  it("clamps negative durations to zero", () => {
    expect(simulatePour(1.0, -50)).toEqual({ pouredMl: 0, foamMl: 0, overflow: false });
  });
});

describe("scoreOf", () => {
  it("is the absolute distance to the target", () => {
    expect(scoreOf(1000, 1000, false)).toBe(0);
    expect(scoreOf(970, 1000, false)).toBe(30);
    expect(scoreOf(1030, 1000, false)).toBe(30);
  });

  it("treats overflow as the worst possible score", () => {
    expect(scoreOf(1000, 1000, true)).toBe(OVERFLOW_SENTINEL);
    expect(scoreOf(OVERFLOW_SENTINEL, 1000, false)).toBe(OVERFLOW_SENTINEL);
  });
});
