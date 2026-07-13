"use client";

/**
 * Lobby-Liste: offene Lobbies vom Game-Server (GET /lobbies), Header wie im
 * Demo (Logo + POT-Pille) plus Wallet-Connect, prominenter Devnet-Disclaimer.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchLobbies, type LobbySummary } from "@/lib/api";
import { fmtSol } from "@/lib/format";
import { SERVER_URL } from "@/lib/constants";
import LobbyCard from "@/components/LobbyCard";
import HowToPlay from "@/components/HowToPlay";
import { WalletButton } from "@/components/WalletProviders";

export default function LobbyListPage() {
  const [lobbies, setLobbies] = useState<LobbySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchLobbies();
      setLobbies(list);
      setError(null);
    } catch {
      setError(`Game-Server nicht erreichbar (${SERVER_URL}).`);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 5000);
    return () => clearInterval(iv);
  }, [load]);

  const open = (lobbies ?? []).filter((l) => l.status.toLowerCase() !== "settled");
  const totalPot = open.reduce((sum, l) => sum + l.potLamports, 0);

  return (
    <>
      <header>
        <div className="logo">
          ZAPF ROYALE<small>PVP · SOLANA</small>
        </div>
        <div className="header-right">
          <div className="pot">
            POT <b>{fmtSol(totalPot)}</b>
          </div>
          <WalletButton />
        </div>
      </header>

      <div className="page">
        <div className="nav-links">
          <Link href="/" className="active">
            LOBBIES
          </Link>
          <Link href="/stats">STATS &amp; FAIRNESS</Link>
        </div>

        <h1>Offene Lobbies</h1>
        <div className="sub">EINSATZ ZAHLEN · ZAPFEN · POT GEWINNEN</div>

        <div className="disclaimer">
          <b>DEVNET-HINWEIS:</b> ZAPF ROYALE läuft ausschließlich auf dem Solana{" "}
          <b>devnet</b> — es wird kein echtes Geld eingesetzt. Spiele mit Echtgeld-Einsatz
          können je nach Rechtsordnung als Glücksspiel reguliert sein. Dieses Projekt ist
          ein Technik-Demo, kein Glücksspielangebot.
        </div>

        {error ? (
          <div className="error-note">{error}</div>
        ) : lobbies === null ? (
          <div className="empty-note">Lade Lobbies …</div>
        ) : open.length === 0 ? (
          <div className="empty-note">
            Gerade keine offene Lobby. Der Server eröffnet automatisch neue Runden —
            gleich nochmal schauen.
          </div>
        ) : (
          <div className="lobby-list">
            {open.map((l) => (
              <LobbyCard key={l.lobbyId} lobby={l} />
            ))}
          </div>
        )}

        <HowToPlay />
      </div>
    </>
  );
}
