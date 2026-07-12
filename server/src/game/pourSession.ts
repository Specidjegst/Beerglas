/**
 * Server-authoritative pour sessions.
 *
 * The client only ever sends `pour_start` / `pour_stop`; the server takes its
 * OWN clock (Date.now at receipt) for both. Sanity bounds:
 *   - max duration = analytic overflow time + POUR_STOP_GRACE_MS buffer
 *   - pour_stop without a matching start is ignored
 *   - exactly one attempt per player (enforced again by LobbyManager)
 *   - pour_start after the play deadline is rejected
 *
 * If the 60s play timeout fires while a pour is still running (client never
 * sent pour_stop), the pour is finalized at the deadline via the
 * LobbyManager.pourFinalizer hook instead of forfeiting to 0 ml.
 */

import { POUR_STOP_GRACE_MS } from "./constants.js";
import { overflowTimeMs, simulatePour, type PourOutcome } from "./simulation.js";
import { LobbyError, type LobbyManager } from "./lobby.js";

interface ActivePour {
  lobbyId: string;
  wallet: string;
  startedAt: number;
}

export class PourSessionManager {
  private readonly active = new Map<string, ActivePour>();

  constructor(
    private readonly lobbies: LobbyManager,
    private readonly now: () => number = Date.now,
  ) {
    lobbies.pourFinalizer = (lobbyId, wallet, atTs) => this.finalizeActive(lobbyId, wallet, atTs);
  }

  private key(lobbyId: string, wallet: string): string {
    return `${lobbyId}:${wallet}`;
  }

  /** Handle pour_start. Throws LobbyError on invalid state. */
  start(lobbyId: string, wallet: string): { startedAt: number } {
    const player = this.lobbies.getPlayer(lobbyId, wallet);
    if (!player) throw new LobbyError("NOT_JOINED", "join must be confirmed before pouring");
    if (player.status !== "playing") {
      throw new LobbyError("ALREADY_PLAYED", "only one attempt per player");
    }
    const startedAt = this.now();
    if (startedAt >= player.deadlineTs) {
      throw new LobbyError("PLAY_TIMEOUT", "play window expired");
    }
    const k = this.key(lobbyId, wallet);
    if (this.active.has(k)) {
      throw new LobbyError("POUR_IN_PROGRESS", "pour already running");
    }
    this.active.set(k, { lobbyId, wallet, startedAt });
    return { startedAt };
  }

  /**
   * Handle pour_stop. Returns the simulated outcome, or null if there was no
   * matching pour_start (message is silently ignored per protocol).
   */
  stop(lobbyId: string, wallet: string): PourOutcome | null {
    return this.finalizeActive(lobbyId, wallet, this.now());
  }

  /**
   * Finalize an active pour at `atTs` (used by both pour_stop and the play
   * timeout). Returns null when no pour is active for this player.
   */
  finalizeActive(lobbyId: string, wallet: string, atTs: number): PourOutcome | null {
    const k = this.key(lobbyId, wallet);
    const pour = this.active.get(k);
    if (!pour) return null;
    this.active.delete(k);

    const { pressure } = this.lobbies.getRound(lobbyId);
    const rawDuration = Math.max(0, atTs - pour.startedAt);
    const maxDuration = overflowTimeMs(pressure) + POUR_STOP_GRACE_MS;
    const duration = Math.min(rawDuration, maxDuration);
    return simulatePour(pressure, duration);
  }

  /** Drop any active pour for a disconnecting socket (timeout will still fire). */
  abandon(lobbyId: string, wallet: string): void {
    this.active.delete(this.key(lobbyId, wallet));
  }

  hasActive(lobbyId: string, wallet: string): boolean {
    return this.active.has(this.key(lobbyId, wallet));
  }
}
