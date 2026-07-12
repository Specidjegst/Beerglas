# Claude Code Prompt — ZAPF ROYALE

> **Hinweis:** Randomness wurde gegenüber dieser Spec von Commit-Reveal auf
> **MagicBlock Ephemeral VRF** umgestellt (Randomness-Request in
> `create_lobby`, Oracle-Callback `fulfill_round`), siehe Root-README.

Copy everything below this line into Claude Code. Attach the file `zapf-royale-v2.html` (the existing UI demo) to the project folder first.

---

Build **Zapf Royale**, a full-stack PvP skill game on Solana (devnet first). Players pour beer from a tap into a 1.6L Maßkrug and try to hit a target fill line. Closest pour wins the pot. This is a monorepo with three packages: `program/` (Anchor), `server/` (Node.js game server), `web/` (Next.js frontend).

## Game concept

- The glass has three etched marks: **0.5 L, 1.0 L, 1.5 L** (capacity 1.6 L / 1600 ml).
- Each lobby round has one **target** (randomly one of the three marks) and one **keg pressure factor** (random between 0.8 and 1.3). Both are identical for every player in the same lobby.
- Pressure scales pour rate (base 520 ml/s × pressure) and foam growth (34 ml/s × pressure^1.6). Players must react to the visible flow speed, not memorize timing.
- Each player gets exactly **one attempt**: hold to pour, release to lock in.
- **Overflow** (beer + 0.7 × foam ≥ 101% of capacity) = automatic worst score for that player.
- **Score** = `abs(poured_ml − target_ml)`, lower is better.
- **Winner** = lowest score. **Tie:** if two or more players share the lowest score, the pot is split equally among them (integer lamport remainder goes to the player who submitted first, deterministically).

## Lobby flow (asynchronous)

- Lobby size: **5 players** (make size a config parameter so 10 works later, but MVP = 5).
- Any player can **join an open lobby at any time**, pay the entry fee, and **play their attempt immediately** — no waiting for others.
- As soon as the lobby has 5 paid players AND all 5 results are recorded, the server triggers settlement automatically.
- **Play timeout: 60 seconds.** From the moment a player's join transaction is confirmed, they have exactly 60 seconds to complete their pour attempt. If the timer expires without a pour, the server submits `poured_ml = 0` for them (worst possible score, entry stays in the pot, no refund). This prevents a paid-but-absent player from blocking settlement forever, and prevents the exploit of watching other results and disconnecting to dodge a loss. Show the countdown prominently in the UI after payment.
- If a lobby doesn't fill within 24 hours, anyone can call `cancel_lobby` and all entries are refunded in full (no fee taken).

## Fees & transparency (critical requirement)

- **Operator fee: 4% of the pot per game (400 bps)**, taken at settlement, sent to a treasury account.
- Fee percentage is stored in a Config PDA — hardcoded to 400 bps at init, changeable only by the program authority, and **every change emits an event**.
- A **GlobalStats PDA** tracks: `total_games_settled`, `total_volume_lamports` (sum of all pots), `total_fees_lamports`. Updated atomically at every settlement.
- Anyone must be able to verify volume and fees: emit Anchor events for every join, result, and settlement (with pot, fee amount, winners), and build a public **/stats page** in the frontend that reads GlobalStats on-chain, shows total volume and total fees paid, lists recent settlements, and links each one to Solana Explorer.

## Package 1: `program/` (Anchor, Rust)

Accounts:
- `Config` PDA: authority, treasury pubkey, `fee_bps: u16 = 400`, allowed entry fees (e.g. 0.05 / 0.1 / 0.5 SOL), `result_authority` (server signer pubkey).
- `Lobby` PDA (seed: lobby id): size, entry_fee, status (Open / Settling / Settled / Cancelled), `seed_commitment: [u8; 32]`, players array with (pubkey, poured_ml, has_played), created_at.
- `Vault` PDA per lobby holding the escrowed SOL.
- `GlobalStats` PDA as described above.

