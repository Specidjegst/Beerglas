"use client";

/**
 * Spielerchips-Leiste wie im Demo: 5 Chips, eigener hervorgehoben,
 * Status wartet / zapft / fertig, freie Plätze als "— FREI —".
 */
import type { PlayerState } from "@/hooks/useGameSocket";
import { shortAddress } from "@/lib/format";
import { LOBBY_SIZE } from "@/lib/constants";

const STATUS_LABEL: Record<string, string> = {
  waiting: "wartet",
  pouring: "zapft …",
  done: "fertig",
};

export interface PlayerChipsProps {
  players: PlayerState[];
  size?: number;
  myWallet?: string | null;
}

export default function PlayerChips({ players, size = LOBBY_SIZE, myWallet }: PlayerChipsProps) {
  const slots: (PlayerState | null)[] = [];
  for (let i = 0; i < size; i++) slots.push(players[i] ?? null);

  return (
    <div className="players">
      {slots.map((p, i) => {
        if (!p) {
          return (
            <div className="chip chip-free" key={`free-${i}`}>
              — FREI —<span className="st">offen</span>
            </div>
          );
        }
        const me = myWallet !== null && myWallet !== undefined && p.wallet === myWallet;
        return (
          <div className={`chip${me ? " me" : ""}`} key={p.wallet}>
            {shortAddress(p.wallet)}
            <span className="st">
              {me && p.status === "waiting" ? "DU BIST DRAN" : (STATUS_LABEL[p.status] ?? p.status)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
