//! `join_lobby` — Spieler zahlt die Entry-Fee per System-Transfer in den
//! Vault-PDA und wird in die Spielerliste aufgenommen.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::{LOBBY_SEED, VAULT_SEED};
use crate::errors::ZapfError;
use crate::events::PlayerJoined;
use crate::state::{Lobby, LobbyStatus, PlayerEntry};

#[derive(Accounts)]
#[instruction(lobby_id: u64)]
pub struct JoinLobby<'info> {
    /// Der beitretende Spieler; zahlt die Entry-Fee.
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [LOBBY_SEED, lobby_id.to_le_bytes().as_ref()],
        bump = lobby.bump,
    )]
    pub lobby: Account<'info, Lobby>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lobby_id.to_le_bytes().as_ref()],
        bump = lobby.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<JoinLobby>, _lobby_id: u64) -> Result<()> {
    let player_key = ctx.accounts.player.key();

    {
        let lobby = &ctx.accounts.lobby;
        // Vor dem VRF-Callback ist die Lobby noch nicht spielbar — eigener
        // Fehlercode, damit Clients den Zustand unterscheiden können.
        require!(
            lobby.status != LobbyStatus::AwaitingRandomness,
            ZapfError::RandomnessNotFulfilled
        );
        require!(lobby.status == LobbyStatus::Open, ZapfError::LobbyNotOpen);
        require!(lobby.joined_count < lobby.size, ZapfError::LobbyFull);
        require!(
            !lobby.contains_player(&player_key),
            ZapfError::AlreadyJoined
        );
    }

    let entry_fee = ctx.accounts.lobby.entry_fee;

    // Einsatz: Spieler -> Vault (Spieler hat die Transaktion signiert).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        entry_fee,
    )?;

    let lobby = &mut ctx.accounts.lobby;
    lobby.players.push(PlayerEntry {
        player: player_key,
        poured_ml: 0,
        has_played: false,
        submission_index: 0,
    });
    lobby.joined_count = lobby
        .joined_count
        .checked_add(1)
        .ok_or(ZapfError::MathOverflow)?;

    let pot_after = entry_fee
        .checked_mul(lobby.joined_count as u64)
        .ok_or(ZapfError::MathOverflow)?;

    emit!(PlayerJoined {
        lobby_id: lobby.lobby_id,
        player: player_key,
        pot_after,
    });

    Ok(())
}
