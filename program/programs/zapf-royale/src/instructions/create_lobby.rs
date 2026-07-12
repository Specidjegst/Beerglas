//! `create_lobby` — nur die result_authority (Server) legt Lobbys an und
//! fordert im selben Ix per CPI Randomness beim MagicBlock-Ephemeral-VRF-
//! Programm an. Die Lobby startet im Status `AwaitingRandomness`; erst der
//! verifizierte Oracle-Callback (`fulfill_round`) öffnet sie.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
#[cfg(not(feature = "test-vrf"))]
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar::slot_hashes;
use anchor_lang::Discriminator;

use ephemeral_vrf_sdk::anchor::VrfProgram;
use ephemeral_vrf_sdk::consts::IDENTITY;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

use crate::constants::{
    CONFIG_SEED, LOBBY_SEED, MAX_LOBBY_SIZE, MIN_LOBBY_SIZE, VAULT_SEED,
};
use crate::errors::ZapfError;
use crate::events::LobbyCreated;
use crate::state::{Config, Lobby, LobbyStatus};

#[derive(Accounts)]
#[instruction(lobby_id: u64)]
pub struct CreateLobby<'info> {
    /// Server-Signer; zahlt die Rent der Lobby und die VRF-Request-Gebühr.
    #[account(mut)]
    pub result_authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = result_authority @ ZapfError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = result_authority,
        space = 8 + Lobby::INIT_SPACE,
        seeds = [LOBBY_SEED, lobby_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub lobby: Account<'info, Lobby>,

    /// Vault-PDA der Lobby. Reines SystemAccount (hält nur Lamports),
    /// wird nicht initialisiert — der Bump wird hier nur abgeleitet und
    /// in der Lobby gespeichert.
    #[account(
        seeds = [VAULT_SEED, lobby_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: Oracle-Queue des Ephemeral-VRF-Programms; die Adresse wird
    /// gegen `config.oracle_queue` validiert (Standard: DEFAULT_QUEUE des
    /// SDKs). Das VRF-Programm schreibt den Request in diese Queue.
    #[account(mut, address = config.oracle_queue @ ZapfError::InvalidOracleQueue)]
    pub oracle_queue: AccountInfo<'info>,

    /// CHECK: Identity-PDA DIESES Programms (`[b"identity"]`, kein Account-
    /// State). Signiert den VRF-Request per `invoke_signed`, damit das
    /// VRF-Programm den Aufrufer verifizieren kann.
    #[account(seeds = [IDENTITY], bump)]
    pub program_identity: AccountInfo<'info>,

    /// CHECK: SlotHashes-Sysvar (vom VRF-Programm als Entropie-Quelle
    /// benötigt).
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,

    /// Das Ephemeral-VRF-Programm (Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz).
    pub vrf_program: Program<'info, VrfProgram>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateLobby>,
    lobby_id: u64,
    size: u8,
    entry_fee: u64,
    client_seed: [u8; 32],
) -> Result<()> {
    require!(
        (MIN_LOBBY_SIZE..=MAX_LOBBY_SIZE).contains(&size),
        ZapfError::InvalidLobbySize
    );
    require!(
        ctx.accounts.config.allowed_entry_fees.contains(&entry_fee),
        ZapfError::EntryFeeNotAllowed
    );

    let now = Clock::get()?.unix_timestamp;

    let lobby = &mut ctx.accounts.lobby;
    lobby.lobby_id = lobby_id;
    lobby.size = size;
    lobby.entry_fee = entry_fee;
    lobby.status = LobbyStatus::AwaitingRandomness;
    lobby.randomness = [0u8; 32];
    lobby.target_ml = 0;
    lobby.pressure_milli = 0;
    lobby.created_at = now;
    lobby.players = Vec::new();
    lobby.joined_count = 0;
    lobby.played_count = 0;
    lobby.bump = ctx.bumps.lobby;
    lobby.vault_bump = ctx.bumps.vault;

    // ---------------------------------------------------------------------
    // VRF-Request: CPI an das Ephemeral-VRF-Programm. Der Oracle antwortet
    // asynchron mit einem Callback auf `fulfill_round` (Discriminator unten),
    // dem die Lobby als einziger zusätzlicher Account mitgegeben wird.
    // caller_seed = solana hash(lobby_id LE-Bytes ++ client_seed) — identisch
    // in Server-TS/Web-TS nachrechenbar.
    // ---------------------------------------------------------------------
    let caller_seed = hashv(&[&lobby_id.to_le_bytes(), &client_seed]).to_bytes();

    // In ephemeral-vrf-sdk 0.4.1 ist create_request_randomness_ix als
    // "legacy global-identity request" markiert; der Callback wird von der
    // globalen VRF_PROGRAM_IDENTITY signiert (genau das prüft fulfill_round).
    // VERIFY on first build: falls die SDK-Version die Funktion als
    // deprecated flaggt, ist das hier bewusst so gewählt.
    #[allow(deprecated)]
    let ix = create_request_randomness_ix(RequestRandomnessParams {
        // Pubkey-Konvertierung über Bytes, da SDK-compat-Pubkey und
        // anchor-lang-Pubkey aus verschiedenen Crate-Versionen stammen
        // können. // VERIFY on first build
        payer: ctx.accounts.result_authority.key().to_bytes().into(),
        oracle_queue: ctx.accounts.oracle_queue.key().to_bytes().into(),
        callback_program_id: crate::ID.to_bytes().into(),
        callback_discriminator: crate::instruction::FulfillRound::DISCRIMINATOR.to_vec(),
        caller_seed,
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: ctx.accounts.lobby.key().to_bytes().into(),
            is_signer: false,
            is_writable: true,
        }]),
        ..Default::default()
    });

    #[cfg(not(feature = "test-vrf"))]
    // VERIFY on first build: create_request_randomness_ix liefert eine
    // compat::Instruction — mit dem Feature "anchor-compat" sollte sie direkt
    // zu anchor_lang::solana_program::instruction::Instruction kompatibel
    // sein; andernfalls Felder (program_id, accounts, data) manuell mappen.
    invoke_signed(
        &ix,
        &[
            ctx.accounts.result_authority.to_account_info(),
            ctx.accounts.program_identity.to_account_info(),
            ctx.accounts.oracle_queue.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.slot_hashes.to_account_info(),
        ],
        &[&[IDENTITY, &[ctx.bumps.program_identity]]],
    )?;

    // TEST-ONLY (Feature "test-vrf"): das VRF-Programm existiert in bankrun
    // nicht, daher wird der CPI übersprungen; die Tests simulieren den
    // Callback über den test-vrf-Pfad von fulfill_round.
    // NIEMALS im Release-/Deploy-Build aktivieren!
    #[cfg(feature = "test-vrf")]
    {
        let _ = ix;
        msg!("test-vrf: VRF-Request-CPI uebersprungen (nur fuer bankrun-Tests)");
    }

    emit!(LobbyCreated {
        lobby_id,
        size,
        entry_fee,
        client_seed,
        created_at: now,
    });

    Ok(())
}
