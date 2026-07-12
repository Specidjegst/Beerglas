//! Globale Konstanten des zapf_royale-Programms.

use anchor_lang::prelude::Pubkey;

/// PDA-Seed der Config: `[b"config"]`
pub const CONFIG_SEED: &[u8] = b"config";
/// PDA-Seed der GlobalStats: `[b"stats"]`
pub const STATS_SEED: &[u8] = b"stats";
/// PDA-Seed einer Lobby: `[b"lobby", lobby_id.to_le_bytes()]`
pub const LOBBY_SEED: &[u8] = b"lobby";
/// PDA-Seed eines Lobby-Vaults: `[b"vault", lobby_id.to_le_bytes()]`
pub const VAULT_SEED: &[u8] = b"vault";

/// Minimale Lobby-Größe.
pub const MIN_LOBBY_SIZE: u8 = 2;
/// Maximale Lobby-Größe (Account-Space ist dafür reserviert; MVP nutzt 5).
pub const MAX_LOBBY_SIZE: u8 = 10;
/// Maximale Anzahl erlaubter Entry-Fees in der Config.
pub const MAX_ALLOWED_ENTRY_FEES: usize = 8;
/// Maximale Operator-Fee: 10 % (1000 bps).
pub const MAX_FEE_BPS: u16 = 1000;
/// Basispunkte-Nenner.
pub const BPS_DENOMINATOR: u128 = 10_000;
/// Nach dieser Zeit (Sekunden) darf eine offene Lobby permissionless
/// gecancelt werden (24 h).
pub const CANCEL_TIMEOUT_SECONDS: i64 = 86_400;
/// Die drei Eichstriche des Maßkrugs in ml.
/// Ziel = TARGETS_ML[randomness[0] % 3] (VRF-Randomness, Byte 0).
pub const TARGETS_ML: [u32; 3] = [500, 1000, 1500];
/// Sentinel-Wert für "übergelaufen": schlechtester möglicher Score.
pub const OVERFLOW_SENTINEL: u32 = u32::MAX;

// ---------------------------------------------------------------------------
// MagicBlock Ephemeral VRF
// ---------------------------------------------------------------------------

/// Untergrenze des Fassdrucks in Milli-Einheiten (0.800).
pub const PRESSURE_MIN_MILLI: u32 = 800;
/// Spannweite des Fassdrucks in Milli-Einheiten: pressure_milli ∈ 800..=1300.
pub const PRESSURE_SPAN_MILLI: u32 = 500;

/// Programm-ID des MagicBlock Ephemeral VRF (devnet + mainnet).
/// Bewusst als lokale Konstante statt über SDK-Typen (`VrfProgram`), um
/// Konflikte zwischen anchor-lang-Versionen im Dependency-Graph zu vermeiden:
/// das SDK bindet sein eigenes anchor-lang (>=0.28,<1.0), dessen `Id`-Trait
/// mit unserem 0.31-`Program<...>`-Wrapper nicht typkompatibel ist (E0277).
pub const VRF_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");

/// Identity-Signer des Ephemeral-VRF-Programms (globaler Identity-PDA).
/// Nur dieser Signer darf `fulfill_round` aufrufen.
///
/// Konvertierung über Bytes, da der Pubkey-Typ des SDKs (compat-Layer) und
/// der von anchor-lang re-exportierte Pubkey-Typ aus unterschiedlichen
/// Crate-Versionen stammen können (das SDK macht in `VrfProgram::id()`
/// dieselbe Konvertierung). // VERIFY on first build
pub fn vrf_program_identity() -> Pubkey {
    Pubkey::new_from_array(ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY.to_bytes())
}

/// Standard-Oracle-Queue des VRF-Programms (devnet + mainnet, siehe
/// `ephemeral_vrf_sdk::consts::DEFAULT_QUEUE`). Wird bei `initialize`
/// verwendet, wenn keine explizite Queue übergeben wird. // VERIFY on first build (Pubkey-Konvertierung, s. o.)
pub fn default_oracle_queue() -> Pubkey {
    Pubkey::new_from_array(ephemeral_vrf_sdk::consts::DEFAULT_QUEUE.to_bytes())
}
