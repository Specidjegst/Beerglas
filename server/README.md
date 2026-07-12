# @zapf/server — ZAPF ROYALE Game Server

Autoritativer Spielserver für ZAPF ROYALE (Solana devnet). Der Server hält den
`result_authority`-Keypair, führt die Zapf-Simulation mit **seiner eigenen Uhr**
aus (der Client-Render ist rein kosmetisch) und meldet Ergebnisse und
Settlements on-chain an das Anchor-Programm `zapf_royale`.

```
pnpm --filter @zapf/server dev        # Dev-Server (tsx watch)
pnpm --filter @zapf/server test       # Unit-Tests (vitest, ohne Netzwerk/Chain)
pnpm --filter @zapf/server typecheck  # tsc --noEmit
pnpm --filter @zapf/server build      # tsc -> dist/ (+ idl.json Kopie)
```

## ENV-Variablen

| Variable | Default | Beschreibung |
| --- | --- | --- |
| `PORT` | `8787` | HTTP/WebSocket-Port |
| `HOST` | `0.0.0.0` | Bind-Adresse |
| `DATA_DIR` | `./data` | JSON-File-Store (Lobbies, VRF-Randomness, Join-Timestamps). Atomar geschrieben (tmp + rename) |
| `AUTH_SECRET` | zufällig pro Boot | HMAC-Secret für Login-Tokens. Setzen, damit Tokens Neustarts überleben |
| `CHAIN` | `mock` | `anchor` = echtes Programm via RPC, `mock` = In-Memory-Chain (Offline-Dev/Tests) |
| `RPC_URL` | devnet | Solana-RPC-Endpoint |
| `PROGRAM_ID` | Platzhalter | Deployte `zapf_royale`-Programm-ID (Pflicht bei `CHAIN=anchor`) |
| `RESULT_AUTHORITY_KEYPAIR` | — | Secret Key als JSON-Array (solana-keygen) **oder** base58. Pflicht bei `CHAIN=anchor`; bei `mock` wird sonst ephemer generiert |
| `TREASURY` | — | Pubkey, der die 4%-Fee erhält (Pflicht bei `CHAIN=anchor`) |
| `ORACLE_QUEUE` | `GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb` | Oracle-Queue des MagicBlock Ephemeral VRF (Default = devnet Default-Queue) |
| `LOBBY_SIZE` | `5` | Plätze pro Lobby (konfigurierbar, MVP = 5) |
| `DEFAULT_ENTRY_FEE_LAMPORTS` | `50000000` | Entry Fee für automatisch erstellte Lobbies (0.05 SOL) |

Vorlage: `.env.example`.

## Spielkonstanten (identisch zu Programm & Frontend)

- Kapazität **1600 ml**, Marken **500 / 1000 / 1500 ml**
- Zapfrate `520 * pressure` ml/s, Schaum `34 * pressure^1.6` ml/s
- Overflow: `fill + 0.7 * foam >= 1600 * 1.01` → Versuch endet **exakt** am
  analytisch berechneten Overflow-Zeitpunkt, Ergebnis = Overflow
  (on-chain gemeldet als `poured_ml = 0xFFFFFFFF`)
- `pressure ∈ [0.8, 1.3]`, Play-Timeout **60 s**, Cancel nach **24 h**
- Score = `abs(poured_ml − target_ml)`, niedrigster gewinnt; Ties teilen den
  Pot, Lamport-Rest geht an den kleinsten `submissionIndex`
- Operator-Fee: **4 % (400 bps)** vom Pot, exakte Integer-Division

## Fairness (MagicBlock Ephemeral VRF)

Die Rundenparameter kommen nicht mehr per Commit–Reveal vom Server, sondern
aus einem **verifizierbaren VRF-Callback on-chain** (MagicBlock Ephemeral VRF,
Programm `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`):

