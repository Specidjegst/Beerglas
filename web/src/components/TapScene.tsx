"use client";

/**
 * 1:1-Port der SVG-Szene aus docs/zapf-royale-v2.html:
 * Maßkrug mit 3 geätzten Marken (aktive Ziel-Marke glühend gestrichelt),
 * Chrom-Zapfsäule mit kippendem Griff (-46° beim Zapfen), Messing-Badge,
 * Manometer (FASSDRUCK), Bierstrahl mit Wobble, Wellen-Oberfläche, Blasen,
 * Schaum-Blobs, Kondensation, Splash-Partikel, Holztheke.
 *
 * Die Komponente läuft als kosmetische Client-Simulation mit denselben
 * Konstanten wie der Server (constants.ts) — gesteuert über die Props
 * pouring/pressure. Die finale Zahl liefert IMMER der Server; bei lokalem
 * Überlauf wird onLocalOverflow gefeuert, damit die Seite pour_stop sendet.
 *
 * Rendering pro Frame über direkte DOM-Refs (kein React-State im rAF-Loop).
 */
import { useEffect, useRef } from "react";
import {
  BASE_RATE_ML_S,
  CAPACITY_ML,
  FOAM_BASE_ML_S,
  FOAM_PRESSURE_EXP,
  MARKS_ML,
  OVERFLOW_FOAM_FACTOR,
} from "@/lib/constants";
import { fmtL } from "@/lib/format";

const CAP = CAPACITY_ML;
const INNER_TOP = 176;
const INNER_BOT = 500;
const INNER_H = INNER_BOT - INNER_TOP;
const NS = "http://www.w3.org/2000/svg";

const yForMl = (ml: number): number => INNER_BOT - (ml / CAP) * INNER_H;

interface Bubble {
  el: SVGCircleElement;
  x: number;
  y: number;
  v: number;
  drift: number;
}

interface Splash {
  el: SVGCircleElement;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export interface TapSceneProps {
  /** Ziel-Marke in ml — null solange die Runde noch nicht ausgelost ist
   *  (HUD zeigt dann "?" und keine Marke leuchtet). */
  targetMl: number | null;
  pressure: number;
  /** true, solange der Spieler den Zapfhahn hält (Server bekommt pour_start/stop separat) */
  pouring: boolean;
  /** true nach Abgabe/Timeout — Simulation friert ein */
  locked: boolean;
  /** Bei Änderung wird die lokale Simulation auf 0 zurückgesetzt */
  resetKey?: string | number;
  /** Lokaler (kosmetischer) Überlauf — Seite sollte pour_stop senden */
  onLocalOverflow?: () => void;
  /** pointerdown auf der Bühne startet ebenfalls das Zapfen (wie im Demo) */
  onStagePointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Während der aktiven Runde werden die Eichstriche unsichtbar — gestoppt
   *  wird nach Gefühl; nach der Abgabe blenden sie zur Auflösung wieder ein. */
  hideMarks?: boolean;
}

export default function TapScene({
  targetMl,
  pressure,
  pouring,
  locked,
  resetKey,
  onLocalOverflow,
  onStagePointerDown,
  hideMarks = false,
}: TapSceneProps) {
  const liquidRef = useRef<SVGPathElement>(null);
  const liquidEdgeRef = useRef<SVGPathElement>(null);
  const foamRef = useRef<SVGPathElement>(null);
  const streamGroupRef = useRef<SVGGElement>(null);
  const streamPathRef = useRef<SVGPathElement>(null);
  const splashGRef = useRef<SVGGElement>(null);
  const bubblesGRef = useRef<SVGGElement>(null);
  const condGRef = useRef<SVGGElement>(null);
  const handleRef = useRef<SVGGElement>(null);

  // Aktuelle Props für den rAF-Loop (kein Re-Subscribe pro Frame)
  const propsRef = useRef({ pouring, locked, pressure, onLocalOverflow });
  propsRef.current = { pouring, locked, pressure, onLocalOverflow };

  // Simulationszustand (rein kosmetisch)
  const simRef = useRef({
    fill: 0,
    foamMl: 0,
    time: 0,
    lastT: 0,
    waveAmp: 0,
    overflowed: false,
    overflowNotified: false,
    bubbles: [] as Bubble[],
    splashes: [] as Splash[],
  });

  // Reset bei neuer Runde
  useEffect(() => {
    const sim = simRef.current;
    sim.fill = 0;
    sim.foamMl = 0;
    sim.waveAmp = 0;
    sim.overflowed = false;
    sim.overflowNotified = false;
    sim.bubbles.forEach((b) => b.el.remove());
    sim.bubbles = [];
    sim.splashes.forEach((s) => s.el.remove());
    sim.splashes = [];
    if (condGRef.current) condGRef.current.style.opacity = "0";
  }, [resetKey, targetMl, pressure]);

  // Griff kippen + Strahl ein-/ausblenden (wie startPour/endPour im Demo)
  useEffect(() => {
    const handle = handleRef.current;
    const streamGroup = streamGroupRef.current;
    if (handle) {
      handle.setAttribute("transform", pouring ? "rotate(-46 160 26)" : "rotate(0 160 26)");
    }
    if (streamGroup) streamGroup.setAttribute("opacity", pouring ? "1" : "0");
    if (pouring && typeof navigator !== "undefined" && "vibrate" in navigator) {
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!reduce) navigator.vibrate(10);
    }
  }, [pouring]);

