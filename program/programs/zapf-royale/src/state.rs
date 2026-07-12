//! Account-Strukturen (State) des zapf_royale-Programms.

use anchor_lang::prelude::*;

/// Globale Programm-Konfiguration. PDA-Seeds: `[b"config"]`.
///
/// Space: 8 (Discriminator) + 32 + 32 + 32 + 32 + 2 + (4 + 8*8) + 1 = 207 Bytes.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin des Programms (darf `set_fee` aufrufen).
    pub authority: Pubkey,
    /// Empfänger der Operator-Fee.
    pub treasury: Pubkey,
    /// Server-Signer: darf Lobbys anlegen, Ergebnisse melden und abrechnen.
    pub result_authority: Pubkey,
    /// Oracle-Queue des Ephemeral-VRF-Programms, gegen die `create_lobby`
    /// den übergebenen Queue-Account validiert. Standard: DEFAULT_QUEUE des
    /// SDKs (identisch auf devnet/mainnet), bei `initialize` überschreibbar.
    pub oracle_queue: Pubkey,
    /// Operator-Fee in Basispunkten (400 = 4 %). Max. 1000.
    pub fee_bps: u16,
    /// Erlaubte Entry-Fees in Lamports (max. 8 Einträge).
    #[max_len(8)]
    pub allowed_entry_fees: Vec<u64>,
    /// PDA-Bump.
    pub bump: u8,
}

/// Globale Transparenz-Statistiken. PDA-Seeds: `[b"stats"]`.
///
/// Space: 8 + 8 + 8 + 8 + 1 = 33 Bytes.
#[account]
#[derive(InitSpace)]
pub struct GlobalStats {
    /// Anzahl erfolgreich abgerechneter Spiele.
    pub total_games_settled: u64,
    /// Summe aller Pots (Lamports) über alle Settlements.
    pub total_volume_lamports: u64,
    /// Summe aller einbehaltenen Fees (Lamports).
    pub total_fees_lamports: u64,
    /// PDA-Bump.
    pub bump: u8,
}

/// Status einer Lobby.
///
/// Diskriminanten (Borsh-Variantenindex) sind Teil des gemeinsamen Kontrakts
/// mit Server + Web: AwaitingRandomness=0, Open=1, Settled=2, Cancelled=3.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum LobbyStatus {
    /// Angelegt, VRF-Randomness angefordert, aber noch nicht geliefert:
    /// keine Joins, keine Ergebnisse, kein Settlement möglich.
    AwaitingRandomness,
    /// Offen (Randomness geliefert): Joins und Ergebnisse möglich.
    Open,
    /// Abgerechnet: Vault ist ausgezahlt, keine Aktionen mehr möglich.
    Settled,
    /// Abgebrochen (24h-Timeout): Einsätze wurden zurückerstattet.
    Cancelled,
}

/// Ein Spieler-Eintrag innerhalb einer Lobby.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub struct PlayerEntry {
    /// Wallet des Spielers.
    pub player: Pubkey,
    /// Gemeldetes Zapf-Ergebnis in ml (u32::MAX = Overflow-Sentinel).
    pub poured_ml: u32,
    /// Ob der Spieler sein Ergebnis bereits gemeldet bekommen hat.
    pub has_played: bool,
    /// Reihenfolge der Ergebnis-Meldung (0-basiert). Entscheidet, wer bei
    /// einem Tie den ganzzahligen Auszahlungs-Rest bekommt (kleinster Index).
    pub submission_index: u8,
}

/// Eine Spiel-Lobby. PDA-Seeds: `[b"lobby", lobby_id.to_le_bytes()]`.
///
/// Space: 8 (Discriminator) + 8 + 1 + 8 + 1 + 32 + 4 + 2 + 8 + (4 + 10*38)
/// + 1 + 1 + 1 + 1 = 460 Bytes (Platz für max. 10 Spieler ist immer
/// reserviert).
#[account]
#[derive(InitSpace)]
pub struct Lobby {
    /// Vom Server vergebene, eindeutige Lobby-ID (Teil der PDA-Seeds).
    pub lobby_id: u64,
    /// Anzahl Spieler, die diese Lobby füllt (2..=10, MVP: 5).
    pub size: u8,
    /// Einsatz pro Spieler in Lamports (muss in Config.allowed_entry_fees sein).
    pub entry_fee: u64,
    /// Aktueller Status.
    pub status: LobbyStatus,
    /// VRF-Randomness aus dem Oracle-Callback (`fulfill_round`).
    /// Genullt, solange Status == AwaitingRandomness.
    pub randomness: [u8; 32],
    /// Ziel-Eichstrich in ml, abgeleitet aus der Randomness:
    /// TARGETS_ML[randomness[0] % 3]. 0, bis die Randomness geliefert ist.
    pub target_ml: u32,
    /// Fassdruck in Milli-Einheiten (800..=1300), abgeleitet aus der
    /// Randomness (Bytes 1..3 LE). 0, bis die Randomness geliefert ist.
    pub pressure_milli: u16,
    /// Unix-Timestamp der Erstellung (für den 24h-Cancel-Timeout).
    pub created_at: i64,
    /// Beigetretene Spieler in Join-Reihenfolge.
    #[max_len(10)]
    pub players: Vec<PlayerEntry>,
    /// Anzahl beigetretener Spieler (== players.len()).
    pub joined_count: u8,
    /// Anzahl gemeldeter Ergebnisse.
    pub played_count: u8,
    /// PDA-Bump der Lobby.
    pub bump: u8,
    /// PDA-Bump des zugehörigen Vaults.
    pub vault_bump: u8,
}

impl Lobby {
    /// Liefert `true`, wenn der Spieler bereits beigetreten ist.
    pub fn contains_player(&self, key: &Pubkey) -> bool {
        self.players.iter().any(|p| p.player == *key)
    }
}
