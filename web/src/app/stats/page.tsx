"use client";

/**
 * /stats — Transparenz-Seite:
 * GlobalStats direkt on-chain (PDA [b"stats"]), Fee klar als 4 % gelabelt,
 * letzte Settlements mit Explorer-Links, Erklärung der VRF-Fairness
 * (MagicBlock Ephemeral VRF).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  fetchGlobalStats,
  getProgramId,
  statsPda,
  type GlobalStatsView,
} from "@/lib/anchorClient";
import { fetchRecentSettlements, type SettlementInfo } from "@/lib/api";
import { explorerUrl, FEE_BPS } from "@/lib/constants";
import { fmtSol, shortAddress } from "@/lib/format";
import { WalletButton } from "@/components/WalletProviders";

export default function StatsPage() {
  const { connection } = useConnection();
  const [stats, setStats] = useState<GlobalStatsView | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [settlements, setSettlements] = useState<SettlementInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [s, list] = await Promise.all([
        fetchGlobalStats(connection),
        fetchRecentSettlements(),
      ]);
      if (cancelled) return;
      setStats(s);
      setStatsLoaded(true);
      setSettlements(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const programId = getProgramId();
  const statsAddress = programId ? statsPda(programId).toBase58() : null;

  return (
    <>
      <header>
        <Link href="/">
          <div className="logo">
            ZAPF ROYALE<small>PVP · SOLANA</small>
          </div>
        </Link>
        <div className="header-right">
          <WalletButton />
        </div>
      </header>

      <div className="page">
        <div className="nav-links">
          <Link href="/">LOBBIES</Link>
          <Link href="/stats" className="active">
            STATS &amp; FAIRNESS
          </Link>
        </div>

        <h1>Transparenz</h1>
        <div className="sub">GLOBALSTATS · DIREKT ON-CHAIN GELESEN (DEVNET)</div>

        {stats ? (
          <div className="stats-grid">
            <div className="stat-tile">
              <div className="lbl">GESETTELTE SPIELE</div>
              <div className="val">{stats.totalGamesSettled.toString()}</div>
            </div>
            <div className="stat-tile">
              <div className="lbl">GESAMTVOLUMEN</div>
              <div className="val">{fmtSol(stats.totalVolumeLamports, 3)}</div>
            </div>
            <div className="stat-tile">
              <div className="lbl">FEES (4&nbsp;% / 400&nbsp;BPS)</div>
              <div className="val brass">{fmtSol(stats.totalFeesLamports, 4)}</div>
            </div>
          </div>
        ) : (
          <div className="empty-note">
            {statsLoaded
              ? "GlobalStats-Account noch nicht gefunden — Programm ggf. noch nicht deployed oder NEXT_PUBLIC_PROGRAM_ID nicht gesetzt."
              : "Lese GlobalStats on-chain …"}
          </div>
        )}

        <div className="disclaimer">
          <b>FEE-MODELL:</b> Pro Spiel gehen exakt <b>4&nbsp;%</b> (400 Basispunkte) des Pots
          als Operator-Fee an die Treasury — festgeschrieben in der Config-PDA, jede Änderung
          emittiert ein On-Chain-Event. Der Rest wird vollständig an die Gewinner ausgezahlt.
        </div>

        {programId && statsAddress ? (
          <div className="fairness" style={{ marginTop: 12 }}>
            <h2>ON-CHAIN NACHPRÜFEN</h2>
            Programm:{" "}
            <a
              className="explorer-link"
              style={{ marginTop: 0 }}
              href={explorerUrl("address", programId.toBase58())}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(programId.toBase58(), 6)} ↗
            </a>
            <br />
            GlobalStats-PDA (<code>[b&quot;stats&quot;]</code>):{" "}
            <a
              className="explorer-link"
              style={{ marginTop: 0 }}
              href={explorerUrl("address", statsAddress)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(statsAddress, 6)} ↗
            </a>
          </div>
        ) : null}

        <h1 style={{ marginTop: 26 }}>Letzte Settlements</h1>
        <div className="sub">POT · FEE ({(FEE_BPS / 100).toFixed(0)}&nbsp;%) · GEWINNER · TX</div>
        {settlements.length === 0 ? (
          <div className="empty-note">
            Noch keine Settlements gemeldet (oder Server offline). Jedes Settlement ist
            unabhängig davon on-chain als <code>LobbySettled</code>-Event nachlesbar.
          </div>
        ) : (
          settlements.map((s) => (
            <div className="settlement-row" key={s.txSig || s.lobbyId}>
              <span>
                LOBBY <b>#{s.lobbyId}</b>
                <br />
                Pot <b>{fmtSol(s.potLamports)}</b> · Fee <b>{fmtSol(s.feeLamports, 4)}</b>
                <br />
                {s.winners.length > 1 ? "Gewinner (geteilt): " : "Gewinner: "}
                {s.winners.map((w) => shortAddress(w)).join(" · ")}
              </span>
              {s.txSig ? (
                <a href={explorerUrl("tx", s.txSig)} target="_blank" rel="noreferrer">
                  Explorer ↗
                </a>
              ) : null}
            </div>
          ))
        )}

        <div className="fairness">
          <h2>PROVABLE FAIRNESS (MAGICBLOCK EPHEMERAL VRF)</h2>
          Ziel-Marke und Fassdruck jeder Lobby stammen aus einer <b>verifizierbaren
          Zufallsfunktion (VRF)</b>: Beim Erstellen der Lobby fordert das Programm per CPI
          Zufall beim MagicBlock-Ephemeral-VRF-Oracle an. Das Oracle liefert die 32-Byte-
          Randomness anschließend per <b>On-Chain-Callback</b> zurück — kryptografisch
          verifiziert, und nur die VRF-Programm-Identität (Programm{" "}
          <code>Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz</code>) kann diesen Callback
          signieren. Weder unser Server noch die Spieler können die Zahl wählen oder
          vorhersagen. Die Ableitung ist deterministisch und für jeden nachrechenbar:
          Ziel = <code>randomness[0] % 3</code> → 0,5&nbsp;/&nbsp;1,0&nbsp;/&nbsp;1,5&nbsp;L,
          Fassdruck aus den Bytes&nbsp;1–2 (linear auf 0,8–1,3 abgebildet). Solange das
          Oracle noch nicht geliefert hat, ist die Lobby gesperrt — beitreten kann man erst,
          wenn Ziel &amp; Druck on-chain feststehen. Details &amp; Quellcode:{" "}
          <a
            className="explorer-link"
            style={{ marginTop: 0 }}
            href="https://github.com/magicblock-labs/ephemeral-vrf"
            target="_blank"
            rel="noreferrer"
          >
            github.com/magicblock-labs/ephemeral-vrf ↗
          </a>
        </div>

        <div className="disclaimer">
          <b>DEVNET-HINWEIS:</b> Nur Solana devnet, kein echtes Geld. Echtgeld-Varianten
          können als Glücksspiel reguliert sein.
        </div>
      </div>
    </>
  );
}