1. `create_lobby(lobby_id, size, entry_fee, client_seed)` macht im selben Ix
   einen CPI-Request an das VRF-Programm (`caller_seed =
   hash(lobby_id LE ++ client_seed)`). Der `client_seed` ist reine
   Request-Entropie: **öffentlich, nicht geheim, nicht sicherheitsrelevant** —
   der Server hält keinerlei Geheimnis mehr, das die Runde biegen könnte.
   Die Lobby startet im Status `AwaitingRandomness`.
2. Das Oracle beweist seine Randomness und ruft (nur mit der
   VRF-Programm-Identity signierbar) unser `fulfill_round(randomness)` auf.
   Das Programm speichert `randomness`, `target_ml`, `pressure_milli` und
   setzt die Lobby auf `Open`. Erst ab jetzt sind Joins möglich.
3. Ableitung (identisch in Programm, Server und Frontend):
   - `target_ml = [500, 1000, 1500][randomness[0] % 3]`
   - `raw = randomness[1] | (randomness[2] << 8)` (u16 little-endian)
   - `pressure_milli = 800 + floor(raw * 500 / 65535)` (Ganzzahl, 800..=1300)
   - `pressure = pressure_milli / 1000`
4. `settle_lobby` braucht kein Seed-Reveal mehr — das Programm nutzt das
   VRF-abgeleitete `lobby.target_ml`. Jeder kann die Randomness on-chain
   nachprüfen und Target/Pressure nachrechnen.

Der Server pollt nach `create_lobby` den Lobby-Account, bis der Callback
gelandet ist (`waitForRoundFulfilled`), und öffnet die Lobby dann für Joins.
`lobby_state` enthält vor dem Settlement weiterhin weder Target/Pressure noch
fremde Ergebnisse (sonst könnten Zuschauer das Target vor dem Einzahlen
ableiten); die Randomness (hex) wird nach dem Settlement mitgesendet.

## Auth (Nonce-Login, gasfrei)

1. `POST /auth/nonce` `{ "wallet": "<base58>" }` → `{ "nonce", "message" }`
2. Wallet signiert die UTF-8-Message `ZAPF ROYALE LOGIN <nonce>` (ed25519).
3. `POST /auth/verify` `{ "wallet", "signature": "<base58>" }` → `{ "token" }`

Das Token ist HMAC-SHA256-signiert (kein externes JWT-Paket), 24 h gültig,
Nonce ist single-use (5 min TTL).

## REST

- `GET /health` → `{ ok, ts }`
- `GET /lobbies` → offene Lobbies mit `entryFeeLamports`, `seatsFilled`,
  `potLamports`, Spielerliste (Status). Lobbies im Status
  `awaiting_randomness` werden nicht gelistet (noch nicht joinbar)

## WebSocket-Protokoll (`GET /ws`, JSON)

Client → Server:

| Message | Bedeutung |
| --- | --- |
| `{type:"hello", token}` | Socket authentifizieren |
| `{type:"watch_lobby", lobbyId}` | `lobby_state`-Broadcasts abonnieren |
| `{type:"join_lobby", lobbyId, txSig}` | Eigene `join_lobby`-Tx melden; Server verifiziert sie on-chain |
| `{type:"pour_start"}` | Zapfhahn auf (Serverzeit beim Empfang zählt) |
| `{type:"pour_stop"}` | Zapfhahn zu (Serverzeit beim Empfang zählt) |

Server → Client:

| Message | Bedeutung |
| --- | --- |
| `{type:"hello_ack", wallet}` | Auth ok |
| `{type:"lobby_state", lobby}` | Broadcast bei jeder Änderung (Status inkl. `awaiting_randomness`, Spielerliste spielt/fertig, Pot, Seats) |
| `{type:"round_config", lobbyId, targetMl, pressure, deadlineTs}` | **Nur** an den Spieler, **nach** bestätigtem Join (Werte aus dem VRF-Callback) |
| `{type:"pour_ack", startedAt}` | Pour läuft |
| `{type:"pour_result", pouredMl, foamMl, overflow, score}` | Serverseitiges Ergebnis (bei Overflow `pouredMl = 0xFFFFFFFF`) |
| `{type:"settled", lobbyId, winners, payoutLamports, payouts, feeLamports, txSig, randomness}` | Settlement inkl. VRF-Randomness (hex) |
| `{type:"error", code, message}` | Fehler (z. B. `ALREADY_JOINED`, `PLAY_TIMEOUT`) |

