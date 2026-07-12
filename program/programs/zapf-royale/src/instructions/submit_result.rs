//! `submit_result` — nur die result_authority (Server) meldet das
//! Zapf-Ergebnis eines Spielers. Der `submission_index` hält die
//! Meldereihenfolge fest (Tie-Remainder geht an den kleinsten Index).

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, LOBBY_SEED};
use crate::errors::ZapfError;
use crate::events::ResultSubmitted;
use crate::state::{Config, Lobby, LobbyStatus};

#[derive(Accounts)]
pub struct SubmitResult<'info> {
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
}

pub fn handler(ctx: Context<SubmitResult>, player: Pubkey, poured_ml: u32) -> Result<()> {
    let lobby = &mut ctx.accounts.lobby;
    require!(lobby.status == LobbyStatus::Open, ZapfError::LobbyNotOpen);

    let lobby_id = lobby.lobby_id;
    let submission_index = lobby.played_count;

    let entry = lobby
        .players
        .iter_mut()
        .find(|p| p.player == player)
        .ok_or(ZapfError::PlayerNotInLobby)?;
    require!(!entry.has_played, ZapfError::AlreadyPlayed);

    entry.has_played = true;
    entry.poured_ml = poured_ml;
    entry.submission_index = submission_index;

    lobby.played_count = submission_index
        .checked_add(1)
        .ok_or(ZapfError::MathOverflow)?;

    emit!(ResultSubmitted {
        lobby_id,
        player,
        poured_ml,
        submission_index,
        played_count: lobby.played_count,
    });

    Ok(())
}
