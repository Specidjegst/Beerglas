//! Fehlercodes des zapf_royale-Programms (beginnen bei 6000 / 0x1770).

use anchor_lang::prelude::*;

#[error_code]
pub enum ZapfError {
    #[msg("fee_bps must not exceed 1000 (10%)")]
    InvalidFeeBps, // 6000
    #[msg("At most 8 allowed entry fees are supported")]
    TooManyAllowedFees, // 6001
    #[msg("At least one allowed entry fee (> 0) is required")]
    NoAllowedFees, // 6002
    #[msg("Signer is not authorized for this instruction")]
    Unauthorized, // 6003
    #[msg("Lobby size must be between 2 and 10")]
    InvalidLobbySize, // 6004
    #[msg("Entry fee is not in the allowed list")]
    EntryFeeNotAllowed, // 6005
    #[msg("Lobby is not open")]
    LobbyNotOpen, // 6006
    #[msg("Lobby is already full")]
    LobbyFull, // 6007
    #[msg("Player has already joined this lobby")]
    AlreadyJoined, // 6008
    #[msg("Player has not joined this lobby")]
    PlayerNotInLobby, // 6009
    #[msg("Result for this player was already submitted")]
    AlreadyPlayed, // 6010
    #[msg("Lobby is not full yet")]
    LobbyNotFull, // 6011
    #[msg("Not all results have been submitted yet")]
    NotAllResultsSubmitted, // 6012
    #[msg("Winner remaining accounts do not match the on-chain winners")]
    InvalidWinnerAccounts, // 6013
    #[msg("Treasury account does not match config.treasury")]
    InvalidTreasury, // 6014
    #[msg("Refund remaining accounts do not match the joined players")]
    InvalidRefundAccounts, // 6015
    #[msg("Lobby can only be cancelled 24h after creation")]
    CancelTooEarly, // 6016
    #[msg("Arithmetic overflow")]
    MathOverflow, // 6017
    #[msg("VRF randomness has not been fulfilled yet")]
    RandomnessNotFulfilled, // 6018
    #[msg("VRF randomness was already fulfilled for this lobby")]
    RandomnessAlreadyFulfilled, // 6019
    #[msg("Callback must be signed by the VRF program identity")]
    UnauthorizedVrfCallback, // 6020
    #[msg("Oracle queue account does not match config.oracle_queue")]
    InvalidOracleQueue, // 6021
    #[msg("VRF program account does not match the Ephemeral VRF program id")]
    InvalidVrfProgram, // 6022
}