### Server-autoritativer Pour

- Der Server nimmt `Date.now()` beim **Empfang** von `pour_start`/`pour_stop`.
- Sanity-Bounds: maximale Dauer = analytischer Overflow-Zeitpunkt + 500 ms
  Puffer; `pour_stop` ohne `pour_start` wird ignoriert; exakt **ein** Versuch.
- 60-s-Play-Timeout ab Join-Bestätigung, serverseitig durchgesetzt.
  Join-Timestamps werden persistiert, Timer werden beim Boot re-armed;
  bereits abgelaufene feuern sofort und submitten `poured_ml = 0`.
  Läuft beim Timeout noch ein Pour (Client hat nie gestoppt / Disconnect),
  wird er zur Deadline eingefroren statt auf 0 gesetzt.
- Nach jedem Pour: `submit_result` on-chain. Bei 5/5 Ergebnissen automatisch
  `settle_lobby` (ohne Argumente — Target kommt aus dem VRF); Gewinner
  (sortiert nach `submissionIndex`, Rest-Empfänger zuerst) als
  `remainingAccounts`.

## Chain-Client

`src/chain/client.ts` definiert das Interface `ChainClient`
(`createLobby`, `waitForRoundFulfilled`, `confirmJoin`, `submitResult`,
`settleLobby`, `cancelLobby`).

- `AnchorChainClient` (`src/chain/anchorClient.ts`): echte Implementierung mit
  `@coral-xyz/anchor` gegen `src/chain/idl.json`. **Die IDL ist handgeschrieben**
  (Anchor-0.31-Format, Standard-Discriminators) und wird nach `anchor build`
  im `program/`-Paket durch `program/target/idl/zapf_royale.json` ersetzt.
  `waitForRoundFulfilled` pollt den Lobby-Account (~2 s Intervall), bis der
  Status `AwaitingRandomness` verlassen hat.
- `MockChainClient`: In-Memory für Tests und `CHAIN=mock`; erzeugt die
  Randomness sofort selbst (`crypto.randomBytes(32)`) mit denselben
  Ableitungsformeln. Mit `autoFulfill = false` bleibt die Lobby in
  `awaiting_randomness`, bis der Test `fulfill(lobbyId)` aufruft.

PDA-Seeds: `Config [b"config"]`, `GlobalStats [b"stats"]`,
`Lobby [b"lobby", lobby_id u64 LE]`, `Vault [b"vault", lobby_id u64 LE]`,
`ProgramIdentity [b"identity"]` (Callback-Identity unseres Programms).
VRF-Accounts bei `create_lobby`: `oracle_queue` (ENV `ORACLE_QUEUE`),
`program_identity`, SlotHashes-Sysvar
(`SysvarS1otHashes111111111111111111111111111`), VRF-Programm
(`Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`).

## Persistenz

`DATA_DIR/lobbies.json` — Lobbies inkl. VRF-Randomness (hex, nach dem
Callback), Client-Seeds, Spielern, Join-Timestamps/Deadlines und Settlements.
Schreiben ist atomar (Tmp-Datei + `rename`) und serialisiert. Die Datei
enthält **keine Geheimnisse** mehr (die Randomness ist ohnehin on-chain
öffentlich) — Lobbies im Status `awaiting_randomness` werden beim Boot wieder
per `waitForRoundFulfilled` aufgenommen.

## Hinweis

Devnet-only. Echtgeldspiele können je nach Jurisdiktion als Glücksspiel
reguliert sein.
