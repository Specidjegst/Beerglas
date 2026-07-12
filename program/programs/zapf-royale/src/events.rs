//! Anchor-Events: jeder Lamport-Fluss und jede Konfig-Änderung wird emittiert,
//! damit Volumen und Fees öffentlich nachvollziehbar sind.

use anchor_lang::prelude::*;

/// Fee wurde durch die Authority geändert.
#[event]
pub struct FeeChanged {
    pub old_bps: u16,
    pub new_bps: u16,
}

/// Neue Lobby wurde angelegt und die VRF-Randomness angefordert.
/// `client_seed` fließt in den `caller_seed` des VRF-Requests ein
/// (hash(lobby_id LE ++ client_seed)) und ist hier öffentlich verifizierbar.
#[event]
pub struct LobbyCreated {
    pub lobby_id: u64,
    pub size: u8,
    pub entry_fee: u64,
    pub client_seed: [u8; 32],
    pub created_at: i64,
}

/// VRF-Oracle-Callback ist eingetroffen: Randomness gespeichert, Ziel und
/// Fassdruck abgeleitet, Lobby ist jetzt Open.
#[event]
pub struct RoundFulfilled {
    pub lobby_id: u64,
    pub randomness: [u8; 32],
    /// TARGETS_ML[randomness[0] % 3]
    pub target_ml: u32,
    /// 800 + floor(u16_le(randomness[1..3]) * 500 / 65535)
    pub pressure_milli: u16,
}

/// Spieler ist beigetreten und hat den Einsatz in den Vault gezahlt.
#[event]
pub struct PlayerJoined {
    pub lobby_id: u64,
    pub player: Pubkey,
    /// Pot nach diesem Join (entry_fee * joined_count).
    pub pot_after: u64,
}

/// Ergebnis eines Spielers wurde von der result_authority gemeldet.
#[event]
pub struct ResultSubmitted {
    pub lobby_id: u64,
    pub player: Pubkey,
    pub poured_ml: u32,
    pub submission_index: u8,
    pub played_count: u8,
}

/// Lobby wurde abgerechnet: alle Beträge und Gewinner transparent im Event.
/// Die zugrunde liegende Randomness steht im `RoundFulfilled`-Event bzw. in
/// `lobby.randomness`.
#[event]
pub struct LobbySettled {
    pub lobby_id: u64,
    pub target_ml: u32,
    pub pot: u64,
    pub fee: u64,
    pub winners: Vec<Pubkey>,
    pub payout_per_winner: u64,
    /// Ganzzahliger Rest, der an den Gewinner mit dem kleinsten
    /// submission_index ging.
    pub remainder: u64,
}

/// Lobby wurde nach 24h-Timeout abgebrochen, Einsätze zurückerstattet.
#[event]
pub struct LobbyCancelled {
    pub lobby_id: u64,
    pub refunded_players: u8,
    pub refund_per_player: u64,
}
