/**
 * REST-Helfer für den Game-Server (Fastify).
 * Endpunkte: GET /lobbies, POST /auth/nonce, POST /auth/verify, GET /settlements.
 */
import { SERVER_URL } from "./constants";

export interface LobbySummary {
  lobbyId: string;
  entryFeeLamports: number;
  potLamports: number;
  playersJoined: number;
  size: number;
  status: string;
}

export interface SettlementInfo {
  lobbyId: string;
  potLamports: number;
  feeLamports: number;
  winners: string[];
  payoutLamports: number;
  txSig: string;
  settledAt?: number;
}

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${SERVER_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function parseLobby(raw: unknown): LobbySummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const size = asNumber(pick(o, "size", "maxPlayers"), 5);
  const entry = asNumber(pick(o, "entryFeeLamports", "entryFee", "entry_fee"));
  const joined = asNumber(pick(o, "playersJoined", "joined", "playerCount"));
  return {
    lobbyId: asString(pick(o, "lobbyId", "id", "lobby_id")),
    entryFeeLamports: entry,
    potLamports: asNumber(pick(o, "potLamports", "pot"), entry * joined),
    playersJoined: joined,
    size,
    status: asString(pick(o, "status"), "open"),
  };
}

/** Offene Lobbies vom Server. */
export async function fetchLobbies(): Promise<LobbySummary[]> {
  const data = await getJson("/lobbies");
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.lobbies)
      ? ((data as Record<string, unknown>).lobbies as unknown[])
      : [];
  return arr.map(parseLobby).filter((l): l is LobbySummary => l !== null && l.lobbyId !== "");
}

/** Schritt 1 Login: Nonce vom Server holen. */
export async function requestNonce(wallet: string): Promise<string> {
  const data = (await postJson("/auth/nonce", { wallet })) as Record<string, unknown>;
  const nonce = asString(pick(data, "nonce"));
  if (!nonce) throw new Error("Server lieferte keine Nonce.");
  return nonce;
}

/** Nachricht, die die Wallet signiert (muss exakt zum Server passen). */
export function loginMessage(nonce: string): string {
  return `ZAPF ROYALE LOGIN ${nonce}`;
}

/** Schritt 2 Login: Signatur (bs58) verifizieren, Session-Token erhalten. */
export async function verifyLogin(
  wallet: string,
  nonce: string,
  signatureBs58: string,
): Promise<string> {
  const data = (await postJson("/auth/verify", {
    wallet,
    nonce,
    signature: signatureBs58,
  })) as Record<string, unknown>;
  const token = asString(pick(data, "token"));
  if (!token) throw new Error("Login fehlgeschlagen (kein Token).");
  return token;
}

/** Letzte Settlements (für /stats). Fehlt der Endpunkt, leere Liste. */
export async function fetchRecentSettlements(): Promise<SettlementInfo[]> {
  try {
    const data = await getJson("/settlements");
    const arr = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.settlements)
        ? ((data as Record<string, unknown>).settlements as unknown[])
        : [];
    return arr.flatMap((raw): SettlementInfo[] => {
      if (typeof raw !== "object" || raw === null) return [];
      const o = raw as Record<string, unknown>;
      const winners = Array.isArray(o.winners)
        ? o.winners.map((w) => asString(w)).filter(Boolean)
        : [];
      return [
        {
          lobbyId: asString(pick(o, "lobbyId", "id", "lobby_id")),
          potLamports: asNumber(pick(o, "potLamports", "pot")),
          feeLamports: asNumber(pick(o, "feeLamports", "fee")),
          winners,
          payoutLamports: asNumber(pick(o, "payoutLamports", "payout")),
          txSig: asString(pick(o, "txSig", "signature", "tx")),
          settledAt: asNumber(pick(o, "settledAt", "timestamp"), 0) || undefined,
        },
      ];
    });
  } catch {
    return [];
  }
}
