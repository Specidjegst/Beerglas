# 🍺 ZAPF ROYALE

PvP-Bierzapf-Skill-Game auf **Solana (devnet)**. Spieler zahlen eine Entry-Fee
in einen On-Chain-Vault, zapfen je **einen** Versuch aus dem Hahn in einen
1,6-Liter-Maßkrug und versuchen, eine Ziel-Eichmarke exakt zu treffen. Der
genaueste Zapfer gewinnt den Pot.

> ## ⚠️ Disclaimer: Glücksspiel & Devnet
>
> Dieses Projekt läuft **ausschließlich auf Solana devnet** (wertloses
> Test-SOL). Echtgeld-Spiele mit Einsatz und Gewinnchance können je nach
> Jurisdiktion als **Glücksspiel** reguliert oder verboten sein. Es gibt
> keinen Mainnet-Deploy, keine Gewährleistung und keine Aufforderung, dieses
> Spiel mit echtem Geld zu betreiben. Nutzung auf eigene Verantwortung.

## Spielregeln (Kurzfassung)

- Der Maßkrug (1600 ml) hat drei Eichmarken: **0,5 L / 1,0 L / 1,5 L**. Pro
  Runde ist eine davon das **Ziel** — für alle Spieler der Lobby dieselbe.
- Der **Fassdruck** (0,8–1,3) skaliert Zapfrate (520 ml/s × Druck) und
  Schaumbildung (34 ml/s × Druck^1,6). Reagieren statt Timing auswendig lernen.
- **Ein Versuch:** Halten = zapfen, Loslassen = abgeben. 60 Sekunden Zeit ab
  Join-Bestätigung, sonst wird 0 ml gewertet.
- **Überlauf** (Bier + 0,7 × Schaum ≥ 101 % der Kapazität) = automatisch
  schlechtestes Ergebnis.
- **Score** = |gezapfte ml − Ziel-ml|, niedrigster gewinnt. Bei Gleichstand
  wird der Pot geteilt (Lamport-Rest an den zuerst gemeldeten Gewinner).
- Lobby: 5 Plätze (konfigurierbar). Voll + alle Ergebnisse da → automatisches
  Settlement on-chain. Füllt sich eine Lobby 24 h nicht, kann jeder
  `cancel_lobby` aufrufen — voller Refund.
- **Operator-Fee: 4 % des Pots** (400 bps), geht bei Settlement an die
  Treasury. Transparent über Events + GlobalStats (siehe unten).

## Architektur

```
       Browser (Spieler)                      Backend                          Solana devnet
┌───────────────────────────┐      ┌───────────────────────────┐      ┌────────────────────────────────┐
│  web/  (Next.js 15)       │      │  server/  (Fastify)       │      │  program/  (Anchor 0.31.1)     │
│  Wallet-Adapter           │      │  WebSocket + REST         │      │  zapf_royale                   │
│  (Phantom/Solflare)       │◄────►│  autoritative             │◄────►│  PDAs: Config, GlobalStats,    │
│  deutsches UI, /stats     │  WS/ │  Zapf-Simulation          │Anchor│        Lobby, Vault            │
└─────────────┬─────────────┘ REST │  result_authority-Keypair │  RPC │  create_lobby ── request ──┐   │
              │                    │  JSON-Persistenz DATA_DIR │      │  fulfill_round ◄─ callback │   │
              │  join_lobby-Tx     └───────────────────────────┘      │  submit_result             │   │
              │  (Entry Fee → Vault)                                  │  settle_lobby              │   │
              └──────────────────────────────────────────────────────►│                            │   │
                                                                      └──────────────┬─────────────┼───┘
                                                                                     │ Randomness- │
                                                                                     │ Callback    │ CPI
                                                                      ┌──────────────▼─────────────▼───┐
                                                                      │  MagicBlock Ephemeral VRF      │
                                                                      │  (Oracle-Queue, devnet)        │
                                                                      └────────────────────────────────┘
```

## Pakete

| Paket | Beschreibung | README |
| --- | --- | --- |
| `program/` | Anchor-0.31.1-Programm `zapf_royale`: Lobbies, Vault-Escrow, VRF-Randomness, Settlement, GlobalStats. **Standalone** (nicht im pnpm-Workspace, Rust-Toolchain in WSL/Linux). | [program/README.md](program/README.md) |
| `server/` | `@zapf/server` — Fastify-Gameserver: WebSocket, server-autoritative Zapf-Simulation, hält den `result_authority`-Keypair, meldet Ergebnisse/Settlements on-chain, JSON-Persistenz in `DATA_DIR`. | [server/README.md](server/README.md) |
| `web/` | `@zapf/web` — Next.js-15-Frontend: Wallet-Adapter (Phantom/Solflare), deutsches UI, Spiel-Flow per WebSocket, `/stats`-Transparenzseite. | [web/README.md](web/README.md) |
| `docs/` | Ursprüngliche Spezifikation + UI-Demo. Achtung: Die Spec beschreibt noch Commit-Reveal — **maßgeblich ist VRF** (siehe Fairness). | [docs/spec.md](docs/spec.md) |

