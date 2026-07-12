//! `cancel_lobby` — permissionless, aber erst 24 h nach Erstellung möglich.
//! Erstattet allen beigetretenen Spielern ihre volle Entry-Fee (keine Fee).
//!
//! Erlaubt für Status `Open` (normale Refunds) und `AwaitingRandomness`
//! (VRF-Callback nie eingetroffen — es konnte niemand joinen, also gibt es
//! keine Refunds; die Lobby wird nur geschlossen).
//!
//! Die Spieler-Wallets kommen als `remaining_accounts` in exakt der
//! Reihenfolge des `players`-Arrays und werden gegen die gespeicherten
//! Pubkeys validiert (bei `AwaitingRandomness` ist das Array leer).

use anchor_lang::prelude::*;

use crate::constants::{CANCEL_TIMEOUT_SECONDS, LOBBY_SEED, VAULT_SEED};
use crate::errors::ZapfError;
use crate::events::LobbyCancelled;
use crate::instructions::pay_from_vault;
use crate::state::{Lobby, LobbyStatus};

#[derive(Accounts)]
pub struct CancelLobby<'info> {
    /// Beliebiger Aufrufer (permissionless) — zahlt nur die Tx-Fee.
    pub caller: Signer<'info>,

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

    pub system_program: Program<'info, System>,
    // remaining_accounts: alle beigetretenen Spieler-Wallets (writable),
    // Reihenfolge = players-Array.
}

pub fn handler<'info>(ctx: Context<'_, '_, 'info, 'info, CancelLobby<'info>>) -> Result<()> {
    let lobby = &ctx.accounts.lobby;

    require!(
        lobby.status == LobbyStatus::Open || lobby.status == LobbyStatus::AwaitingRandomness,
        ZapfError::LobbyNotOpen
    );

    let now = Clock::get()?.unix_timestamp;
    let deadline = lobby
        .created_at
        .checked_add(CANCEL_TIMEOUT_SECONDS)
        .ok_or(ZapfError::MathOverflow)?;
    require!(now >= deadline, ZapfError::CancelTooEarly);

    // Refund-Accounts validieren (Anzahl, Pubkeys, writable).
    require!(
        ctx.remaining_accounts.len() == lobby.players.len(),
        ZapfError::InvalidRefundAccounts
    );
    for (acc, entry) in ctx.remaining_accounts.iter().zip(lobby.players.iter()) {
        require_keys_eq!(acc.key(), entry.player, ZapfError::InvalidRefundAccounts);
        require!(acc.is_writable, ZapfError::InvalidRefundAccounts);
    }

    let lobby_id = lobby.lobby_id;
    let vault_bump = lobby.vault_bump;
    let entry_fee = lobby.entry_fee;
    let refunded_players = lobby.joined_count;

    // Volle Erstattung an jeden beigetretenen Spieler, keine Fee.
    for acc in ctx.remaining_accounts.iter() {
        pay_from_vault(
            &ctx.accounts.vault,
            acc,
            &ctx.accounts.system_program,
            entry_fee,
            lobby_id,
            vault_bump,
        )?;
    }

    let lobby = &mut ctx.accounts.lobby;
    lobby.status = LobbyStatus::Cancelled;

    emit!(LobbyCancelled {
        lobby_id,
        refunded_players,
        refund_per_player: entry_fee,
    });

    Ok(())
}
