/**
 * LobbyManager — authoritative lobby lifecycle.
 *
 * create (create_lobby ix requests VRF randomness on-chain) -> awaiting_randomness
 * -> oracle callback fulfill_round lands (waitForRoundFulfilled) -> open ->
 * players join on-chain themselves, server confirms the join tx -> each
 * confirmed player has PLAY_TIMEOUT_MS to pour (timer persisted; re-armed on
 * boot; expired timers submit pouredMl=0) -> when size players have joined AND
 * all have a result, settlement runs automatically (program uses the
 * VRF-derived target). Unfilled lobbies become cancellable after CANCEL_AFTER_S
 * (also lobbies stuck in awaiting_randomness).
 */

import type { ChainClient } from "../chain/client.js";
import type { JsonStore } from "../persistence.js";
import type {
  LobbyPublicState,
  LobbyRecord,
  LobbyStoreData,
  PlayerPublicStatus,
  PlayerRecord,
  RoundConfigMessagePayload,
  SettlementInfo,
} from "../types.js";
import {
  CANCEL_AFTER_S,
  FEE_BPS,
  LOBBY_SIZE,
  OVERFLOW_SENTINEL,
  PLAY_TIMEOUT_MS,
} from "./constants.js";
import { generateClientSeed, toHex } from "./fairness.js";
import {
  computeWinners,
  scoreOf,
  simulatePour,
  splitPot,
  type PourOutcome,
  type ResultEntry,
} from "./simulation.js";
import { BASE_RATE_ML_S } from "./constants.js";

/** How long createLobby/boot waits for the VRF callback before giving up. */
const FULFILL_TIMEOUT_MS = 120_000;

export class LobbyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LobbyError";
  }
}

export interface PourResultView {
  /** As reported on-chain (OVERFLOW_SENTINEL on overflow). */
  pouredMl: number;
  foamMl: number;
  overflow: boolean;
  score: number;
}

/**
 * Optional hook: if a pour is physically in progress when the play timeout
 * fires, the WS layer finalizes it at the deadline instead of forfeiting to 0.
 */
export type PourFinalizer = (lobbyId: string, wallet: string, atTs: number) => PourOutcome | null;

export interface LobbyManagerOptions {
  chain: ChainClient;
  store: JsonStore<LobbyStoreData>;
  /** Anzahl Demo-Bots, die freie Plätze auffüllen, sobald ein Mensch joint.
   *  NUR für CHAIN=mock gedacht — Bots zahlen keine echte Entry Fee. */
  bots?: number;
  /** Zeitfaktor für Bot-Join/-Pour-Verzögerungen (Tests: klein wählen). */
  botSpeed?: number;
  lobbySize?: number;
  playTimeoutMs?: number;
  cancelAfterS?: number;
  feeBps?: number;
  fulfillTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export class LobbyManager {
  private readonly chain: ChainClient;
  private readonly store: JsonStore<LobbyStoreData>;
  readonly lobbySize: number;
  readonly botCount: number;
  private readonly botSpeed: number;
  readonly playTimeoutMs: number;
  readonly cancelAfterS: number;
  readonly feeBps: number;
  readonly fulfillTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string, err?: unknown) => void;

  private readonly lobbies = new Map<string, LobbyRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private idCounter = 0;

  pourFinalizer?: PourFinalizer;
  private readonly updateListeners: ((lobby: LobbyRecord) => void)[] = [];
  private readonly settledListeners: ((lobby: LobbyRecord, s: SettlementInfo) => void)[] = [];

  constructor(opts: LobbyManagerOptions) {
    this.chain = opts.chain;
    this.store = opts.store;
    this.botCount = Math.max(0, opts.bots ?? 0);
    this.botSpeed = opts.botSpeed ?? 1;
    this.lobbySize = opts.lobbySize ?? LOBBY_SIZE;
    this.playTimeoutMs = opts.playTimeoutMs ?? PLAY_TIMEOUT_MS;
    this.cancelAfterS = opts.cancelAfterS ?? CANCEL_AFTER_S;
    this.feeBps = opts.feeBps ?? FEE_BPS;
    this.fulfillTimeoutMs = opts.fulfillTimeoutMs ?? FULFILL_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((msg, err) => (err ? console.error(msg, err) : console.log(msg)));
  }

