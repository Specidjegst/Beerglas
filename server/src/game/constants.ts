/**
 * Shared game constants for ZAPF ROYALE.
 *
 * These MUST stay in sync with the on-chain program (`program/`) and the
 * frontend (`web/`). The server is the authority for the pour simulation;
 * the frontend render is purely cosmetic.
 */

/** Glass capacity in ml (1.6 L Masskrug). */
export const CAPACITY_ML = 1600;

/** The three etched marks; the round target is always one of these. */
export const MARKS_ML = [500, 1000, 1500] as const;

/** Base pour rate in ml/s. Effective rate = BASE_RATE_ML_S * pressure. */
export const BASE_RATE_ML_S = 520;

/** Foam growth base in ml/s. Effective foam rate = FOAM_RATE_BASE * pressure^FOAM_PRESSURE_EXP. */
export const FOAM_RATE_BASE = 34;
export const FOAM_PRESSURE_EXP = 1.6;

/** Overflow rule: fill + FOAM_OVERFLOW_WEIGHT * foam >= CAPACITY_ML * OVERFLOW_FACTOR. */
export const FOAM_OVERFLOW_WEIGHT = 0.7;
export const OVERFLOW_FACTOR = 1.01;
export const OVERFLOW_THRESHOLD_ML = CAPACITY_ML * OVERFLOW_FACTOR; // 1616

/** Keg pressure bounds (derived from the VRF randomness). */
export const PRESSURE_MIN = 0.8;
export const PRESSURE_MAX = 1.3;

/**
 * Integer pressure representation (thousandths), as stored on-chain:
 * pressure_milli = 800 + floor(u16le(randomness, 1) * 500 / 65535).
 */
export const PRESSURE_MILLI_MIN = 800;
export const PRESSURE_MILLI_SPAN = 500;

/** A player has this long after join confirmation to complete their single pour. */
export const PLAY_TIMEOUT_MS = 60_000;

/** Default lobby size (configurable; MVP = 5). */
export const LOBBY_SIZE = 5;

/** After this many seconds an unfilled lobby becomes cancellable (full refunds). */
export const CANCEL_AFTER_S = 86_400;

/** Reported as poured_ml on-chain when a player overflows (u32::MAX). */
export const OVERFLOW_SENTINEL = 0xffffffff;

/** Operator fee in basis points (4% of the pot, taken at settlement). */
export const FEE_BPS = 400;

/** Message prefix signed by wallets during nonce login. */
export const LOGIN_MESSAGE_PREFIX = "ZAPF ROYALE LOGIN ";

/**
 * Sanity bound for a pour session: a pour can never meaningfully last longer
 * than the analytic overflow time; we allow this extra buffer for latency.
 */
export const POUR_STOP_GRACE_MS = 500;
