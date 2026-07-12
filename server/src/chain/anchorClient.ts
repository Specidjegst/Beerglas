/**
 * Real ChainClient implementation against the zapf_royale Anchor program
 * (MagicBlock Ephemeral VRF flow).
 *
 * NOTE ON THE IDL: `./idl.json` is a hand-written Anchor 0.31 IDL that mirrors
 * the program's public interface. After the program package is built
 * (`anchor build` in program/), replace idl.json with the generated
 * `program/target/idl/zapf_royale.json`. Discriminators in the hand-written
 * file already follow the standard Anchor derivation, so they match as long
 * as instruction/account names are unchanged.
 *
 * PDA seeds (must match program/):
 *   Config          [b"config"]
 *   GlobalStats     [b"stats"]
 *   Lobby           [b"lobby", lobby_id as u64 LE]
 *   Vault           [b"vault", lobby_id as u64 LE]
 *   ProgramIdentity [b"identity"]   (VRF callback signer identity of OUR program)
 *
 * VRF: create_lobby CPIs a randomness request to the Ephemeral VRF program;
 * the oracle later calls back into our fulfill_round ix. The server never
 * sends fulfill_round itself — it only POLLS the lobby account until the
 * status leaves AwaitingRandomness (waitForRoundFulfilled).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type Commitment } from "@solana/web3.js";
import type { ChainClient, FulfilledRound } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** MagicBlock Ephemeral VRF program (same address on devnet and mainnet). */
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");

/** MagicBlock default oracle queue on devnet (override via ENV ORACLE_QUEUE). */
export const DEFAULT_ORACLE_QUEUE = new PublicKey("GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb");

/** SlotHashes sysvar (entropy input for the VRF request). */
export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

/** Poll interval for waitForRoundFulfilled. */
const FULFILL_POLL_MS = 2000;

type AnyMethods = Record<
  string,
  (...args: unknown[]) => {
    accountsPartial(accounts: Record<string, PublicKey>): {
      remainingAccounts(
        accs: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
      ): { rpc(): Promise<string> };
      rpc(): Promise<string>;
    };
  }
>;

type AnyAccounts = Record<string, { fetch(address: PublicKey): Promise<Record<string, unknown>> }>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AnchorChainClientOptions {
  rpcUrl: string;
  programId: string;
  resultAuthority: Keypair;
  treasury: PublicKey;
  /** Ephemeral VRF oracle queue account (ENV ORACLE_QUEUE; devnet default). */
  oracleQueue?: PublicKey;
  commitment?: Commitment;
}

export class AnchorChainClient implements ChainClient {
  private readonly connection: Connection;
  private readonly program: anchor.Program;
  private readonly programId: PublicKey;
  private readonly resultAuthority: Keypair;
  private readonly treasury: PublicKey;
  private readonly oracleQueue: PublicKey;

  constructor(opts: AnchorChainClientOptions) {
    const commitment = opts.commitment ?? "confirmed";
    this.connection = new Connection(opts.rpcUrl, commitment);
    this.programId = new PublicKey(opts.programId);
    this.resultAuthority = opts.resultAuthority;
    this.treasury = opts.treasury;
    this.oracleQueue = opts.oracleQueue ?? DEFAULT_ORACLE_QUEUE;

    const idlPath = path.join(__dirname, "idl.json");
    const idl = JSON.parse(readFileSync(idlPath, "utf8")) as anchor.Idl & { address: string };
    // The deployed program id always wins over the placeholder in idl.json.
    idl.address = this.programId.toBase58();

    const provider = new anchor.AnchorProvider(
      this.connection,
      new anchor.Wallet(this.resultAuthority),
      { commitment },
    );
    this.program = new anchor.Program(idl, provider);
  }

  private get methods(): AnyMethods {
    return this.program.methods as unknown as AnyMethods;
  }

  private get accounts(): AnyAccounts {
    return this.program.account as unknown as AnyAccounts;
  }

  private lobbyIdBytes(lobbyId: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(lobbyId);
    return buf;
  }