Instructions:
1. `initialize(config)` — one-time setup.
2. `create_lobby(size, entry_fee, seed_commitment)` — only `result_authority`; commitment = SHA-256 of the server's secret seed (provable fairness).
3. `join_lobby` — player transfers entry fee into vault. Reject double joins and full/closed lobbies.
4. `submit_result(player, poured_ml)` — only `result_authority`; reject if player hasn't joined, already played, or lobby closed.
5. `settle_lobby(revealed_seed)` — only `result_authority`; verify SHA-256(revealed_seed) == commitment; compute winner(s) on-chain from stored results; transfer 4% of pot to treasury, split remainder among winner(s); update GlobalStats; emit `LobbySettled` event with all amounts; mark Settled.
6. `cancel_lobby` — permissionless after 24h timeout; refund all joined players fully.

Security requirements: checked math everywhere, no re-settlement, vault can only pay out via settle/cancel, PDA seeds documented, all lamport flows in events.

Write full Anchor tests (litesvm or bankrun) covering: happy path 5 players, tie split between 2 players, tie split remainder handling, overflow player, double-join rejection, double-play rejection, settlement before lobby full rejection, cancel + refund, fee math exactness (4% of pot), GlobalStats accumulation over multiple games.

## Package 2: `server/` (Node.js + TypeScript)

- Fastify + WebSocket. Holds the `result_authority` keypair (env var).
- **Server-authoritative pour:** the client only sends `pour_start` and `pour_stop` over an open WebSocket. The server runs the fill simulation itself (same constants as the UI: base 520 ml/s × pressure, foam 34 × pressure^1.6, capacity 1600, overflow rule) using its own clock, with sanity bounds on latency. The client render is cosmetic; the server's number is the truth.
- Per lobby: generate a random 32-byte seed, commit its hash on-chain at `create_lobby`, derive target mark and pressure deterministically from the seed (e.g. HMAC), reveal the seed at settlement.
- Endpoints/WS messages: list open lobbies, join handshake (verify the player's join transaction landed), pour session, live lobby state broadcast, settlement notification.
- Enforce the 60-second play timeout server-side: start the timer at join confirmation; on expiry without a completed pour, submit `poured_ml = 0` for that player automatically. The timer must survive server restarts (persist join timestamps).
- After each pour: sign and send `submit_result`. When 5/5 played: send `settle_lobby`.
- Auth: client proves wallet ownership by signing a nonce message (no gas).

## Package 3: `web/` (Next.js + @solana/wallet-adapter)

- **Reuse the attached `zapf-royale-v2.html` as the visual reference and port its SVG scene 1:1 into a React component** — the Maßkrug with the 3 etched marks, glowing target mark, chrome tap with tilting handle, pressure gauge, wave surface, bubbles, foam, condensation, splash particles. Do not redesign it; keep the exact look, fonts (Alfa Slab One / Outfit / JetBrains Mono) and palette.
- Pages: lobby list (open lobbies with entry fee, seats filled, pot), game screen (join → pay → pour via WebSocket, tap animation driven by server tick), result screen (accuracy %, verdict, waiting state until lobby settles, then winner reveal with payout amounts), **/stats** transparency page (GlobalStats, fee = 4% clearly labeled, recent settlements with Explorer links, provable-fairness explanation of the commit-reveal scheme).
- Wallet connect: Phantom + Solflare, sign-message login matching the server nonce flow.
- German UI copy throughout (ZIEL, FASSDRUCK, GEDRÜCKT HALTEN ZUM ZAPFEN, ABGEGEBEN, ÜBERGELAUFEN, etc. — take wording from the attached demo).

## Milestones (work in this order, verify each before moving on)

1. Anchor program + full test suite green.
2. Server with pour simulation + devnet integration (create/join/submit/settle against localnet).
3. Frontend port of the demo UI + wallet connect + full game loop on devnet.
4. /stats transparency page.
5. End-to-end test: 5 wallets, one full game, verify fee lands in treasury and stats update.

## Non-goals for MVP

Mainnet deployment, SPL token entries, 10-player lobbies (keep configurable but untested), sound, mobile app. Add a prominent disclaimer that real-money games may be regulated as gambling depending on jurisdiction and this is devnet-only.

Use latest stable Anchor and Solana web3.js v2 where practical. Set up the monorepo with pnpm workspaces. Document every PDA, instruction and the fairness scheme in the README.