  onUpdate(listener: (lobby: LobbyRecord) => void): void {
    this.updateListeners.push(listener);
  }

  onSettled(listener: (lobby: LobbyRecord, s: SettlementInfo) => void): void {
    this.settledListeners.push(listener);
  }

  private emitUpdate(lobby: LobbyRecord): void {
    for (const fn of this.updateListeners) {
      try {
        fn(lobby);
      } catch (err) {
        this.log("onUpdate listener failed", err);
      }
    }
  }

  private emitSettled(lobby: LobbyRecord, s: SettlementInfo): void {
    for (const fn of this.settledListeners) {
      try {
        fn(lobby, s);
      } catch (err) {
        this.log("onSettled listener failed", err);
      }
    }
  }

  /** Load persisted state and re-arm play timers (expired ones fire immediately). */
  async init(): Promise<void> {
    const data = await this.store.load({ lobbies: [] });
    for (const lobby of data.lobbies) {
      this.lobbies.set(lobby.lobbyId, lobby);
    }
    for (const lobby of this.lobbies.values()) {
      // Settlements interrupted by a crash/restart are retried below.
      if (lobby.status === "settling") lobby.status = "open";
      // Lobbies still waiting for the oracle callback: resume the watch.
      if (lobby.status === "awaiting_randomness") {
        void this.awaitFulfillment(lobby).catch((err) =>
          this.log(`VRF fulfillment resume failed for lobby ${lobby.lobbyId}`, err),
        );
        continue;
      }
      if (lobby.status !== "open") continue;
      for (const p of lobby.players) {
        if (p.status === "playing") this.armTimer(lobby.lobbyId, p);
      }
      // Retry settlement for lobbies that are already complete (crashed or
      // failed settle before the restart). No-op unless full & all done.
      void this.maybeSettle(lobby).catch((err) =>
        this.log(`settle retry failed for lobby ${lobby.lobbyId}`, err),
      );
    }
  }

  private async persist(): Promise<void> {
    await this.store.save({ lobbies: [...this.lobbies.values()] });
  }

