//! `settle_lobby` — nur die result_authority. Nutzt das per VRF-Callback
//! on-chain gespeicherte Ziel (`lobby.target_ml`), bestimmt Gewinner,
//! zahlt Fee an die Treasury und den Rest an die Gewinner aus.
//!
//! Gewinner-Wallets kommen als `remaining_accounts` in derselben Reihenfolge,
//! in der die Gewinner im `players`-Array stehen; jede Pubkey wird gegen den
//! on-chain berechneten Gewinner validiert.

use anchor_lang::prelude::*;

use crate::constants::{
    BPS_DENOMINATOR, CONFIG_SEED, LOBBY_SEED, OVERFLOW_SENTINEL, STATS_SEED, VAULT_SEED,
};
use crate::errors::ZapfError;
use crate::events::LobbySettled;
use crate::instructions::pay_from_vault;
use crate::state::{Config, GlobalStats, Lobby, LobbyStatus};

#[derive(Accounts)]
pub struct SettleLobby<'info> {
    pub result_authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = result_authority @ ZapfError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [LOBBY_SEED, lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.bump,
    )]
    pub lobby: Account<'info, Lobby>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// Fee-Empfänger; muss exakt config.treasury sein.
    #[account(mut, address = config.treasury @ ZapfError::InvalidTreasury)]
    pub treasury: SystemAccount<'info>,

    #[account(mut, seeds = [STATS_SEED], bump = global_stats.bump)]
    pub global_stats: Account<'info, GlobalStats>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: die Gewinner-Wallets (writable), Reihenfolge =
    // Reihenfolge der Gewinner im players-Array.
}

pub fn handler<'info>(ctx: Context<'_, '_, 'info, 'info, SettleLobby<'info>>) -> Result<()> {
    // ---------- Phase 1: Validierung & Berechnung (nur Lesezugriffe) ----------
    let lobby = &ctx.accounts.lobby;

    require!(lobby.status == LobbyStatus::Open, ZapfError::LobbyNotOpen);
    require!(lobby.joined_count == lobby.size, ZapfError::LobbyNotFull);
    require!(
        lobby.played_count == lobby.size,
        ZapfError::NotAllResultsSubmitted
    );

    // Ziel wurde beim VRF-Callback (`fulfill_round`) on-chain gespeichert;
    // Status Open garantiert, dass die Randomness geliefert wurde.
    let target_ml = lobby.target_ml;

    // Score pro Spieler: Overflow-Sentinel => u64::MAX, sonst |poured - target|.
    // Gewinner = alle Spieler mit dem niedrigsten Score (Indizes im
    // players-Array, in Array-Reihenfolge).
    let mut best_score = u64::MAX;
    let mut winner_indices: Vec<usize> = Vec::new();
    for (i, entry) in lobby.players.iter().enumerate() {
        let score = if entry.poured_ml == OVERFLOW_SENTINEL {
            u64::MAX
        } else {
            u64::from(entry.poured_ml.abs_diff(target_ml))
        };
        if score < best_score {
            best_score = score;
            winner_indices.clear();
            winner_indices.push(i);
        } else if score == best_score {
            winner_indices.push(i);
        }
    }
    let winner_count = winner_indices.len() as u64; // >= 1, da size >= 2

    // Pot / Fee / Auszahlung — durchgehend checked bzw. u128-Zwischenschritt.
    let pot = lobby
        .entry_fee
        .checked_mul(lobby.size as u64)
        .ok_or(ZapfError::MathOverflow)?;
    let fee_u128 = (pot as u128)
        .checked_mul(ctx.accounts.config.fee_bps as u128)
        .ok_or(ZapfError::MathOverflow)?
        / BPS_DENOMINATOR;
    let fee = u64::try_from(fee_u128).map_err(|_| ZapfError::MathOverflow)?;
    let payout_pool = pot.checked_sub(fee).ok_or(ZapfError::MathOverflow)?;
    let payout_per_winner = payout_pool / winner_count;
    let remainder = payout_pool % winner_count;
    // Invariante: fee + payout_per_winner * winner_count + remainder == pot.

    // Der ganzzahlige Rest geht an den Gewinner mit dem kleinsten
    // submission_index (= wer zuerst gemeldet wurde).
    let mut remainder_pos = 0usize; // Position innerhalb winner_indices
    let mut min_submission_index = u8::MAX;
    for (pos, &wi) in winner_indices.iter().enumerate() {
        let s = lobby.players[wi].submission_index;
        if s < min_submission_index {
            min_submission_index = s;
            remainder_pos = pos;
        }
    }

    // remaining_accounts gegen die on-chain berechneten Gewinner validieren.
    require!(
        ctx.remaining_accounts.len() == winner_indices.len(),
        ZapfError::InvalidWinnerAccounts
    );
    let mut winner_keys: Vec<Pubkey> = Vec::with_capacity(winner_indices.len());
    for (acc, &wi) in ctx.remaining_accounts.iter().zip(winner_indices.iter()) {
        let expected = lobby.players[wi].player;
        require_keys_eq!(acc.key(), expected, ZapfError::InvalidWinnerAccounts);
        require!(acc.is_writable, ZapfError::InvalidWinnerAccounts);
        winner_keys.push(expected);
    }

    let lobby_id = lobby.lobby_id;
    let vault_bump = lobby.vault_bump;

    // ---------- Phase 2: Auszahlungen (CPIs mit Vault-PDA-Signer) ----------
    for (pos, acc) in ctx.remaining_accounts.iter().enumerate() {
        let mut amount = payout_per_winner;
        if pos == remainder_pos {
            amount = amount
                .checked_add(remainder)
                .ok_or(ZapfError::MathOverflow)?;
        }
        pay_from_vault(
            &ctx.accounts.vault,
            acc,
            &ctx.accounts.system_program,
            amount,
            lobby_id,
            vault_bump,
        )?;
    }
    pay_from_vault(
        &ctx.accounts.vault,
        &ctx.accounts.treasury.to_account_info(),
        &ctx.accounts.system_program,
        fee,
        lobby_id,
        vault_bump,
    )?;

    // ---------- Phase 3: State-Updates & Event ----------
    let lobby = &mut ctx.accounts.lobby;
    lobby.status = LobbyStatus::Settled;

    let stats = &mut ctx.accounts.global_stats;
    stats.total_games_settled = stats
        .total_games_settled
        .checked_add(1)
        .ok_or(ZapfError::MathOverflow)?;
    stats.total_volume_lamports = stats
        .total_volume_lamports
        .checked_add(pot)
        .ok_or(ZapfError::MathOverflow)?;
    stats.total_fees_lamports = stats
        .total_fees_lamports
        .checked_add(fee)
        .ok_or(ZapfError::MathOverflow)?;

    emit!(LobbySettled {
        lobby_id,
        target_ml,
        pot,
        fee,
        winners: winner_keys,
        payout_per_winner,
        remainder,
    });

    Ok(())
}
