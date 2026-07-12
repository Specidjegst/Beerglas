import { describe, expect, it } from "vitest";
import { deriveRound, fromHex, generateClientSeed, toHex } from "../src/game/fairness.js";

/** 32-byte randomness with the first three bytes set (rest zero). */
const rnd = (b0: number, b1 = 0, b2 = 0): Uint8Array => {
  const r = new Uint8Array(32);
  r[0] = b0;
  r[1] = b1;
  r[2] = b2;
  return r;
};

describe("deriveRound (VRF randomness -> round parameters)", () => {
  it("maps randomness[0] % 3 onto the three marks", () => {
    expect(deriveRound(rnd(0)).targetMl).toBe(500);
    expect(deriveRound(rnd(1)).targetMl).toBe(1000);
    expect(deriveRound(rnd(2)).targetMl).toBe(1500);
    expect(deriveRound(rnd(3)).targetMl).toBe(500);
    expect(deriveRound(rnd(255)).targetMl).toBe(500); // 255 % 3 == 0
  });

  it("yields pressure_milli = 800 at raw = 0", () => {
    const round = deriveRound(rnd(0, 0x00, 0x00));
    expect(round.pressureMilli).toBe(800);
    expect(round.pressure).toBe(0.8);
  });

  it("yields pressure_milli = 1300 at raw = 65535", () => {
    const round = deriveRound(rnd(0, 0xff, 0xff));
    expect(round.pressureMilli).toBe(1300);
    expect(round.pressure).toBe(1.3);
  });

  it("reads raw as u16 little-endian from bytes 1..3 and floors the scaling", () => {
    // raw = 0x1234 = 4660 -> 800 + floor(4660 * 500 / 65535) = 800 + 35 = 835
    expect(deriveRound(rnd(0, 0x34, 0x12)).pressureMilli).toBe(835);
    // raw = 0x8000 = 32768 -> 800 + floor(32768 * 500 / 65535) = 800 + 250 = 1050
    expect(deriveRound(rnd(0, 0x00, 0x80)).pressureMilli).toBe(1050);
  });

  it("always produces an integer pressure_milli in 800..=1300 (pressure = milli/1000)", () => {
    for (let i = 0; i < 200; i++) {
      const round = deriveRound(generateClientSeed()); // any 32 random bytes
      expect(Number.isInteger(round.pressureMilli)).toBe(true);
      expect(round.pressureMilli).toBeGreaterThanOrEqual(800);
      expect(round.pressureMilli).toBeLessThanOrEqual(1300);
      expect(round.pressure).toBe(round.pressureMilli / 1000);
      expect([500, 1000, 1500]).toContain(round.targetMl);
    }
  });

  it("ignores bytes 3..32 entirely", () => {
    const a = rnd(1, 0x42, 0x17);
    const b = rnd(1, 0x42, 0x17);
    b.fill(0xaa, 3);
    expect(deriveRound(a)).toEqual(deriveRound(b));
  });

  it("rejects randomness that is not exactly 32 bytes", () => {
    expect(() => deriveRound(new Uint8Array(31))).toThrow();
    expect(() => deriveRound(new Uint8Array(33))).toThrow();
    expect(() => deriveRound(new Uint8Array(0))).toThrow();
  });
});

describe("hex helpers", () => {
  it("round-trips", () => {
    const bytes = generateClientSeed();
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(toHex(bytes)).toHaveLength(64);
  });
});