  private nextLobbyId(): bigint {
    this.idCounter += 1;
    // Time-based, strictly increasing, collision-free for a single server.
    return BigInt(this.now()) * 1000n + BigInt(this.idCounter % 1000);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a lobby: send create_lobby (which CPIs the VRF request), persist as
   * awaiting_randomness, then wait for the oracle callback. Resolves once the
   * lobby is open (round parameters fulfilled). If the wait times out, the
   * lobby stays awaiting_randomness and is resumed on the next boot.
   */
  async createLobby(entryFeeLamports: bigint, size?: number): Promise<LobbyRecord> {
    const lobbyId = this.nextLobbyId();
    const clientSeed = generateClientSeed();
    const lobbySize = size ?? this.lobbySize;

    const createTxSig = await this.chain.createLobby(
      lobbyId,
      lobbySize,
      entryFeeLamports,
      clientSeed,
    );

    const lobby: LobbyRecord = {
      lobbyId: lobbyId.toString(),
      size: lobbySize,
      entryFeeLamports: entryFeeLamports.toString(),
      status: "awaiting_randomness",
      clientSeedHex: toHex(clientSeed),
      randomnessHex: null,
      targetMl: 0,
      pressureMilli: 0,
      createdAt: this.now(),
      createTxSig,
      players: [],
    };
    this.lobbies.set(lobby.lobbyId, lobby);
    await this.persist();
    this.emitUpdate(lobby);

    await this.awaitFulfillment(lobby);
    return lobby;
  }

  /** Wait for the VRF callback and transition awaiting_randomness -> open. */
  private async awaitFulfillment(lobby: LobbyRecord): Promise<void> {
    const fulfilled = await this.chain.waitForRoundFulfilled(
      BigInt(lobby.lobbyId),
      this.fulfillTimeoutMs,
    );
    // The lobby may have been cancelled while we were waiting.
    if (lobby.status !== "awaiting_randomness") return;

    lobby.randomnessHex = toHex(fulfilled.randomness);
    lobby.targetMl = fulfilled.targetMl;
    lobby.pressureMilli = fulfilled.pressureMilli;
    lobby.status = "open";
    await this.persist();
    this.emitUpdate(lobby);
  }

  /**
   * Confirm a player's on-chain join. On success the player's 60s play window
   * starts and the round config (target, pressure, deadline) is returned —
   * it must only ever be sent to confirmed players.
   */
  async confirmJoin(
    lobbyId: string,
    wallet: string,
    txSig: string,
  ): Promise<RoundConfigMessagePayload> {
    const lobby = this.mustGet(lobbyId);
    // Joining is only possible once the VRF round is fulfilled (status open).
    if (lobby.status !== "open") throw new LobbyError("LOBBY_CLOSED", "lobby is not open");
    // Idempotent: a reconnecting client may repeat join_lobby and simply gets
    // the same round config back (deadline unchanged, no second seat).
    const existing = lobby.players.find((p) => p.wallet === wallet);
    if (existing) return this.roundConfigFor(lobby, existing);
    if (lobby.players.length >= lobby.size) {
      throw new LobbyError("LOBBY_FULL", "lobby is full");
    }

    const ok = await this.chain.confirmJoin(txSig, BigInt(lobbyId), wallet);
    if (!ok) throw new LobbyError("JOIN_NOT_CONFIRMED", "join transaction not confirmed on-chain");

    // Re-check after the async gap (double-join race on two sockets).
    if (lobby.status !== "open") throw new LobbyError("LOBBY_CLOSED", "lobby is not open");
    const raced = lobby.players.find((p) => p.wallet === wallet);
    if (raced) return this.roundConfigFor(lobby, raced);
    if (lobby.players.length >= lobby.size) {
      throw new LobbyError("LOBBY_FULL", "lobby is full");
    }

    const joinConfirmedAt = this.now();
    const player: PlayerRecord = {
      wallet,
      joinTxSig: txSig,
      joinConfirmedAt,
      deadlineTs: joinConfirmedAt + this.playTimeoutMs,
      status: "playing",
    };
    lobby.players.push(player);
    this.armTimer(lobby.lobbyId, player);
    await this.persist();
    this.emitUpdate(lobby);

    // Demo-Bots füllen freie Plätze auf, sobald ein Mensch drin ist.
    this.scheduleBots(lobby);

    return this.roundConfigFor(lobby, player);
  }

  // ---------------------------------------------------------------------------
  // Demo-Bots (nur CHAIN=mock): joinen zeitversetzt und zapfen mit realistischer
  // Streuung — gute Schützen (~±90 ml) mit gelegentlichen Ausreißern.
  // ---------------------------------------------------------------------------

  private static readonly BOT_NAMES = ["Sepp", "Resi", "Xaver", "Vroni", "Girgl", "Zenzi", "Wastl", "Kathi", "Loisl"];

  private scheduleBots(lobby: LobbyRecord): void {
    if (this.botCount <= 0 || lobby.status !== "open") return;
    if (!lobby.players.some((p) => !p.isBot)) return; // erst wenn ein Mensch joint
    const existingBots = lobby.players.filter((p) => p.isBot).length;
    const freeSeats = lobby.size - lobby.players.length;
    const toAdd = Math.min(freeSeats, this.botCount - existingBots);

    for (let i = 0; i < toAdd; i++) {
      const name = LobbyManager.BOT_NAMES[(existingBots + i) % LobbyManager.BOT_NAMES.length];
      const wallet = `BOT-${name}`;
      const key = `bot-join:${lobby.lobbyId}:${wallet}`;
      if (this.timers.has(key)) continue;
      const joinDelay = (700 + Math.random() * 1800 + i * 900) * this.botSpeed;
      const handle = setTimeout(() => {
        this.timers.delete(key);
        void this.botJoinAndPour(lobby.lobbyId, wallet).catch((err) =>
          this.log(`bot ${wallet} failed in lobby ${lobby.lobbyId}`, err),
        );
      }, joinDelay);
      handle.unref?.();
      this.timers.set(key, handle);
    }
  }

  private async botJoinAndPour(lobbyId: string, wallet: string): Promise<void> {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby || lobby.status !== "open") return;
    if (lobby.players.length >= lobby.size) return;
    if (lobby.players.some((p) => p.wallet === wallet)) return;

    const joinConfirmedAt = this.now();
    const bot: PlayerRecord = {
      wallet,
      isBot: true,
      joinTxSig: "bot",
      joinConfirmedAt,
      deadlineTs: joinConfirmedAt + this.playTimeoutMs,
      status: "playing",
    };
    lobby.players.push(bot);
    this.armTimer(lobby.lobbyId, bot); // Sicherheitsnetz: Timeout -> 0 ml
    await this.persist();
    this.emitUpdate(lobby);
    this.scheduleBots(lobby); // ggf. weitere Plätze auffüllen

    // Zapfen mit menschlicher Reaktionsstreuung.
    const key = `bot-pour:${lobby.lobbyId}:${wallet}`;
    const pourDelay = (1200 + Math.random() * 4000) * this.botSpeed;
    const handle = setTimeout(() => {
      this.timers.delete(key);
      void (async () => {
        const l = this.lobbies.get(lobbyId);
        const p = l?.players.find((x) => x.wallet === wallet);
        if (!l || !p || l.status !== "open" || p.status !== "playing") return;
        const pressure = l.pressureMilli / 1000;
        const idealMs = (l.targetMl / (BASE_RATE_ML_S * pressure)) * 1000;
        // 15% Ausreißer (±600 ms), sonst ±180 ms Reaktionsfehler.
        const spread = Math.random() < 0.15 ? 600 : 180;
        const durationMs = Math.max(60, idealMs + (Math.random() * 2 - 1) * spread);
        const outcome = simulatePour(pressure, durationMs);
        await this.recordResult(l, p, outcome, false);
      })().catch((err) => this.log(`bot pour failed for ${wallet}`, err));
    }, pourDelay);
    handle.unref?.();
    this.timers.set(key, handle);
  }

