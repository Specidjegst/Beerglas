//! `set_fee` — nur die Authority darf die Fee ändern; jede Änderung
//! emittiert ein `FeeChanged`-Event (Transparenz-Anforderung).

use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, MAX_FEE_BPS};
use crate::errors::ZapfError;
use crate::events::FeeChanged;
use crate::state::Config;

#[derive(Accounts)]
pub struct SetFee<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ ZapfError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<SetFee>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ZapfError::InvalidFeeBps);

    let config = &mut ctx.accounts.config;
    let old_bps = config.fee_bps;
    config.fee_bps = fee_bps;

    emit!(FeeChanged {
        old_bps,
        new_bps: fee_bps,
    });

    Ok(())
}
