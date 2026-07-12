"use client";

/**
 * WebSocket-Zustandsmaschine für eine Lobby.
 *
 * Senden:    {type:"hello", token}  {type:"watch_lobby", lobbyId}
 *            {type:"pour_start"}    {type:"pour_stop"}
 * Empfangen: {type:"lobby_state", …}  (status u. a. "awaiting_randomness",
 *            solange das MagicBlock-VRF-Oracle die Zufallszahl noch nicht
 *            per On-Chain-Callback geliefert hat)
 *            {type:"round_config", targetMl, pressure, deadlineTs}
 *            {type:"pour_result", pouredMl, overflow, score}
 *            {type:"settled", winners, payoutLamports, feeLamports, txSig, randomness}
 *
 * Robust: automatischer Reconnect mit Backoff; hello/watch_lobby werden nach
 * jedem (Re-)Connect erneut gesendet, der Server liefert dann den aktuellen Stand.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "@/lib/constants";

export type SocketStatus = "idle" | "connecting" | "open" | "closed";

export type PlayerStatus = "waiting" | "pouring" | "done";

export interface PlayerState {
  wallet: string;
  status: PlayerStatus;
  pouredMl?: number;
  overflow?: boolean;
}

export interface LobbyState {
  lobbyId: string;
  entryFeeLamports: number;
  potLamports: number;
  size: number;
  /** u. a. "awaiting_randomness" | "open" | "settled" | "cancelled" */
  status: string;
  players: PlayerState[];
}

export interface RoundConfig {
  targetMl: number;
  pressure: number;
  /** Unix-Timestamp (ms) für das Ende der 60-s-Spielzeit */
  deadlineTs: number;
}

export interface PourResult {
  pouredMl: number;
  overflow: boolean;
  score: number;
}

export interface SettledInfo {
  winners: string[];
  payoutLamports: number;
  feeLamports: number;
  txSig: string;
  /** VRF-Randomness (32 Bytes) als Hex-String, geliefert vom MagicBlock-Oracle */
  randomness: string;
  potLamports?: number;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

function parsePlayers(v: unknown): PlayerState[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p): PlayerState[] => {
    if (typeof p !== "object" || p === null) return [];
    const o = p as Record<string, unknown>;
    const wallet = str(o.wallet ?? o.player ?? o.pubkey);
    if (!wallet) return [];
    const rawStatus = str(o.status, "waiting");
    const status: PlayerStatus =
      rawStatus === "pouring" || rawStatus === "done" ? rawStatus : "waiting";
    return [
      {
        wallet,
        status: o.hasPlayed === true ? "done" : status,
        pouredMl: o.pouredMl !== undefined ? num(o.pouredMl) : undefined,
        overflow: typeof o.overflow === "boolean" ? o.overflow : undefined,
      },
    ];
  });
}

/** ms-Normalisierung: Server darf Sekunden ODER Millisekunden schicken. */
function toMs(ts: number): number {
  return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
}

export interface GameSocket {
  status: SocketStatus;
  lobbyState: LobbyState | null;
  roundConfig: RoundConfig | null;
  pourResult: PourResult | null;
  settled: SettledInfo | null;
  lastError: string | null;
  sendPourStart: () => void;
  sendPourStop: () => void;
}

export function useGameSocket(lobbyId: string, token: string | null): GameSocket {
  const [status, setStatus] = useState<SocketStatus>("idle");
  const [lobbyState, setLobbyState] = useState<LobbyState | null>(null);
  const [roundConfig, setRoundConfig] = useState<RoundConfig | null>(null);
  const [pourResult, setPourResult] = useState<PourResult | null>(null);
  const [settled, setSettled] = useState<SettledInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!token || !lobbyId) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const handleMessage = (raw: string) => {
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case "lobby_state": {
          const entry = num(msg.entryFeeLamports ?? msg.entryFee);
          const players = parsePlayers(msg.players);
          setLobbyState({
            lobbyId: str(msg.lobbyId, lobbyId),
            entryFeeLamports: entry,
            potLamports: num(msg.potLamports ?? msg.pot, entry * players.length),
            size: num(msg.size, 5),
            status: str(msg.status, "open"),
            players,
          });
          break;
        }
        case "round_config":
          setRoundConfig({
            targetMl: num(msg.targetMl, 1000),
            pressure: num(msg.pressure, 1),
            deadlineTs: toMs(num(msg.deadlineTs)),
          });
          break;
        case "pour_result":
          setPourResult({
            pouredMl: num(msg.pouredMl),
            overflow: msg.overflow === true,
            score: num(msg.score),
          });
          break;
        case "settled":
          setSettled({
            winners: Array.isArray(msg.winners)
              ? msg.winners.map((w) => str(w)).filter(Boolean)
              : [],
            payoutLamports: num(msg.payoutLamports),
            feeLamports: num(msg.feeLamports),
            txSig: str(msg.txSig),
            randomness: str(msg.randomness),
            potLamports: msg.potLamports !== undefined ? num(msg.potLamports) : undefined,
          });
          break;
        case "error":
          setLastError(str(msg.message ?? msg.error, "Unbekannter Serverfehler"));
          break;
        default:
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        setStatus("closed");
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        retryRef.current = 0;
        setStatus("open");
        ws.send(JSON.stringify({ type: "hello", token }));
        ws.send(JSON.stringify({ type: "watch_lobby", lobbyId }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string") handleMessage(ev.data);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        setStatus("closed");
        const delay = Math.min(1000 * 2 ** retryRef.current, 10_000);
        retryRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* noop */
        }
      }
    };
  }, [token, lobbyId]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const sendPourStart = useCallback(() => send({ type: "pour_start" }), [send]);
  const sendPourStop = useCallback(() => send({ type: "pour_stop" }), [send]);

  return {
    status,
    lobbyState,
    roundConfig,
    pourResult,
    settled,
    lastError,
    sendPourStart,
    sendPourStop,
  };
}
