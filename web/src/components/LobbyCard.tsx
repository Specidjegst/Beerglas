"use client";

/** Karte einer offenen Lobby: Entry Fee (◎), Plätze x/5, Pot. */
import Link from "next/link";
import type { LobbySummary } from "@/lib/api";
import { fmtSol } from "@/lib/format";

export default function LobbyCard({ lobby }: { lobby: LobbySummary }) {
  const full = lobby.playersJoined >= lobby.size;
  return (
    <Link href={`/game/${encodeURIComponent(lobby.lobbyId)}`} className="lobby-card">
      <div className="lobby-card-head">
        <span className="lobby-id">LOBBY #{lobby.lobbyId}</span>
        <span className={`lobby-status${full ? " full" : ""}`}>
          {full ? "VOLL" : "OFFEN"}
        </span>
      </div>
      <div className="lobby-card-grid">
        <div>
          <div className="lbl">EINSATZ</div>
          <div className="val">{fmtSol(lobby.entryFeeLamports)}</div>
        </div>
        <div>
          <div className="lbl">PLÄTZE</div>
          <div className="val">
            {lobby.playersJoined}/{lobby.size}
          </div>
        </div>
        <div>
          <div className="lbl">POT</div>
          <div className="val brass">{fmtSol(lobby.potLamports)}</div>
        </div>
      </div>
      <div className="lobby-card-cta">{full ? "ZUSCHAUEN" : "MITZAPFEN →"}</div>
    </Link>
  );
}
