# @zapf/web — ZAPF ROYALE Frontend

Next.js-15-Frontend (App Router, React 18, TypeScript strict) für das
PvP-Bierzapf-Spiel auf **Solana devnet**. Die Optik ist ein 1:1-Port des
UI-Demos `docs/zapf-royale-v2.html` (kein Tailwind — portiertes CSS mit
Custom Properties in `src/app/globals.css`).

## Setup

```bash
cp .env.example .env.local   # Werte anpassen
pnpm install                 # im Monorepo-Root
pnpm --filter @zapf/web dev  # http://localhost:3000
```

ENV (alle `NEXT_PUBLIC_`, landen im Client-Bundle):

| Variable                 | Bedeutung                                    | Default                        |
| ------------------------ | -------------------------------------------- | ------------------------------ |
| `NEXT_PUBLIC_SERVER_URL` | Game-Server (REST + WS, `/ws` wird angehängt)| `http://localhost:8787`        |
| `NEXT_PUBLIC_RPC_URL`    | Solana-RPC (devnet)                          | `https://api.devnet.solana.com`|
| `NEXT_PUBLIC_PROGRAM_ID` | Anchor-Programm-ID                           | System Program (Platzhalter)   |

## Seiten

- `/` — Lobby-Liste (`GET /lobbies`): Einsatz (◎), Plätze x/5, Pot; Wallet-Connect
  (Phantom + Solflare); prominenter Devnet-/Glücksspiel-Disclaimer.
- `/game/[lobbyId]` — kompletter Spiel-Flow:
  1. Wallet connect + gasfreier Login: `POST /auth/nonce` → `signMessage("ZAPF ROYALE LOGIN <nonce>")` → `POST /auth/verify` → Token
  2. Join: `join_lobby(lobbyId)`-Transaktion (Entry Fee → Vault-PDA) via Wallet.
     Ist die Lobby noch `awaiting_randomness` (MagicBlock-VRF-Oracle hat die
     Randomness noch nicht per On-Chain-Callback geliefert), ist der Join
     gesperrt und die UI zeigt „WÜRFELT ZIEL AUS …“
  3. WebSocket: `hello` + `watch_lobby`; nach `round_config` großer 60-s-Countdown,
     Hold-Button `pointerdown` → `pour_start`, `pointerup` → `pour_stop`
  4. `pour_result` → Result-Overlay (Accuracy %, Verdikt, „Warten auf N Spieler …“)
  5. `settled` → Gewinner-Reveal mit Payouts (◎), Explorer-Link und der
     VRF-Randomness (Hex, gekürzt)
- `/stats` — Transparenz: GlobalStats **direkt on-chain** (PDA `[b"stats"]`),
  Fee klar als **4 %** gelabelt, letzte Settlements mit Explorer-Links,
  Erklärung der VRF-Fairness: [MagicBlock Ephemeral VRF](https://github.com/magicblock-labs/ephemeral-vrf)
  (Programm `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`), Ziel = `randomness[0] % 3`,
  Druck aus den Bytes 1–2.

## Server-Autorität

Der Client rendert die Zapf-Simulation nur **kosmetisch** (`TapScene.tsx`,
gleiche Konstanten wie der Server: 520 ml/s × Druck, Schaum 34 × Druck^1.6,
Kapazität 1600 ml, Überlauf bei `fill + 0.7·foam ≥ 1616 ml`). Die endgültig
gewertete Menge kommt ausschließlich vom Server (`pour_result`).

## PDA-Seeds (identisch zum Programm)

```
lobby  = [b"lobby",  lobby_id u64 LE]
vault  = [b"vault",  lobby_id u64 LE]
config = [b"config"]
stats  = [b"stats"]
```

## Wichtig: IDL

`src/lib/idl.json` ist **von Hand geschrieben** (passend zur Schnittstelle in
`docs/spec.md`, inkl. korrekt berechneter Anchor-Discriminators; VRF-Variante
mit `fulfill_round`-Callback, `client_seed` in `create_lobby` und
`settle_lobby` ohne Argumente). Nach `anchor build` bitte durch
`program/target/idl/zapf_royale.json` ersetzen — die Programm-Adresse wird zur
Laufzeit ohnehin mit `NEXT_PUBLIC_PROGRAM_ID` überschrieben. Für das VRF sind
**keine zusätzlichen `NEXT_PUBLIC_`-Variablen** nötig (Oracle-Queue & Callback
laufen komplett über Server/Programm).

## Scripts

- `dev` / `build` / `start` — Next.js
- `typecheck` — `tsc --noEmit` (TypeScript strict)

## Hinweis

Nur **devnet**, kein echtes Geld. Echtgeld-Varianten können je nach
Rechtsordnung als Glücksspiel reguliert sein — dieses Projekt ist ein
Technik-Demo, kein Glücksspielangebot.
