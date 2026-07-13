"use client";

/**
 * Spielanleitung "SO WIRD GEZAPFT" — erklärt Ziel-Marken, Fassdruck, Schaum
 * und Gewinnregel. Wird auf der Lobby-Liste angezeigt; die Mini-Grafik zeigt
 * den Maßkrug mit den drei Eichstrichen (0,5 / 1,0 / 1,5 L).
 */

function MiniKrug() {
  // Vereinfachter Maßkrug mit den drei Marken; 1,0 L als "aktives Ziel".
  return (
    <svg viewBox="0 0 120 150" width="96" height="120" aria-hidden="true">
      <path
        d="M30,12 L90,12 L86,138 Q86,144 80,144 L40,144 Q34,144 34,138 Z"
        fill="rgba(210,225,235,.07)"
        stroke="rgba(230,240,250,.4)"
        strokeWidth="2"
      />
      <path
        d="M90,40 Q112,44 112,78 Q112,112 88,116"
        fill="none"
        stroke="rgba(230,240,250,.35)"
        strokeWidth="8"
        strokeLinecap="round"
      />
      {/* Bier bis knapp unter die 1,0-L-Marke */}
      <path d="M36,84 L84,84 L82,138 Q82,141 79,141 L41,141 Q38,141 38,138 Z" fill="#E89B1C" opacity=".85" />
      <rect x="36" y="76" width="47" height="9" rx="4" fill="#FFF6E0" opacity=".9" />
      {/* Marken */}
      <line x1="38" y1="120" x2="58" y2="120" stroke="rgba(230,240,250,.5)" strokeWidth="1.5" />
      <text x="61" y="123" fontSize="9" fill="rgba(230,240,250,.6)" fontFamily="monospace">
        0,5 L
      </text>
      <line x1="38" y1="82" x2="82" y2="82" stroke="#EDE7D8" strokeWidth="2.4" strokeDasharray="6 4" />
      <text x="61" y="77" fontSize="10" fill="#EDE7D8" fontFamily="monospace" fontWeight="bold">
        1,0 L ← ZIEL
      </text>
      <line x1="38" y1="44" x2="58" y2="44" stroke="rgba(230,240,250,.5)" strokeWidth="1.5" />
      <text x="61" y="47" fontSize="9" fill="rgba(230,240,250,.6)" fontFamily="monospace">
        1,5 L
      </text>
    </svg>
  );
}

export default function HowToPlay() {
  return (
    <section className="howto">
      <h2>So wird gezapft 🍺</h2>
      <div className="howto-grid">
        <div className="howto-krug">
          <MiniKrug />
        </div>
        <ol className="howto-steps">
          <li>
            <b>Lobby beitreten.</b> Einsatz zahlen (in der Testphase: einfach{" "}
            <b>„Als Gast zapfen“</b> — kostenlos, ohne Wallet).
          </li>
          <li>
            <b>Dein Ziel wird ausgelost.</b> Jede Runde bekommt per{" "}
            <b>VRF-Zufall</b> eine der drei Marken am Krug als Ziel:{" "}
            <b>0,5&nbsp;L, 1,0&nbsp;L oder 1,5&nbsp;L</b>. Die Ziel-Marke{" "}
            <b>leuchtet gestrichelt</b> und steht groß oben links (ZIEL). Alle
            Spieler der Lobby haben dasselbe Ziel.
          </li>
          <li>
            <b>Achte auf den Fassdruck!</b> Auch der wird ausgelost (Anzeige
            oben rechts): je höher der Druck, desto <b>schneller</b> läuft das
            Bier — und desto schneller wächst der <b>Schaum</b>.
          </li>
          <li>
            <b>Halten = zapfen, loslassen = abgeben.</b> Du hast{" "}
            <b>genau 1 Versuch</b> und <b>60 Sekunden</b> Zeit. Lass genau an
            der Ziel-Marke los!
          </li>
          <li>
            <b>Nicht überlaufen lassen:</b> Wenn Bier + Schaum über den Rand
            gehen, ist der Versuch automatisch verloren.
          </li>
          <li>
            <b>Gewonnen hat,</b> wer am nächsten an der Ziel-Marke landet — der
            Pot geht an den Sieger (bei Gleichstand wird geteilt, 4 % Gebühr,
            alles on-chain nachprüfbar unter <b>Stats &amp; Fairness</b>).
          </li>
        </ol>
      </div>
    </section>
  );
}
