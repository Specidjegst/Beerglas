import { LAMPORTS_PER_SOL } from "./constants";

/** ml → "1,0 L" / "0,98 L" (deutsches Komma, wie im Demo). */
export function fmtL(ml: number): string {
  return (ml / 1000).toFixed(ml % 500 === 0 ? 1 : 2).replace(".", ",") + " L";
}

/** Lamports → SOL (Zahl). */
export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

/** Lamports → "0.50 ◎" */
export function fmtSol(lamports: number | bigint, digits = 2): string {
  return lamportsToSol(lamports).toFixed(digits) + " ◎";
}

/** "7xKqabc…F2ah" → gekürzte Wallet-Anzeige wie im Demo ("7xKq…F2ah"). */
export function shortAddress(addr: string, len = 4): string {
  if (addr.length <= len * 2 + 1) return addr;
  return addr.slice(0, len) + "…" + addr.slice(-len);
}

/** Sekunden → "0:47" */
export function fmtCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Accuracy in % nach Demo-Logik (Overflow ⇒ 0). */
export function accuracyPct(pouredMl: number, targetMl: number, overflow: boolean): number {
  if (overflow) return 0;
  const diff = Math.abs(pouredMl - targetMl);
  return Math.max(0, 100 - (diff / targetMl) * 100);
}

/** Verdikt-Text exakt wie im Demo (showResult). */
export function verdictFor(acc: number, overflow: boolean): string {
  if (overflow) return "ÜBERGELAUFEN!";
  if (acc >= 99.2) return "PERFEKT GEZAPFT!";
  if (acc >= 96) return "SAUBER GEZAPFT!";
  if (acc >= 88) return "NICHT SCHLECHT";
  return "DANEBEN …";
}

/** Verdikt-Farbe wie im Demo: gut ≥96, schlecht <60, sonst Messing. */
export function verdictColor(acc: number): string {
  if (acc >= 96) return "var(--good)";
  if (acc < 60) return "var(--bad)";
  return "var(--brass)";
}
