//! `initialize` — einmaliges Setup von Config + GlobalStats.

use anchor_lang::prelude::*;

use crate::constants::{
    default_oracle_queue, CONFIG_SEED, MAX_ALLOWED_ENTRY_FEES, MAX_FEE_BPS, STATS_SEED,
};
use crate::errors::ZapfError;
use crate::state::{Config, GlobalStats};

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Programm-Admin; zahlt die Rent für Config + GlobalStats.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = 8 + GlobalStats::INIT_SPACE,
        seeds = [STATS_SEED],
        bump,
    )]
    pub global_stats: Account<'info, GlobalStats>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    fee_bps: u16,
    allowed_entry_fees: Vec<u64>,
    treasury: Pubkey,
    result_authority: Pubkey,
    oracle_queue: Option<Pubkey>,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ZapfError::InvalidFeeBps);
    require!(
        allowed_entry_fees.len() <= MAX_ALLOWED_ENTRY_FEES,
        ZapfError::TooManyAllowedFees
    );
    require!(!allowed_entry_fees.is_empty(), ZapfError::NoAllowedFees);
    require!(
        allowed_entry_fees.iter().all(|fee| *fee > 0),
        ZapfError::NoAllowedFees
    );

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = treasury;
    config.result_authority = result_authority;
    // VRF-Oracle-Queue: explizit übergeben (devnet/mainnet flexibel) oder
    // Standard-Queue des Ephemeral-VRF-SDKs.
    config.oracle_queue = oracle_queue.unwrap_or_else(default_oracle_queue);
    config.fee_bps = fee_bps;
    config.allowed_entry_fees = allowed_entry_fees;
    config.bump = ctx.bumps.config;

    let stats = &mut ctx.accounts.global_stats;
    stats.total_games_settled = 0;
    stats.total_volume_lamports = 0;
    stats.total_fees_lamports = 0;
    stats.bump = ctx.bumps.global_stats;

    Ok(())
}
