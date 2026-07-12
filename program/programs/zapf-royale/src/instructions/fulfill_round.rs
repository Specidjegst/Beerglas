//! `fulfill_round` — Callback des MagicBlock-Ephemeral-VRF-Programms.
//!
//! Darf ausschließlich vom VRF-Programm ausgelöst werden: dessen globaler
//! Identity-PDA (`ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY`) signiert
//! den Callback per CPI. Speichert die Randomness in der Lobby, leitet Ziel
//! und Fassdruck deterministisch ab und öffnet die Lobby für Joins.
//!
//! Ableitung (EXAKT identisch in Server-TS und Web-TS):
//! - `target_ml = [500, 1000, 1500][randomness[0] % 3]`
//! - `raw = randomness[1] | (randomness[2] << 8)` (u16, little-endian)
//! - `pressure_milli = 800 + floor(raw * 500 / 65535)` — 800..=1300
//!
//! TEST-ONLY (Cargo-Feature "test-vrf"): akzeptiert ALTERNATIV
//! `config.result_authority` als Signer (Config-PDA als remaining account),
//! damit die bankrun-Tests den Oracle-Callback simulieren können.
//! NIEMALS im Release-/Deploy-Build aktivieren!

use anchor_lang::prelude::*;

#[cfg(feature = "test-vrf")]
use crate::constants::CONFIG_SEED;
use crate::constants::{
    LOBBY_SEED, PRESSURE_MIN_MILLI, PRESSURE_SPAN_MILLI, TARGETS_ML,
};
use crate::errors::ZapfError;
use crate::events::RoundFulfilled;
#[cfg(feature = "test-vrf")]
use crate::state::Config;
use crate::state::{Lobby, LobbyStatus};

#[derive(Accounts)]
pub struct FulfillRound<'info> {
    /// Identity-Signer des VRF-Programms — beweist, dass der Callback per
    /// CPI aus dem VRF-Programm kommt. Im test-vrf-Build entfällt die
    /// Adress-Constraint; stattdessen prüft der Handler den Signer (VRF-
    /// Identity ODER config.result_authority via remaining account).
    /// cfg_attr wird vor der Anchor-Derive-Expansion aufgelöst.
    #[cfg_attr(
        not(feature = "test-vrf"),
        account(address = crate::constants::vrf_program_identity() @ ZapfError::UnauthorizedVrfCallback)
    )]
    pub vrf_program_identity: Signer<'info>,

    /// Die Lobby wurde dem VRF-Request als einziger zusätzlicher Account
    /// (writable) mitgegeben — siehe `create_lobby`.
    #[account(
        mut,
        seeds = [LOBBY_SEED, lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.bump,
    )]
    pub lobby: Account<'info, Lobby>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, FulfillRound<'info>>,
    randomness: [u8; 32],
) -> Result<()> {
    // TEST-ONLY Signer-Check (siehe Modul-Doku). Im Produktions-Build
    // erledigt die address-Constraint im Accounts-Struct die Prüfung.
    #[cfg(feature = "test-vrf")]
    verify_test_build_signer(&ctx)?;

    let lobby = &mut ctx.accounts.lobby;
    require!(
        lobby.status == LobbyStatus::AwaitingRandomness,
        ZapfError::RandomnessAlreadyFulfilled
    );

    // Ableitung exakt nach Kontrakt (identisch in Server-TS / Web-TS).
    let target_ml = TARGETS_ML[(randomness[0] as usize) % TARGETS_ML.len()];
    let raw = u32::from(randomness[1]) | (u32::from(randomness[2]) << 8);
    // raw <= 65535 => raw * 500 <= 32_767_500, passt in u32; Ergebnis 800..=1300.
    let pressure_milli =
        (PRESSURE_MIN_MILLI + raw * PRESSURE_SPAN_MILLI / u32::from(u16::MAX)) as u16;

    lobby.randomness = randomness;
    lobby.target_ml = target_ml;
    lobby.pressure_milli = pressure_milli;
    lobby.status = LobbyStatus::Open;

    emit!(RoundFulfilled {
        lobby_id: lobby.lobby_id,
        randomness,
        target_ml,
        pressure_milli,
    });

    Ok(())
}

/// TEST-ONLY (Feature "test-vrf"): erlaubt zusätzlich zur echten
/// VRF-Programm-Identity auch `config.result_authority` als Signer. Die
/// Config-PDA kommt dafür als erster remaining account mit (im Produktions-
/// Callback ist die Account-Liste exakt [identity, lobby], deshalb darf die
/// Config nicht Teil des regulären Accounts-Structs sein).
/// NIEMALS im Release-/Deploy-Build aktivieren!
#[cfg(feature = "test-vrf")]
fn verify_test_build_signer<'info>(
    ctx: &Context<'_, '_, 'info, 'info, FulfillRound<'info>>,
) -> Result<()> {
    let signer = ctx.accounts.vrf_program_identity.key();
    if signer == crate::constants::vrf_program_identity() {
        return Ok(());
    }
    let config_info = ctx
        .remaining_accounts
        .first()
        .ok_or(ZapfError::UnauthorizedVrfCallback)?;
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID);
    require_keys_eq!(
        config_info.key(),
        expected_config,
        ZapfError::UnauthorizedVrfCallback
    );
    let config: Account<Config> = Account::try_from(config_info)?;
    require_keys_eq!(
        signer,
        config.result_authority,
        ZapfError::UnauthorizedVrfCallback
    );
    Ok(())
}