  private roundConfigFor(lobby: LobbyRecord, player: PlayerRecord): RoundConfigMessagePayload {
    return {
      lobbyId: lobby.lobbyId,
      targetMl: lobby.targetMl,
      pressure: lobby.pressureMilli / 1000,
      deadlineTs: player.deadlineTs,
    };
  }

  /** Record a finished pour for a player (single attempt, enforced here). */
  async submitPour(lobbyId: string, wallet: string, outcome: PourOutcome): Promise<PourResultView> {
    const lobby = this.mustGet(lobbyId);
    const player = lobby.players.find((p) => p.wallet === wallet);
    if (!player) throw new LobbyError("NOT_JOINED", "wallet has not joined this lobby");
    return this.recordResult(lobby, player, outcome, false);
  }

  private async recordResult(
    lobby: LobbyRecord,
    player: PlayerRecord,
    outcome: PourOutcome,
    timedOut: boolean,
  ): Promise<PourResultView> {
    if (lobby.status !== "open") throw new LobbyError("LOBBY_CLOSED", "lobby is not open");
    if (player.status !== "playing") {
      throw new LobbyError("ALREADY_PLAYED", "player already has a result");
    }

    // Mark done synchronously (before any await) so a second submit can't race in.
    player.status = "done";
    player.pouredMl = outcome.pouredMl;
    player.overflow = outcome.overflow;
    player.timedOut = timedOut;
    player.submissionIndex = lobby.players.filter((p) => p.status === "done").length - 1;
    this.clearTimer(lobby.lobbyId, player.wallet);

    const reported = outcome.overflow ? OVERFLOW_SENTINEL : outcome.pouredMl;
    try {
      player.submitTxSig = await this.chain.submitResult(
        BigInt(lobby.lobbyId),
        player.wallet,
        reported,
      );
    } catch (err) {
      // Result stays recorded locally; on-chain submit needs manual retry.
      player.submitTxSig = null;
      this.log(`submitResult failed for lobby ${lobby.lobbyId} player ${player.wallet}`, err);
    }

    await this.persist();
    this.emitUpdate(lobby);
    await this.maybeSettle(lobby);

    return {
      pouredMl: reported,
      foamMl: outcome.foamMl,
      overflow: outcome.overflow,
      score: scoreOf(outcome.pouredMl, lobby.targetMl, outcome.overflow),
    };
  }

