/**
 * ZAPF ROYALE — Programm-Tests (solana-bankrun + anchor-bankrun).
 *
 * Voraussetzung: `anchor build -- --features test-vrf` wurde ausgeführt (die
 * Tests laden target/idl/zapf_royale.json und target/deploy/zapf_royale.so
 * über startAnchor). Es wird KEIN lokaler Validator benötigt.
 *
 * VRF-Simulation: Das Programm nutzt MagicBlock Ephemeral VRF — der Oracle
 * liefert Randomness per Callback (`fulfill_round`), den on-chain nur die
 * VRF-Programm-Identity signieren darf. In bankrun existiert weder das
 * VRF-Programm noch der Oracle, deshalb MUSS das Programm mit dem
 * Cargo-Feature "test-vrf" gebaut sein: dann überspringt create_lobby den
 * VRF-CPI und fulfill_round akzeptiert alternativ config.result_authority
 * als Signer (Config-PDA als remaining account). NIEMALS ein solches
 * Artefakt deployen!
 *
 * Hinweis zur Technik: bankrun dedupliziert identische Transaktionen
 * (gleiche Message + Blockhash). Für Tests, die dieselbe Instruction
 * zweimal senden (Doppel-Join, Doppel-Play, Doppel-Settle, Doppel-Cancel),
 * bauen wir die zweite Transaktion manuell mit einem anderen Fee-Payer,
 * damit sie eine neue Signatur bekommt und wirklich das Programm erreicht.
 */

import * as path from "path";
import { assert } from "chai";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { startAnchor, Clock, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import type { ZapfRoyale } from "../target/types/zapf_royale";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("../target/idl/zapf_royale.json");
const PROGRAM_ID = new PublicKey(IDL.address);

// ---------------------------------------------------------------------------
// Konstanten (müssen zu constants.rs / errors.rs / ephemeral-vrf-sdk passen)
// ---------------------------------------------------------------------------

const SOL = 1_000_000_000n;
const FEE_005 = 50_000_000n; // 0.05 SOL
const FEE_01 = 100_000_000n; // 0.1 SOL
const FEE_05 = 500_000_000n; // 0.5 SOL
const FEE_ODD = 1_000_001n; // erzeugt einen Auszahlungs-Rest beim Tie-Split
const U32_MAX = 4_294_967_295; // Overflow-Sentinel

// MagicBlock Ephemeral VRF (ephemeral_vrf_sdk::consts)
const VRF_PROGRAM_ID = new PublicKey(
  "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
);
const DEFAULT_QUEUE = new PublicKey(
  "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"
);
const SLOT_HASHES_SYSVAR = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111"
);

const ERR = {
  InvalidFeeBps: 6000,
  TooManyAllowedFees: 6001,
  NoAllowedFees: 6002,
  Unauthorized: 6003,
  InvalidLobbySize: 6004,
  EntryFeeNotAllowed: 6005,
  LobbyNotOpen: 6006,
  LobbyFull: 6007,
  AlreadyJoined: 6008,
  PlayerNotInLobby: 6009,
  AlreadyPlayed: 6010,
  LobbyNotFull: 6011,
  NotAllResultsSubmitted: 6012,
  InvalidWinnerAccounts: 6013,
  InvalidTreasury: 6014,
  InvalidRefundAccounts: 6015,
  CancelTooEarly: 6016,
  MathOverflow: 6017,
  RandomnessNotFulfilled: 6018,
  RandomnessAlreadyFulfilled: 6019,
  UnauthorizedVrfCallback: 6020,
  InvalidOracleQueue: 6021,
} as const;

type ErrName = keyof typeof ERR;

// ---------------------------------------------------------------------------
// Test-Setup
// ---------------------------------------------------------------------------