## Fairness: MagicBlock Ephemeral VRF

Die Zufälligkeit der Runde (Ziel-Marke + Fassdruck) kommt **nicht vom
Server**, sondern aus dem **MagicBlock Ephemeral VRF** (v0.4.1) — verifiable
randomness mit On-Chain-Callback:

1. **Anfordern:** `create_lobby` macht einen CPI-Call `request_randomness` an
   das Ephemeral-VRF-Programm (mit der konfigurierten **Oracle-Queue**). Die
   Lobby startet ohne bekannte Rundenparameter.
2. **Callback:** Das VRF-Oracle beantwortet die Anfrage mit dem Callback
   **`fulfill_round`** und liefert die verifizierbare Randomness. Nur die
   **VRF-Programm-Identity** kann diesen Callback signieren — weder der
   Game-Server noch der Betreiber können die Randomness setzen oder
   nachträglich ändern.
3. **Ableitung on-chain (nachrechenbar):**
   - `target_ml = [500, 1000, 1500][randomness[0] % 3]`
   - `pressure` aus den Bytes 1–2 der Randomness (u16 little-endian, linear
     auf 0,8–1,3 abgebildet)
4. **Nachprüfbar:** Randomness, Ziel und alle Lamport-Flüsse (Join, Fee,
   Payouts, Refunds) stehen in Anchor-Events; jeder kann Ableitung und
   Auszahlung im Explorer verifizieren. Die Gewinnerermittlung läuft komplett
   on-chain aus den gespeicherten Ergebnissen.

**Transparenz:** Die 4-%-Fee ist in der Config-PDA hinterlegt (Änderung nur
durch die Programm-Authority, jede Änderung emittiert ein Event). Die
**GlobalStats-PDA** akkumuliert `total_games_settled`,
`total_volume_lamports` und `total_fees_lamports` atomar bei jedem
Settlement. Die **/stats-Seite** des Frontends liest GlobalStats direkt
on-chain und verlinkt jedes Settlement zum Solana Explorer.

> Hinweis: Ältere Dokumente (u. a. `docs/spec.md`) beschreiben noch ein
> Commit-Reveal-Schema. Das wurde durch das VRF-Design ersetzt.

## Setup lokal

Voraussetzungen: **Node 20+**, pnpm via corepack (`corepack enable` — die
Version kommt aus `packageManager` im Root-`package.json`).

```bash
pnpm install

pnpm dev:server   # Gameserver auf http://localhost:8787 (CHAIN=mock, keine Chain nötig)
pnpm dev:web      # Frontend auf http://localhost:3000

pnpm test:server  # Vitest-Unit-Tests des Servers
```

Env-Vorlagen: [`server/.env.example`](server/.env.example); fürs Web
`NEXT_PUBLIC_SERVER_URL`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_PROGRAM_ID`
(siehe [web/README.md](web/README.md)).

### Anchor-Programm bauen (Windows: WSL!)

Die Solana/Anchor-Toolchain läuft unter Windows **nur über WSL**:

```powershell
wsl --install          # einmalig, dann Neustart + Ubuntu einrichten
```

In der WSL-Shell:

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Solana CLI (Agave, stable)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
# Anchor 0.31.1 über avm
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.1 && avm use 0.31.1

cd program
yarn install
anchor build
anchor keys sync       # ersetzt die Platzhalter-Programm-ID in lib.rs + Anchor.toml
anchor build           # erneut, mit der echten ID
anchor test            # Bankrun-Testsuite
```

**Alternative ohne WSL:** Die GitHub Action
[`.github/workflows/program.yml`](.github/workflows/program.yml) als
Build-Maschine nutzen — sie läuft bei jedem Push auf `main` mit Änderungen
unter `program/**` und lässt sich auch manuell starten (workflow_dispatch).
Das Workflow-Artifact **`zapf-royale-program`** enthält `zapf_royale.so`,
die IDL (`target/idl/*.json`) und die TS-Types zum Herunterladen; das `.so`
kann dann z. B. mit `solana program deploy` deployed werden.

## CI

- [`.github/workflows/program.yml`](.github/workflows/program.yml) — Anchor
  Build + Bankrun-Tests bei Änderungen unter `program/**` (Rust/Agave/Anchor
  gecacht), Artefakte: `.so` + IDL.
- [`.github/workflows/node.yml`](.github/workflows/node.yml) — bei jedem
  Push/PR: `@zapf/server` Typecheck + Tests, `@zapf/web` Production-Build.

