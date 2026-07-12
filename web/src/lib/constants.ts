/**
 * Gemeinsame Spielkonstanten — MÜSSEN exakt mit server/ (Autorität) und dem
 * On-Chain-Programm übereinstimmen. Der Client rendert nur kosmetisch,
 * der Server rechnet mit denselben Zahlen und liefert die Wahrheit.
 */

/** Krug-Kapazität in ml (1,6 L Maßkrug) */
export const CAPACITY_ML = 1600;

/** Die drei geätzten Marken (mögliche Ziele) in ml */
export const MARKS_ML = [500, 1000, 1500] as const;

/** Basis-Zapfrate in ml/s bei Druckfaktor 1.0 */
export const BASE_RATE_ML_S = 520;

/** Schaumwachstum: FOAM_BASE_ML_S * pressure^FOAM_PRESSURE_EXP in ml/s */
export const FOAM_BASE_ML_S = 34;
export const FOAM_PRESSURE_EXP = 1.6;

/** Überlauf, wenn fill + OVERFLOW_FOAM_FACTOR * foam >= OVERFLOW_THRESHOLD_ML */
export const OVERFLOW_FOAM_FACTOR = 0.7;
export const OVERFLOW_THRESHOLD_ML = 1616; // = CAPACITY_ML * 1.01

/** Druckfaktor-Spanne (deterministisch aus der VRF-Randomness, Bytes 1–2) */
export const PRESSURE_MIN = 0.8;
export const PRESSURE_MAX = 1.3;

/** Spielzeit ab Join-Bestätigung: genau 60 s für den einen Versuch */
export const PLAY_TIMEOUT_S = 60;

/** Lobby-Größe (MVP; konfigurierbar im Programm) */
export const LOBBY_SIZE = 5;

/** Operator-Fee in Basispunkten (4 %) — nur Anzeige, Wahrheit liegt on-chain */
export const FEE_BPS = 400;

export const LAMPORTS_PER_SOL = 1_000_000_000;

// ── ENV ──────────────────────────────────────────────────────────────────────

export const SERVER_URL: string =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8787";

export const RPC_URL: string =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

export const PROGRAM_ID_STR: string =
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? "11111111111111111111111111111111";

/** WebSocket-URL des Game-Servers, aus SERVER_URL abgeleitet (http→ws). */
export function wsUrl(): string {
  return SERVER_URL.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws";
}

/** Explorer-Link (devnet) für Adresse oder Tx-Signatur. */
export function explorerUrl(kind: "address" | "tx", value: string): string {
  return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
}