describe("zapf_royale", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<ZapfRoyale>;

  const resultAuthority = Keypair.generate();
  const treasury = Keypair.generate();
  // P[0..9] = Spieler, P[10] = Außenstehender, P[11] = Cancel-Aufrufer
  const P: Keypair[] = Array.from({ length: 12 }, () => Keypair.generate());
  const outsider = P[10];
  const canceller = P[11];

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    PROGRAM_ID
  );
  const [statsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    PROGRAM_ID
  );
  // Identity-PDA des Programms — signiert den VRF-Request (nur CPI-Seed).
  const [identityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("identity")],
    PROGRAM_ID
  );

  const idBuf = (id: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(id));
    return b;
  };
  const lobbyPda = (id: number): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("lobby"), idBuf(id)],
      PROGRAM_ID
    )[0];
  const vaultPda = (id: number): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), idBuf(id)],
      PROGRAM_ID
    )[0];

  /** Deterministischer client_seed pro Lobby (fließt in den caller_seed ein). */
  const clientSeed = (id: number): Buffer => {
    const s = Buffer.alloc(32, 9);
    idBuf(id).copy(s, 0);
    return s;
  };

  /**
   * Deterministische VRF-Randomness:
   * - byte0 steuert das Ziel: target_ml = [500, 1000, 1500][byte0 % 3]
   * - bytes 1..3 (LE u16 `raw`) steuern den Druck:
   *   pressure_milli = 800 + floor(raw * 500 / 65535)
   */
  const makeRandomness = (b0: number, raw = 0): Buffer => {
    const r = Buffer.alloc(32, 7);
    r[0] = b0;
    r[1] = raw & 0xff;
    r[2] = (raw >> 8) & 0xff;
    return r;
  };
  const expectedPressureMilli = (raw: number): number =>
    800 + Math.floor((raw * 500) / 65535);

  // Erwartete GlobalStats werden über alle Settlements mitgeführt.
  let expGames = 0n;
  let expVolume = 0n;
  let expFees = 0n;

  before(async () => {
    const preloaded = [resultAuthority, treasury, ...P].map((kp) => ({
      address: kp.publicKey,
      info: {
        lamports: Number(100n * SOL),
        data: new Uint8Array(0),
        owner: SystemProgram.programId,
        executable: false,
      },
    }));
    // Fake-Account an der VRF-Programm-Adresse (executable), damit Anchors
    // Program<VrfProgram>-Check (Adresse + executable-Flag) in create_lobby
    // besteht. Der eigentliche CPI ist im test-vrf-Build deaktiviert, der
    // Account wird also nie ausgeführt.
    preloaded.push({
      address: VRF_PROGRAM_ID,
      info: {
        lamports: Number(1n * SOL),
        data: new Uint8Array(0),
        owner: new PublicKey("BPFLoader2111111111111111111111111111111111"),
        executable: true,
      },
    });
    context = await startAnchor(path.resolve(__dirname, ".."), [], preloaded);
    provider = new BankrunProvider(context);
    program = new Program<ZapfRoyale>(IDL, provider);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const balance = async (pk: PublicKey): Promise<bigint> =>
    await context.banksClient.getBalance(pk);

  async function expectZapfError(p: Promise<unknown>, name: ErrName) {
    const code = ERR[name];
    try {
      await p;
    } catch (e: any) {
      const s =
        String(e) +
        (e?.message ?? "") +
        JSON.stringify(e?.logs ?? e?.transactionLogs ?? []);
      assert(
        s.includes(name) ||
          s.includes(String(code)) ||
          s.includes("0x" + code.toString(16)),
        `Erwartet ${name} (${code}), bekommen: ${s}`
      );
      return;
    }
    assert.fail(`Erwartet ${name} (${code}), aber Transaktion war erfolgreich`);
  }

  async function expectAnyError(p: Promise<unknown>) {
    try {
      await p;
    } catch {
      return;
    }
    assert.fail("Erwarteter Fehler blieb aus");
  }

  /** Manuelle Tx mit eigenem Fee-Payer (umgeht bankrun-Deduplizierung). */
  async function sendWithPayer(
    ix: TransactionInstruction,
    payer: Keypair,
    extraSigners: Keypair[] = []
  ) {
    const tx = new Transaction();
    tx.add(ix);
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer, ...extraSigners);
    await context.banksClient.processTransaction(tx);
  }

  function createLobbyBuilder(
    id: number,
    size: number,
    entryFee: bigint,
    seed: Buffer,
    overrides: Partial<{
      resultAuthority: PublicKey;
      oracleQueue: PublicKey;
    }> = {}
  ) {
    return program.methods
      .createLobby(new BN(id), size, new BN(entryFee.toString()), Array.from(seed))
      .accountsPartial({
        resultAuthority:
          overrides.resultAuthority ?? resultAuthority.publicKey,
        config: configPda,
        lobby: lobbyPda(id),
        vault: vaultPda(id),
        oracleQueue: overrides.oracleQueue ?? DEFAULT_QUEUE,
        programIdentity: identityPda,
        slotHashes: SLOT_HASHES_SYSVAR,
        vrfProgram: VRF_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      });
  }

  async function createLobby(
    id: number,
    size: number,
    entryFee: bigint,
    seed: Buffer = clientSeed(id)
  ) {
    await createLobbyBuilder(id, size, entryFee, seed)
      .signers([resultAuthority])
      .rpc();
  }

  /**
   * Simulierter VRF-Oracle-Callback (test-vrf-Build): result_authority
   * signiert statt der VRF-Programm-Identity; die Config-PDA kommt als
   * remaining account mit, damit das Programm den Signer prüfen kann.
   */
  function fulfillBuilder(
    id: number,
    randomness: Buffer,
    signer: Keypair = resultAuthority,
    withConfig = true
  ) {
    let b = program.methods
      .fulfillRound(Array.from(randomness))
      .accountsPartial({
        vrfProgramIdentity: signer.publicKey,
        lobby: lobbyPda(id),
      });
    if (withConfig) {
      b = b.remainingAccounts([
        { pubkey: configPda, isSigner: false, isWritable: false },
      ]);
    }
    return b.signers([signer]);
  }
  const fulfill = (id: number, randomness: Buffer) =>
    fulfillBuilder(id, randomness).rpc();

  /** create_lobby + simulierter Oracle-Callback in einem Schritt. */
  async function createOpenLobby(
    id: number,
    size: number,
    entryFee: bigint,
    randomness: Buffer
  ) {
    await createLobby(id, size, entryFee);
    await fulfill(id, randomness);
  }

  function joinBuilder(id: number, player: Keypair) {
    return program.methods
      .joinLobby(new BN(id))
      .accountsPartial({
        player: player.publicKey,
        lobby: lobbyPda(id),
        vault: vaultPda(id),
        systemProgram: SystemProgram.programId,
      })
      .signers([player]);
  }
  const join = (id: number, player: Keypair) => joinBuilder(id, player).rpc();

  function submitBuilder(id: number, player: PublicKey, pouredMl: number) {
    return program.methods
      .submitResult(player, pouredMl)
      .accountsPartial({
        resultAuthority: resultAuthority.publicKey,
        config: configPda,
        lobby: lobbyPda(id),
      })
      .signers([resultAuthority]);
  }
  const submit = (id: number, player: PublicKey, pouredMl: number) =>
    submitBuilder(id, player, pouredMl).rpc();

  function settleBuilder(id: number, winners: PublicKey[]) {
    return program.methods
      .settleLobby()
      .accountsPartial({
        resultAuthority: resultAuthority.publicKey,
        config: configPda,
        lobby: lobbyPda(id),
        vault: vaultPda(id),
        treasury: treasury.publicKey,
        globalStats: statsPda,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        winners.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true }))
      )
      .signers([resultAuthority]);
  }
  const settle = (id: number, winners: PublicKey[]) =>
    settleBuilder(id, winners).rpc();

  function cancelBuilder(id: number, caller: PublicKey, refundees: PublicKey[]) {
    return program.methods
      .cancelLobby()
      .accountsPartial({
        caller,
        lobby: lobbyPda(id),
        vault: vaultPda(id),
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        refundees.map((pk) => ({
          pubkey: pk,
          isSigner: false,
          isWritable: true,
        }))
      );
  }

  async function assertStats() {
    const stats = await program.account.globalStats.fetch(statsPda);
    assert.strictEqual(BigInt(stats.totalGamesSettled.toString()), expGames);
    assert.strictEqual(
      BigInt(stats.totalVolumeLamports.toString()),
      expVolume
    );
    assert.strictEqual(BigInt(stats.totalFeesLamports.toString()), expFees);
  }

  async function advanceClock(seconds: bigint) {
    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + seconds
      )
    );
  }

  // -------------------------------------------------------------------------
  // initialize / set_fee
  // -------------------------------------------------------------------------

  it("initialize: legt Config (fee_bps=400, Standard-Oracle-Queue) und GlobalStats an", async () => {
    await program.methods
      .initialize(
        400,
        [FEE_005, FEE_01, FEE_05, FEE_ODD].map((f) => new BN(f.toString())),
        treasury.publicKey,
        resultAuthority.publicKey,
        null // oracle_queue: None -> DEFAULT_QUEUE des VRF-SDKs
      )
      .accountsPartial({
        authority: provider.wallet.publicKey,
        config: configPda,
        globalStats: statsPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.strictEqual(config.feeBps, 400);
    assert.isTrue(config.authority.equals(provider.wallet.publicKey));
    assert.isTrue(config.treasury.equals(treasury.publicKey));
    assert.isTrue(config.resultAuthority.equals(resultAuthority.publicKey));
    assert.isTrue(
      config.oracleQueue.equals(DEFAULT_QUEUE),
      "oracle_queue = DEFAULT_QUEUE, wenn None übergeben wurde"
    );
    assert.deepStrictEqual(
      config.allowedEntryFees.map((f: BN) => BigInt(f.toString())),
      [FEE_005, FEE_01, FEE_05, FEE_ODD]
    );

    await assertStats(); // alles 0
  });

  it("initialize: zweiter Aufruf schlägt fehl (Config existiert bereits)", async () => {
    // Andere Argumente, damit die Tx nicht als Duplikat wegdedupliziert wird.
    await expectAnyError(
      program.methods
        .initialize(
          500,
          [new BN(FEE_01.toString())],
          treasury.publicKey,
          resultAuthority.publicKey,
          DEFAULT_QUEUE
        )
        .accountsPartial({
          authority: provider.wallet.publicKey,
          config: configPda,
          globalStats: statsPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  });

  it("set_fee: nur authority; Werte werden gesetzt", async () => {
    // Fremder Signer wird abgelehnt
    await expectZapfError(
      program.methods
        .setFee(500)
        .accountsPartial({
          authority: resultAuthority.publicKey,
          config: configPda,
        })
        .signers([resultAuthority])
        .rpc(),
      "Unauthorized"
    );

    // fee_bps > 1000 wird abgelehnt
    await expectZapfError(
      program.methods
        .setFee(1001)
        .accountsPartial({
          authority: provider.wallet.publicKey,
          config: configPda,
        })
        .rpc(),
      "InvalidFeeBps"
    );

    // Authority darf ändern …
    await program.methods
      .setFee(500)
      .accountsPartial({
        authority: provider.wallet.publicKey,
        config: configPda,
      })
      .rpc();
    let config = await program.account.config.fetch(configPda);
    assert.strictEqual(config.feeBps, 500);

    // … und zurück auf 400 (alle folgenden Fee-Berechnungen erwarten 4 %).
    await program.methods
      .setFee(400)
      .accountsPartial({
        authority: provider.wallet.publicKey,
        config: configPda,
      })
      .rpc();
    config = await program.account.config.fetch(configPda);
    assert.strictEqual(config.feeBps, 400);
  });

  // -------------------------------------------------------------------------
  // create_lobby Validierungen
  // -------------------------------------------------------------------------

  it("create_lobby: nur result_authority, size 2..=10, Fee aus Allowlist, korrekte Queue", async () => {
    // Falscher Signer (die Programm-Authority ist NICHT die result_authority)
    await expectZapfError(
      createLobbyBuilder(900, 5, FEE_01, clientSeed(900), {
        resultAuthority: provider.wallet.publicKey,
      }).rpc(),
      "Unauthorized"
    );

    // size < 2
    await expectZapfError(
      createLobby(901, 1, FEE_01),
      "InvalidLobbySize"
    );
    // size > 10
    await expectZapfError(
      createLobby(902, 11, FEE_01),
      "InvalidLobbySize"
    );
    // Entry-Fee nicht in der Allowlist
    await expectZapfError(
      createLobby(903, 5, 123_456n),
      "EntryFeeNotAllowed"
    );
    // Falsche Oracle-Queue (!= config.oracle_queue)
    await expectZapfError(
      createLobbyBuilder(904, 5, FEE_01, clientSeed(904), {
        oracleQueue: treasury.publicKey,
      })
        .signers([resultAuthority])
        .rpc(),
      "InvalidOracleQueue"
    );
  });

  // -------------------------------------------------------------------------
  // Lobby 7: VRF-Lifecycle — AwaitingRandomness -> fulfill_round -> Open
  // -------------------------------------------------------------------------

  it("VRF: Lobby startet in AwaitingRandomness (randomness genullt)", async () => {
    await createLobby(7, 5, FEE_01);

    const lobby = await program.account.lobby.fetch(lobbyPda(7));
    assert.isDefined((lobby.status as any).awaitingRandomness);
    assert.deepStrictEqual(
      Buffer.from(lobby.randomness),
      Buffer.alloc(32, 0),
      "randomness genullt bis zum Callback"
    );
    assert.strictEqual(lobby.targetMl, 0);
    assert.strictEqual(lobby.pressureMilli, 0);
  });

  it("VRF: join vor fulfill_round wird abgelehnt", async () => {
    await expectZapfError(join(7, P[0]), "RandomnessNotFulfilled");
  });

  it("VRF: submit_result vor fulfill_round wird abgelehnt", async () => {
    await expectZapfError(submit(7, P[0].publicKey, 500), "LobbyNotOpen");
  });

  it("VRF: settle vor fulfill_round wird abgelehnt", async () => {
    await expectZapfError(settle(7, []), "LobbyNotOpen");
  });

  it("VRF: fulfill_round mit fremdem Signer wird abgelehnt (test-vrf-Pfad)", async () => {
    // outsider ist weder VRF-Identity noch config.result_authority.
    await expectZapfError(
      fulfillBuilder(7, makeRandomness(3, 0x8000), outsider).rpc(),
      "UnauthorizedVrfCallback"
    );
  });

  it("VRF: fulfill_round ohne Config-Account wird abgelehnt (test-vrf-Pfad)", async () => {
    await expectZapfError(
      fulfillBuilder(7, makeRandomness(3, 0x8000), resultAuthority, false).rpc(),
      "UnauthorizedVrfCallback"
    );
  });

  it("VRF: fulfill_round speichert randomness, target und pressure; Lobby wird Open", async () => {
    // byte0 = 3 -> 3 % 3 = 0 -> Ziel 500 ml (testet den Modulo-Umbruch);
    // raw = 0x8000 = 32768 -> pressure_milli = 800 + floor(32768*500/65535) = 1050.
    const randomness = makeRandomness(3, 0x8000);
    await fulfill(7, randomness);

    const lobby = await program.account.lobby.fetch(lobbyPda(7));
    assert.isDefined((lobby.status as any).open);
    assert.deepStrictEqual(Buffer.from(lobby.randomness), randomness);
    assert.strictEqual(lobby.targetMl, 500);
    assert.strictEqual(lobby.pressureMilli, 1050);
    assert.strictEqual(lobby.pressureMilli, expectedPressureMilli(0x8000));
  });

  it("VRF: Doppel-fulfill wird abgelehnt", async () => {
    // Andere Randomness-Bytes -> andere Tx-Message -> keine Deduplizierung.
    await expectZapfError(
      fulfill(7, makeRandomness(4, 0x1234)),
      "RandomnessAlreadyFulfilled"
    );
  });

  // -------------------------------------------------------------------------
  // Lobby 1: Happy Path — 5 Spieler, ein Gewinner, exakte 4%-Fee
  // -------------------------------------------------------------------------

  it("Happy Path: 5 Spieler, ein Gewinner bekommt Pot minus exakt 4% Fee", async () => {
    // byte0 = 1 -> Ziel 1000 ml; raw = 0xFFFF -> pressure_milli = 1300 (Maximum).
    const randomness = makeRandomness(1, 0xffff);
    await createOpenLobby(1, 5, FEE_01, randomness);

    let lobby = await program.account.lobby.fetch(lobbyPda(1));
    assert.strictEqual(lobby.size, 5);
    assert.strictEqual(BigInt(lobby.entryFee.toString()), FEE_01);
    assert.isDefined((lobby.status as any).open);
    assert.deepStrictEqual(Buffer.from(lobby.randomness), randomness);
    assert.strictEqual(lobby.targetMl, 1000);
    assert.strictEqual(lobby.pressureMilli, 1300);

    // 5 Spieler joinen; Vault wächst um je eine Entry-Fee.
    for (let i = 0; i < 5; i++) {
      await join(1, P[i]);
      assert.strictEqual(
        await balance(vaultPda(1)),
        FEE_01 * BigInt(i + 1),
        `Vault nach Join ${i + 1}`
      );
    }
    lobby = await program.account.lobby.fetch(lobbyPda(1));
    assert.strictEqual(lobby.joinedCount, 5);
    assert.strictEqual(lobby.players.length, 5);

    // Ergebnisse (Ziel 1000): P1 liegt mit 1005 am nächsten.
    const pours = [900, 1005, 1200, 400, 1600];
    for (let i = 0; i < 5; i++) {
      await submit(1, P[i].publicKey, pours[i]);
    }
    lobby = await program.account.lobby.fetch(lobbyPda(1));
    assert.strictEqual(lobby.playedCount, 5);
    for (let i = 0; i < 5; i++) {
      assert.isTrue(lobby.players[i].hasPlayed);
      assert.strictEqual(lobby.players[i].pouredMl, pours[i]);
      // Meldereihenfolge == Join-Reihenfolge in diesem Test
      assert.strictEqual(lobby.players[i].submissionIndex, i);
    }

    const winnerBefore = await balance(P[1].publicKey);
    const treasuryBefore = await balance(treasury.publicKey);

    await settle(1, [P[1].publicKey]);

    const pot = FEE_01 * 5n; // 500_000_000
    const fee = (pot * 400n) / 10_000n; // 20_000_000 — exakt 4 %
    assert.strictEqual(
      (await balance(P[1].publicKey)) - winnerBefore,
      pot - fee,
      "Gewinner-Auszahlung"
    );
    assert.strictEqual(
      (await balance(treasury.publicKey)) - treasuryBefore,
      fee,
      "Treasury-Fee exakt 4% des Pots"
    );
    assert.strictEqual(await balance(vaultPda(1)), 0n, "Vault leer");

    lobby = await program.account.lobby.fetch(lobbyPda(1));
    assert.isDefined((lobby.status as any).settled);

    expGames += 1n;
    expVolume += pot;
    expFees += fee;
    await assertStats();
  });

  it("join: abgerechnete Lobby wird abgelehnt", async () => {
    await expectZapfError(join(1, P[5]), "LobbyNotOpen");
  });

  it("settle: Doppel-Settlement wird abgelehnt", async () => {
    const ix = await settleBuilder(1, [P[1].publicKey]).instruction();
    // Anderer Fee-Payer als beim ersten Settlement -> keine Tx-Deduplizierung.
    await expectZapfError(
      sendWithPayer(ix, resultAuthority),
      "LobbyNotOpen"
    );
  });

  // -------------------------------------------------------------------------
  // Lobby 2: Tie — 2 Gewinner teilen den Pot exakt
  // -------------------------------------------------------------------------

  it("Tie: 2 Gewinner mit gleichem Score teilen den Pot 50/50", async () => {
    // byte0 = 4 -> 4 % 3 = 1 -> Ziel 1000 ml.
    await createOpenLobby(2, 5, FEE_01, makeRandomness(4));
    for (let i = 0; i < 5; i++) await join(2, P[i]);

    // P0 und P1 sind beide 50 ml daneben -> Tie.
    const pours = [950, 1050, 800, 700, 0];
    for (let i = 0; i < 5; i++) await submit(2, P[i].publicKey, pours[i]);

    const b0 = await balance(P[0].publicKey);
    const b1 = await balance(P[1].publicKey);
    const bt = await balance(treasury.publicKey);

    // Gewinner-Accounts in players-Array-Reihenfolge: [P0, P1]
    await settle(2, [P[0].publicKey, P[1].publicKey]);

    const pot = FEE_01 * 5n;
    const fee = (pot * 400n) / 10_000n;
    const perWinner = (pot - fee) / 2n; // 240_000_000, Rest 0

    assert.strictEqual((await balance(P[0].publicKey)) - b0, perWinner);
    assert.strictEqual((await balance(P[1].publicKey)) - b1, perWinner);
    assert.strictEqual((await balance(treasury.publicKey)) - bt, fee);
    assert.strictEqual(await balance(vaultPda(2)), 0n);

    expGames += 1n;
    expVolume += pot;
    expFees += fee;
    await assertStats();
  });

  // -------------------------------------------------------------------------
  // Lobby 3: Tie mit Rest — Remainder an den kleinsten submission_index
  // -------------------------------------------------------------------------

  it("Tie-Remainder: ganzzahliger Rest geht an den frühesten submission_index", async () => {
    // Ziel 1000 ml
    await createOpenLobby(3, 5, FEE_ODD, makeRandomness(1));
    for (let i = 0; i < 5; i++) await join(3, P[i]);

    // Meldereihenfolge absichtlich != Join-Reihenfolge:
    // P3 zuerst (submission_index 0), dann P1 (index 1), dann der Rest.
    // P1 und P3 sind beide 25 ml daneben -> Tie zwischen P1 und P3.
    await submit(3, P[3].publicKey, 1025); // index 0, diff 25  (Gewinner)
    await submit(3, P[1].publicKey, 975); //  index 1, diff 25  (Gewinner)
    await submit(3, P[0].publicKey, 500); //  index 2, diff 500
    await submit(3, P[2].publicKey, 800); //  index 3, diff 200
    await submit(3, P[4].publicKey, 700); //  index 4, diff 300

    const lobby = await program.account.lobby.fetch(lobbyPda(3));
    assert.strictEqual(lobby.players[3].submissionIndex, 0);
    assert.strictEqual(lobby.players[1].submissionIndex, 1);

    const b1 = await balance(P[1].publicKey);
    const b3 = await balance(P[3].publicKey);
    const bt = await balance(treasury.publicKey);

    // Gewinner in players-Array-Reihenfolge: [P1, P3]
    await settle(3, [P[1].publicKey, P[3].publicKey]);

    const pot = FEE_ODD * 5n; // 5_000_005
    const fee = (pot * 400n) / 10_000n; // 200_000 (abgerundet)
    const pool = pot - fee; // 4_800_005
    const perWinner = pool / 2n; // 2_400_002
    const remainder = pool % 2n; // 1

    assert.strictEqual(remainder, 1n, "Testaufbau: Rest muss 1 sein");
    // P3 hat den kleineren submission_index (0) -> bekommt den Rest.
    assert.strictEqual((await balance(P[3].publicKey)) - b3, perWinner + 1n);
    assert.strictEqual((await balance(P[1].publicKey)) - b1, perWinner);
    assert.strictEqual((await balance(treasury.publicKey)) - bt, fee);
    assert.strictEqual(await balance(vaultPda(3)), 0n);

    expGames += 1n;
    expVolume += pot;
    expFees += fee;
    await assertStats();
  });

  // -------------------------------------------------------------------------
  // Lobby 4: Overflow-Sentinel (u32::MAX) verliert immer
  // -------------------------------------------------------------------------

  it("Overflow-Spieler (u32::MAX) verliert; übrige teilen den Pot", async () => {
    // byte0 = 2 -> Ziel 1500 ml
    await createOpenLobby(4, 5, FEE_01, makeRandomness(2));
    for (let i = 0; i < 5; i++) await join(4, P[i]);

    await submit(4, P[0].publicKey, U32_MAX); // übergelaufen
    for (let i = 1; i < 5; i++) await submit(4, P[i].publicKey, 0); // je 1500 daneben

    const b0 = await balance(P[0].publicKey);
    const balancesBefore: bigint[] = [];
    for (let i = 1; i < 5; i++) balancesBefore.push(await balance(P[i].publicKey));
    const bt = await balance(treasury.publicKey);

    await settle(4, [1, 2, 3, 4].map((i) => P[i].publicKey));

    const pot = FEE_01 * 5n;
    const fee = (pot * 400n) / 10_000n;
    const perWinner = (pot - fee) / 4n; // 120_000_000, Rest 0

    assert.strictEqual(
      (await balance(P[0].publicKey)) - b0,
      0n,
      "Overflow-Spieler bekommt nichts"
    );
    for (let i = 1; i < 5; i++) {
      assert.strictEqual(
        (await balance(P[i].publicKey)) - balancesBefore[i - 1],
        perWinner,
        `Auszahlung Gewinner P${i}`
      );
    }
    assert.strictEqual((await balance(treasury.publicKey)) - bt, fee);

    expGames += 1n;
    expVolume += pot;
    expFees += fee;
    await assertStats();
  });

  // -------------------------------------------------------------------------
  // Lobby 5: Ablehnungsfälle rund um Join / Play / Settle
  // -------------------------------------------------------------------------

  it("Doppel-Join wird abgelehnt", async () => {
    // byte0 = 0 -> Ziel 500 ml; raw = 0 -> pressure_milli = 800 (Minimum).
    await createOpenLobby(5, 5, FEE_01, makeRandomness(0, 0));

    const lobby = await program.account.lobby.fetch(lobbyPda(5));
    assert.strictEqual(lobby.targetMl, 500);
    assert.strictEqual(lobby.pressureMilli, 800);

    await join(5, P[0]);
    // Zweiter Join desselben Spielers: manuelle Tx mit dem Spieler als
    // Fee-Payer (sonst identische Message -> bankrun-Dedupe).
    const ix = await joinBuilder(5, P[0]).instruction();
    await expectZapfError(sendWithPayer(ix, P[0]), "AlreadyJoined");
  });

  it("Join auf volle Lobby wird abgelehnt", async () => {
    for (let i = 1; i < 5; i++) await join(5, P[i]);
    await expectZapfError(join(5, P[5]), "LobbyFull");
  });

  it("submit_result: fremder Signer wird abgelehnt", async () => {
    await expectZapfError(
      program.methods
        .submitResult(P[0].publicKey, 400)
        .accountsPartial({
          resultAuthority: outsider.publicKey,
          config: configPda,
          lobby: lobbyPda(5),
        })
        .signers([outsider])
        .rpc(),
      "Unauthorized"
    );
  });

  it("submit_result: nicht gejointer Spieler wird abgelehnt", async () => {
    await expectZapfError(submit(5, P[5].publicKey, 400), "PlayerNotInLobby");
  });

  it("Doppel-Play wird abgelehnt", async () => {
    await submit(5, P[0].publicKey, 400); // diff 100 -> späterer Gewinner
    const ix = await submitBuilder(5, P[0].publicKey, 400).instruction();
    await expectZapfError(
      sendWithPayer(ix, resultAuthority),
      "AlreadyPlayed"
    );
  });

  it("settle: vor vollständigen Ergebnissen abgelehnt", async () => {
    await submit(5, P[1].publicKey, 650); // diff 150
    await submit(5, P[2].publicKey, 800); // diff 300
    await submit(5, P[3].publicKey, 900); // diff 400
    // 4 von 5 gespielt:
    await expectZapfError(
      settle(5, [P[0].publicKey]),
      "NotAllResultsSubmitted"
    );
  });

  it("settle: falsche Gewinner-Accounts werden abgelehnt", async () => {
    await submit(5, P[4].publicKey, 1000); // diff 500 — jetzt 5/5
    // Richtiger Gewinner ist P0 — wir übergeben P1.
    await expectZapfError(
      settle(5, [P[1].publicKey]),
      "InvalidWinnerAccounts"
    );
    // Falsche Anzahl (leer).
    await expectZapfError(settle(5, []), "InvalidWinnerAccounts");
  });

  it("settle: falsche Treasury wird abgelehnt", async () => {
    await expectZapfError(
      program.methods
        .settleLobby()
        .accountsPartial({
          resultAuthority: resultAuthority.publicKey,
          config: configPda,
          lobby: lobbyPda(5),
          vault: vaultPda(5),
          treasury: outsider.publicKey, // != config.treasury
          globalStats: statsPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: P[0].publicKey, isSigner: false, isWritable: true },
        ])
        .signers([resultAuthority])
        .rpc(),
      "InvalidTreasury"
    );
  });

  it("settle: nach den Fehlversuchen klappt die korrekte Abrechnung", async () => {
    const b0 = await balance(P[0].publicKey);
    const bt = await balance(treasury.publicKey);

    await settle(5, [P[0].publicKey]);

    const pot = FEE_01 * 5n;
    const fee = (pot * 400n) / 10_000n;
    assert.strictEqual((await balance(P[0].publicKey)) - b0, pot - fee);
    assert.strictEqual((await balance(treasury.publicKey)) - bt, fee);

    expGames += 1n;
    expVolume += pot;
    expFees += fee;
    await assertStats();
  });

  // -------------------------------------------------------------------------
  // Lobby 6: settle vor voller Lobby
  // -------------------------------------------------------------------------

  it("settle: nicht volle Lobby wird abgelehnt (auch wenn alle Gejointen gespielt haben)", async () => {
    await createOpenLobby(6, 5, FEE_01, makeRandomness(1));
    await join(6, P[0]);
    await join(6, P[1]);
    await submit(6, P[0].publicKey, 990);
    await submit(6, P[1].publicKey, 800);

    await expectZapfError(
      settle(6, [P[0].publicKey]),
      "LobbyNotFull"
    );
  });

  // -------------------------------------------------------------------------
  // GlobalStats über mehrere Spiele
  // -------------------------------------------------------------------------

  it("GlobalStats akkumulieren korrekt über mehrere Spiele", async () => {
    // Lobbys 1, 2, 3, 4, 5 wurden abgerechnet.
    assert.strictEqual(expGames, 5n);
    const expectedVolume =
      FEE_01 * 5n * 4n /* Lobbys 1,2,4,5 */ + FEE_ODD * 5n; /* Lobby 3 */
    const expectedFees =
      ((FEE_01 * 5n * 400n) / 10_000n) * 4n +
      (FEE_ODD * 5n * 400n) / 10_000n;
    assert.strictEqual(expVolume, expectedVolume);
    assert.strictEqual(expFees, expectedFees);
    await assertStats();
  });

  // -------------------------------------------------------------------------
  // Lobby 8 (Open) + Lobby 9 (AwaitingRandomness): Cancel nach 24 h
  // -------------------------------------------------------------------------

  it("cancel: vor Ablauf der 24 h abgelehnt (Open mit Spielern)", async () => {
    await createOpenLobby(8, 5, FEE_005, makeRandomness(0));
    await join(8, P[5]);
    await join(8, P[6]);
    await join(8, P[7]);
    assert.strictEqual(await balance(vaultPda(8)), FEE_005 * 3n);

    await expectZapfError(
      cancelBuilder(8, provider.wallet.publicKey, [
        P[5].publicKey,
        P[6].publicKey,
        P[7].publicKey,
      ]).rpc(),
      "CancelTooEarly"
    );
  });

  it("cancel: vor Ablauf der 24 h abgelehnt (AwaitingRandomness)", async () => {
    // VRF-Callback trifft nie ein — Lobby bleibt AwaitingRandomness.
    await createLobby(9, 5, FEE_005);
    await expectZapfError(
      cancelBuilder(9, provider.wallet.publicKey, []).rpc(),
      "CancelTooEarly"
    );
  });

  it("cancel: falsche Refund-Accounts werden abgelehnt", async () => {
    await advanceClock(86_401n); // > 24 h

    // Falsche Anzahl
    await expectZapfError(
      cancelBuilder(8, provider.wallet.publicKey, [
        P[5].publicKey,
        P[6].publicKey,
      ]).rpc(),
      "InvalidRefundAccounts"
    );
    // Falsche Reihenfolge
    await expectZapfError(
      cancelBuilder(8, provider.wallet.publicKey, [
        P[6].publicKey,
        P[5].publicKey,
        P[7].publicKey,
      ]).rpc(),
      "InvalidRefundAccounts"
    );
  });

  it("cancel: nach 24 h refundet permissionless alle Spieler voll (keine Fee)", async () => {
    const b5 = await balance(P[5].publicKey);
    const b6 = await balance(P[6].publicKey);
    const b7 = await balance(P[7].publicKey);
    const bt = await balance(treasury.publicKey);

    // Permissionless: ein unbeteiligter Aufrufer zahlt nur die Tx-Fee.
    const ix = await cancelBuilder(8, canceller.publicKey, [
      P[5].publicKey,
      P[6].publicKey,
      P[7].publicKey,
    ]).instruction();
    await sendWithPayer(ix, canceller);

    assert.strictEqual((await balance(P[5].publicKey)) - b5, FEE_005);
    assert.strictEqual((await balance(P[6].publicKey)) - b6, FEE_005);
    assert.strictEqual((await balance(P[7].publicKey)) - b7, FEE_005);
    assert.strictEqual(
      await balance(treasury.publicKey),
      bt,
      "Cancel nimmt keine Fee"
    );
    assert.strictEqual(await balance(vaultPda(8)), 0n);

    const lobby = await program.account.lobby.fetch(lobbyPda(8));
    assert.isDefined((lobby.status as any).cancelled);

    // Stats unverändert (Cancel ist kein Settlement).
    await assertStats();
  });

  it("cancel: AwaitingRandomness nach 24 h — keine Spieler, keine Refunds", async () => {
    const bt = await balance(treasury.publicKey);

    // Anderer Caller/Fee-Payer als beim CancelTooEarly-Versuch oben,
    // damit die Tx nicht als Duplikat wegdedupliziert wird.
    const ix = await cancelBuilder(9, canceller.publicKey, []).instruction();
    await sendWithPayer(ix, canceller);

    const lobby = await program.account.lobby.fetch(lobbyPda(9));
    assert.isDefined((lobby.status as any).cancelled);
    assert.strictEqual(lobby.joinedCount, 0);
    assert.strictEqual(await balance(vaultPda(9)), 0n);
    assert.strictEqual(await balance(treasury.publicKey), bt);

    // Ein verspäteter Oracle-Callback auf die gecancelte Lobby wird
    // abgelehnt (Status != AwaitingRandomness).
    await expectZapfError(
      fulfill(9, makeRandomness(1)),
      "RandomnessAlreadyFulfilled"
    );

    // Stats weiterhin unverändert.
    await assertStats();
  });

  it("cancel/join: gecancelte Lobby ist zu", async () => {
    await expectZapfError(join(8, P[8]), "LobbyNotOpen");

    // Zweiter Cancel (andere Reihenfolge der Accounts, damit keine
    // Tx-Deduplizierung greift — der Status-Check kommt vor der
    // Account-Validierung).
    const ix = await cancelBuilder(8, canceller.publicKey, [
      P[6].publicKey,
      P[5].publicKey,
      P[7].publicKey,
    ]).instruction();
    await expectZapfError(sendWithPayer(ix, canceller), "LobbyNotOpen");
  });
});
