//! # ZAPF ROYALE — On-Chain-Programm
//!
//! PvP-Bierzapf-Spiel auf Solana (devnet). Spieler zahlen eine Entry-Fee in
//! einen Lobby-Vault, der Server (result_authority) meldet die Zapf-Ergebnisse
//! und rechnet die Lobby ab. Fairness über **MagicBlock Ephemeral VRF**:
//! `create_lobby` fordert per CPI Randomness beim VRF-Programm
//! (Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz) an; der Oracle liefert sie
//! per verifiziertem Callback (`fulfill_round`, Signer = VRF-Programm-
//! Identity). Ziel und Fassdruck werden on-chain abgeleitet:
//! `target_ml = TARGETS_ML[randomness[0] % 3]`,
//! `pressure_milli = 800 + floor(u16_le(randomness[1..3]) * 500 / 65535)`.
//!
//! PDAs:
//! - Config:      `[b"config"]`
//! - GlobalStats: `[b"stats"]`
//! - Lobby:       `[b"lobby", lobby_id.to_le_bytes()]`
//! - Vault:       `[b"vault", lobby_id.to_le_bytes()]` (SystemAccount, hält nur Lamports)
//! - Identity:    `[b"identity"]` (nur CPI-Signer für den VRF-Request, kein Account-State)

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

// Platzhalter-ID: nach `anchor keys sync` durch die echte Programm-ID ersetzen
// (siehe README).
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod zapf_royale {
    use super::*;

    /// Einmaliges Setup: legt Config + GlobalStats an. Payer = authority.
    /// `oracle_queue = None` nutzt die Standard-Queue des VRF-SDKs.
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        allowed_entry_fees: Vec<u64>,
        treasury: Pubkey,
        result_authority: Pubkey,
        oracle_queue: Option<Pubkey>,
    ) -> Result<()> {
        instructions::initialize::handler(
            ctx,
            fee_bps,
            allowed_entry_fees,
            treasury,
            result_authority,
            oracle_queue,
        )
    }

    /// Fee ändern — nur authority. Emittiert `FeeChanged`.
    pub fn set_fee(ctx: Context<SetFee>, fee_bps: u16) -> Result<()> {
        instructions::set_fee::handler(ctx, fee_bps)
    }

    /// Lobby anlegen — nur result_authority. Fordert im selben Ix per CPI
    /// VRF-Randomness an; die Lobby startet als `AwaitingRandomness`.
    pub fn create_lobby(
        ctx: Context<CreateLobby>,
        lobby_id: u64,
        size: u8,
        entry_fee: u64,
        client_seed: [u8; 32],
    ) -> Result<()> {
        instructions::create_lobby::handler(ctx, lobby_id, size, entry_fee, client_seed)
    }

    /// VRF-Oracle-Callback — nur das VRF-Programm (Identity-Signer) darf
    /// diese Ix ausführen. Speichert Randomness, leitet Ziel + Fassdruck ab
    /// und öffnet die Lobby. Emittiert `RoundFulfilled`.
    pub fn fulfill_round<'info>(
        ctx: Context<'_, '_, 'info, 'info, FulfillRound<'info>>,
        randomness: [u8; 32],
    ) -> Result<()> {
        instructions::fulfill_round::handler(ctx, randomness)
    }

    /// Spieler tritt bei und zahlt die Entry-Fee in den Vault.
    pub fn join_lobby(ctx: Context<JoinLobby>, lobby_id: u64) -> Result<()> {
        instructions::join_lobby::handler(ctx, lobby_id)
    }

    /// Ergebnis melden — nur result_authority.
    pub fn submit_result(ctx: Context<SubmitResult>, player: Pubkey, poured_ml: u32) -> Result<()> {
        instructions::submit_result::handler(ctx, player, poured_ml)
    }

    /// Lobby abrechnen — nur result_authority. Ziel kommt aus
    /// `lobby.target_ml` (VRF). Gewinner-Wallets als remaining_accounts
    /// (Reihenfolge = players-Array-Reihenfolge der Gewinner).
    pub fn settle_lobby<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleLobby<'info>>,
    ) -> Result<()> {
        instructions::settle_lobby::handler(ctx)
    }

    /// Lobby abbrechen — permissionless nach 24 h (Status Open oder
    /// AwaitingRandomness). Spieler-Wallets als remaining_accounts
    /// (Reihenfolge = players-Array; leer bei AwaitingRandomness).
    pub fn cancel_lobby<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelLobby<'info>>,
    ) -> Result<()> {
        instructions::cancel_lobby::handler(ctx)
    }
}
