/** Shared server-side types: persisted records, public states, WS protocol. */

export type LobbyStatus = "awaiting_randomness" | "open" | "settling" | "settled" | "cancelled";

/** Player lifecycle after a confirmed join. */
export type PlayerStatus = "playing" | "done";

/** Public (German) status labels used in lobby_state broadcasts. */
export type PlayerPublicStatus = "wartet" | "spielt" | "fertig";

export interface PlayerRecord {
  wallet: string;
  /** Server-gesteuerter Demo-Mitspieler (nur CHAIN=mock). */
  isBot?: boolean;
  joinTxSig: string;
  /** Server clock (ms) when the join tx was confirmed; the 60s timer starts here. */
  joinConfirmedAt: number;
  /** joinConfirmedAt + playTimeoutMs; persisted so timers survive restarts. */
  deadlineTs: number;
  status: PlayerStatus;
  /** Raw poured ml (not the sentinel). Present once status === "done". */
  pouredMl?: number;
  overflow?: boolean;
  /** 0-based submit order within the lobby; tie remainder goes to the smallest. */
  submissionIndex?: number;
  submitTxSig?: string | null;
  timedOut?: boolean;
}

export interface SettlementInfo {
  txSig: string;
  winners: string[];
  /** Base share per winner in lamports (decimal string). */
  payoutLamports: string;
  payouts: { wallet: string; lamports: string }[];
  feeLamports: string;
  potLamports: string;
  /** VRF randomness of the round (hex, 32 bytes) — public, verifiable on-chain. */
  randomnessHex: string;
}

export interface LobbyRecord {
  /** u64 as decimal string. */
  lobbyId: string;
  size: number;
  /** Lamports as decimal string. */
  entryFeeLamports: string;
  status: LobbyStatus;
  /** Public request entropy sent with create_lobby (VRF caller_seed input). NOT secret. */
  clientSeedHex: string;
  /** Oracle randomness (hex, 32 bytes) once fulfill_round landed; null while awaiting. */
  randomnessHex: string | null;
  /** 0 until the VRF callback fulfilled the round. */
  targetMl: number;
  /** Integer pressure in thousandths (800..=1300); 0 until fulfilled. */
  pressureMilli: number;
  createdAt: number;
  createTxSig: string;
  players: PlayerRecord[];
  settlement?: SettlementInfo;
  cancelTxSig?: string;
}

export interface LobbyStoreData {
  lobbies: LobbyRecord[];
}

/** What watchers may see. No target/pressure, and no results while the lobby is live. */
export interface LobbyPublicState {
  lobbyId: string;
  size: number;
  entryFeeLamports: string;
  potLamports: string;
  seatsFilled: number;
  status: LobbyStatus;
  createdAt: number;
  players: {
    wallet: string;
    /** Server-gesteuerter Demo-Mitspieler (UI zeigt "BOT"-Label). */
    isBot: boolean;
    status: PlayerPublicStatus;
    /** Only revealed after settlement (sentinel for overflow). */
    pouredMl: number | null;
  }[];
  /** VRF randomness (hex); only exposed after settlement, like the results. */
  randomnessHex: string | null;
}

export interface RoundConfigMessagePayload {
  lobbyId: string;
  targetMl: number;
  pressure: number;
  deadlineTs: number;
}

// ---------------------------------------------------------------------------
// WebSocket protocol (JSON messages)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "hello"; token: string }
  | { type: "watch_lobby"; lobbyId: string }
  | { type: "join_lobby"; lobbyId: string; txSig: string }
  | { type: "pour_start" }
  | { type: "pour_stop" };

export type ServerMessage =
  | { type: "hello_ack"; wallet: string }
  | { type: "lobby_state"; lobby: LobbyPublicState }
  | ({ type: "round_config" } & RoundConfigMessagePayload)
  | { type: "pour_ack"; startedAt: number }
  | { type: "pour_result"; pouredMl: number; foamMl: number; overflow: boolean; score: number }
  | {
      type: "settled";
      lobbyId: string;
      winners: string[];
      payoutLamports: string;
      payouts: { wallet: string; lamports: string }[];
      feeLamports: string;
      txSig: string;
      /** VRF randomness of the round as hex string. */
      randomness: string;
    }
  | { type: "error"; code: string; message: string };
