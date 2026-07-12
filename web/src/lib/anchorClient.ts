/**
 * Anchor/web3-Client für das ZAPF-ROYALE-Programm (devnet).
 *
 * Das IDL in ./idl.json ist VON HAND geschrieben, passend zur Schnittstelle in
 * docs/spec.md — nach `anchor build` durch das generierte
 * target/idl/zapf_royale.json ersetzen. Die Programm-Adresse wird zur Laufzeit
 * mit NEXT_PUBLIC_PROGRAM_ID überschrieben.
 *
 * PDA-Seeds (dokumentiert, identisch zum Programm):
 *   lobby  = [b"lobby",  lobby_id als u64 LE]
 *   vault  = [b"vault",  lobby_id als u64 LE]
 *   config = [b"config"]
 *   stats  = [b"stats"]
 */
import { BN, Program, type Idl, type Provider } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import rawIdl from "./idl.json";
import { PROGRAM_ID_STR } from "./constants";

const te = new TextEncoder();

function u64Le(n: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, n, true);
  return buf;
}

/** Programm-ID aus ENV; null, wenn (noch) keine gültige Pubkey gesetzt ist. */
export function getProgramId(): PublicKey | null {
  try {
    return new PublicKey(PROGRAM_ID_STR);
  } catch {
    return null;
  }
}

export function lobbyPda(lobbyId: bigint | number, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [te.encode("lobby"), u64Le(BigInt(lobbyId))],
    programId,
  )[0];
}

export function vaultPda(lobbyId: bigint | number, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [te.encode("vault"), u64Le(BigInt(lobbyId))],
    programId,
  )[0];
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([te.encode("config")], programId)[0];
}

export function statsPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([te.encode("stats")], programId)[0];
}

/**
 * Read-only-Program (nur Connection als Provider) — reicht zum Bauen von
 * Instructions und zum Fetchen/Dekodieren von Accounts.
 */
export function getReadonlyProgram(connection: Connection): Program | null {
  const programId = getProgramId();
  if (!programId) return null;
  const idl = {
    ...(rawIdl as unknown as Record<string, unknown>),
    address: programId.toBase58(),
  } as unknown as Idl;
  const provider: Provider = { connection };
  try {
    return new Program(idl, provider);
  } catch {
    return null;
  }
}

/**
 * join_lobby-Transaktion bauen (Spieler zahlt Entry Fee in den Vault).
 * Wird anschließend über den Wallet-Adapter signiert & gesendet.
 */
export async function buildJoinLobbyTransaction(
  connection: Connection,
  lobbyId: bigint | number,
  player: PublicKey,
): Promise<Transaction> {
  const programId = getProgramId();
  if (!programId) throw new Error("NEXT_PUBLIC_PROGRAM_ID ist nicht gesetzt/ungültig.");
  const program = getReadonlyProgram(connection);
  if (!program) throw new Error("Anchor-Programm konnte nicht initialisiert werden.");

  // join_lobby-Accounts exakt in Struct-Reihenfolge des Programms
  // (player, lobby, vault, system_program) — KEIN config-Account.
  const accounts = {
    player,
    lobby: lobbyPda(lobbyId, programId),
    vault: vaultPda(lobbyId, programId),
    systemProgram: SystemProgram.programId,
  };

  // Untypisierter Zugriff: das IDL ist generisch (kein Literal-Typ),
  // daher sind die Methods-Namespaces nicht statisch typisiert.
  const methods = program.methods as unknown as Record<
    string,
    (arg: BN) => {
      accountsStrict(a: Record<string, PublicKey>): { instruction(): Promise<TransactionInstruction> };
    }
  >;
  const ix = await methods
    .joinLobby(new BN(lobbyId.toString()))
    .accountsStrict(accounts)
    .instruction();

  const tx = new Transaction().add(ix);
  tx.feePayer = player;
  return tx;
}

export interface GlobalStatsView {
  totalGamesSettled: bigint;
  totalVolumeLamports: bigint;
  totalFeesLamports: bigint;
}

/**
 * GlobalStats direkt on-chain lesen (PDA [b"stats"]).
 * null, wenn Programm nicht deployed / Account nicht existiert / IDL nicht passt.
 */
export async function fetchGlobalStats(connection: Connection): Promise<GlobalStatsView | null> {
  const programId = getProgramId();
  const program = getReadonlyProgram(connection);
  if (!programId || !program) return null;
  try {
    const accounts = program.account as unknown as Record<
      string,
      { fetch(pda: PublicKey): Promise<Record<string, unknown>> }
    >;
    const raw = await accounts.globalStats.fetch(statsPda(programId));
    const asBig = (v: unknown): bigint => BigInt((v as { toString(): string }).toString());
    return {
      totalGamesSettled: asBig(raw.totalGamesSettled),
      totalVolumeLamports: asBig(raw.totalVolumeLamports),
      totalFeesLamports: asBig(raw.totalFeesLamports),
    };
  } catch {
    return null;
  }
}
