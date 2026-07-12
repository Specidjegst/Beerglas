# ZAPF ROYALE — On-Chain-Programm (`@zapf/program`)

Anchor-Programm (`zapf_royale`) für das PvP-Bierzapf-Spiel auf **Solana devnet**.
Spieler zahlen eine Entry-Fee in einen Lobby-Vault, spielen je einen
Zapf-Versuch, der Game-Server (`result_authority`) meldet die Ergebnisse, und
bei voller Lobby mit vollständigen Ergebnissen wird on-chain abgerechnet.
Fairness über **MagicBlock Ephemeral VRF**: Ziel-Marke und Fassdruck jeder
Runde stammen aus verifizierbarer Oracle-Randomness (siehe
[Fairness-Schema](#fairness-schema-magicblock-ephemeral-vrf)).

> Devnet-only. Echtgeld-Spiele können je nach Jurisdiktion als Glücksspiel
> reguliert sein — dieses Projekt ist ausschließlich für devnet gedacht.

## Verzeichnisstruktur

```
program/
├── Anchor.toml
├── Cargo.toml                      # Rust-Workspace
├── package.json                    # "@zapf/program" (Test-Tooling)
├── tsconfig.json
├── programs/zapf-royale/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                  # Programm-Einstieg, declare_id!
│       ├── constants.rs            # Seeds, Limits, Ziel-Tabelle
│       ├── state.rs                # Config, GlobalStats, Lobby, PlayerEntry
│       ├── errors.rs               # ZapfError (#[error_code])
│       ├── events.rs               # Alle Anchor-Events
│       └── instructions/           # Ein Modul pro Instruction
└── tests/zapf-royale.test.ts       # Bankrun-Testsuite
```

## PDAs

| Account     | Seeds                                | Typ / Inhalt                                   |
|-------------|--------------------------------------|------------------------------------------------|
| Config      | `[b"config"]`                        | Authority, Treasury, result_authority, oracle_queue (VRF), fee_bps, Allowlist der Entry-Fees |
| GlobalStats | `[b"stats"]`                         | total_games_settled, total_volume_lamports, total_fees_lamports |
| Lobby       | `[b"lobby", lobby_id.to_le_bytes()]` | Lobby-State inkl. `players`-Array, VRF-`randomness`, `target_ml`, `pressure_milli` (`lobby_id: u64`, little-endian) |
| Vault       | `[b"vault", lobby_id.to_le_bytes()]` | **SystemAccount** — hält nur Lamports (den Pot), keine Daten |
| Identity    | `[b"identity"]`                      | Kein Account-State — reiner CPI-Signer-Seed für den VRF-Request (`invoke_signed`) |

Der Vault ist bewusst ein reines System-Konto (0 Bytes Daten, Owner =
System-Programm). Auszahlungen erfolgen per `system_program::transfer`-CPI,
signiert mit den Vault-PDA-Seeds (`invoke_signed`). Der Vault kann Lamports
ausschließlich über `settle_lobby` und `cancel_lobby` verlassen.

### Space-Berechnung (via `#[derive(InitSpace)]`)

- `Config`: 8 (Discriminator) + 32·4 (Pubkeys inkl. oracle_queue) + 2
  (fee_bps) + 4 + 8·8 (Vec<u64>, max. 8) + 1 (bump) = **207 Bytes**
- `GlobalStats`: 8 + 8·3 + 1 = **33 Bytes**
- `Lobby`: 8 + 8 (lobby_id) + 1 (size) + 8 (entry_fee) + 1 (status) + 32
  (randomness) + 4 (target_ml) + 2 (pressure_milli) + 8 (created_at) + 4 +
  10·38 (Vec<PlayerEntry>, max. 10; PlayerEntry = 32 + 4 + 1 + 1) + 1 + 1
  + 1 + 1 = **460 Bytes** — der Platz für 10 Spieler ist immer reserviert,
  auch wenn das MVP mit `size = 5` spielt.

### Lobby-Status

`AwaitingRandomness = 0` → `Open = 1` → `Settled = 2` / `Cancelled = 3`.
Eine Lobby startet in `AwaitingRandomness` (VRF-Request läuft); erst der
Oracle-Callback (`fulfill_round`) öffnet sie für Joins.

## Instructions

| # | Instruction | Signer | Beschreibung |
|---|-------------|--------|--------------|
| 1 | `initialize(fee_bps, allowed_entry_fees, treasury, result_authority, oracle_queue)` | authority (payer) | Einmalig. Legt Config + GlobalStats an. `fee_bps <= 1000`, 1–8 Entry-Fees (> 0). Init-Wert lt. Spec: 400 bps. `oracle_queue: Option<Pubkey>` — `None` = `DEFAULT_QUEUE` des VRF-SDKs (devnet/mainnet flexibel). |
| 2 | `set_fee(fee_bps)` | authority | Ändert die Fee (max. 1000 bps) und emittiert `FeeChanged { old_bps, new_bps }`. |
| 3 | `create_lobby(lobby_id, size, entry_fee, client_seed)` | result_authority (payer) | `size` 2..=10, `entry_fee` muss in der Allowlist sein. Status = `AwaitingRandomness`; fordert im selben Ix per CPI VRF-Randomness an (`caller_seed = hash(lobby_id LE ++ client_seed)`, Callback = `fulfill_round`, Lobby-PDA als Callback-Account). Zusätzliche Accounts: `oracle_queue` (== `config.oracle_queue`), `program_identity` (`[b"identity"]`), SlotHashes-Sysvar, VRF-Programm. |
| 4 | `fulfill_round(randomness)` | VRF-Programm-Identity | Oracle-Callback — nur die Identity des VRF-Programms (`ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY`) darf signieren. Speichert `randomness`, leitet `target_ml` + `pressure_milli` ab, Status → Open. Emittiert `RoundFulfilled`. |
| 5 | `join_lobby(lobby_id)` | Spieler | System-Transfer `entry_fee` → Vault. Fehler bei: `AwaitingRandomness` (`RandomnessNotFulfilled`), nicht Open, voll, Doppel-Join. |
| 6 | `submit_result(player, poured_ml)` | result_authority | Fehler wenn Spieler nicht gejoint / schon gespielt / Lobby nicht Open. Speichert `submission_index = played_count` (Meldereihenfolge). `poured_ml = u32::MAX` ist der Overflow-Sentinel, `poured_ml = 0` der Timeout-Fall. |
| 7 | `settle_lobby()` | result_authority | Nur bei `joined_count == size == played_count`. Ziel = `lobby.target_ml` (VRF), berechnet Gewinner on-chain, zahlt Fee + Gewinne aus, updatet GlobalStats, Status → Settled. Gewinner-Wallets als `remaining_accounts` (writable) in **players-Array-Reihenfolge der Gewinner**; Pubkeys werden on-chain validiert. `treasury` muss `config.treasury` sein. |
| 8 | `cancel_lobby()` | beliebig (permissionless) | Erst ab `created_at + 86400 s`, bei Status Open **oder** AwaitingRandomness (Oracle-Callback nie eingetroffen — dann gibt es keine Spieler und keine Refunds). Voller Refund an alle Gejointen (keine Fee), Status → Cancelled. Spieler-Wallets als `remaining_accounts` (writable) in players-Array-Reihenfolge. |

### Settlement-Logik (on-chain)

1. `target_ml = lobby.target_ml` — wurde beim VRF-Callback on-chain aus der
   Randomness abgeleitet (Status Open garantiert die Erfüllung).
2. Score je Spieler: `poured_ml == u32::MAX` → `u64::MAX` (Overflow verliert
   immer), sonst `abs_diff(poured_ml, target_ml)`.
3. Gewinner = alle Spieler mit dem minimalen Score (Tie-Split).
4. `pot = entry_fee * size` (checked), `fee = pot * fee_bps / 10_000`
   (u128-Zwischenrechnung, abgerundet), `pool = pot - fee`.
5. `payout_per_winner = pool / n`, `remainder = pool % n` — der Rest geht an
   den Gewinner mit dem **kleinsten `submission_index`** (wer zuerst gemeldet
   wurde). Invariante: `fee + n·payout_per_winner + remainder == pot`, der
   Vault ist danach leer.

## Events

| Event | Felder |
|-------|--------|
| `FeeChanged` | `old_bps`, `new_bps` |
| `LobbyCreated` | `lobby_id`, `size`, `entry_fee`, `client_seed`, `created_at` |
| `RoundFulfilled` | `lobby_id`, `randomness`, `target_ml`, `pressure_milli` |
| `PlayerJoined` | `lobby_id`, `player`, `pot_after` |
| `ResultSubmitted` | `lobby_id`, `player`, `poured_ml`, `submission_index`, `played_count` |
| `LobbySettled` | `lobby_id`, `target_ml`, `pot`, `fee`, `winners: Vec<Pubkey>`, `payout_per_winner`, `remainder` |
| `LobbyCancelled` | `lobby_id`, `refunded_players`, `refund_per_player` |

Jeder Lamport-Fluss (Join, Settlement, Refund) und jede Fee-Änderung ist damit
öffentlich nachvollziehbar; die `/stats`-Seite des Frontends liest zusätzlich
`GlobalStats` direkt on-chain.

## Fairness-Schema (MagicBlock Ephemeral VRF)

Die Rundenparameter stammen aus einer **Verifiable Random Function** des
[MagicBlock Ephemeral VRF](https://github.com/magicblock-labs/ephemeral-vrf)-
Programms (`Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`, devnet + mainnet):

1. **Request:** `create_lobby` schickt per CPI einen Randomness-Request an
   das VRF-Programm — mit `caller_seed = hash(lobby_id LE-Bytes ++
   client_seed)` (der `client_seed` steht öffentlich im
   `LobbyCreated`-Event), Callback = `fulfill_round` unseres Programms und
   der Lobby-PDA als Callback-Account. Der Request wird von unserem
   Identity-PDA (`[b"identity"]`) signiert. Die Lobby ist bis zur Antwort
   `AwaitingRandomness` — niemand kann joinen.
2. **Callback:** Der Oracle berechnet die VRF-Randomness (verifizierbar
   gegen seinen Public Key) und ruft `fulfill_round(randomness)` per CPI
   auf. Das Programm akzeptiert den Callback **nur**, wenn die globale
   VRF-Programm-Identity (`ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY`)
   als Signer dabei ist — niemand sonst (auch nicht der Server) kann
   Randomness einschleusen.
3. **Ableitung (on-chain, identisch in Server- und Web-Code):**
   - `target_ml = [500, 1000, 1500][randomness[0] % 3]`
   - `raw = randomness[1] | (randomness[2] << 8)` (u16, little-endian)
   - `pressure_milli = 800 + floor(raw * 500 / 65535)` (800..=1300;
     Anzeige/Simulation: `pressure = pressure_milli / 1000`)
4. **Settlement:** `settle_lobby()` nutzt das gespeicherte `lobby.target_ml`;
   Gewinnerermittlung und Auszahlung passieren vollständig on-chain aus den
   gespeicherten Ergebnissen. `randomness` ist im `RoundFulfilled`-Event und
   im Lobby-Account öffentlich; weder Server noch Spieler können sie
   beeinflussen oder vorab kennen (vor `fulfill_round` ist kein Join möglich).

## Fehlercodes

`ZapfError` (ab 6000): `InvalidFeeBps`, `TooManyAllowedFees`, `NoAllowedFees`,
`Unauthorized`, `InvalidLobbySize`, `EntryFeeNotAllowed`, `LobbyNotOpen`,
`LobbyFull`, `AlreadyJoined`, `PlayerNotInLobby`, `AlreadyPlayed`,
`LobbyNotFull`, `NotAllResultsSubmitted`, `InvalidWinnerAccounts`,
`InvalidTreasury`, `InvalidRefundAccounts`, `CancelTooEarly`, `MathOverflow`,
`RandomnessNotFulfilled`, `RandomnessAlreadyFulfilled`,
`UnauthorizedVrfCallback`, `InvalidOracleQueue`. Details in
`programs/zapf-royale/src/errors.rs`.

## Build & Test

**Windows-Hinweis:** Die Solana/Anchor-Toolchain läuft unter Windows nur über
**WSL** (Ubuntu empfohlen). Alle folgenden Befehle in einer WSL-Shell im
`program/`-Verzeichnis ausführen.

Toolchain (einmalig):

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Solana CLI (Agave)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
# Anchor 0.31.1 über avm
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.1 && avm use 0.31.1
# Node-Abhängigkeiten der Tests
yarn install   # bzw. npm install / pnpm install
```

### Programm-ID setzen (wichtig!)

`declare_id!` in `src/lib.rs` und die IDs in `Anchor.toml` enthalten den
Anchor-Platzhalter `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS`. Nach dem
ersten Build das eigene Programm-Keypair synchronisieren:

```bash
anchor build
anchor keys sync   # ersetzt die Platzhalter-ID in lib.rs + Anchor.toml
anchor build       # erneut bauen mit der echten ID
```

### Tests & das `test-vrf`-Feature

Die Testsuite (`tests/zapf-royale.test.ts`) läuft gegen
**solana-bankrun**/**anchor-bankrun** — kein lokaler Validator nötig, aber die
Artefakte aus dem Build (`target/deploy/zapf_royale.so`,
`target/idl/zapf_royale.json`, `target/types/`) müssen existieren.

In bankrun existiert weder das VRF-Programm noch ein Oracle. Deshalb gibt es
das Cargo-Feature **`test-vrf`** (in `programs/zapf-royale/Cargo.toml`):

- `create_lobby` überspringt den VRF-Request-CPI (nur Log-Meldung),
- `fulfill_round` akzeptiert **zusätzlich** `config.result_authority` als
  Signer (Config-PDA als remaining account), sodass die Tests den
  Oracle-Callback mit deterministischen Randomness-Bytes simulieren können.

**Ein mit `test-vrf` gebautes Artefakt darf NIEMALS deployed werden** — es
würde dem Server erlauben, die Randomness selbst zu setzen. Der reguläre
`anchor build` (ohne Feature) enthält den Test-Pfad nicht (cfg-gated).

```bash
anchor test -- --features test-vrf    # Build mit Feature + ts-mocha-Suite
# oder manuell:
anchor build -- --features test-vrf
yarn test:bankrun
```

Abgedeckte Fälle: VRF-Lifecycle (AwaitingRandomness → fulfill_round → Open,
inkl. Ableitung von `target_ml`/`pressure_milli` an den Rändern 800/1300),
Join/Submit/Settle vor dem Callback, fremder Callback-Signer, Doppel-fulfill,
falsche Oracle-Queue, Happy Path (5 Spieler, exakt 4 % Fee), Tie-Split (2
Gewinner), Tie-Remainder an den kleinsten `submission_index`,
Overflow-Sentinel (`u32::MAX`), Doppel-Join, Join auf volle/geschlossene
Lobby, Doppel-Play, fremde Signer, Settle vor voller Lobby / vor allen
Ergebnissen, falsche Gewinner-Accounts, falsche Treasury, Doppel-Settlement,
Cancel vor/nach 24 h (Clock-Warp) für Open (voller Refund) und
AwaitingRandomness (keine Refunds) und GlobalStats-Akkumulation über mehrere
Spiele.

### Hinweis: erster `anchor build` nach dem VRF-Umbau

Die exakte API von `ephemeral-vrf-sdk 0.4.1` (Feature `anchor-compat`) konnte
ohne lokale Rust-Toolchain nicht kompiliert werden. Alle Stellen, an denen
API-Drift möglich ist, sind im Code mit `// VERIFY on first build` markiert
(Pubkey-Typ-Konvertierungen SDK ↔ anchor-lang, `compat::Instruction` vs.
`invoke_signed`, Deprecation von `create_request_randomness_ix`). Beim ersten
Build diese Stellen prüfen und ggf. minimal anpassen.

### Devnet-Deploy

```bash
solana config set --url devnet
solana airdrop 5            # devnet-SOL für den Deployer
anchor deploy --provider.cluster devnet
```

Danach einmalig `initialize` mit `fee_bps = 400`, der Treasury-Pubkey, dem
`result_authority`-Pubkey des Game-Servers, der Entry-Fee-Allowlist
(z. B. 0.05 / 0.1 / 0.5 SOL in Lamports) und `oracle_queue = None`
(Standard-Queue des VRF-SDKs; nur setzen, wenn eine eigene Queue verwendet
wird) aufrufen.

## Hinweis zum Monorepo

Dieses Paket ist bewusst **nicht** Teil des pnpm-Workspaces (`server`, `web`):
Anchor verwaltet sein JS-Test-Tooling selbst (Anchor.toml ruft `yarn`), und
die Rust-Toolchain lebt in WSL. `server/` und `web/` konsumieren die IDL aus
`program/target/idl/zapf_royale.json` bzw. `program/target/types/`.
