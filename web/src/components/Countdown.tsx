"use client";

/**
 * Großer 60-s-Countdown (Spielzeit ab Join-Bestätigung).
 * Tickt clientseitig gegen deadlineTs (ms); Wahrheit bleibt der Server.
 */
import { useEffect, useState } from "react";
import { fmtCountdown } from "@/lib/format";

export interface CountdownProps {
  deadlineTs: number; // Unix ms
  onExpire?: () => void;
}

export default function Countdown({ deadlineTs, onExpire }: CountdownProps) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    let fired = false;
    const tick = () => {
      const rest = (deadlineTs - Date.now()) / 1000;
      setRemaining(rest);
      if (rest <= 0 && !fired) {
        fired = true;
        onExpire?.();
      }
    };
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, [deadlineTs, onExpire]);

  if (remaining === null) return null;
  const danger = remaining <= 10;

  return (
    <div className={`countdown${danger ? " danger" : ""}`} aria-live="polite">
      <span className="countdown-num">{fmtCountdown(remaining)}</span>
      <span className="countdown-lbl">ZEIT FÜR DEINEN ZAPF</span>
    </div>
  );
}
