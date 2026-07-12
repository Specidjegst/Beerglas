pub mod cancel_lobby;
pub mod create_lobby;
pub mod fulfill_round;
pub mod initialize;
pub mod join_lobby;
pub mod set_fee;
pub mod settle_lobby;
pub mod submit_result;

pub use cancel_lobby::*;
pub use create_lobby::*;
pub use fulfill_round::*;
pub use initialize::*;
pub use join_lobby::*;
pub use set_fee::*;
pub use settle_lobby::*;
pub use submit_result::*;

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::VAULT_SEED;

/// Zahlt `amount` Lamports aus dem Vault-PDA an `to`.
///
/// Der Vault ist ein reines SystemAccount (0 Bytes Daten, Owner =
/// System-Programm). Deshalb erfolgt die Auszahlung über einen
/// `system_program::transfer`-CPI, signiert mit den Vault-PDA-Seeds
/// (`invoke_signed`). Direkte Lamport-Manipulation wäre hier nicht möglich,
/// da das Programm den Account nicht besitzt.
pub(crate) fn pay_from_vault<'info>(
    vault: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
    lobby_id: u64,
    vault_bump: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let lobby_id_bytes = lobby_id.to_le_bytes();
    let bump = [vault_bump];
    let seeds: &[&[u8]] = &[VAULT_SEED, lobby_id_bytes.as_ref(), &bump];
    let signer_seeds = &[seeds];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            system_program::Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )
}