  private async maybeSettle(lobby: LobbyRecord): Promise<void> {
    if (lobby.status !== "open") return;
    if (lobby.players.length < lobby.size) return;
    if (!lobby.players.every((p) => p.status === "done")) return;

    lobby.status = "settling";
    await this.persist();
    this.emitUpdate(lobby);

    const results: ResultEntry[] = lobby.players.map((p) => ({
      player: p.wallet,
      pouredMl: p.pouredMl ?? 0,
      overflow: p.overflow ?? false,
      submissionIndex: p.submissionIndex ?? 0,
    }));
    const { winners } = computeWinners(results, lobby.targetMl);
    const pot = BigInt(lobby.entryFeeLamports) * BigInt(lobby.players.length);
    const split = splitPot(pot, winners, this.feeBps);
    const winnerWallets = winners.map((w) => w.player);

    let txSig: string;
    try {
      txSig = await this.chain.settleLobby(BigInt(lobby.lobbyId), winnerWallets);
    } catch (err) {
      lobby.status = "open"; // allow retry (init() re-runs maybeSettle for complete lobbies)
      await this.persist();
      this.log(`settleLobby failed for lobby ${lobby.lobbyId}`, err);
      return;
    }

    const settlement: SettlementInfo = {
      txSig,
      winners: winnerWallets,
      payoutLamports: split.shareLamports.toString(),
      payouts: split.payouts.map((p) => ({ wallet: p.player, lamports: p.lamports.toString() })),
      feeLamports: split.feeLamports.toString(),
      potLamports: pot.toString(),
      randomnessHex: lobby.randomnessHex ?? "",
    };
    lobby.status = "settled";
    lobby.settlement = settlement;
    await this.persist();
    this.emitUpdate(lobby);
    this.emitSettled(lobby, settlement);
  }

  /**
   * Cancel an expired lobby (also permissionless on-chain): unfilled open
   * lobbies (refunds) and lobbies stuck in awaiting_randomness (no players,
   * nothing to refund).
   */
  async cancelIfExpired(lobbyId: string): Promise<boolean> {
    const lobby = this.mustGet(lobbyId);
    if (lobby.status !== "open" && lobby.status !== "awaiting_randomness") return false;
    if (this.now() < lobby.createdAt + this.cancelAfterS * 1000) return false;
    if (
      lobby.status === "open" &&
      lobby.players.length >= lobby.size &&
      lobby.players.every((p) => p.status === "done")
    ) {
      return false; // complete: settle instead
    }

    const txSig = await this.chain.cancelLobby(
      BigInt(lobbyId),
      lobby.players.map((p) => p.wallet),
    );
    for (const p of lobby.players) this.clearTimer(lobbyId, p.wallet);
    lobby.status = "cancelled";
    lobby.cancelTxSig = txSig;
    await this.persist();
    this.emitUpdate(lobby);
    return true;
  }