  configPda(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("config")], this.programId)[0];
  }

  statsPda(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("stats")], this.programId)[0];
  }

  lobbyPda(lobbyId: bigint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("lobby"), this.lobbyIdBytes(lobbyId)],
      this.programId,
    )[0];
  }

  vaultPda(lobbyId: bigint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), this.lobbyIdBytes(lobbyId)],
      this.programId,
    )[0];
  }

  /** Identity PDA of OUR program used by the VRF program for the callback. */
  programIdentityPda(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("identity")], this.programId)[0];
  }

  async createLobby(
    lobbyId: bigint,
    size: number,
    entryFeeLamports: bigint,
    clientSeed: Uint8Array,
  ): Promise<string> {
    return this.methods["createLobby"]!(
      new anchor.BN(lobbyId.toString()),
      size,
      new anchor.BN(entryFeeLamports.toString()),
      Array.from(clientSeed),
    )
      .accountsPartial({
        config: this.configPda(),
        lobby: this.lobbyPda(lobbyId),
        vault: this.vaultPda(lobbyId),
        resultAuthority: this.resultAuthority.publicKey,
        oracleQueue: this.oracleQueue,
        programIdentity: this.programIdentityPda(),
        slotHashes: SLOT_HASHES_SYSVAR,
        vrfProgram: VRF_PROGRAM_ID,
      })
      .rpc();
  }

  /**
   * Poll the lobby account until the VRF oracle's fulfill_round callback has
   * landed (status left AwaitingRandomness) and return the stored randomness
   * and derived round parameters.
   */
  async waitForRoundFulfilled(lobbyId: bigint, timeoutMs: number): Promise<FulfilledRound> {
    const pda = this.lobbyPda(lobbyId);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      let lobby: Record<string, unknown> | null = null;
      try {
        lobby = await this.accounts["lobby"]!.fetch(pda);
      } catch {
        // Account not visible yet at this commitment — keep polling.
      }

      if (lobby) {
        // Anchor decodes Rust enums as { variantNameCamelCase: {} }.
        const status = lobby["status"] as Record<string, unknown> | undefined;
        if (status && !("awaitingRandomness" in status)) {
          return {
            randomness: Uint8Array.from(lobby["randomness"] as number[]),
            targetMl: Number(lobby["targetMl"]),
            pressureMilli: Number(lobby["pressureMilli"]),
          };
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`VRF fulfillment timed out for lobby ${lobbyId} after ${timeoutMs}ms`);
      }
      await sleep(Math.min(FULFILL_POLL_MS, remaining));
    }
  }

  async confirmJoin(txSig: string, lobbyId: bigint, player: string): Promise<boolean> {
    // 1. The referenced transaction must exist and have succeeded.
    const tx = await this.connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) return false;

    // 2. Authoritative check: the on-chain lobby account must list the player.
    try {
      const lobby = await this.accounts["lobby"]!.fetch(this.lobbyPda(lobbyId));
      const players = lobby["players"] as { player: PublicKey; hasPlayed: boolean }[];
      return players.some((p) => p.player.toBase58() === player);
    } catch {
      return false;
    }
  }

  async submitResult(lobbyId: bigint, player: string, pouredMl: number): Promise<string> {
    return this.methods["submitResult"]!(new PublicKey(player), pouredMl)
      .accountsPartial({
        config: this.configPda(),
        lobby: this.lobbyPda(lobbyId),
        resultAuthority: this.resultAuthority.publicKey,
      })
      .rpc();
  }

  async settleLobby(lobbyId: bigint, winners: string[]): Promise<string> {
    return this.methods["settleLobby"]!()
      .accountsPartial({
        config: this.configPda(),
        globalStats: this.statsPda(),
        lobby: this.lobbyPda(lobbyId),
        vault: this.vaultPda(lobbyId),
        treasury: this.treasury,
        resultAuthority: this.resultAuthority.publicKey,
      })
      .remainingAccounts(
        winners.map((w) => ({
          pubkey: new PublicKey(w),
          isSigner: false,
          isWritable: true,
        })),
      )
      .rpc();
  }

  async cancelLobby(lobbyId: bigint, players: string[]): Promise<string> {
    return this.methods["cancelLobby"]!()
      .accountsPartial({
        lobby: this.lobbyPda(lobbyId),
        vault: this.vaultPda(lobbyId),
        caller: this.resultAuthority.publicKey,
      })
      .remainingAccounts(
        players.map((p) => ({
          pubkey: new PublicKey(p),
          isSigner: false,
          isWritable: true,
        })),
      )
      .rpc();
  }
}
