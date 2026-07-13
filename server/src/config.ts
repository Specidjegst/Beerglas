/** ENV-based server configuration. See .env.example for all variables. */

import { randomBytes } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { LOBBY_SIZE } from "./game/constants.js";

export type ChainMode = "anchor" | "mock";

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  chain: ChainMode;
  rpcUrl: string;
  programId: string;
  resultAuthority: Keypair;
  treasury: PublicKey | null;
  /** MagicBlock Ephemeral VRF oracle queue (ENV ORACLE_QUEUE; devnet default). */
  oracleQueue: PublicKey;
  lobbySize: number;
  /** Demo-Bots pro Lobby (füllen freie Plätze, sobald ein Mensch joint).
   *  Wird nur im Mock-Modus wirksam — Bots zahlen keine echte Entry Fee. */
  bots: number;
  defaultEntryFeeLamports: bigint;
  authSecret: Buffer;
}

/** MagicBlock default oracle queue on devnet. */
export const DEFAULT_ORACLE_QUEUE = "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb";

/** Accepts a solana-keygen JSON array or a base58-encoded 64-byte secret key. */
export function parseKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const chain: ChainMode = env.CHAIN === "anchor" ? "anchor" : "mock";

  let resultAuthority: Keypair;
  if (env.RESULT_AUTHORITY_KEYPAIR && env.RESULT_AUTHORITY_KEYPAIR.trim() !== "") {
    resultAuthority = parseKeypair(env.RESULT_AUTHORITY_KEYPAIR);
  } else if (chain === "mock") {
    resultAuthority = Keypair.generate(); // ephemeral, offline dev only
  } else {
    throw new Error("RESULT_AUTHORITY_KEYPAIR is required when CHAIN=anchor");
  }

  let treasury: PublicKey | null = null;
  if (env.TREASURY && env.TREASURY.trim() !== "") {
    treasury = new PublicKey(env.TREASURY.trim());
  } else if (chain === "anchor") {
    throw new Error("TREASURY is required when CHAIN=anchor");
  }

  if (chain === "anchor" && (!env.PROGRAM_ID || env.PROGRAM_ID.trim() === "")) {
    throw new Error("PROGRAM_ID is required when CHAIN=anchor");
  }

  // Testphase: im Mock-Modus standardmäßig 2 Bots (ENV BOTS überschreibt;
  // BOTS=0 schaltet sie aus). Auf anchor immer 0 — Bots zahlen keine Fee.
  const bots = chain === "mock" ? Math.max(0, Number(env.BOTS ?? 2) || 0) : 0;
  // Mit Bots braucht es eine echte Wettbewerbs-Lobby: mindestens bots+1
  // Plätze, sonst wäre der einzige menschliche Spieler immer der Sieger.
  const lobbySize = Math.max(Number(env.LOBBY_SIZE ?? LOBBY_SIZE), bots > 0 ? bots + 1 : 1);

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? "./data",
    chain,
    rpcUrl: env.RPC_URL ?? "https://api.devnet.solana.com",
    programId: env.PROGRAM_ID ?? "Zapf1111111111111111111111111111111111111111",
    resultAuthority,
    treasury,
    oracleQueue: new PublicKey(
      env.ORACLE_QUEUE && env.ORACLE_QUEUE.trim() !== ""
        ? env.ORACLE_QUEUE.trim()
        : DEFAULT_ORACLE_QUEUE,
    ),
    lobbySize,
    bots,
    defaultEntryFeeLamports: BigInt(env.DEFAULT_ENTRY_FEE_LAMPORTS ?? "50000000"),
    authSecret:
      env.AUTH_SECRET && env.AUTH_SECRET.trim() !== ""
        ? Buffer.from(env.AUTH_SECRET, "utf8")
        : randomBytes(32),
  };
}
