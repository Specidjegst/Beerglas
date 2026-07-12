/**
 * WebSocket protocol (JSON), endpoint GET /ws.
 *
 * Client -> Server:
 *   {type:"hello", token}                    authenticate the socket
 *   {type:"watch_lobby", lobbyId}            subscribe to lobby_state broadcasts
 *   {type:"join_lobby", lobbyId, txSig}      report the player's own join tx for confirmation
 *   {type:"pour_start"} / {type:"pour_stop"} the single pour attempt (server clock is truth)
 *
 * Server -> Client:
 *   hello_ack, lobby_state (broadcast on every change; status may be
 *   awaiting_randomness while the VRF callback is pending), round_config (only
 *   to the player, only after confirmed join), pour_ack, pour_result,
 *   settled (includes the VRF randomness as hex), error.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AuthService } from "./auth.js";
import { LobbyError, type LobbyManager } from "./game/lobby.js";
import type { PourSessionManager } from "./game/pourSession.js";
import type { ClientMessage, ServerMessage } from "./types.js";

interface ConnState {
  socket: WebSocket;
  wallet: string | null;
  watching: Set<string>;
  /** Lobby the wallet joined via this socket (pour_start/stop context). */
  joinedLobbyId: string | null;
}

export interface WsDeps {
  auth: AuthService;
  lobbies: LobbyManager;
  pours: PourSessionManager;
}

export function registerWs(app: FastifyInstance, deps: WsDeps): void {
  const conns = new Set<ConnState>();

  const send = (conn: ConnState, msg: ServerMessage): void => {
    if (conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(JSON.stringify(msg));
    }
  };

  const broadcastLobby = (lobbyId: string): void => {
    const lobby = deps.lobbies.getLobby(lobbyId);
    if (!lobby) return;
    const msg: ServerMessage = { type: "lobby_state", lobby: deps.lobbies.publicState(lobby) };
    for (const conn of conns) {
      if (conn.watching.has(lobbyId) || conn.joinedLobbyId === lobbyId) send(conn, msg);
    }
  };

  deps.lobbies.onUpdate((lobby) => broadcastLobby(lobby.lobbyId));
  deps.lobbies.onSettled((lobby, s) => {
    const msg: ServerMessage = {
      type: "settled",
      lobbyId: lobby.lobbyId,
      winners: s.winners,
      payoutLamports: s.payoutLamports,
      payouts: s.payouts,
      feeLamports: s.feeLamports,
      txSig: s.txSig,
      randomness: s.randomnessHex,
    };
    for (const conn of conns) {
      if (conn.watching.has(lobby.lobbyId) || conn.joinedLobbyId === lobby.lobbyId) {
        send(conn, msg);
      }
    }
  });

  const handleMessage = async (conn: ConnState, msg: ClientMessage): Promise<void> => {
    switch (msg.type) {
      case "hello": {
        const wallet = typeof msg.token === "string" ? deps.auth.verifyToken(msg.token) : null;
        if (!wallet) {
          send(conn, { type: "error", code: "AUTH_FAILED", message: "invalid or expired token" });
          return;
        }
        conn.wallet = wallet;
        send(conn, { type: "hello_ack", wallet });
        return;
      }

      case "watch_lobby": {
        const lobby = typeof msg.lobbyId === "string" ? deps.lobbies.getLobby(msg.lobbyId) : undefined;
        if (!lobby) {
          send(conn, { type: "error", code: "LOBBY_NOT_FOUND", message: "unknown lobby" });
          return;
        }
        conn.watching.add(lobby.lobbyId);
        send(conn, { type: "lobby_state", lobby: deps.lobbies.publicState(lobby) });
        return;
      }

      case "join_lobby": {
        if (!conn.wallet) {
          send(conn, { type: "error", code: "NOT_AUTHENTICATED", message: "send hello first" });
          return;
        }
        if (typeof msg.lobbyId !== "string" || typeof msg.txSig !== "string") {
          send(conn, { type: "error", code: "BAD_REQUEST", message: "lobbyId and txSig required" });
          return;
        }
        const cfg = await deps.lobbies.confirmJoin(msg.lobbyId, conn.wallet, msg.txSig);
        conn.joinedLobbyId = cfg.lobbyId;
        conn.watching.add(cfg.lobbyId);
        // Round config strictly AFTER the confirmed join, only to this player.
        send(conn, { type: "round_config", ...cfg });
        return;
      }

      case "pour_start": {
        if (!conn.wallet || !conn.joinedLobbyId) {
          send(conn, { type: "error", code: "NOT_IN_LOBBY", message: "join a lobby first" });
          return;
        }
        const { startedAt } = deps.pours.start(conn.joinedLobbyId, conn.wallet);
        send(conn, { type: "pour_ack", startedAt });
        return;
      }

      case "pour_stop": {
        if (!conn.wallet || !conn.joinedLobbyId) return; // ignore, per protocol
        const outcome = deps.pours.stop(conn.joinedLobbyId, conn.wallet);
        if (!outcome) return; // pour_stop without pour_start: ignore
        const result = await deps.lobbies.submitPour(conn.joinedLobbyId, conn.wallet, outcome);
        send(conn, {
          type: "pour_result",
          pouredMl: result.pouredMl,
          foamMl: result.foamMl,
          overflow: result.overflow,
          score: result.score,
        });
        return;
      }

      default:
        send(conn, { type: "error", code: "UNKNOWN_TYPE", message: "unknown message type" });
    }
  };

  app.get("/ws", { websocket: true }, (socket: WebSocket, _req: FastifyRequest) => {
    const conn: ConnState = { socket, wallet: null, watching: new Set(), joinedLobbyId: null };
    conns.add(conn);

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(conn, { type: "error", code: "BAD_JSON", message: "message must be JSON" });
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        send(conn, { type: "error", code: "BAD_REQUEST", message: "missing message type" });
        return;
      }
      void handleMessage(conn, msg).catch((err: unknown) => {
        if (err instanceof LobbyError) {
          send(conn, { type: "error", code: err.code, message: err.message });
        } else {
          app.log.error(err, "ws message handling failed");
          send(conn, { type: "error", code: "INTERNAL", message: "internal server error" });
        }
      });
    });

    socket.on("close", () => {
      conns.delete(conn);
      // Deliberately do NOT abandon an active pour here: the play timeout will
      // finalize it at the deadline (anti rage-quit — see spec).
    });
  });
}
