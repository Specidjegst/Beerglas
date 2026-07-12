/**
 * Chain access is fully encapsulated behind this interface so the game logic
 * and all unit tests run without any network or validator.
 *
 * Implementations:
 *  - AnchorChainClient (./anchorClient.ts) — real devnet/localnet via @coral-xyz/anchor
 *  - MockChainClient (below)               — in-memory, for tests and CHAIN=mock
 */

import { randomBytes } from "node:crypto";
import { deriveRound } from "../game/fairness.js";

/** Result of a fulfilled VRF round (randomness + derived parameters). */
export interface FulfilledRound {
  randomness: Uint8Array;
  targetMl: number;
  pressureMilli: number;
}

export interface ChainClient {
  /**
   * create_lobby as result_authority. clientSeed is public request entropy for
   * the VRF request (CPI to the Ephemeral VRF program happens inside the ix).
   * The lobby starts in status AwaitingRandomness. Returns the tx signature.
   */
  createLobby(
    lobbyId: bigint,
    size: number,
    entryFeeLamports: bigint,
    clientSeed: Uint8Array,
  ): Promise<string>;

  /**
   * Wait until the VRF oracle's fulfill_round callback landed and the lobby is
   * Open. Resolves with the on-chain randomness and the derived round
   * parameters; rejects after timeoutMs.
   */
  waitForRoundFulfilled(lobbyId: bigint, timeoutMs: number): Promise<FulfilledRound>;

  /**
   * Verify that a player's join_lobby transaction landed successfully and the
   * player actually occupies a seat in the on-chain lobby account.
   */
  confirmJoin(txSig: string, lobbyId: bigint, player: string): Promise<boolean>;

  /** submit_result as result_authority. pouredMl is the reported u32 (sentinel for overflow). */
  submitResult(lobbyId: bigint, player: string, pouredMl: number): Promise<string>;

  /**
   * settle_lobby as result_authority (no seed reveal anymore — the program
   * uses the VRF-derived lobby.target_ml). Winners (sorted by submissionIndex
   * asc, remainder receiver first) are passed as remainingAccounts.
   */
  settleLobby(lobbyId: bigint, winners: string[]): Promise<string>;

  /** cancel_lobby (permissionless after 24h); all joined players are refunded. */
  cancelLobby(lobbyId: bigint, players: string[]): Promise<string>;
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

export interface MockCall {
  method: string;
  lobbyId: string;
  args: Record<string, unknown>;
}

export class MockChainClient implements ChainClient {
  /** Flip to false to make confirmJoin fail (e.g. testing bogus join txs). */
  confirmJoinResult = true;

  /**
   * When true (default) waitForRoundFulfilled resolves immediately with fresh
   * randomness. Set to false to hold lobbies in AwaitingRandomness until the
   * test calls fulfill(lobbyId).
   */
  autoFulfill = true;

  readonly calls: MockCall[] = [];
  readonly createLobbyCalls: { lobbyId: string; size: number; entryFeeLamports: string; clientSeedHex: string }[] = [];
  readonly submitResultCalls: { lobbyId: string; player: string; pouredMl: number }[] = [];
  readonly settleCalls: { lobbyId: string; winners: string[] }[] = [];
  readonly cancelCalls: { lobbyId: string; players: string[] }[] = [];

  /** Randomness per lobby (stable across repeated waitForRoundFulfilled calls). */
  private readonly randomnessByLobby = new Map<string, Uint8Array>();
  private readonly pendingFulfillments = new Map<string, () => void>();

  private seq = 0;

  private sig(kind: string): string {
    this.seq += 1;
    return `mock-${kind}-${this.seq}`;
  }

  async createLobby(
    lobbyId: bigint,
    size: number,
    entryFeeLamports: bigint,
    clientSeed: Uint8Array,
  ): Promise<string> {
    const rec = {
      lobbyId: lobbyId.toString(),
      size,
      entryFeeLamports: entryFeeLamports.toString(),
      clientSeedHex: Buffer.from(clientSeed).toString("hex"),
    };
    this.createLobbyCalls.push(rec);
    this.calls.push({ method: "createLobby", lobbyId: rec.lobbyId, args: rec });
    return this.sig("create");
  }

  async waitForRoundFulfilled(lobbyId: bigint, timeoutMs: number): Promise<FulfilledRound> {
    const key = lobbyId.toString();
    if (!this.autoFulfill && !this.randomnessByLobby.has(key)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingFulfillments.delete(key);
          reject(new Error(`mock VRF fulfillment timed out for lobby ${key}`));
        }, timeoutMs);
        timer.unref?.();
        this.pendingFulfillments.set(key, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    let randomness = this.randomnessByLobby.get(key);
    if (!randomness) {
      randomness = new Uint8Array(randomBytes(32));
      this.randomnessByLobby.set(key, randomness);
    }
    const round = deriveRound(randomness);
    this.calls.push({
      method: "waitForRoundFulfilled",
      lobbyId: key,
      args: { randomnessHex: Buffer.from(randomness).toString("hex") },
    });
    return { randomness, targetMl: round.targetMl, pressureMilli: round.pressureMilli };
  }

  /** Test hook: deliver the oracle callback for a lobby held by autoFulfill=false. */
  fulfill(lobbyId: string | bigint, randomness?: Uint8Array): void {
    const key = lobbyId.toString();
    if (randomness) this.randomnessByLobby.set(key, randomness);
    const release = this.pendingFulfillments.get(key);
    this.pendingFulfillments.delete(key);
    release?.();
  }

  async confirmJoin(_txSig: string, lobbyId: bigint, player: string): Promise<boolean> {
    this.calls.push({ method: "confirmJoin", lobbyId: lobbyId.toString(), args: { player } });
    return this.confirmJoinResult;
  }

  async submitResult(lobbyId: bigint, player: string, pouredMl: number): Promise<string> {
    const rec = { lobbyId: lobbyId.toString(), player, pouredMl };
    this.submitResultCalls.push(rec);
    this.calls.push({ method: "submitResult", lobbyId: rec.lobbyId, args: rec });
    return this.sig("submit");
  }

  async settleLobby(lobbyId: bigint, winners: string[]): Promise<string> {
    const rec = { lobbyId: lobbyId.toString(), winners: [...winners] };
    this.settleCalls.push(rec);
    this.calls.push({ method: "settleLobby", lobbyId: rec.lobbyId, args: rec });
    return this.sig("settle");
  }

  async cancelLobby(lobbyId: bigint, players: string[]): Promise<string> {
    const rec = { lobbyId: lobbyId.toString(), players: [...players] };
    this.cancelCalls.push(rec);
    this.calls.push({ method: "cancelLobby", lobbyId: rec.lobbyId, args: rec });
    return this.sig("cancel");
  }
}
