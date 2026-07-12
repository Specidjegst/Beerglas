"use client";

/**
 * Result-Overlay wie im Demo (showResult) + Gewinner-Reveal nach Settlement.
 * Phase 1: eigenes Ergebnis (Accuracy %, Verdikt, "Warten auf N Spieler …").
 * Phase 2: settled → Gewinner, Payouts in ◎, Explorer-Link, VRF-Randomness.
 */
import type { PourResult, SettledInfo } from "@/hooks/useGameSocket";
import { accuracyPct, fmtL, fmtSol, shortAddress, verdictColor, verdictFor } from "@/lib/format";
import { explorerUrl } from "@/lib/constants";

/** 64-Hex-Zeichen-Randomness gekürzt darstellen (Anfang…Ende). */
function shortHex(hex: string, edge = 10): string {
  return hex.length > edge * 2 + 1 ? `${hex.slice(0, edge)}…${hex.slice(-edge)}` : hex;
}

export interface ResultOverlayProps {
  open: boolean;
  result: PourResult | null;
  targetMl: number;
  /** Anzahl Spieler, auf die noch gewartet wird */
  waitingCount: number;
  settled: SettledInfo | null;
  myWallet: string | null;
}

export default function ResultOverlay({
  open,
  result,
  targetMl,
  waitingCount,
  settled,
  myWallet,
}: ResultOverlayProps) {
  const acc = result ? accuracyPct(result.pouredMl, targetMl, result.overflow) : 0;

  return (
    <div className={`overlay${open ? " show" : ""}`}>
      <div className="card">
        {settled ? (
          <>
            <div
              className="verdict"
              style={{
                color:
                  myWallet && settled.winners.includes(myWallet)
                    ? "var(--good)"
                    : "var(--brass)",
              }}
            >
              {myWallet && settled.winners.includes(myWallet)
                ? "DU HAST GEWONNEN!"
                : "RUNDE BEENDET"}
            </div>
            <div className="acc">{fmtSol(settled.payoutLamports)}</div>
            <div className="detail">
              {settled.winners.length > 1 ? "Gewinner (Pot geteilt)" : "Gewinner"}:{" "}
              {settled.winners.map((w, i) => (
                <b key={w}>
                  {i > 0 ? " · " : ""}
                  {shortAddress(w)}
                  {myWallet === w ? " (DU)" : ""}
                </b>
              ))}
            </div>
            <div className="detail" style={{ marginTop: 6 }}>
              Fee (4 %): <b>{fmtSol(settled.feeLamports, 4)}</b>
            </div>
            {result ? (
              <div className="detail" style={{ marginTop: 6 }}>
                Dein Zapf: <b>{result.overflow ? "> 1,6 L" : fmtL(result.pouredMl)}</b> · Ziel{" "}
                <b>{fmtL(targetMl)}</b>
              </div>
            ) : null}
            {settled.txSig ? (
              <a
                className="explorer-link"
                href={explorerUrl("tx", settled.txSig)}
                target="_blank"
                rel="noreferrer"
              >
                Settlement im Explorer ansehen ↗
              </a>
            ) : null}
            {settled.randomness ? (
              <div className="seed-line">
                VRF-Randomness: <code>{shortHex(settled.randomness)}</code>
              </div>
            ) : null}
          </>
        ) : result ? (
          <>
            <div className="verdict" style={{ color: verdictColor(acc) }}>
              {verdictFor(acc, result.overflow)}
            </div>
            <div className="acc">{acc.toFixed(1)}%</div>
            <div className="detail">
              Gezapft <b>{result.overflow ? "> 1,6 L" : fmtL(result.pouredMl)}</b> · Ziel{" "}
              <b>{fmtL(targetMl)}</b>
            </div>
            <div className="detail" style={{ marginTop: 6 }}>
              {waitingCount > 0
                ? `Warten auf ${waitingCount} Spieler …`
                : "Alle fertig — Settlement läuft …"}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