  // rAF-Loop + Kondensationstropfen (nur Client)
  useEffect(() => {
    const liquid = liquidRef.current;
    const liquidEdge = liquidEdgeRef.current;
    const foamEl = foamRef.current;
    const streamPath = streamPathRef.current;
    const splashG = splashGRef.current;
    const bubblesG = bubblesGRef.current;
    const condG = condGRef.current;
    if (!liquid || !liquidEdge || !foamEl || !streamPath || !splashG || !bubblesG || !condG) {
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sim = simRef.current;

    // Kondensationstropfen (statische Zufallspositionen, einmalig)
    condG.innerHTML = "";
    for (let i = 0; i < 26; i++) {
      const c = document.createElementNS(NS, "circle");
      const y = 210 + Math.random() * 270;
      const spread = 52 - ((y - INNER_TOP) / INNER_H) * 4;
      c.setAttribute("cx", String(160 + (Math.random() * 2 - 1) * spread));
      c.setAttribute("cy", String(y));
      c.setAttribute("r", (1 + Math.random() * 2.4).toFixed(1));
      c.setAttribute("fill", "url(#dropG)");
      condG.appendChild(c);
    }

    function wavePath(surfY: number, amp: number): string {
      let d = `M92,${INNER_BOT + 10} L92,${(surfY + amp * Math.sin(sim.time * 3)).toFixed(1)} `;
      for (let x = 92; x <= 228; x += 8) {
        const y =
          surfY +
          Math.sin(x * 0.09 + sim.time * 4) * amp +
          Math.sin(x * 0.045 - sim.time * 2.6) * amp * 0.6;
        d += `L${x},${y.toFixed(1)} `;
      }
      d += `L228,${INNER_BOT + 10} Z`;
      return d;
    }

    function render() {
      const p = propsRef.current;
      const beerTop = yForMl(Math.min(sim.fill, CAP));
      const foamPx = Math.min((sim.foamMl / CAP) * INNER_H, 74);
      const foamTop = beerTop - foamPx;

      liquid!.setAttribute("d", wavePath(beerTop, sim.waveAmp));
      liquidEdge!.setAttribute("d", wavePath(beerTop, sim.waveAmp));

      // Schaum: blubberige Oberkante
      if (foamPx > 1) {
        let d = `M92,${beerTop + 4} L92,${foamTop + 3} `;
        for (let x = 92; x <= 228; x += 13) {
          const r = 5 + ((x * 7) % 5);
          d += `Q${x + 6.5},${foamTop - r + Math.sin(x * 0.3 + sim.time * 1.4) * 1.6} ${x + 13},${foamTop + 3} `;
        }
        d += `L228,${beerTop + 4} Z`;
        foamEl!.setAttribute("d", d);
      } else {
        foamEl!.setAttribute("d", "");
      }

      // Bierstrahl mit Wobble
      if (p.pouring && !p.locked && !sim.overflowed) {
        const tipY = 112;
        const endY = foamTop - 2;
        const wob = Math.sin(sim.time * 26) * 1.4;
        const wTop = 4.6 * Math.sqrt(p.pressure);
        const wBot = wTop * 0.62;
        streamPath!.setAttribute(
          "d",
          `M${160 - wTop},${tipY} L${160 + wTop},${tipY} ` +
            `Q${160 + wBot + wob},${(tipY + endY) / 2} ${160 + wBot + wob},${endY} ` +
            `L${160 - wBot + wob},${endY} Q${160 - wBot + wob},${(tipY + endY) / 2} ${160 - wTop},${tipY} Z`,
        );
      }

      // Kondensation, sobald das Glas kalt & gefüllt ist
      condG!.style.opacity = sim.fill > CAP * 0.18 ? "0.9" : "0";
    }

    function spawnBubble() {
      if (reduceMotion || sim.fill < 40) return;
      const c = document.createElementNS(NS, "circle");
      const sites = [125, 143, 160, 178, 196];
      const x = sites[Math.floor(Math.random() * sites.length)]! + (Math.random() * 8 - 4);
      const r = 0.8 + Math.random() * 1.9;
      c.setAttribute("r", r.toFixed(1));
      c.setAttribute("cx", String(x));
      c.setAttribute("cy", String(INNER_BOT - 4));
      c.setAttribute("fill", "rgba(255,246,224,.55)");
      bubblesG!.appendChild(c);
      sim.bubbles.push({
        el: c,
        x,
        y: INNER_BOT - 4,
        v: 26 + Math.random() * 36,
        drift: Math.random() * 2 - 1,
      });
    }

    function spawnSplash(y: number) {
      if (reduceMotion) return;
      for (let i = 0; i < 2; i++) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("r", (1 + Math.random() * 1.6).toFixed(1));
        c.setAttribute("fill", "rgba(255,246,224,.85)");
        splashG!.appendChild(c);
        sim.splashes.push({
          el: c,
          x: 160 + (Math.random() * 10 - 5),
          y,
          vx: (Math.random() * 2 - 1) * 46,
          vy: -(30 + Math.random() * 55),
          life: 0.5,
        });
      }
    }

    let raf = 0;
    function loop(t: number) {
      if (!sim.lastT) sim.lastT = t;
      const dt = Math.min((t - sim.lastT) / 1000, 0.05);
      sim.lastT = t;
      sim.time += dt;

      const p = propsRef.current;
      const active = p.pouring && !p.locked && !sim.overflowed;

      if (active) {
        sim.fill += BASE_RATE_ML_S * p.pressure * dt;
        sim.foamMl += FOAM_BASE_ML_S * Math.pow(p.pressure, FOAM_PRESSURE_EXP) * dt;
        sim.waveAmp = Math.min(sim.waveAmp + dt * 8, 2.6);
        if (Math.random() < 0.8) spawnBubble();
        spawnSplash(
          yForMl(Math.min(sim.fill, CAP)) - Math.min((sim.foamMl / CAP) * INNER_H, 74),
        );
        if (sim.fill + sim.foamMl * OVERFLOW_FOAM_FACTOR >= CAP * 1.01) {
          sim.overflowed = true;
          if (!sim.overflowNotified) {
            sim.overflowNotified = true;
            p.onLocalOverflow?.();
          }
        }
      } else {
        sim.waveAmp = Math.max(sim.waveAmp - dt * 1.8, 0.35);
      }

      // Blasen-Physik
      const surfY = yForMl(Math.min(sim.fill, CAP));
      sim.bubbles = sim.bubbles.filter((b) => {
        b.y -= b.v * dt;
        b.x += b.drift * dt * 8;
        if (b.y <= surfY + 3) {
          b.el.remove();
          return false;
        }
        b.el.setAttribute("cy", b.y.toFixed(1));
        b.el.setAttribute("cx", b.x.toFixed(1));
        return true;
      });
      sim.splashes = sim.splashes.filter((s) => {
        s.life -= dt;
        if (s.life <= 0) {
          s.el.remove();
          return false;
        }
        s.vy += 280 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.el.setAttribute("cx", s.x.toFixed(1));
        s.el.setAttribute("cy", s.y.toFixed(1));
        s.el.setAttribute("opacity", (s.life * 2).toFixed(2));
        return true;
      });

      render();
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      sim.lastT = 0;
      sim.bubbles.forEach((b) => b.el.remove());
      sim.bubbles = [];
      sim.splashes.forEach((s) => s.el.remove());
      sim.splashes = [];
      condG.innerHTML = "";
    };
  }, []);

