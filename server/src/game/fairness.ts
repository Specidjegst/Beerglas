/**
 * VRF fairness scheme (MagicBlock Ephemeral VRF).
 *
 * The randomness for a round is produced by the Ephemeral VRF oracle and
 * delivered to the program via a verified on-chain callback (fulfill_round).
 * The server holds NO secrets anymore: it only draws a public client_seed as
 * request entropy for create_lobby (mixed into the oracle's caller_seed) and
 * derives the round parameters from the fulfilled randomness with the same
 * formulas as the on-chain program and the frontend:
 *
 *   target_ml      = [500, 1000, 1500][randomness[0] % 3]
 *   raw            = randomness[1] | (randomness[2] << 8)      (u16 LE, bytes 1..3)
 *   pressure_milli = 800 + floor(raw * 500 / 65535)            (integer, 800..=1300)
 *   pressure       = pressure_milli / 1000
 *
 * This derivation MUST match program/ (Rust) and web/ (TS) exactly.
 */

import { randomBytes } from "node:crypto";
import { MARKS_ML, PRESSURE_MILLI_MIN, PRESSURE_MILLI_SPAN } from "./constants.js";

export interface RoundConfig {
  targetMl: number;
  /** Integer keg pressure in thousandths (800..=1300); on-chain representation. */
  pressureMilli: number;
  /** pressureMilli / 1000 — the value the simulation runs with. */
  pressure: number;
}

/**
 * Draw a fresh 32-byte client seed for the VRF request. This is pure request
 * entropy (part of the oracle's caller_seed): public, NOT secret and NOT
 * security-critical — the oracle's verified randomness is the fairness source.
 */
export function generateClientSeed(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** Deterministically derive the round parameters from the VRF randomness. */
export function deriveRound(randomness: Uint8Array): RoundConfig {
  if (randomness.length !== 32) throw new Error("randomness must be 32 bytes");
  const targetMl = MARKS_ML[randomness[0]! % MARKS_ML.length]!;
  const raw = randomness[1]! | (randomness[2]! << 8); // u16 little-endian
  const pressureMilli = PRESSURE_MILLI_MIN + Math.floor((raw * PRESSURE_MILLI_SPAN) / 65535);
  return { targetMl, pressureMilli, pressure: pressureMilli / 1000 };
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
