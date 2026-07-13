"use client";

/**
 * Spielseite /game/[lobbyId] — kompletter Flow:
 *  1) Wallet connect + Sign-Message-Login (POST /auth/nonce → signMessage → /auth/verify → Token)
 *  2) Join: Anchor-Tx join_lobby(lobbyId) bauen und via Wallet senden (Entry Fee on-chain).
 *     Solange die Lobby noch "awaiting_randomness" ist (MagicBlock-VRF-Oracle hat die
 *     Zufallszahl noch nicht per Callback geliefert), ist der Join gesperrt.
 *  3) WS: hello + watch_lobby; nach round_config: 60-s-Countdown GROSS, TapScene aktiv,
 *     Hold-Button pointerdown → pour_start, pointerup → pour_stop (Server ist Autorität)
 *  4) pour_result → Result-Overlay ("Warten auf N Spieler …")
 *  5) settled → Gewinner-Reveal mit Payouts (◎) und Explorer-Link
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import TapScene from "@/components/TapScene";
import PlayerChips from "@/components/PlayerChips";
import ResultOverlay from "@/components/ResultOverlay";
import Countdown from "@/components/Countdown";
import { WalletButton } from "@/components/WalletProviders";
import { useGameSocket } from "@/hooks/useGameSocket";
import { buildJoinLobbyTransaction } from "@/lib/anchorClient";
import {
  fetchLobbies,
  fetchServerChainMode,
  loginMessage,
  requestNonce,
  verifyLogin,
} from "@/lib/api";
import { fmtL, fmtSol } from "@/lib/format";
import { DEMO_MODE, LOBBY_SIZE } from "@/lib/constants";

export default function GamePage() {
  const params = useParams<{ lobbyId: string }>();
  const rawLobbyId = params?.lobbyId;
  const lobbyId = typeof rawLobbyId === "string" ? decodeURIComponent(rawLobbyId) : "";

  const { connection } = useConnection();
  const { publicKey, connected, signMessage, sendTransaction } = useWallet();

  // Demo-Modus: per Build-Env erzwingbar (NEXT_PUBLIC_DEMO_MODE=1), sonst
  // zur Laufzeit erkannt — Server im Mock-Modus => Gast-Login + Join ohne Tx.
  const [demoMode, setDemoMode] = useState(DEMO_MODE);
  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    void fetchServerChainMode().then((chain) => {
      if (!cancelled && chain === "mock") setDemoMode(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Gast-Identität (nur Demo-Modus): flüchtiges Keypair im Speicher, signiert
  // den Login lokal — kein Wallet, kein SOL, keine Extension nötig.
  const [guest, setGuest] = useState<Keypair | null>(null);
  const activePubkey = publicKey ?? guest?.publicKey ?? null;
  const myWallet = activePubkey ? activePubkey.toBase58() : null;

  // ── Auth ────────────────────────────────────────────────────────────
  const [token, setToken] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);

  // ── Join ────────────────────────────────────────────────────────────
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinSig, setJoinSig] = useState<string | null>(null);

  // ── Pour (lokal, kosmetisch — Wahrheit kommt vom Server) ───────────
  const [pouring, setPouring] = useState(false);
  const [localLocked, setLocalLocked] = useState(false);
  const [expired, setExpired] = useState(false);
  const pouringRef = useRef(false);

  const socket = useGameSocket(lobbyId, token);
  const { lobbyState, roundConfig, pourResult, settled, sendJoin, sendPourStart, sendPourStop } =
    socket;

  // Join-Handshake: sobald eine Join-Signatur vorliegt und der Socket offen
  // ist, beim Server anmelden (Antwort: round_config). Idempotent — deckt
  // auch den Fall ab, dass der Socket erst nach doJoin aufgeht.
  useEffect(() => {
    if (joinSig && socket.status === "open" && !roundConfig) sendJoin(joinSig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinSig, socket.status]);

  // Wallet-Wechsel ⇒ Session verwerfen
  useEffect(() => {
    setToken(null);
    setJoinSig(null);
    pouringRef.current = false;
    setPouring(false);
    setLocalLocked(false);
    setExpired(false);
    setFlowError(null);
  }, [myWallet]);

  const me = useMemo(
    () => lobbyState?.players.find((p) => p.wallet === myWallet) ?? null,
    [lobbyState, myWallet],
  );
  const joined = me !== null || joinSig !== null;
  const played = pourResult !== null || me?.status === "done";
  const size = lobbyState?.size ?? LOBBY_SIZE;
  const doneCount = lobbyState
    ? lobbyState.players.filter((p) => p.status === "done").length
    : 0;
  const waitingCount = Math.max(0, size - doneCount);
  const locked = localLocked || played || expired;

  // ── Aktionen ────────────────────────────────────────────────────────
  const doLogin = useCallback(async () => {
    if (!publicKey || !signMessage) {
      setFlowError("Wallet unterstützt signMessage nicht.");
      return;
    }
    setAuthBusy(true);
    setFlowError(null);
    try {
      const wallet = publicKey.toBase58();
      const nonce = await requestNonce(wallet);
      const sigBytes = await signMessage(new TextEncoder().encode(loginMessage(nonce)));
      const newToken = await verifyLogin(wallet, nonce, bs58.encode(sigBytes));
      setToken(newToken);
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : "Login fehlgeschlagen.");
    } finally {
      setAuthBusy(false);
    }
  }, [publicKey, signMessage]);

  /** Gast-Login (DEMO_MODE): Keypair erzeugen und Nonce lokal signieren. */
  const doGuestLogin = useCallback(async () => {
    setAuthBusy(true);
    setFlowError(null);
    try {
      const kp = guest ?? Keypair.generate();
      if (!guest) setGuest(kp);
      const wallet = kp.publicKey.toBase58();
      const nonce = await requestNonce(wallet);
      const sigBytes = nacl.sign.detached(
        new TextEncoder().encode(loginMessage(nonce)),
        kp.secretKey,
      );
      const newToken = await verifyLogin(wallet, nonce, bs58.encode(sigBytes));
      setToken(newToken);
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : "Gast-Login fehlgeschlagen.");
    } finally {
      setAuthBusy(false);
    }
  }, [guest]);

  const doJoin = useCallback(async () => {
    if (!activePubkey) return;
    setJoinBusy(true);
    setFlowError(null);
    try {
      if (demoMode) {
        // Testphase: keine On-Chain-Transaktion — der Mock-Server (CHAIN=mock)
        // akzeptiert jede Signatur. Kein Entry-Fee-Transfer, reiner UI-/Flow-Test.
        setJoinSig(`demo-${activePubkey.toBase58().slice(0, 8)}-${Date.now()}`);
        return;
      }
      if (!publicKey) throw new Error("Ohne Wallet nur im Demo-Modus spielbar.");
      const idNum = BigInt(lobbyId);
      const tx = await buildJoinLobbyTransaction(connection, idNum, publicKey);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      setJoinSig(sig);
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : "Join-Transaktion fehlgeschlagen.");
    } finally {
      setJoinBusy(false);
    }
  }, [activePubkey, publicKey, demoMode, lobbyId, connection, sendTransaction]);

  const canPour =
    joined && token !== null && roundConfig !== null && !locked && socket.status === "open";

  const startPour = useCallback(() => {
    if (!canPour || pouringRef.current) return;
    pouringRef.current = true;
    setPouring(true);
    sendPourStart();
  }, [canPour, sendPourStart]);

  const endPour = useCallback(() => {
    if (!pouringRef.current) return;
    pouringRef.current = false;
    setPouring(false);
    setLocalLocked(true);
    sendPourStop();
  }, [sendPourStop]);

  // Loslassen irgendwo auf der Seite beendet den Zapf (wie im Demo)
  useEffect(() => {
    if (!pouring) return;
    const up = () => endPour();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
    };
  }, [pouring, endPour]);

  const onExpire = useCallback(() => {
    if (!played) {
      setExpired(true);
      endPour();
    }
  }, [played, endPour]);

  // ── Nochmal spielen: in die nächste offene Lobby springen ───────────
  // Voller Seitenwechsel (kein Client-Routing) — setzt sämtlichen
  // Runden-State inkl. WebSocket sauber zurück.
  const [againBusy, setAgainBusy] = useState(false);
  const goNextRound = useCallback(async () => {
    setAgainBusy(true);
    try {
      const list = await fetchLobbies();
      const next = list.find(
        (l) => l.lobbyId !== lobbyId && l.status.toLowerCase() === "open",
      );
      window.location.assign(next ? `/game/${next.lobbyId}` : "/");
    } catch {
      window.location.assign("/");
    }
  }, [lobbyId]);

  // ── Anzeige ─────────────────────────────────────────────────────────
  const overlayOpen = pourResult !== null || settled !== null;

  let holdLabel = "GEDRÜCKT HALTEN ZUM ZAPFEN";
  if (pouring) holdLabel = "ZAPFT …";
  else if (played || localLocked) holdLabel = "ABGEGEBEN";
  else if (expired) holdLabel = "ZEIT ABGELAUFEN";

  const awaitingRandomness =
    (lobbyState?.status ?? "").toLowerCase() === "awaiting_randomness";

  let flowStep: "connect" | "login" | "vrf" | "join" | "waiting" | "play" = "play";
  if (!connected && !guest) flowStep = "connect";
  else if (!token) flowStep = "login";
  else if (!joined && awaitingRandomness) flowStep = "vrf";
  else if (!joined) flowStep = "join";
  else if (!roundConfig) flowStep = "waiting";

  return (
    <div className="game-shell">
      <header>
        <Link href="/">
          <div className="logo">
            ZAPF ROYALE<small>PVP · SOLANA</small>
          </div>
        </Link>
        <div className="header-right">
          <div className="pot">
            POT <b>{fmtSol(lobbyState?.potLamports ?? 0)}</b>
          </div>
          <WalletButton />
        </div>
      </header>

      <PlayerChips players={lobbyState?.players ?? []} size={size} myWallet={myWallet} />

      {roundConfig && !played && !expired ? (
        <>
          <div className="target-banner">
            🎯 DEIN ZIEL: <b>{fmtL(roundConfig.targetMl)}</b> — die Marken sind beim Zapfen
            unsichtbar: stoppe nach Gefühl!
          </div>
          <Countdown deadlineTs={roundConfig.deadlineTs} onExpire={onExpire} />
        </>
      ) : null}

      <TapScene
        targetMl={roundConfig?.targetMl ?? null}
        pressure={roundConfig?.pressure ?? 1}
        pouring={pouring}
        locked={locked}
        hideMarks={roundConfig !== null && !locked}
        resetKey={roundConfig ? `${roundConfig.deadlineTs}` : "idle"}
        onLocalOverflow={endPour}
        onStagePointerDown={(e) => {
          e.preventDefault();
          startPour();
        }}
      />

      <div className="controls">
        {flowStep === "connect" ? (
          <div className="flow-panel">
            {demoMode ? (
              <>
                <button
                  className="hold-btn"
                  onClick={() => void doGuestLogin()}
                  disabled={authBusy}
                >
                  {authBusy ? "ANMELDEN …" : "ALS GAST ZAPFEN (DEMO)"}
                </button>
                <div className="msg">Testphase: ohne Wallet spielen — oder unten Wallet verbinden.</div>
              </>
            ) : (
              <div className="msg">Wallet verbinden, um mitzuzapfen (Phantom / Solflare, devnet)</div>
            )}
            <WalletButton />
          </div>
        ) : flowStep === "login" ? (
          <div className="flow-panel">
            <button className="hold-btn" onClick={() => void doLogin()} disabled={authBusy}>
              {authBusy ? "SIGNIERE …" : "MIT WALLET ANMELDEN"}
            </button>
            <div className="msg">Gasfreier Login: Du signierst nur eine Nachricht.</div>
          </div>
        ) : flowStep === "vrf" ? (
          <div className="flow-panel">
            <button className="hold-btn" disabled>
              WÜRFELT ZIEL AUS …
            </button>
            <div className="msg">
              <span className={`ws-dot${socket.status === "open" ? " open" : ""}`} />
              Das MagicBlock-VRF-Oracle liefert gerade die Zufallszahl on-chain — der
              Beitritt wird freigeschaltet, sobald Ziel &amp; Fassdruck feststehen.
            </div>
          </div>
        ) : flowStep === "join" ? (
          <div className="flow-panel">
            <button className="hold-btn" onClick={() => void doJoin()} disabled={joinBusy}>
              {joinBusy
                ? "TRANSAKTION LÄUFT …"
                : demoMode
                  ? "MITSPIELEN (DEMO — KEIN EINSATZ)"
                  : `EINSATZ ZAHLEN · ${fmtSol(lobbyState?.entryFeeLamports ?? 0)}`}
            </button>
            <div className="msg">
              <span className={`ws-dot${socket.status === "open" ? " open" : ""}`} />
              {demoMode
                ? "Demo-Modus: Testphase ohne echte Transaktion."
                : "Einsatz geht in den Lobby-Vault (on-chain, devnet)."}
            </div>
          </div>
        ) : flowStep === "waiting" ? (
          <div className="flow-panel">
            <button className="hold-btn" disabled>
              WARTE AUF RUNDENSTART …
            </button>
            <div className="msg">
              <span className={`ws-dot${socket.status === "open" ? " open" : ""}`} />
              Join wird bestätigt — gleich bekommst du Ziel &amp; Fassdruck.
            </div>
          </div>
        ) : (
          <>
            <button
              className={`hold-btn${pouring ? " down" : ""}`}
              disabled={!canPour && !pouring}
              onPointerDown={(e) => {
                e.preventDefault();
                startPour();
              }}
            >
              {holdLabel}
            </button>
            <div className="hint">1 VERSUCH · LOSLASSEN = ABGABE</div>
          </>
        )}
        {flowError ? (
          <div className="flow-panel">
            <div className="msg err">{flowError}</div>
          </div>
        ) : null}
        {socket.lastError ? (
          <div className="flow-panel">
            <div className="msg err">{socket.lastError}</div>
          </div>
        ) : null}
      </div>

      <ResultOverlay
        open={overlayOpen}
        result={pourResult}
        targetMl={roundConfig?.targetMl ?? 1000}
        waitingCount={waitingCount}
        settled={settled}
        myWallet={myWallet}
        onAgain={() => void goNextRound()}
        againBusy={againBusy}
      />
    </div>
  );
}