  const needleDeg = ((pressure - 1.05) / 0.25) * 58;

  return (
    <>
      {/* ── HUD: ZIEL + FASSDRUCK ─────────────────────────────────────── */}
      <div className="hud">
        <div className="target-hud">
          <div className="lbl">ZIEL</div>
          <div className="val">{targetMl !== null ? fmtL(targetMl) : "?"}</div>
        </div>
        <div className="gauge-wrap">
          <svg width="74" height="52" viewBox="0 0 74 52">
            <path
              d="M8 48 A32 32 0 0 1 66 48"
              fill="none"
              stroke="#3a2d1c"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <path
              d="M8 48 A32 32 0 0 1 66 48"
              fill="none"
              stroke="url(#gaugeGrad)"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <g transform={`rotate(${needleDeg} 37 48)`}>
              <line x1="37" y1="48" x2="37" y2="20" stroke="#EDE7D8" strokeWidth="2.5" strokeLinecap="round" />
            </g>
            <circle cx="37" cy="48" r="4.5" fill="#D6A644" />
            <defs>
              <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#7BC96F" />
                <stop offset=".55" stopColor="#D6A644" />
                <stop offset="1" stopColor="#E05555" />
              </linearGradient>
            </defs>
          </svg>
          <div className="lbl">
            FASSDRUCK <span style={{ color: "var(--chalk)" }}>{(pressure * 1.5).toFixed(1)} BAR</span>
          </div>
        </div>
      </div>

      {/* ── BÜHNE ─────────────────────────────────────────────────────── */}
      <div className="stage" onPointerDown={onStagePointerDown}>
        <svg viewBox="0 0 320 560" preserveAspectRatio="xMidYMid meet">
          <defs>
            {/* chrome tower */}
            <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#5a5a60" />
              <stop offset=".18" stopColor="#e9edf2" />
              <stop offset=".42" stopColor="#9aa0aa" />
              <stop offset=".55" stopColor="#f4f7fb" />
              <stop offset=".78" stopColor="#7d838d" />
              <stop offset="1" stopColor="#3c3c42" />
            </linearGradient>
            <linearGradient id="brassG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f2d78c" />
              <stop offset=".5" stopColor="#D6A644" />
              <stop offset="1" stopColor="#8F6A1E" />
            </linearGradient>
            <radialGradient id="badgeG" cx=".38" cy=".32" r=".9">
              <stop offset="0" stopColor="#fbe7ae" />
              <stop offset=".55" stopColor="#D6A644" />
              <stop offset="1" stopColor="#7a5a18" />
            </radialGradient>
            {/* beer */}
            <linearGradient id="beerG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#FFC94D" />
              <stop offset=".45" stopColor="#E89B1C" />
              <stop offset="1" stopColor="#9C5A08" />
            </linearGradient>
            <linearGradient id="beerEdge" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgba(60,30,0,.38)" />
              <stop offset=".12" stopColor="rgba(0,0,0,0)" />
              <stop offset=".88" stopColor="rgba(0,0,0,0)" />
              <stop offset="1" stopColor="rgba(60,30,0,.38)" />
            </linearGradient>
            <linearGradient id="foamG" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#FFFDF5" />
              <stop offset="1" stopColor="#F0E2BE" />
            </linearGradient>
            <linearGradient id="streamG" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgba(255,201,77,.35)" />
              <stop offset=".5" stopColor="#FFD98A" />
              <stop offset="1" stopColor="rgba(255,201,77,.35)" />
            </linearGradient>
            {/* glass */}
            <linearGradient id="glassBody" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgba(210,225,235,.22)" />
              <stop offset=".1" stopColor="rgba(210,225,235,.05)" />
              <stop offset=".46" stopColor="rgba(210,225,235,.02)" />
              <stop offset=".62" stopColor="rgba(255,255,255,.09)" />
              <stop offset=".9" stopColor="rgba(210,225,235,.05)" />
              <stop offset="1" stopColor="rgba(210,225,235,.26)" />
            </linearGradient>
            <linearGradient id="glassShine" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgba(255,255,255,.5)" />
              <stop offset="1" stopColor="rgba(255,255,255,.04)" />
            </linearGradient>
            <radialGradient id="dropG" cx=".35" cy=".3" r=".9">
              <stop offset="0" stopColor="rgba(255,255,255,.75)" />
              <stop offset=".5" stopColor="rgba(220,235,245,.28)" />
              <stop offset="1" stopColor="rgba(220,235,245,.05)" />
            </radialGradient>
            <clipPath id="glassInner">
              <path d="M104,176 L216,176 L210,500 L110,500 Z" />
            </clipPath>
            <filter id="softBlur" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="1.1" />
            </filter>
          </defs>

          {/* ══ ZAPFSÄULE ══ */}
          <g id="tower">
            {/* handle (pivot at 160,26) */}
            <g
              ref={handleRef}
              transform="rotate(0 160 26)"
              style={{ transition: "transform .18s cubic-bezier(.34,1.56,.64,1)" }}
            >
              <rect x="156.5" y="-22" width="7" height="48" rx="3.5" fill="url(#chrome)" />
              <rect x="149" y="-52" width="22" height="40" rx="11" fill="#15100c" stroke="#4a3826" strokeWidth="1" />
              <rect x="152.5" y="-48" width="5" height="30" rx="2.5" fill="rgba(255,255,255,.10)" />
              <text
                x="160"
                y="-27"
                textAnchor="middle"
                fontSize="9"
                fill="#D6A644"
                style={{ fontFamily: "var(--font-slab), serif" }}
              >
                ZR
              </text>
            </g>
            {/* tower column */}
            <rect x="142" y="18" width="36" height="76" rx="16" fill="url(#chrome)" />
            <rect x="147" y="22" width="6" height="66" rx="3" fill="rgba(255,255,255,.35)" />
            {/* brass collar */}
            <rect x="138" y="60" width="44" height="12" rx="6" fill="url(#brassG)" />
            {/* badge */}
            <circle cx="160" cy="44" r="17" fill="url(#badgeG)" stroke="#6e5216" strokeWidth="1.5" />
            <circle cx="160" cy="44" r="12.5" fill="#20160c" />
            <text
              x="160"
              y="41.5"
              textAnchor="middle"
              fontSize="7"
              fill="#EDE7D8"
              style={{ fontFamily: "var(--font-slab), serif" }}
            >
              ZAPF
            </text>
            <text
              x="160"
              y="50.5"
              textAnchor="middle"
              fontSize="7"
              fill="#D6A644"
              style={{ fontFamily: "var(--font-slab), serif" }}
            >
              ROYALE
            </text>
            {/* spout */}
            <path d="M152,88 L168,88 L166,106 Q166,112 160,112 Q154,112 154,106 Z" fill="url(#chrome)" />
            <ellipse cx="160" cy="111" rx="5" ry="2" fill="#2a2a2e" />
          </g>

          {/* ══ BIERSTRAHL ══ */}
          <g ref={streamGroupRef} opacity="0">
            <path ref={streamPathRef} fill="url(#streamG)" />
            <g ref={splashGRef} />
          </g>

          {/* ══ MASSKRUG ══ */}
          <g id="krug">
            {/* shadow on counter */}
            <ellipse cx="160" cy="526" rx="78" ry="10" fill="rgba(0,0,0,.5)" filter="url(#softBlur)" />
            {/* handle of the krug */}
            <path
              d="M216,230 Q268,236 268,320 Q268,404 212,414"
              fill="none"
              stroke="url(#glassBody)"
              strokeWidth="20"
              strokeLinecap="round"
            />
            <path
              d="M216,230 Q268,236 268,320 Q268,404 212,414"
              fill="none"
              stroke="rgba(255,255,255,.22)"
              strokeWidth="4"
              strokeLinecap="round"
            />

            {/* CONTENT (clipped) */}
            <g clipPath="url(#glassInner)">
              <path ref={liquidRef} fill="url(#beerG)" />
              <path ref={liquidEdgeRef} fill="url(#beerEdge)" />
              <g ref={bubblesGRef} />
              <path ref={foamRef} fill="url(#foamG)" />
            </g>

            {/* glass body over content */}
            <path
              d="M96,170 L224,170 L217,506 Q217,514 209,514 L111,514 Q103,514 103,506 Z"
              fill="url(#glassBody)"
              stroke="rgba(230,240,250,.35)"
              strokeWidth="2.5"
            />
            {/* thick base */}
            <path
              d="M107,486 L213,486 L211,506 Q211,512 204,512 L116,512 Q109,512 109,506 Z"
              fill="rgba(220,235,245,.14)"
            />
            {/* rim */}
            <ellipse cx="160" cy="170" rx="64" ry="5" fill="none" stroke="rgba(255,255,255,.4)" strokeWidth="2" />
            {/* vertical shine */}
            <rect x="122" y="185" width="10" height="300" rx="5" fill="url(#glassShine)" opacity=".5" />
            <rect x="196" y="195" width="5" height="270" rx="2.5" fill="url(#glassShine)" opacity=".3" />
            {/* condensation */}
            <g ref={condGRef} opacity="1" style={{ opacity: 0, transition: "opacity 1.2s" }} />

            {/* etched marks — beim Zapfen unsichtbar (Blind-Zapf), danach Reveal */}
            <g
              fontSize="11"
              fontWeight="600"
              style={{
                fontFamily: "var(--font-mono), monospace",
                opacity: hideMarks ? 0 : 1,
                transition: "opacity 0.7s ease",
              }}
            >
              {MARKS_ML.map((ml) => {
                const y = yForMl(ml);
                const active = ml === targetMl;
                return (
                  <g key={ml}>
                    <line
                      x1={108}
                      x2={active ? 212 : 150}
                      y1={y}
                      y2={y}
                      stroke={active ? "#EDE7D8" : "rgba(230,240,250,.42)"}
                      strokeWidth={active ? 2.4 : 1.6}
                      strokeDasharray={active ? "7 5" : undefined}
                      style={
                        active
                          ? { filter: "drop-shadow(0 0 5px rgba(237,231,216,.7))" }
                          : undefined
                      }
                    />
                    <text
                      x={active ? 176 : 156}
                      y={y - 5}
                      fill={active ? "#EDE7D8" : "rgba(230,240,250,.5)"}
                      fontSize={active ? 13 : undefined}
                    >
                      {(ml / 1000).toFixed(1).replace(".", ",")} L
                    </text>
                  </g>
                );
              })}
            </g>
          </g>

          {/* wooden counter */}
          <rect x="0" y="520" width="320" height="40" fill="#241a10" />
          <rect x="0" y="520" width="320" height="4" fill="rgba(214,166,68,.3)" />
          <rect x="0" y="527" width="320" height="1.5" fill="rgba(0,0,0,.35)" />
          <rect x="0" y="540" width="320" height="1.5" fill="rgba(0,0,0,.3)" />
        </svg>
      </div>
    </>
  );
}