  /** Periodic sweep: cancel every expired open/awaiting lobby. */
  async sweepExpired(): Promise<void> {
    for (const lobby of [...this.lobbies.values()]) {
      if (lobby.status !== "open" && lobby.status !== "awaiting_randomness") continue;
      try {
        await this.cancelIfExpired(lobby.lobbyId);
      } catch (err) {
        this.log(`cancel sweep failed for lobby ${lobby.lobbyId}`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Play timeout
  // -------------------------------------------------------------------------

  private timerKey(lobbyId: string, wallet: string): string {
    return `${lobbyId}:${wallet}`;
  }

  private armTimer(lobbyId: string, player: PlayerRecord): void {
    const delay = Math.max(0, player.deadlineTs - this.now());
    const key = this.timerKey(lobbyId, player.wallet);
    this.clearTimerByKey(key);
    const handle = setTimeout(() => {
      this.timers.delete(key);
      void this.handleTimeout(lobbyId, player.wallet).catch((err) =>
        this.log(`play timeout handling failed for ${key}`, err),
      );
    }, delay);
    // Don't keep the process alive just for game timers (tests, shutdown).
    handle.unref?.();
    this.timers.set(key, handle);
  }

  private clearTimer(lobbyId: string, wallet: string): void {
    this.clearTimerByKey(this.timerKey(lobbyId, wallet));
  }

  private clearTimerByKey(key: string): void {
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  private async handleTimeout(lobbyId: string, wallet: string): Promise<void> {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby || lobby.status !== "open") return;
    const player = lobby.players.find((p) => p.wallet === wallet);
    if (!player || player.status !== "playing") return;

    // If a pour is mid-flight, lock it in at the deadline; otherwise forfeit 0.
    const outcome: PourOutcome = this.pourFinalizer?.(lobbyId, wallet, player.deadlineTs) ?? {
      pouredMl: 0,
      foamMl: 0,
      overflow: false,
    };
    await this.recordResult(lobby, player, outcome, true);
  }

  /** Stop all timers (graceful shutdown / test teardown). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private mustGet(lobbyId: string): LobbyRecord {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new LobbyError("LOBBY_NOT_FOUND", `unknown lobby ${lobbyId}`);
    return lobby;
  }

  getLobby(lobbyId: string): LobbyRecord | undefined {
    return this.lobbies.get(lobbyId);
  }

  getPlayer(lobbyId: string, wallet: string): PlayerRecord | undefined {
    return this.lobbies.get(lobbyId)?.players.find((p) => p.wallet === wallet);
  }

  /** Round parameters — server-internal; only confirmed players may see these. */
  getRound(lobbyId: string): { targetMl: number; pressure: number } {
    const lobby = this.mustGet(lobbyId);
    if (lobby.randomnessHex === null) {
      throw new LobbyError("AWAITING_RANDOMNESS", "VRF round not fulfilled yet");
    }
    return { targetMl: lobby.targetMl, pressure: lobby.pressureMilli / 1000 };
  }

  listOpen(): LobbyPublicState[] {
    return [...this.lobbies.values()]
      .filter((l) => l.status === "open")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((l) => this.publicState(l));
  }

  /**
   * Watcher-safe view. Target/pressure stay hidden (only round_config after a
   * confirmed join reveals them) and per-player poured amounts are only shown
   * once the lobby is settled — otherwise watchers could infer the target
   * from other players' results before paying in. The VRF randomness is
   * likewise only echoed after settlement (it is public on-chain anyway).
   */
  publicState(lobby: LobbyRecord): LobbyPublicState {
    const revealed = lobby.status === "settled";
    return {
      lobbyId: lobby.lobbyId,
      size: lobby.size,
      entryFeeLamports: lobby.entryFeeLamports,
      potLamports: (BigInt(lobby.entryFeeLamports) * BigInt(lobby.players.length)).toString(),
      seatsFilled: lobby.players.length,
      status: lobby.status,
      createdAt: lobby.createdAt,
      players: lobby.players.map((p) => {
        const status: PlayerPublicStatus = p.status === "done" ? "fertig" : "spielt";
        return {
          wallet: p.wallet,
          isBot: p.isBot === true,
          status,
          pouredMl: revealed
            ? p.overflow
              ? OVERFLOW_SENTINEL
              : (p.pouredMl ?? null)
            : null,
        };
      }),
      randomnessHex: revealed ? lobby.randomnessHex : null,
    };
  }
}