## Deployment (devnet)

Reihenfolge ist wichtig — die Program-ID fließt in alle nachgelagerten Envs:

### 1. Programm auf devnet deployen

```bash
# in WSL, im program/-Verzeichnis (oder .so aus dem CI-Artifact nehmen)
solana config set --url devnet
solana airdrop 5
anchor deploy --provider.cluster devnet
```

Die dabei vergebene **Program-ID** in die Envs eintragen: `PROGRAM_ID`
(Server) und `NEXT_PUBLIC_PROGRAM_ID` (Web).

### 2. `initialize` ausführen

Einmalig die Config anlegen: `fee_bps = 400`, Treasury-Pubkey,
`result_authority`-Pubkey des Game-Servers, Entry-Fee-Allowlist
(z. B. 0,05 / 0,1 / 0,5 SOL) — Details in
[program/README.md](program/README.md).

### 3. Server auf Railway

Beide Deployments laufen als **zwei Services im selben Railway-Projekt**,
jeweils aus diesem Repo. Die Service-Konfigurationen liegen als
Config-as-Code im Repo: [`server/railway.json`](server/railway.json) und
[`web/railway.json`](web/railway.json).

**Service 1 — Game-Server:** Build über `server/Dockerfile` (Multi-Stage,
non-root, Port 8787), Healthcheck auf **`/health`**, Restart-Policy
`ON_FAILURE`.

Manuelle Schritte im Railway-Dashboard:

1. **Projekt aus dem GitHub-Repo anlegen.** Im Service unter
   *Settings → Config-as-code* den Pfad **`server/railway.json`** setzen
   (Root Directory leer lassen — Build-Kontext muss der Repo-Root bleiben,
   sonst findet der pnpm-Workspace-Build sein Lockfile nicht). Sinnvoll:
   *Watch Paths* auf `server/**` begrenzen.
2. **Volume mounten auf `/app/data`** — dort liegt die JSON-Persistenz
   (Lobbies, Join-Timestamps, Pending-Rounds). Ohne Volume ist der State
   nach jedem Redeploy weg.
3. **Env-Variablen setzen:**

   | Variable | Wert |
   | --- | --- |
   | `CHAIN` | `anchor` |
   | `RPC_URL` | Solana-devnet-RPC (z. B. `https://api.devnet.solana.com`) |
   | `PROGRAM_ID` | Program-ID aus Schritt 1 |
   | `RESULT_AUTHORITY_KEYPAIR` | Secret Key des Server-Signers (JSON-Array oder base58) — **Secret!** |
   | `TREASURY` | Pubkey, der die 4-%-Fee erhält |
   | `ORACLE_QUEUE` | Oracle-Queue-Account des MagicBlock Ephemeral VRF (devnet) |
   | `DATA_DIR` | `/app/data` (muss zum Volume-Mount passen) |
   | `AUTH_SECRET` | zufälliger String, damit Login-Tokens Neustarts überleben |

   `PORT` setzt Railway selbst — der Server liest die Variable und bindet
   darauf (`HOST=0.0.0.0` ist im Image gesetzt).
4. Nach dem Deploy die öffentliche URL des Service notieren — sie wird
   `NEXT_PUBLIC_SERVER_URL` fürs Frontend.

### 4. Web auf Railway (zweiter Service)

**Service 2 — Frontend:** Im selben Railway-Projekt einen zweiten Service
aus demselben Repo anlegen. Build über `web/Dockerfile`
(Next.js-**standalone**-Build, non-root, Port 3000), Healthcheck auf `/`.

1. Unter *Settings → Config-as-code* den Pfad **`web/railway.json`** setzen
   (Root Directory wieder leer lassen). *Watch Paths*: `web/**`.
2. **Env-Variablen setzen** (werden beim Docker-Build als Build-Args
   durchgereicht — Next.js backt `NEXT_PUBLIC_*` zur Build-Zeit ins Bundle,
   nach einer Änderung also **redeployen**):

   | Variable | Wert |
   | --- | --- |
   | `NEXT_PUBLIC_SERVER_URL` | öffentliche Railway-URL des Game-Servers (Schritt 3) |
   | `NEXT_PUBLIC_RPC_URL` | Solana-devnet-RPC (z. B. `https://api.devnet.solana.com`) |
   | `NEXT_PUBLIC_PROGRAM_ID` | Program-ID aus Schritt 1 |

   `PORT` setzt Railway selbst — der Standalone-Server (`web/server.js`)
   liest `PORT`/`HOSTNAME` aus der Umgebung.
3. Public Domain für den Service generieren — fertig.

---

Noch einmal, weil es wichtig ist: **devnet-only, kein Echtgeld.** 🍻
