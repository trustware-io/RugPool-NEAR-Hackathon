//! RugPool rehearsal, Milestones 1 to 10: the Court round-trip, real challenges, rounds that
//! end in a showdown and pay the Jackpot to the last King, auto-defend, the weekly draw, the
//! controls a capped mainnet deployment needs, a funded yield reserve, a registration fee, and
//! a draw picked by drand.
//! USDC arrives through `ft_transfer_call` and is credited to a game balance (optionally
//! joining the Court). A Court member challenges from that balance at the curve price; the
//! ticket splits 55/25/15/5 into the Jackpot, the dethroned King, the Court and the protocol.
//! The Court share goes partly to depositors (reward-per-share) and partly to the draw pot.
//! Funds leave through `withdraw` (Court principal, after a cooldown) or `claim` (game balance
//! plus Court earnings). A showdown starts when the Jackpot reaches the trigger or the round
//! reaches its backstop age; a late challenge extends it; once it ends, anyone can call
//! `settle_round` to pay the Jackpot to the King and open the next round. A dethroned King
//! with auto-defend armed retakes the throne in the same transaction, up to 25 retakes. Once a
//! week `close_draw` freezes the draw pot and everyone's weight (principal × time) and names a
//! drand round still in the future; once drand publishes it, `finalize_draw` checks its
//! signature and pays the pot to the depositor that round's randomness picks.
//! A withdrawal request takes the money out of the Court at once (it stops earning and stops
//! counting toward the minimum). Deposits relayed by NEAR Intents can't be refunded, so they
//! never panic: they are credited, or held for the owner to return. Yield comes from a finite
//! reserve that anyone can fund (never from principal): while it lasts, the Court earns an APY
//! split between depositors, the Jackpot seed and the King's stream. A new account's first
//! deposit pays a small registration fee toward its storage, and empty accounts are deleted.
//!
//! Errors panic as "CODE: message" so the app can map them to its `GameErrorCode`s.

mod drand;

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LazyOption, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, ext_contract, near,
};

/// Smallest deposit. Every new account costs the contract storage, so dust deposits are refused.
pub const MIN_DEPOSIT: u128 = 1_000_000;
const EVENT_LOG_MAX: u64 = 200;
const PAGE_MAX: u64 = 50;
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(20);
/// Fixed-point scale for the Court reward-per-share accumulator.
const PRECISION: u128 = 1_000_000_000_000_000_000;

pub const START_PRICE: u128 = 5_000_000;
pub const STEP_BPS: u32 = 300;
/// Jackpot, dethroned King, Court, protocol.
pub const SPLIT_BPS: [u32; 4] = [5500, 2500, 1500, 500];
pub const MIN_COURT: u128 = 25_000_000;
/// Auto-defend retakes allowed in one transaction, so a war always fits in the gas limit.
pub const MAX_RETAKES: u32 = 25;
/// Blocks after a buy before the next one: a buy in block N locks N + 1, so no two buys land
/// back to back and nobody can answer a buy in the very next block.
const BUY_LOCK_BLOCKS: u64 = 1;
/// Most accounts in the draw at once. `close_draw` and `finalize_draw` walk them all, so this
/// bounds their gas; see the sandbox test `draw_gas_per_depositor` for the measured cost.
pub const MAX_DEPOSITORS: u32 = 500;
/// Court principal needed to hold one of the `MAX_DEPOSITORS` draw slots, so filling the draw
/// costs $5 a slot rather than $1. Smaller Court deposits still earn fees and yield.
pub const DRAW_MIN_COURT: u128 = 5_000_000;
/// Storage a new account can take (account, draw weight, depositor entry), with headroom.
/// Storage the contract's NEAR must cover beyond what it already uses. Without it, whatever
/// adds storage stops or changes so that it adds none, and the buffer is left for paying
/// players out (each payout in flight stores a record of about 150 bytes):
/// - direct deposits, Court joins and arming auto-defend are refused;
/// - Intents deliveries are held in `recovery`;
/// - events are logged but not added to the stored log (`emit`);
/// - a King with no stream entry yet gets his yield in his game balance (`accrue_yield`).
/// Challenges stay open, because a round's clock keeps running: if filling the contract's
/// storage could stop them, a King could do it to win unopposed. With the last two rules a
/// challenge adds nothing to the collections while the buffer is short. It can still lengthen
/// the contract's own record, which `ROOT_GROWTH_BYTES` is held for. The buffer is more than twice the most one Intents delivery can add: a new
/// account, its draw slot and weight, the King's first stream entry and two events (measured
/// by `the_storage_buffer_covers_the_largest_delivery`).
const STORAGE_BUFFER_BYTES: u64 = 2_000;
/// Held on top of the buffer: the most the contract's own record can still grow through
/// calls that stay open while the buffer is short. A first King with the longest id (4 + 64
/// bytes), `king_since`, the showdown's end and the first buy block (8 each). The record
/// shrinks again when a round settles, so this bounds the growth over any number of rounds.
const ROOT_GROWTH_BYTES: u64 = 92;
/// What freezing a draw stores besides the entries themselves: the entries' record (its key
/// and the protocol's 40 bytes per record), the pending draw in the contract's own record
/// (40 bytes) and the `draw_closed` event. 171 bytes, measured by
/// `freezing_a_draw_needs_room_for_its_entries_on_top_of_the_buffer`.
const DRAW_FREEZE_OVERHEAD_BYTES: u64 = 300;
const DRAW_EVERY_MS: u64 = 7 * 24 * 3_600_000;
/// How far past `close_draw` the deciding drand round is. Block timestamps are set by the block
/// producer, so the round has to be far enough ahead that it's still unpublished when the
/// entries freeze.
const DRAW_ROUND_MARGIN_MS: u64 = 30_000;
const YEAR_MS: u128 = 365 * 24 * 3_600_000;
/// How long a payout must have been in flight before the owner may settle it by hand. Its
/// callback normally lands within a few blocks.
const PAYOUT_STUCK_MS: u64 = 3_600_000;

/// The yield the reserve pays while it lasts: an APY on the Court, split between depositors,
/// the Jackpot seed and the King's stream.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct YieldParams {
    pub apy_bps: u32,
    /// Court, Jackpot seed, King's stream. Sums to 10000.
    pub split_bps: [u32; 3],
}

impl YieldParams {
    pub fn spec() -> Self {
        Self { apy_bps: 500, split_bps: [5000, 3000, 2000] }
    }

    fn validated(self) -> Self {
        if self.apy_bps > 10_000 || self.split_bps.iter().sum::<u32>() != 10_000 {
            fail("INVALID_AMOUNT", "Yield params out of range.");
        }
        self
    }
}

/// One stretch of yield, already capped by the reserve.
struct YieldDue {
    paid: u128,
    court: u128,
    seed: u128,
    king: u128,
    /// What rounding left over, carried into the next accrual.
    carry: u128,
}

/// Deposit caps and the draw schedule. `new` defaults to no caps and a weekly draw with a
/// \$1 minimum pot; a mainnet deployment passes real caps.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Limits {
    /// Most one account may hold (balance + Court + pending) through direct deposits.
    pub max_account: U128,
    /// Most the contract may hold across everyone through direct deposits.
    pub max_total: U128,
    /// The draw rolls over while the pot is smaller than this.
    pub draw_min: U128,
    pub draw_every_ms: u64,
}

impl Limits {
    pub fn uncapped() -> Self {
        Self { max_account: U128(u128::MAX), max_total: U128(u128::MAX), draw_min: U128(1_000_000), draw_every_ms: DRAW_EVERY_MS }
    }
}

/// An account's draw weight this epoch: principal × milliseconds, accrued up to `last_touch`.
#[near(serializers = [borsh])]
pub struct DrawWeight {
    acc: u128,
    last_touch: u64,
    epoch: u64,
}

/// A closed draw waiting for its drand round. Its pot and the entries' weights are frozen.
#[near(serializers = [borsh])]
pub struct PendingDraw {
    round: u64,
    pot: u128,
    total: u128,
}

#[near(serializers = [json])]
pub struct PendingDrawView {
    /// The drand quicknet round whose signature `finalize_draw` takes.
    pub round: u64,
    pub pot: U128,
}

/// When rounds end. `new` defaults to the spec values; testnet demos pass shorter ones.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Timing {
    /// Showdown trigger as a share of the Court (bps), unless `trigger_fixed` is set.
    pub trigger_bps: u32,
    pub trigger_fixed: Option<U128>,
    /// Round age that starts the showdown when the Jackpot never reaches the trigger.
    pub backstop_ms: u64,
    pub showdown_ms: u64,
    /// A challenge with less than this left on the clock pushes the end to this far out.
    pub snipe_ms: u64,
}

impl Timing {
    pub fn spec() -> Self {
        Self { trigger_bps: 20, trigger_fixed: None, backstop_ms: 6 * 3_600_000, showdown_ms: 600_000, snipe_ms: 60_000 }
    }

    fn validated(self) -> Self {
        let year = 365 * 24 * 3_600_000;
        let ok = self.trigger_bps <= 10_000
            && (1..=year).contains(&self.backstop_ms)
            && (1..=year).contains(&self.showdown_ms)
            && self.snipe_ms <= self.showdown_ms;
        if !ok {
            fail("INVALID_AMOUNT", "Timing out of range.");
        }
        self
    }
}

#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Account {
    balance: u128,
    court: u128,
    withdraw_pending: u128,
    withdraw_ready_at: Option<u64>,
    /// `ceil(court * acc_per_share / PRECISION)` at the last sync. Rounding up keeps the sum
    /// of everyone's accruals at or below what was distributed, so rewards stay solvent.
    reward_debt: u128,
    /// Court rewards accrued but not yet claimed.
    earned: u128,
}

#[near(serializers = [borsh])]
pub struct Round {
    id: u64,
    challenges: u32,
    next_price: u128,
    /// The King's ticket, for the settlement multiple.
    last_price: u128,
    king: Option<AccountId>,
    king_since: Option<u64>,
    started_at: u64,
    jackpot: u128,
    showdown_ends_at: Option<u64>,
}

/// Stored and returned as the app's `GameEvent`: `{ id, at, type, data }`. New variants go
/// at the end: stored events are Borsh, so reordering would misread them after an upgrade.
#[near(serializers = [borsh, json])]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
#[derive(Clone)]
pub enum EventKind {
    Challenged { by: AccountId, price: U128, dethroned: Option<AccountId> },
    CourtJoin { by: AccountId, amount: U128 },
    Withdraw { by: AccountId, amount: U128 },
    ShowdownStarted { reason: ShowdownReason, ends_at: u64 },
    RoundSettled { winner: Option<AccountId>, jackpot: U128, multiple: f64 },
    AutoDefended { by: AccountId, price: U128, against: AccountId },
    DrawWon { by: AccountId, amount: U128 },
    /// An Intents delivery with no usable beneficiary, held for the owner to return.
    DepositHeld { amount: U128 },
    /// The draw's entries froze; drand `round` picks the winner.
    DrawClosed { round: u64, amount: U128 },
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy)]
pub enum ShowdownReason {
    Size,
    Time,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Event {
    pub id: u64,
    pub at: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[near(serializers = [json])]
pub struct EventPage {
    pub events: Vec<Event>,
    pub cursor: u64,
}

#[near(serializers = [json])]
pub struct RoundView {
    pub id: u64,
    pub challenges: u32,
    pub next_price: U128,
    pub king: Option<AccountId>,
    pub king_since: Option<u64>,
    pub started_at: u64,
    pub jackpot: U128,
    pub showdown_trigger: U128,
    pub showdown_ends_at: Option<u64>,
    pub backstop_at: u64,
}

#[near(serializers = [json])]
pub struct CourtView {
    pub total: U128,
    pub apy_bps_live: u32,
    pub next_draw_at: u64,
    pub draw_pot: U128,
    pub pending_draw: Option<PendingDrawView>,
}

#[near(serializers = [json])]
pub struct ParamsView {
    pub start_price: U128,
    pub step_bps: u32,
    pub split_bps: [u32; 4],
    pub min_court: U128,
    pub showdown_ms: u64,
    pub snipe_ms: u64,
    /// Kept from a new account's first deposit, toward its storage.
    pub registration_fee: U128,
}

#[near(serializers = [json])]
pub struct StateView {
    pub round: RoundView,
    pub court: CourtView,
    pub params: ParamsView,
    pub paused: bool,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub balance: U128,
    pub court: U128,
    pub court_earned: U128,
    pub draw_weight_bps: u32,
    pub king_stream: U128,
    pub auto_defend_max: U128,
    /// Court money on its way out: it no longer earns or counts toward the minimum.
    pub withdraw_pending: U128,
    pub withdraw_ready_at: Option<u64>,
}

/// What the contract holds against. Once no payout is in flight, the contract's token
/// balance must equal the sum of these fields. `rewards` is what was set aside for Court
/// depositors and not yet claimed; it may exceed their total accrual by rounding dust.
/// `in_flight` is payouts sent whose outcome the contract hasn't booked yet: the tokens have
/// either left or are about to come back to the books. It is zero at rest. `get_payout` has
/// each payout's start time: one that stays in flight has a failed callback (see
/// `resolve_payout`).
#[near(serializers = [json])]
pub struct Liabilities {
    pub balances: U128,
    pub court: U128,
    pub jackpot: U128,
    pub rewards: U128,
    pub draw_pot: U128,
    pub treasury: U128,
    pub pending: U128,
    pub recovery: U128,
    pub yield_reserve: U128,
    pub streams: U128,
    pub in_flight: U128,
}

/// `ft_transfer_call` msg. Empty means "credit the sender's game balance". The beneficiary
/// exists because a NEAR Intents delivery arrives with `intents.near` as the sender.
#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct DepositMsg {
    action: DepositAction,
    beneficiary: Option<AccountId>,
}

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
enum DepositAction {
    Balance,
    Join,
    /// Funds the yield reserve; credits no account.
    FundYield,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
pub enum PayoutKind {
    Withdraw,
    Claim,
    Recovery,
    Treasury,
    Reserve,
}

/// A payout sent to the token and not yet booked as paid or failed.
#[near(serializers = [borsh])]
pub struct Payout {
    account_id: AccountId,
    amount: u128,
    kind: PayoutKind,
    started_at: u64,
}

#[near(serializers = [json])]
pub struct PayoutView {
    pub account_id: AccountId,
    pub amount: U128,
    pub kind: PayoutKind,
    pub started_at: u64,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    Events,
    Defenders,
    Depositors,
    DrawWeights,
    Streams,
    DrawEntries,
    Payouts,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: AccountId,
    withdraw_cooldown_ms: u64,
    /// Share of the Court's ticket cut that goes to the draw pot; the rest pays depositors.
    court_draw_bps: u32,
    timing: Timing,
    owner: AccountId,
    /// The NEAR Intents account. Its deliveries are never refused, because they can't be refunded.
    intents: Option<AccountId>,
    paused: bool,
    limits: Limits,
    accounts: LookupMap<AccountId, Account>,
    balances_total: u128,
    court_total: u128,
    acc_per_share: u128,
    rewards_pool: u128,
    draw_pot: u128,
    treasury: u128,
    round: Round,
    events: LookupMap<u64, Event>,
    last_event_id: u64,
    /// Auto-defend max retake price per account. Kept out of `Account` so arming needs no
    /// migration of existing accounts.
    defenders: LookupMap<AccountId, u128>,
    /// Withdrawals requested but not yet paid.
    pending_total: u128,
    /// Intents deliveries with no usable beneficiary.
    recovery: u128,
    draw_epoch: u64,
    draw_epoch_start: u64,
    /// Everyone who has been in the Court since the last draw. `LookupMap` can't be walked,
    /// and the draw has to walk the depositors.
    depositors: IterableSet<AccountId>,
    draw_weights: LookupMap<AccountId, DrawWeight>,
    yield_params: YieldParams,
    /// Funded yield not yet paid out. Yield never comes from anywhere else.
    yield_reserve: u128,
    /// When yield was last accrued.
    yield_last: u64,
    /// The fraction of a micro-USDC (scaled by `10_000 × YEAR_MS`) that the last accrual
    /// rounded off. Without it, accruals a few seconds apart would floor every one to zero.
    yield_carry: u128,
    /// Each King's yield stream, claimable with the game balance.
    streams: LookupMap<AccountId, u128>,
    streams_total: u128,
    registration_fee: u128,
    pending_draw: Option<PendingDraw>,
    /// The block of the last challenge, for the buy lock.
    last_buy_block: Option<u64>,
    /// The pending draw's entries and their frozen weights, only accounts with weight. One
    /// stored value: written and read once per draw, which costs far less than an entry each.
    draw_entries: LazyOption<Vec<(AccountId, u128)>>,
    /// Accounts allowed to relay play calls (see `require_trusted_relay`).
    relayers: Vec<AccountId>,
    /// Payouts in flight. A payout's amount stays on the books here until its callback books
    /// the outcome, so a callback that fails loses nothing: the record waits for `resolve_payout`.
    payouts: LookupMap<u64, Payout>,
    last_payout_id: u64,
    in_flight: u128,
}

/// The registration fee can't eat a minimum deposit: at most half of it.
fn validated_fee(fee: Option<U128>) -> u128 {
    let fee = fee.map_or(0, |f| f.0);
    if fee > MIN_DEPOSIT / 2 {
        fail("INVALID_AMOUNT", "The registration fee is at most half the minimum deposit.");
    }
    fee
}

fn fail(code: &str, message: &str) -> ! {
    env::panic_str(&format!("{code}: {message}"))
}

/// The ticket after `price`: +STEP_BPS, floored, the same as the app's `priceAt`.
pub fn next_price(price: u128) -> u128 {
    price * (10_000 + STEP_BPS as u128) / 10_000
}

/// Splits a ticket into [Jackpot, King, Court, protocol]. Each share is floored and the
/// rounding remainder goes to the Jackpot, so the parts always sum to the price.
pub fn split_ticket(price: u128) -> [u128; 4] {
    let share = |bps: u32| price * bps as u128 / 10_000;
    let (king, court, protocol) = (share(SPLIT_BPS[1]), share(SPLIT_BPS[2]), share(SPLIT_BPS[3]));
    [price - king - court - protocol, king, court, protocol]
}

/// The ticket price of challenge `k` (0-based) in a round.
#[cfg(test)]
fn price_at(k: u32) -> u128 {
    (0..k).fold(START_PRICE, |p, _| next_price(p))
}

/// Moves rewards accrued since the last sync into `earned`.
fn accrue(a: &mut Account, acc: u128) {
    a.earned += (a.court * acc / PRECISION).saturating_sub(a.reward_debt);
}

/// Restarts accrual from now. Call after every change to `court`.
fn rebase(a: &mut Account, acc: u128) {
    a.reward_debt = (a.court * acc).div_ceil(PRECISION);
}

#[near]
impl Contract {
    /// Only the contract account can initialize it, so nobody can front-run a deploy that
    /// isn't batched with its init call.
    #[private]
    #[init]
    pub fn new(
        token: AccountId,
        withdraw_cooldown_ms: u64,
        court_draw_bps: u32,
        timing: Option<Timing>,
        owner: Option<AccountId>,
        intents: Option<AccountId>,
        limits: Option<Limits>,
        yield_params: Option<YieldParams>,
        registration_fee: Option<U128>,
        relayers: Option<Vec<AccountId>>,
    ) -> Self {
        if court_draw_bps > 10_000 {
            fail("INVALID_AMOUNT", "court_draw_bps must be at most 10000.");
        }
        Self {
            token,
            withdraw_cooldown_ms,
            court_draw_bps,
            timing: timing.unwrap_or_else(Timing::spec).validated(),
            owner: owner.unwrap_or_else(env::predecessor_account_id),
            intents,
            paused: false,
            limits: limits.unwrap_or_else(Limits::uncapped),
            accounts: LookupMap::new(StorageKey::Accounts),
            balances_total: 0,
            court_total: 0,
            acc_per_share: 0,
            rewards_pool: 0,
            draw_pot: 0,
            treasury: 0,
            round: Round::open(1, env::block_timestamp_ms(), 0),
            events: LookupMap::new(StorageKey::Events),
            last_event_id: 0,
            defenders: LookupMap::new(StorageKey::Defenders),
            pending_total: 0,
            recovery: 0,
            draw_epoch: 0,
            draw_epoch_start: env::block_timestamp_ms(),
            depositors: IterableSet::new(StorageKey::Depositors),
            draw_weights: LookupMap::new(StorageKey::DrawWeights),
            yield_params: yield_params.unwrap_or_else(YieldParams::spec).validated(),
            yield_reserve: 0,
            yield_last: env::block_timestamp_ms(),
            yield_carry: 0,
            streams: LookupMap::new(StorageKey::Streams),
            streams_total: 0,
            registration_fee: validated_fee(registration_fee),
            last_buy_block: None,
            pending_draw: None,
            draw_entries: LazyOption::new(StorageKey::DrawEntries, None),
            relayers: relayers.unwrap_or_default(),
            payouts: LookupMap::new(StorageKey::Payouts),
            last_payout_id: 0,
            in_flight: 0,
        }
    }

    /// Upgrades M10 state in place: everything is kept, and the trusted relayers are set.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(relayers: Vec<AccountId>) -> Self {
        let old: ContractV10 = env::state_read().unwrap_or_else(|| fail("MIGRATE", "No M10 state to migrate."));
        Self {
            token: old.token,
            withdraw_cooldown_ms: old.withdraw_cooldown_ms,
            court_draw_bps: old.court_draw_bps,
            timing: old.timing,
            owner: old.owner,
            intents: old.intents,
            paused: old.paused,
            limits: old.limits,
            accounts: old.accounts,
            balances_total: old.balances_total,
            court_total: old.court_total,
            acc_per_share: old.acc_per_share,
            rewards_pool: old.rewards_pool,
            draw_pot: old.draw_pot,
            treasury: old.treasury,
            round: old.round,
            events: old.events,
            last_event_id: old.last_event_id,
            defenders: old.defenders,
            pending_total: old.pending_total,
            recovery: old.recovery,
            draw_epoch: old.draw_epoch,
            draw_epoch_start: old.draw_epoch_start,
            depositors: old.depositors,
            draw_weights: old.draw_weights,
            yield_params: old.yield_params,
            yield_reserve: old.yield_reserve,
            yield_last: old.yield_last,
            yield_carry: old.yield_carry,
            streams: old.streams,
            streams_total: old.streams_total,
            registration_fee: old.registration_fee,
            pending_draw: old.pending_draw,
            last_buy_block: old.last_buy_block,
            draw_entries: old.draw_entries,
            relayers,
            payouts: LookupMap::new(StorageKey::Payouts),
            last_payout_id: 0,
            in_flight: 0,
        }
    }

    // ---- actions --------------------------------------------------------------------

    /// Takes the throne at the current price, paid from the game balance.
    pub fn challenge(&mut self, max_price: U128) {
        self.require_unpaused();
        self.require_trusted_relay();
        let id = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        self.accrue_yield(now);
        self.poke_at(now);
        if self.round.showdown_ends_at.is_some_and(|end| now >= end) {
            fail("ROUND_CLOSED", "The showdown is over. The King is being crowned.");
        }
        let block = env::block_height();
        if self.last_buy_block.is_some_and(|last| block <= last + BUY_LOCK_BLOCKS) {
            fail("BUY_LOCKED", "Someone just bought. Try again in a moment.");
        }
        let price = self.round.next_price;
        let a = self.accounts.get(&id).unwrap_or_else(|| fail("COURT_TOO_SMALL", "You need $25 in the Court to challenge."));
        if a.court < MIN_COURT {
            fail("COURT_TOO_SMALL", "You need $25 in the Court to challenge.");
        }
        if self.round.king.as_ref() == Some(&id) {
            fail("ALREADY_KING", "You are already the King.");
        }
        if price > max_price.0 {
            fail("PRICE_MOVED", "The price moved above your max.");
        }
        if a.balance < price {
            fail("INSUFFICIENT_BALANCE", "Not enough in your game balance.");
        }

        self.last_buy_block = Some(block);
        let mut dethroned = self.take_throne(id, price, now, false);
        // Each dethroned King with auto-defend armed answers at once, which can start a war.
        // Retakes happen inside this call, so the buy lock doesn't apply to them.
        for _ in 0..MAX_RETAKES {
            let Some(king) = dethroned else { break };
            let price = self.round.next_price;
            if !self.will_retake(&king, price) {
                break;
            }
            dethroned = self.take_throne(king, price, now, true);
        }
    }

    /// Arms auto-defend: when dethroned, retake the throne for up to `max_price` per ticket,
    /// paid from the game balance. 0 disarms.
    pub fn set_auto_defend(&mut self, max_price: U128) {
        self.require_trusted_relay();
        let id = env::predecessor_account_id();
        if !self.accounts.contains_key(&id) {
            fail("INSUFFICIENT_BALANCE", "Deposit USDC first.");
        }
        if max_price.0 == 0 {
            self.defenders.remove(&id);
        } else {
            // Disarming always works; arming waits for the pause to lift.
            self.require_live();
            self.defenders.insert(id, max_price.0);
        }
    }

    /// Ends the draw's week. The pot and every depositor's weight (principal × time held this
    /// epoch) freeze, and the drand round that will pick the winner is named: one far enough
    /// ahead that nobody can know it yet, so nobody can time this call or move money to win.
    /// Rolls the pot over while it's under `draw_min` or nobody has weight. Anyone can call it
    /// once the draw is due (the keeper does).
    pub fn close_draw(&mut self) {
        let now = env::block_timestamp_ms();
        self.accrue_yield(now);
        if self.pending_draw.is_some() {
            fail("DRAW_PENDING", "The last draw is still waiting for its drand round.");
        }
        if now < self.next_draw_at() {
            fail("NOT_READY", "The draw is not due yet.");
        }
        let weights: Vec<(AccountId, u128)> = self.depositors.iter().map(|id| (id.clone(), self.slot_weight(id, now))).collect();
        let total: u128 = weights.iter().map(|(_, w)| w).sum();
        let pot = self.draw_pot;
        if pot >= self.limits.draw_min.0 && total > 0 {
            let entries: Vec<(AccountId, u128)> = weights.iter().filter(|(_, w)| *w > 0).cloned().collect();
            // Freezing the entries stores them until drand's round, up to 42 KB at the cap. The
            // draw waits unless the contract can pay for all of that and still have its buffer.
            let stored = 4 + entries.iter().map(|(id, _)| 4 + id.len() as u64 + 16).sum::<u64>() + DRAW_FREEZE_OVERHEAD_BYTES;
            if !self.has_storage_for(stored) {
                fail("PAUSED", "The draw waits until the contract's storage is topped up.");
            }
            self.draw_entries.set(Some(entries));
            let round = drand::round_at(now + DRAW_ROUND_MARGIN_MS);
            self.pending_draw = Some(PendingDraw { round, pot, total });
            self.draw_pot = 0;
            self.emit(EventKind::DrawClosed { round, amount: U128(pot) });
        }
        // A new epoch: weights restart from now, and anyone below the draw minimum drops out.
        for (id, _) in weights {
            if self.accounts.get(&id).is_none_or(|a| a.court < DRAW_MIN_COURT) {
                self.depositors.remove(&id);
                self.draw_weights.remove(&id);
            }
        }
        self.draw_epoch += 1;
        self.draw_epoch_start = now;
    }

    /// Pays the pending draw: `signature` is drand quicknet's signature (hex) for the round
    /// `close_draw` named, and its randomness picks one entry with odds proportional to the
    /// frozen weights. Anyone can call it once drand has published the round (the keeper
    /// does); the signature is unique, so the caller can't pick it.
    pub fn finalize_draw(&mut self, signature: String) {
        let round = self.pending_draw.as_ref().map(|p| p.round).unwrap_or_else(|| fail("NO_DRAW", "No draw is waiting for drand."));
        let randomness = drand::decode_hex(&signature)
            .and_then(|sig| drand::verify(round, &sig))
            .unwrap_or_else(|| fail("BAD_SIGNATURE", "Not drand's signature for this draw's round."));
        self.pay_draw(randomness);
    }

    // ---- owner ----------------------------------------------------------------------

    /// Stops new play (challenges, joins, arming, direct deposits). Never stops anyone
    /// leaving: claims and withdrawals keep working, and Intents deliveries are still credited.
    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        self.paused = paused;
    }

    /// Sets the accounts allowed to relay spending calls (see `require_trusted_relay`).
    pub fn set_relayers(&mut self, relayers: Vec<AccountId>) {
        self.require_owner();
        self.relayers = relayers;
    }

    /// Returns Intents deliveries that arrived with no usable beneficiary.
    pub fn recover(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.require_owner();
        if amount.0 == 0 || amount.0 > self.recovery {
            fail("INVALID_AMOUNT", "More than is held for recovery.");
        }
        self.recovery -= amount.0;
        self.pay_out(receiver_id, amount.0, PayoutKind::Recovery)
    }

    /// Takes funds back out of the yield reserve, e.g. to wind a deployment down.
    pub fn withdraw_reserve(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.require_owner();
        self.accrue_yield(env::block_timestamp_ms());
        if amount.0 == 0 || amount.0 > self.yield_reserve {
            fail("INVALID_AMOUNT", "More than the yield reserve holds.");
        }
        self.yield_reserve -= amount.0;
        self.pay_out(receiver_id, amount.0, PayoutKind::Reserve)
    }

    /// Sends the protocol's 5% to `receiver_id`.
    pub fn claim_treasury(&mut self, receiver_id: AccountId) -> Promise {
        self.require_owner();
        let amount = self.treasury;
        if amount == 0 {
            fail("NOTHING_TO_CLAIM", "The treasury is empty.");
        }
        self.treasury = 0;
        self.pay_out(receiver_id, amount, PayoutKind::Treasury)
    }

    /// Starts the showdown once the round reaches its backstop age, or once the Jackpot is at
    /// the size trigger (yield raises the Jackpot and Court withdrawals lower the trigger
    /// between challenges). Anyone can call it (the keeper does); `challenge` runs it too.
    pub fn poke(&mut self) {
        let now = env::block_timestamp_ms();
        self.accrue_yield(now);
        self.poke_at(now);
    }

    /// Pays the Jackpot to the King once the showdown is over, or carries it into the next
    /// round when nobody took the throne, then opens the next round at the start price.
    pub fn settle_round(&mut self) {
        let now = env::block_timestamp_ms();
        if !self.round.showdown_ends_at.is_some_and(|end| now >= end) {
            fail("NOT_READY", "The showdown has not ended.");
        }
        // The King's stream and the Jackpot seed run right up to the crowning.
        self.accrue_yield(now);
        let pot = self.round.jackpot;
        let (winner, carry, multiple) = match self.round.king.clone() {
            Some(king) => {
                self.account_mut(&king).balance += pot;
                self.balances_total += pot;
                // Two decimals, rounded half up like the mock: 1.838x shows as 1.84.
                let last = self.round.last_price;
                (Some(king), 0, ((pot * 100 + last / 2) / last) as f64 / 100.0)
            }
            None => (None, pot, 0.0),
        };
        self.emit(EventKind::RoundSettled { winner, jackpot: U128(pot), multiple });
        self.round = Round::open(self.round.id + 1, now, carry);
    }

    pub fn join_court(&mut self, amount: U128) {
        self.require_live();
        self.require_trusted_relay();
        let id = env::predecessor_account_id();
        self.require_room_in_court(&id, amount.0);
        let a = self.accounts.get(&id).unwrap_or_else(|| fail("INSUFFICIENT_BALANCE", "Deposit USDC first."));
        if amount.0 == 0 {
            fail("INVALID_AMOUNT", "Amount must be more than zero.");
        }
        if amount.0 > a.balance {
            fail("INSUFFICIENT_BALANCE", "Your game balance is too small.");
        }
        self.do_join(&id, amount.0);
    }

    /// Takes `amount` out of the Court at once: it stops earning, stops counting toward the
    /// minimum and stops gaining draw weight. It can be withdrawn after the cooldown, which
    /// restarts for everything pending.
    pub fn request_withdraw(&mut self, amount: U128) {
        self.require_trusted_relay();
        let id = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let court = self.accounts.get(&id).map_or(0, |a| a.court);
        if amount.0 == 0 || amount.0 > court {
            fail("INVALID_AMOUNT", "Amount must be more than zero and at most your Court deposit.");
        }
        self.accrue_yield(now);
        self.touch(&id, now);
        let acc = self.acc_per_share;
        let ready_at = now + self.withdraw_cooldown_ms;
        let a = self.account_mut(&id);
        accrue(a, acc);
        a.court -= amount.0;
        rebase(a, acc);
        a.withdraw_pending += amount.0;
        a.withdraw_ready_at = Some(ready_at);
        let left = a.court;
        self.court_total -= amount.0;
        self.pending_total += amount.0;
        // Below the draw minimum the slot goes, with this week's weight, so a $5 join can't hold a
        // slot after withdrawing down to dust.
        if left < DRAW_MIN_COURT {
            self.depositors.remove(&id);
            self.draw_weights.remove(&id);
        }
    }

    /// Sends the pending withdrawal to the player's wallet once the cooldown ends.
    pub fn withdraw(&mut self) -> Promise {
        let id = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let a = self.accounts.get_mut(&id).unwrap_or_else(|| fail("NOTHING_TO_WITHDRAW", "Request a withdrawal first."));
        let Some(ready_at) = a.withdraw_ready_at.filter(|_| a.withdraw_pending > 0) else {
            fail("NOTHING_TO_WITHDRAW", "Request a withdrawal first.")
        };
        if now < ready_at {
            fail("COOLDOWN", "The withdrawal cooldown has not ended.");
        }
        let amount = a.withdraw_pending;
        a.withdraw_pending = 0;
        a.withdraw_ready_at = None;
        self.pending_total -= amount;
        self.pay_out(id, amount, PayoutKind::Withdraw)
    }

    /// Sends the player's game balance, Court earnings and King's stream to their wallet.
    pub fn claim(&mut self) -> Promise {
        let id = env::predecessor_account_id();
        if !self.accounts.contains_key(&id) {
            fail("NOTHING_TO_CLAIM", "Nothing to claim yet.");
        }
        self.accrue_yield(env::block_timestamp_ms());
        let stream = self.streams.remove(&id).unwrap_or(0);
        let acc = self.acc_per_share;
        let a = self.account_mut(&id);
        accrue(a, acc);
        rebase(a, acc);
        let earned = a.earned;
        a.earned = 0;
        a.balance += earned + stream;
        let amount = a.balance;
        if amount == 0 {
            fail("NOTHING_TO_CLAIM", "Nothing to claim yet.");
        }
        a.balance = 0;
        self.rewards_pool -= earned;
        self.streams_total -= stream;
        self.balances_total = self.balances_total + earned + stream - amount;
        self.pay_out(id, amount, PayoutKind::Claim)
    }

    /// Books a payout's outcome: done if the token transfer went through, and the funds back
    /// where they came from if it failed, so nothing is lost. A payout is named by its
    /// `payout_id`. One sent by the M10 code just before an upgrade arrives with the old
    /// arguments instead (`account_id`, `amount`, `kind`); that code had taken the amount off
    /// the books with no record, so it is booked from the arguments, as M10 did.
    #[private]
    pub fn on_payout(
        &mut self,
        payout_id: Option<u64>,
        account_id: Option<AccountId>,
        amount: Option<U128>,
        kind: Option<PayoutKind>,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let paid = result.is_ok();
        match (payout_id, account_id, amount, kind) {
            // No record: the owner already settled it (`resolve_payout`).
            (Some(id), ..) => {
                if let Some(payout) = self.payouts.remove(&id) {
                    self.finish_payout(payout, paid);
                }
            }
            (None, Some(account_id), Some(amount), Some(kind)) => self.book_payout(account_id, amount.0, kind, paid),
            _ => {}
        }
        paid
    }

    /// Settles a payout whose callback never completed (it ran out of NEAR for storage, say, or
    /// the code changed under it), so its amount is still held in `in_flight`. `paid` is whether
    /// the token transfer went through, which that transfer's receipt on chain shows: true
    /// drops the record, false returns the funds to where they came from. The contract can't
    /// check `paid`, so this trusts the owner, for stuck payouts only and only after an hour.
    pub fn resolve_payout(&mut self, payout_id: u64, paid: bool) {
        self.require_owner();
        let started_at = self.payouts.get(&payout_id).map(|p| p.started_at).unwrap_or_else(|| fail("NO_PAYOUT", "No such payout is in flight."));
        if env::block_timestamp_ms() < started_at + PAYOUT_STUCK_MS {
            fail("NOT_READY", "The payout may still complete on its own.");
        }
        let payout = self.payouts.remove(&payout_id).unwrap_or_else(|| fail("NO_PAYOUT", "No such payout is in flight."));
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({ "standard": "rugpool", "version": "0.2.0", "event": "payout_resolved", "data": [{ "payout_id": payout_id, "account_id": payout.account_id, "amount": U128(payout.amount), "paid": paid }] })
        ));
        self.finish_payout(payout, paid);
    }

    // ---- views ----------------------------------------------------------------------

    pub fn get_state(&self) -> StateView {
        let r = &self.round;
        StateView {
            round: RoundView {
                id: r.id,
                challenges: r.challenges,
                next_price: U128(r.next_price),
                king: r.king.clone(),
                king_since: r.king_since,
                started_at: r.started_at,
                jackpot: U128(r.jackpot + self.pending_jackpot(env::block_timestamp_ms())),
                showdown_trigger: U128(self.trigger()),
                showdown_ends_at: r.showdown_ends_at,
                backstop_at: r.started_at + self.timing.backstop_ms,
            },
            court: CourtView {
                total: U128(self.court_total),
                apy_bps_live: if self.yield_reserve > self.yield_due(env::block_timestamp_ms()).paid { self.yield_params.apy_bps * self.yield_params.split_bps[0] / 10_000 } else { 0 },
                next_draw_at: self.next_draw_at(),
                draw_pot: U128(self.draw_pot),
                pending_draw: self.pending_draw.as_ref().map(|p| PendingDrawView { round: p.round, pot: U128(p.pot) }),
            },
            params: ParamsView {
                start_price: U128(START_PRICE),
                step_bps: STEP_BPS,
                split_bps: SPLIT_BPS,
                min_court: U128(MIN_COURT),
                showdown_ms: self.timing.showdown_ms,
                snipe_ms: self.timing.snipe_ms,
                registration_fee: U128(self.registration_fee),
            },
            paused: self.paused,
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let empty = Account::default();
        let a = self.accounts.get(&account_id).unwrap_or(&empty);
        // Odds this epoch. Until any time has passed (a new epoch, a first deposit), the
        // principal share is the best estimate.
        let now = env::block_timestamp_ms();
        let total: u128 = self.depositors.iter().map(|id| self.slot_weight(id, now)).sum();
        let weight = if !self.depositors.contains(&account_id) {
            0
        } else if total > 0 {
            self.weight_at(&account_id, now) * 10_000 / total
        } else if self.court_total > 0 {
            a.court * 10_000 / self.court_total
        } else {
            0
        };
        // Include yield accrued since the last write, so the numbers don't lag.
        let due = self.yield_due(now);
        let acc = if self.court_total > 0 { self.acc_per_share + due.court * PRECISION / self.court_total } else { self.acc_per_share };
        let pending = (a.court * acc / PRECISION).saturating_sub(a.reward_debt);
        let streaming = if self.round.king.as_ref() == Some(&account_id) { due.king } else { 0 };
        AccountView {
            balance: U128(a.balance),
            court: U128(a.court),
            court_earned: U128(a.earned + pending),
            draw_weight_bps: weight as u32,
            king_stream: U128(self.streams.get(&account_id).copied().unwrap_or(0) + streaming),
            auto_defend_max: U128(self.defenders.get(&account_id).copied().unwrap_or(0)),
            withdraw_pending: U128(a.withdraw_pending),
            withdraw_ready_at: a.withdraw_ready_at,
        }
    }

    /// Events newer than `from`, at most the newest `PAGE_MAX`. Pass `cursor` back next time.
    /// The cursor is always the newest id, so a client that is ahead (after a redeploy) resets.
    pub fn get_events(&self, from: u64) -> EventPage {
        let last = self.last_event_id;
        let oldest_kept = last.saturating_sub(EVENT_LOG_MAX) + 1;
        let start = from.saturating_add(1).max(oldest_kept).max(last.saturating_sub(PAGE_MAX) + 1);
        let events = (start..=last).filter_map(|id| self.events.get(&id).cloned()).collect();
        EventPage { events, cursor: last }
    }

    pub fn get_relayers(&self) -> Vec<AccountId> {
        self.relayers.clone()
    }

    /// The id of the newest payout. Ids count up from 1, so the payouts still in flight are
    /// found by walking down from here until their amounts add up to `in_flight`.
    pub fn get_last_payout_id(&self) -> u64 {
        self.last_payout_id
    }

    pub fn get_payout(&self, payout_id: u64) -> Option<PayoutView> {
        self.payouts.get(&payout_id).map(|p| PayoutView { account_id: p.account_id.clone(), amount: U128(p.amount), kind: p.kind, started_at: p.started_at })
    }

    pub fn get_liabilities(&self) -> Liabilities {
        Liabilities {
            balances: U128(self.balances_total),
            court: U128(self.court_total),
            jackpot: U128(self.round.jackpot),
            rewards: U128(self.rewards_pool),
            // A pending draw's pot is still owed, to whoever drand picks.
            draw_pot: U128(self.draw_pot + self.pending_draw.as_ref().map_or(0, |p| p.pot)),
            treasury: U128(self.treasury),
            pending: U128(self.pending_total),
            recovery: U128(self.recovery),
            yield_reserve: U128(self.yield_reserve),
            streams: U128(self.streams_total),
            in_flight: U128(self.in_flight),
        }
    }

    // ---- internals ------------------------------------------------------------------

    /// Pays a ticket, crowns `id`, and applies the showdown rules. Returns the dethroned King.
    fn take_throne(&mut self, id: AccountId, price: u128, now: u64, auto: bool) -> Option<AccountId> {
        let [jackpot, king_share, court_share, protocol] = split_ticket(price);
        self.account_mut(&id).balance -= price;
        self.balances_total -= price;
        self.round.jackpot += jackpot;
        let dethroned = self.round.king.take();
        match &dethroned {
            Some(prev) => {
                self.account_mut(prev).balance += king_share;
                self.balances_total += king_share;
            }
            // The first King of a round has nobody to pay back.
            None => self.round.jackpot += king_share,
        }
        self.pay_court(court_share);
        self.treasury += protocol;

        self.round.king = Some(id.clone());
        self.round.king_since = Some(now);
        self.round.challenges += 1;
        self.round.last_price = price;
        self.round.next_price = next_price(price);
        let kind = match (auto, dethroned.clone()) {
            (true, Some(against)) => EventKind::AutoDefended { by: id, price: U128(price), against },
            _ => EventKind::Challenged { by: id, price: U128(price), dethroned: dethroned.clone() },
        };
        self.emit(kind);

        match self.round.showdown_ends_at {
            None if self.round.jackpot >= self.trigger() => self.start_showdown(ShowdownReason::Size, now),
            Some(end) if end - now < self.timing.snipe_ms => self.round.showdown_ends_at = Some(now + self.timing.snipe_ms),
            _ => {}
        }
        dethroned
    }

    /// Whether a dethroned King's auto-defend retakes at `price`: armed at or above it, able to
    /// pay, and still in the Court with the minimum.
    fn will_retake(&self, king: &AccountId, price: u128) -> bool {
        let (Some(&max), Some(a)) = (self.defenders.get(king), self.accounts.get(king)) else {
            return false;
        };
        price <= max && a.balance >= price && a.court >= MIN_COURT
    }

    /// Yield due since the last accrual, capped by the reserve and split three ways. With no
    /// King, the King's share goes to the Jackpot.
    fn yield_due(&self, now: u64) -> YieldDue {
        let ms = now.saturating_sub(self.yield_last) as u128;
        let scaled = self.court_total * self.yield_params.apy_bps as u128 * ms + self.yield_carry;
        let due = scaled / (10_000 * YEAR_MS);
        // An emptied reserve owes nothing more, so nothing carries.
        let (paid, carry) = if due > self.yield_reserve { (self.yield_reserve, 0) } else { (due, scaled % (10_000 * YEAR_MS)) };
        let [c, s, _] = self.yield_params.split_bps.map(|b| b as u128);
        let (court, seed) = (paid * c / 10_000, paid * s / 10_000);
        YieldDue { paid, court, seed, king: paid - court - seed, carry }
    }

    /// Yield due to the Jackpot right now (its seed share, plus the King's share when there's
    /// no King), for views.
    fn pending_jackpot(&self, now: u64) -> u128 {
        let due = self.yield_due(now);
        due.seed + if self.round.king.is_none() { due.king } else { 0 }
    }

    /// Pays the yield due out of the reserve. Call before anything that changes the Court
    /// total or the King.
    fn accrue_yield(&mut self, now: u64) {
        let due = self.yield_due(now);
        self.yield_last = now;
        self.yield_carry = due.carry;
        if due.paid == 0 {
            return;
        }
        self.yield_reserve -= due.paid;
        // `yield_due` is 0 with an empty Court, so the division is safe.
        self.acc_per_share += due.court * PRECISION / self.court_total;
        self.rewards_pool += due.court;
        self.round.jackpot += due.seed;
        match self.round.king.clone() {
            Some(king) => match self.streams.get(&king).copied() {
                // A first stream entry is new storage. While the buffer is short the King's
                // share goes to his game balance, which he claims together with the stream.
                None if !self.has_storage_buffer() => match self.accounts.get_mut(&king) {
                    Some(a) => {
                        a.balance += due.king;
                        self.balances_total += due.king;
                    }
                    None => self.round.jackpot += due.king,
                },
                s => {
                    self.streams.insert(king, s.unwrap_or(0) + due.king);
                    self.streams_total += due.king;
                }
            },
            None => self.round.jackpot += due.king,
        }
        // Yield can carry the Jackpot over the size trigger between challenges.
        if self.size_trigger_reached() {
            self.start_showdown(ShowdownReason::Size, now);
        }
    }

    /// Deletes an account with nothing left in it, so its storage is freed. The King's account
    /// is kept: the Jackpot may still be paid into it.
    fn forget_if_empty(&mut self, id: &AccountId) {
        if self.round.king.as_ref() == Some(id) || self.streams.get(id).is_some_and(|s| *s > 0) {
            return;
        }
        let Some(a) = self.accounts.get(id) else { return };
        if a.balance != 0 || a.court != 0 || a.withdraw_pending != 0 || a.earned != 0 {
            return;
        }
        self.accounts.remove(id);
        self.defenders.remove(id);
        self.draw_weights.remove(id);
        self.depositors.remove(id);
        self.streams.remove(id);
    }

    fn require_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            fail("NOT_OWNER", "Only the owner can do this.");
        }
    }

    fn require_unpaused(&self) {
        if self.paused {
            fail("PAUSED", "The game is paused. Claims and withdrawals still work.");
        }
    }

    /// For calls that grow storage: also refused while the storage buffer is short.
    fn require_live(&self) {
        self.require_unpaused();
        if !self.has_storage_buffer() {
            fail("PAUSED", "The game is paused until its storage is topped up. Claims and withdrawals still work.");
        }
    }

    /// Session keys can't pay for a transaction (their allowance is 1 yoctoNEAR), so they only
    /// work relayed (NEP-366), where the call's signer is whoever relayed it. Anyone can relay a
    /// signed delegate action, so a thief holding a stolen session key could relay it past the
    /// relayer's expiry and revocation checks, and spend the player's balance buying the thief's
    /// throne. Calls that spend, lock or delay the player's money (challenge, set_auto_defend,
    /// join_court, and request_withdraw, which restarts the cooldown of everything pending) must
    /// therefore arrive from the game's relayers if relayed. Paying out what is already due
    /// (withdraw, claim) stays open to any relayer: it only ever moves the player's money to the
    /// player, so it works even if the game's relayer is down.
    fn require_trusted_relay(&self) {
        let signer = env::signer_account_id();
        if signer != env::predecessor_account_id() && !self.relayers.contains(&signer) {
            fail("UNTRUSTED_RELAYER", "Play through the RugPool app.");
        }
    }

    fn next_draw_at(&self) -> u64 {
        self.draw_epoch_start + self.limits.draw_every_ms
    }

    /// Pays the pending draw's pot to the entry `randomness` lands on. The winner may have
    /// emptied their account since the close (and had it deleted); the pot is theirs anyway.
    fn pay_draw(&mut self, randomness: [u8; 32]) {
        let PendingDraw { pot, total, .. } = self.pending_draw.take().unwrap_or_else(|| fail("NO_DRAW", "No draw is waiting for drand."));
        // total is far below 2^128 (all the USDC there is × a week of ms is ~2^86), so the
        // modulo bias is negligible.
        let mut point = u128::from_le_bytes(randomness[..16].try_into().unwrap()) % total;
        let entries = self.draw_entries.take().unwrap_or_default();
        let winner = entries
            .into_iter()
            .find(|(_, w)| {
                let hit = point < *w;
                point = point.saturating_sub(*w);
                hit
            })
            .map(|(id, _)| id)
            .unwrap_or_else(|| fail("DRAW", "No winner found."));
        if !self.accounts.contains_key(&winner) {
            self.accounts.insert(winner.clone(), Account::default());
        }
        self.account_mut(&winner).balance += pot;
        self.balances_total += pot;
        self.emit(EventKind::DrawWon { by: winner, amount: U128(pot) });
    }

    /// Draw weight this epoch up to `now`: principal × milliseconds. An account last touched
    /// in an earlier epoch counts from the epoch's start. Weight counts only while the account
    /// holds a draw slot: dropping below `DRAW_MIN_COURT` forfeits this epoch's weight, and a
    /// new slot starts from zero.
    fn weight_at(&self, id: &AccountId, now: u64) -> u128 {
        if !self.depositors.contains(id) {
            return 0;
        }
        self.slot_weight(id, now)
    }

    /// `weight_at` for an account known to hold a draw slot: walks of `depositors` skip the
    /// membership read, one of the few storage reads each depositor costs.
    fn slot_weight(&self, id: &AccountId, now: u64) -> u128 {
        let court = self.accounts.get(id).map_or(0, |a| a.court);
        if court == 0 {
            return 0;
        }
        match self.draw_weights.get(id) {
            Some(w) if w.epoch == self.draw_epoch => w.acc + court * now.saturating_sub(w.last_touch) as u128,
            _ => court * now.saturating_sub(self.draw_epoch_start) as u128,
        }
    }

    /// Banks the weight earned so far. Call before every change to an account's Court principal.
    /// Accounts without a draw slot earn no weight, so there's nothing to bank.
    fn touch(&mut self, id: &AccountId, now: u64) {
        if !self.depositors.contains(id) {
            return;
        }
        let acc = self.weight_at(id, now);
        self.draw_weights.insert(id.clone(), DrawWeight { acc, last_touch: now, epoch: self.draw_epoch });
    }

    fn held(&self) -> u128 {
        self.balances_total + self.court_total + self.pending_total
    }

    fn trigger(&self) -> u128 {
        match self.timing.trigger_fixed {
            Some(fixed) => fixed.0,
            None => self.court_total * self.timing.trigger_bps as u128 / 10_000,
        }
    }

    fn poke_at(&mut self, now: u64) {
        if self.round.showdown_ends_at.is_some() {
            return;
        }
        if now >= self.round.started_at + self.timing.backstop_ms {
            self.start_showdown(ShowdownReason::Time, now);
        } else if self.size_trigger_reached() {
            // The trigger can also come down to the Jackpot: Court withdrawals lower it.
            self.start_showdown(ShowdownReason::Size, now);
        }
    }

    /// Whether the Jackpot has reached the size trigger with no showdown started. Only with a
    /// King: an empty throne waits for its first challenge, as a carried-over Jackpot does.
    /// Not while paused: claims still accrue yield then, and nobody could answer a showdown.
    fn size_trigger_reached(&self) -> bool {
        !self.paused && self.round.king.is_some() && self.round.showdown_ends_at.is_none() && self.round.jackpot >= self.trigger()
    }

    fn start_showdown(&mut self, reason: ShowdownReason, now: u64) {
        let ends_at = now + self.timing.showdown_ms;
        self.round.showdown_ends_at = Some(ends_at);
        self.emit(EventKind::ShowdownStarted { reason, ends_at });
    }

    fn account_mut(&mut self, id: &AccountId) -> &mut Account {
        self.accounts.get_mut(id).unwrap_or_else(|| fail("INSUFFICIENT_BALANCE", "Deposit USDC first."))
    }

    fn do_join(&mut self, id: &AccountId, amount: u128) {
        let now = env::block_timestamp_ms();
        self.accrue_yield(now);
        self.touch(id, now);
        let acc = self.acc_per_share;
        let a = self.account_mut(id);
        accrue(a, acc);
        a.balance -= amount;
        a.court += amount;
        rebase(a, acc);
        if a.court >= DRAW_MIN_COURT && !self.depositors.contains(id) {
            // Weight starts when the slot does; time under the minimum never counts.
            self.depositors.insert(id.clone());
            self.draw_weights.insert(id.clone(), DrawWeight { acc: 0, last_touch: now, epoch: self.draw_epoch });
        }
        self.balances_total -= amount;
        self.court_total += amount;
        self.emit(EventKind::CourtJoin { by: id.clone(), amount: U128(amount) });
    }

    /// Splits the Court's ticket cut between depositors' rewards and the draw pot. Depositors'
    /// share is floored, so the odd micro goes to the draw pot.
    fn pay_court(&mut self, amount: u128) {
        let to_rewards = amount * (10_000 - self.court_draw_bps as u128) / 10_000;
        let to_draw = amount - to_rewards;
        self.draw_pot += to_draw;
        if self.court_total == 0 {
            self.draw_pot += to_rewards;
            return;
        }
        self.acc_per_share += to_rewards * PRECISION / self.court_total;
        self.rewards_pool += to_rewards;
    }

    fn pay_out(&mut self, id: AccountId, amount: u128, kind: PayoutKind) -> Promise {
        self.last_payout_id += 1;
        let payout_id = self.last_payout_id;
        self.payouts.insert(payout_id, Payout { account_id: id.clone(), amount, kind, started_at: env::block_timestamp_ms() });
        self.in_flight += amount;
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(id, U128(amount), Some("RugPool payout".to_string()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).on_payout(Some(payout_id), None, None, None))
    }

    fn finish_payout(&mut self, payout: Payout, paid: bool) {
        self.in_flight -= payout.amount;
        self.book_payout(payout.account_id, payout.amount, payout.kind, paid);
    }

    fn book_payout(&mut self, account_id: AccountId, amount: u128, kind: PayoutKind, paid: bool) {
        if paid {
            match kind {
                PayoutKind::Withdraw => {
                    self.emit(EventKind::Withdraw { by: account_id.clone(), amount: U128(amount) });
                    self.forget_if_empty(&account_id);
                }
                PayoutKind::Claim => self.forget_if_empty(&account_id),
                _ => {}
            }
            return;
        }
        let now = env::block_timestamp_ms();
        match kind {
            // The account may have been deleted since, by another payout of the same account
            // that succeeded first; re-create it rather than lose the refund from the books.
            PayoutKind::Withdraw => {
                let a = self.accounts.entry(account_id).or_default();
                a.withdraw_pending += amount;
                // Back to pending, withdrawable at once. If a newer request is waiting out its
                // cooldown, the returned amount waits with it rather than unlocking it early.
                a.withdraw_ready_at = Some(a.withdraw_ready_at.unwrap_or(now));
                self.pending_total += amount;
            }
            PayoutKind::Claim => {
                self.accounts.entry(account_id).or_default().balance += amount;
                self.balances_total += amount;
            }
            PayoutKind::Recovery => self.recovery += amount,
            PayoutKind::Treasury => self.treasury += amount,
            PayoutKind::Reserve => self.yield_reserve += amount,
        }
    }

    fn emit(&mut self, kind: EventKind) {
        let id = self.last_event_id + 1;
        let event = Event { id, at: env::block_timestamp_ms(), kind };
        let data = serde_json::to_value(&event).unwrap_or_default();
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({ "standard": "rugpool", "version": "0.2.0", "event": data["type"], "data": [data["data"]] })
        ));
        // The stored log feeds the app. A new event can be longer than the one it replaces, so
        // while the storage buffer is short the log isn't added to; the chain's logs have it.
        if !self.has_storage_buffer() {
            return;
        }
        self.last_event_id = id;
        self.events.insert(id, event);
        if id > EVENT_LOG_MAX {
            self.events.remove(&(id - EVENT_LOG_MAX));
        }
    }
}

impl Round {
    fn open(id: u64, now: u64, jackpot: u128) -> Self {
        Self {
            id,
            challenges: 0,
            next_price: START_PRICE,
            last_price: 0,
            king: None,
            king_since: None,
            started_at: now,
            jackpot,
            showdown_ends_at: None,
        }
    }
}

/// The M10 state layout (`pool2` today), read once by `migrate`.
#[near(serializers = [borsh])]
pub struct ContractV10 {
    token: AccountId,
    withdraw_cooldown_ms: u64,
    court_draw_bps: u32,
    timing: Timing,
    owner: AccountId,
    intents: Option<AccountId>,
    paused: bool,
    limits: Limits,
    accounts: LookupMap<AccountId, Account>,
    balances_total: u128,
    court_total: u128,
    acc_per_share: u128,
    rewards_pool: u128,
    draw_pot: u128,
    treasury: u128,
    round: Round,
    events: LookupMap<u64, Event>,
    last_event_id: u64,
    defenders: LookupMap<AccountId, u128>,
    pending_total: u128,
    recovery: u128,
    draw_epoch: u64,
    draw_epoch_start: u64,
    depositors: IterableSet<AccountId>,
    draw_weights: LookupMap<AccountId, DrawWeight>,
    yield_params: YieldParams,
    yield_reserve: u128,
    yield_last: u64,
    yield_carry: u128,
    streams: LookupMap<AccountId, u128>,
    streams_total: u128,
    registration_fee: u128,
    pending_draw: Option<PendingDraw>,
    last_buy_block: Option<u64>,
    draw_entries: LazyOption<Vec<(AccountId, u128)>>,
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Credits the beneficiary's game balance, then joins the Court if asked. Panicking here
    /// makes the token refund the sender, which is right for direct deposits. Deliveries from
    /// NEAR Intents can't be refunded, so they take `credit_intents` and never panic.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token {
            fail("WRONG_TOKEN", "Only the configured USDC token is accepted.");
        }
        if self.intents.as_ref() == Some(&sender_id) {
            if self.has_storage_buffer() {
                self.credit_intents(amount.0, &msg);
            } else {
                // Crediting writes new storage (an account, a draw slot, a stream, events), and
                // running out of NEAR for it would fail the call and lose the funds. Holding the
                // amount changes one stored number and adds nothing, so there is no event either.
                self.recovery += amount.0;
            }
            return PromiseOrValue::Value(U128(0));
        }
        if amount.0 < MIN_DEPOSIT {
            fail("INVALID_AMOUNT", "Deposit at least 1 USDC.");
        }
        let parsed = if msg.is_empty() {
            DepositMsg { action: DepositAction::Balance, beneficiary: None }
        } else {
            serde_json::from_str(&msg).unwrap_or_else(|_| fail("INVALID_MSG", "Unrecognized deposit message."))
        };
        if parsed.action == DepositAction::FundYield {
            self.accrue_yield(env::block_timestamp_ms());
            self.yield_reserve += amount.0;
            return PromiseOrValue::Value(U128(0));
        }
        // Funding the reserve stays open while paused; only play stops.
        self.require_live();
        let id = parsed.beneficiary.unwrap_or(sender_id);
        let mine = self.accounts.get(&id).map_or(0, |a| a.balance + a.court + a.withdraw_pending);
        if mine + amount.0 > self.limits.max_account.0 || self.held() + amount.0 > self.limits.max_total.0 {
            fail("CAP_REACHED", "This deposit would go over the deposit cap.");
        }
        if parsed.action == DepositAction::Join {
            self.require_room_in_court(&id, self.net_of_fee(&id, amount.0));
        }
        self.credit(&id, amount.0, parsed.action == DepositAction::Join);
        PromiseOrValue::Value(U128(0))
    }
}

impl Contract {
    /// Credits a deposit. A new account's first deposit keeps the registration fee for the
    /// treasury, toward the account's storage.
    fn credit(&mut self, id: &AccountId, amount: u128, join: bool) {
        let mut amount = amount;
        if !self.accounts.contains_key(id) {
            self.accounts.insert(id.clone(), Account::default());
            let fee = self.registration_fee.min(amount);
            self.treasury += fee;
            amount -= fee;
        }
        self.account_mut(id).balance += amount;
        self.balances_total += amount;
        if join && amount > 0 {
            self.do_join(id, amount);
        }
    }

    /// An Intents delivery: credited to the beneficiary named in the msg whatever the cap or
    /// the pause. It joins the Court only while the game is live and the Court has room. It is
    /// held in `recovery` for the owner to return when there's no usable beneficiary or when it's
    /// dust (so nobody can mint accounts for free). The caller has checked `has_storage_buffer`.
    fn credit_intents(&mut self, amount: u128, msg: &str) {
        let parsed = serde_json::from_str::<DepositMsg>(msg).ok();
        if parsed.as_ref().is_some_and(|m| m.action == DepositAction::FundYield) {
            self.accrue_yield(env::block_timestamp_ms());
            self.yield_reserve += amount;
            return;
        }
        let target = parsed.and_then(|m| m.beneficiary.map(|b| (b, m.action)));
        match target {
            Some((id, action)) if amount >= MIN_DEPOSIT => {
                let join = action == DepositAction::Join && !self.paused && self.court_has_room(&id, self.net_of_fee(&id, amount));
                self.credit(&id, amount, join);
            }
            _ => {
                self.recovery += amount;
                self.emit(EventKind::DepositHeld { amount: U128(amount) });
            }
        }
    }

    /// Whether `joining` more can go into the Court. Only a Court of at least `DRAW_MIN_COURT`
    /// takes a draw slot, so joins that stay below it always fit.
    fn court_has_room(&self, id: &AccountId, joining: u128) -> bool {
        let court = self.accounts.get(id).map_or(0, |a| a.court);
        self.depositors.contains(id) || court + joining < DRAW_MIN_COURT || self.depositors.len() < MAX_DEPOSITORS
    }

    fn require_room_in_court(&self, id: &AccountId, joining: u128) {
        if !self.court_has_room(id, joining) {
            fail("COURT_FULL", "The draw is full. Join with less than $5, or try again after the next draw.");
        }
    }

    /// What a deposit credits once a new account's registration fee is taken.
    fn net_of_fee(&self, id: &AccountId, amount: u128) -> u128 {
        if self.accounts.contains_key(id) { amount } else { amount - self.registration_fee.min(amount) }
    }

    /// Whether the contract's NEAR covers its storage, `STORAGE_BUFFER_BYTES` and
    /// `ROOT_GROWTH_BYTES`.
    fn has_storage_buffer(&self) -> bool {
        self.has_storage_for(0)
    }

    /// Whether the contract could store `bytes` more and still have its buffer.
    fn has_storage_for(&self, bytes: u64) -> bool {
        let needed = env::storage_byte_cost().saturating_mul((env::storage_usage() + STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES + bytes) as u128);
        env::account_balance() >= needed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    const USDC: u128 = 1_000_000;
    /// `priceAt(k, 5_000_000, 300)` for k = 0..=30, computed by the app's `src/game/curve.ts`.
    const CURVE_TS: [u128; 31] = [
        5000000, 5150000, 5304500, 5463635, 5627544, 5796370, 5970261, 6149368, 6333849, 6523864, 6719579,
        6921166, 7128800, 7342664, 7562943, 7789831, 8023525, 8264230, 8512156, 8767520, 9030545, 9301461,
        9580504, 9867919, 10163956, 10468874, 10782940, 11106428, 11439620, 11782808, 12136292,
    ];

    fn token() -> AccountId {
        "usdc.test".parse().unwrap()
    }

    /// A direct call: the account both signs and calls.
    fn ctx(predecessor: AccountId, ms: u64) {
        testing_env!(
            VMContextBuilder::new()
                .signer_account_id(predecessor.clone())
                .predecessor_account_id(predecessor)
                .block_timestamp(ms * 1_000_000)
                .build()
        );
    }

    fn setup() -> Contract {
        ctx(accounts(0), 1_000);
        Contract::new(token(), 60_000, 5_000, None, None, Some(intents()), None, None, None, None)
    }

    fn deposit(c: &mut Contract, who: AccountId, amount: u128, msg: &str) {
        ctx(token(), 2_000);
        let _ = c.ft_on_transfer(who, U128(amount), msg.into());
    }

    /// A Court member with `court` joined and `balance` left to play with.
    fn player(c: &mut Contract, who: AccountId, court: u128, balance: u128) {
        deposit(c, who.clone(), court, r#"{"action":"join"}"#);
        if balance > 0 {
            deposit(c, who, balance, "");
        }
    }

    fn challenge(c: &mut Contract, who: AccountId) {
        challenge_at(c, who, 3_000);
    }

    fn liabilities(c: &Contract) -> u128 {
        let l = c.get_liabilities();
        l.balances.0 + l.court.0 + l.jackpot.0 + l.rewards.0 + l.draw_pot.0 + l.treasury.0 + l.pending.0 + l.recovery.0 + l.yield_reserve.0 + l.streams.0
    }

    fn intents() -> AccountId {
        "intents.test".parse().unwrap()
    }

    /// The token's answer to the in-flight payout of `amount` to `who`.
    fn answer(c: &mut Contract, who: AccountId, amount: u128, kind: PayoutKind, paid: bool) -> bool {
        let id = (1..=c.last_payout_id)
            .find(|id| c.payouts.get(id).is_some_and(|p| p.account_id == who && p.amount == amount && p.kind as u8 == kind as u8))
            .expect("no such payout in flight");
        c.on_payout(Some(id), None, None, None, if paid { Ok(()) } else { Err(PromiseError::Failed) })
    }

    /// A delivery relayed by NEAR Intents: the token calls in with Intents as the sender.
    fn deliver(c: &mut Contract, amount: u128, msg: &str) {
        ctx(token(), 2_000);
        let _ = c.ft_on_transfer(intents(), U128(amount), msg.into());
    }

    #[test]
    fn price_curve_matches_curve_ts() {
        let mut p = START_PRICE;
        for (k, expected) in CURVE_TS.iter().enumerate() {
            assert_eq!(p, *expected, "challenge {k}");
            p = next_price(p);
        }
    }

    #[test]
    fn split_sums_to_price_and_matches_split_ticket() {
        assert_eq!(split_ticket(5_000_000), [2_750_000, 1_250_000, 750_000, 250_000]);
        assert_eq!(split_ticket(8_264_000), [4_545_200, 2_066_000, 1_239_600, 413_200]);
        assert_eq!(split_ticket(7), [5, 1, 1, 0]);
        for p in CURVE_TS.iter().copied().chain([1, 3, 9_999, 123_456_789]) {
            assert_eq!(split_ticket(p).iter().sum::<u128>(), p);
        }
    }

    #[test]
    fn challenge_splits_the_ticket_and_credits_the_dethroned_king() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 20 * USDC);
        let total = liabilities(&c);

        challenge(&mut c, accounts(1));
        // First King: the King share goes to the Jackpot.
        assert_eq!(c.round.jackpot, 2_750_000 + 1_250_000);
        assert_eq!(c.get_account(accounts(1)).balance.0, 15 * USDC);

        challenge(&mut c, accounts(2));
        assert_eq!(c.get_account(accounts(1)).balance.0, 15 * USDC + 1_287_500, "25% of 5.15");
        assert_eq!(c.round.king, Some(accounts(2)));
        assert_eq!(c.round.challenges, 2);
        assert_eq!(c.round.next_price, 5_304_500);
        assert_eq!(c.treasury, 250_000 + 257_500);
        assert_eq!(c.draw_pot, 375_000 + 386_250);
        assert_eq!(liabilities(&c), total, "a challenge only moves money between buckets");

        let page = c.get_events(0);
        let last = serde_json::to_value(page.events.last().unwrap()).unwrap();
        assert_eq!(last["type"], "challenged");
        assert_eq!(last["data"], json!({ "by": accounts(2), "price": "5150000", "dethroned": accounts(1) }));
    }

    #[test]
    fn court_rewards_follow_principal() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 90 * USDC, 0);
        challenge(&mut c, accounts(1));
        // 15% of 5.00 = 0.75, half to depositors = 0.375, split 30:90.
        assert_eq!(c.get_account(accounts(1)).court_earned.0, 93_750);
        assert_eq!(c.get_account(accounts(2)).court_earned.0, 281_250);

        // A late joiner earns nothing from earlier tickets.
        player(&mut c, accounts(3), 30 * USDC, 0);
        assert_eq!(c.get_account(accounts(3)).court_earned.0, 0);
        // Joining more does not change what was already earned.
        deposit(&mut c, accounts(2), 30 * USDC, r#"{"action":"join"}"#);
        assert_eq!(c.get_account(accounts(2)).court_earned.0, 281_250);
    }

    #[test]
    fn rewards_never_exceed_the_pool() {
        let mut c = setup();
        // Odd principals so every accrual rounds.
        player(&mut c, accounts(1), 33_333_333, 200 * USDC);
        player(&mut c, accounts(2), 27_777_777, 200 * USDC);
        player(&mut c, accounts(3), 41_111_111, 0);
        for i in 0..20 {
            challenge(&mut c, accounts(1 + i % 2));
            if i == 7 {
                deposit(&mut c, accounts(3), 3_333_333, r#"{"action":"join"}"#);
            }
        }
        let owed: u128 = (1..=3).map(|i| c.get_account(accounts(i)).court_earned.0).sum();
        assert!(owed <= c.rewards_pool, "owed {owed} > pool {}", c.rewards_pool);
        assert!(c.rewards_pool - owed <= 30, "dust stays tiny");
    }

    #[test]
    fn rounding_up_the_debt_keeps_rewards_solvent() {
        let mut c = setup();
        // Each member's share sits at x.9 micro-USDC when they join, so a floored debt would
        // let every one of them claim a whole unit from a 1-unit reward.
        c.acc_per_share = 900_000_000_000;
        for i in 1..=5 {
            deposit(&mut c, accounts(i), MIN_DEPOSIT, r#"{"action":"join"}"#);
        }
        c.pay_court(2);
        let owed: u128 = (1..=5).map(|i| c.get_account(accounts(i)).court_earned.0).sum();
        assert!(owed <= c.rewards_pool, "owed {owed} > pool {}", c.rewards_pool);
    }

    #[test]
    #[should_panic(expected = "COURT_TOO_SMALL")]
    fn challenge_needs_the_court_minimum() {
        let mut c = setup();
        player(&mut c, accounts(1), 24 * USDC, 10 * USDC);
        challenge(&mut c, accounts(1));
    }

    #[test]
    #[should_panic(expected = "ALREADY_KING")]
    fn king_cannot_challenge_himself() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        challenge(&mut c, accounts(1));
        challenge(&mut c, accounts(1));
    }

    #[test]
    #[should_panic(expected = "PRICE_MOVED")]
    fn challenge_respects_max_price() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        ctx(accounts(1), 3_000);
        c.challenge(U128(START_PRICE - 1));
    }

    #[test]
    #[should_panic(expected = "INSUFFICIENT_BALANCE")]
    fn challenge_needs_the_ticket_in_the_balance() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 4 * USDC);
        challenge(&mut c, accounts(1));
    }

    fn challenge_in_block(c: &mut Contract, who: AccountId, block: u64) {
        testing_env!(VMContextBuilder::new().signer_account_id(who.clone()).predecessor_account_id(who).block_timestamp(3_000_000_000).block_height(block).build());
        let price = c.round.next_price;
        c.challenge(U128(price));
    }

    #[test]
    #[should_panic(expected = "BUY_LOCKED")]
    fn nobody_buys_in_the_block_after_a_buy() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        challenge_in_block(&mut c, accounts(1), 10);
        challenge_in_block(&mut c, accounts(2), 11);
    }

    #[test]
    #[should_panic(expected = "BUY_LOCKED")]
    fn only_one_buy_lands_per_block() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        challenge_in_block(&mut c, accounts(1), 10);
        challenge_in_block(&mut c, accounts(2), 10);
    }

    #[test]
    fn the_block_after_next_is_open_again() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        challenge_in_block(&mut c, accounts(1), 10);
        challenge_in_block(&mut c, accounts(2), 12);
        assert_eq!(c.round.king, Some(accounts(2)));
        assert_eq!(c.last_buy_block, Some(12));
    }

    #[test]
    fn auto_defend_retakes_ignore_the_buy_lock() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        challenge_in_block(&mut c, accounts(1), 10);
        ctx(accounts(1), 3_000);
        c.set_auto_defend(U128(6 * USDC));
        // accounts(2) takes the throne in block 12; accounts(1) retakes in the same call.
        challenge_in_block(&mut c, accounts(2), 12);
        assert_eq!(c.round.king, Some(accounts(1)));
        assert!(event_types(&c).contains(&"auto_defended".to_string()));
        assert_eq!(c.last_buy_block, Some(12), "the lock runs from the war's block");
    }

    #[test]
    fn claim_pays_balance_plus_earnings() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 20 * USDC);
        challenge(&mut c, accounts(1));
        challenge(&mut c, accounts(2));
        let a = c.get_account(accounts(1));
        let expected = a.balance.0 + a.court_earned.0;
        let before = liabilities(&c);
        ctx(accounts(1), 4_000);
        let _ = c.claim();
        assert_eq!(liabilities(&c), before - expected, "exactly the claim leaves");
        let a = c.get_account(accounts(1));
        assert_eq!((a.balance.0, a.court_earned.0), (0, 0));
    }

    /// Demo timings: $8 fixed trigger, 5 min backstop, 90s showdown, 15s snipe window.
    fn setup_timed() -> Contract {
        ctx(accounts(0), 1_000);
        let timing = Timing { trigger_bps: 20, trigger_fixed: Some(U128(8 * USDC)), backstop_ms: 300_000, showdown_ms: 90_000, snipe_ms: 15_000 };
        Contract::new(token(), 60_000, 5_000, Some(timing), None, None, None, None, None, None)
    }

    /// Challenges in the first block past the buy lock.
    fn challenge_at(c: &mut Contract, who: AccountId, ms: u64) {
        let block = c.last_buy_block.map_or(0, |b| b + BUY_LOCK_BLOCKS + 1);
        testing_env!(VMContextBuilder::new().signer_account_id(who.clone()).predecessor_account_id(who).block_timestamp(ms * 1_000_000).block_height(block).build());
        let price = c.round.next_price;
        c.challenge(U128(price));
    }

    fn event_types(c: &Contract) -> Vec<String> {
        c.get_events(0).events.iter().map(|e| serde_json::to_value(e).unwrap()["type"].as_str().unwrap().to_string()).collect()
    }

    /// Three tickets (5.00, 5.15, 5.3045) put 9.749975 in the Jackpot, past the $8 trigger.
    fn into_showdown() -> Contract {
        let mut c = setup_timed();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        challenge_at(&mut c, accounts(1), 3_000);
        challenge_at(&mut c, accounts(2), 4_000);
        assert_eq!(c.round.showdown_ends_at, None, "6.8325 is under the trigger");
        challenge_at(&mut c, accounts(1), 5_000);
        c
    }

    #[test]
    fn jackpot_reaching_the_trigger_starts_the_showdown() {
        let c = into_showdown();
        assert_eq!(c.round.jackpot, 9_749_975);
        assert_eq!(c.round.showdown_ends_at, Some(95_000));
        let last = serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap();
        assert_eq!(last["type"], "showdown_started");
        assert_eq!(last["data"], json!({ "reason": "size", "ends_at": 95_000 }));
        assert_eq!(c.get_state().round.showdown_ends_at, Some(95_000));
    }

    #[test]
    fn a_late_challenge_extends_the_showdown() {
        let mut c = into_showdown();
        challenge_at(&mut c, accounts(2), 50_000);
        assert_eq!(c.round.showdown_ends_at, Some(95_000), "45s left is outside the snipe window");
        challenge_at(&mut c, accounts(1), 80_000);
        assert_eq!(c.round.showdown_ends_at, Some(95_000), "exactly 15s left does not extend");
        challenge_at(&mut c, accounts(2), 85_000);
        assert_eq!(c.round.showdown_ends_at, Some(100_000), "10s left resets the clock to 15s");
    }

    #[test]
    #[should_panic(expected = "ROUND_CLOSED")]
    fn challenges_stop_when_the_clock_hits_zero() {
        let mut c = into_showdown();
        challenge_at(&mut c, accounts(2), 95_000);
    }

    #[test]
    #[should_panic(expected = "NOT_READY")]
    fn settle_waits_for_the_end() {
        let mut c = into_showdown();
        ctx(accounts(3), 94_999);
        c.settle_round();
    }

    #[test]
    fn settle_pays_the_jackpot_to_the_king_and_opens_the_next_round() {
        let mut c = into_showdown();
        let before = c.get_account(accounts(1)).balance.0;
        let total = liabilities(&c);
        ctx(accounts(3), 95_000);
        c.settle_round();
        assert_eq!(c.get_account(accounts(1)).balance.0, before + 9_749_975);
        assert_eq!(liabilities(&c), total, "the Jackpot moves into a balance");
        let s = c.get_state();
        assert_eq!((s.round.id, s.round.challenges, s.round.next_price.0, s.round.jackpot.0), (2, 0, START_PRICE, 0));
        assert_eq!((s.round.king, s.round.showdown_ends_at, s.round.started_at), (None, None, 95_000));
        let last = serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap();
        // 9.749975 / 5.3045 = 1.838x, shown as 1.84.
        assert_eq!(last["data"], json!({ "winner": accounts(1), "jackpot": "9749975", "multiple": 1.84 }));
        // The new round plays at the start price again.
        challenge_at(&mut c, accounts(2), 96_000);
        assert_eq!(c.round.last_price, START_PRICE);
    }

    #[test]
    fn an_empty_round_times_out_and_settles_with_no_winner() {
        let mut c = setup_timed();
        ctx(accounts(3), 300_999);
        c.poke();
        assert_eq!(c.round.showdown_ends_at, None, "1s short of the backstop");
        ctx(accounts(3), 301_000);
        c.poke();
        assert_eq!(c.round.showdown_ends_at, Some(391_000));
        ctx(accounts(3), 391_000);
        c.settle_round();
        assert_eq!(event_types(&c), ["showdown_started", "round_settled"]);
        let last = serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap();
        assert_eq!(last["data"], json!({ "winner": null, "jackpot": "0", "multiple": 0.0 }));
        assert_eq!(c.get_state().round.id, 2);
    }

    #[test]
    fn the_backstop_also_fires_from_a_challenge() {
        let mut c = setup_timed();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        challenge_at(&mut c, accounts(1), 301_000);
        assert_eq!(c.round.showdown_ends_at, Some(391_000));
        assert_eq!(event_types(&c)[1..], ["showdown_started", "challenged"]);
    }

    /// Writes the current state in the M10 layout, as `pool2` holds it before the upgrade.
    fn as_m10(c: Contract) {
        let mut c = c;
        c.accounts.flush();
        c.events.flush();
        c.defenders.flush();
        c.depositors.flush();
        c.draw_weights.flush();
        c.streams.flush();
        c.draw_entries.flush();
        let old = ContractV10 {
            token: c.token.clone(),
            withdraw_cooldown_ms: c.withdraw_cooldown_ms,
            court_draw_bps: c.court_draw_bps,
            timing: c.timing.clone(),
            owner: c.owner.clone(),
            intents: c.intents.clone(),
            paused: c.paused,
            limits: c.limits.clone(),
            accounts: c.accounts,
            balances_total: c.balances_total,
            court_total: c.court_total,
            acc_per_share: c.acc_per_share,
            rewards_pool: c.rewards_pool,
            draw_pot: c.draw_pot,
            treasury: c.treasury,
            round: c.round,
            events: c.events,
            last_event_id: c.last_event_id,
            defenders: c.defenders,
            pending_total: c.pending_total,
            recovery: c.recovery,
            draw_epoch: c.draw_epoch,
            draw_epoch_start: c.draw_epoch_start,
            depositors: c.depositors,
            draw_weights: c.draw_weights,
            yield_params: c.yield_params,
            yield_reserve: c.yield_reserve,
            yield_last: c.yield_last,
            yield_carry: c.yield_carry,
            streams: c.streams,
            streams_total: c.streams_total,
            registration_fee: c.registration_fee,
            pending_draw: c.pending_draw,
            last_buy_block: c.last_buy_block,
            draw_entries: c.draw_entries,
        };
        env::state_write(&old);
    }

    #[test]
    fn migrate_keeps_m10_state() {
        let mut c = into_showdown();
        c.registration_fee = 50_000;
        fund(&mut c, 100 * USDC);
        arm(&mut c, accounts(1), 9 * USDC);
        ctx(accounts(2), 6_000);
        c.request_withdraw(U128(5 * USDC));
        let a1 = serde_json::to_value(c.get_account(accounts(1))).unwrap();
        let a2 = serde_json::to_value(c.get_account(accounts(2))).unwrap();
        let total = liabilities(&c);
        let state = serde_json::to_value(c.get_state()).unwrap();
        let events = serde_json::to_value(c.get_events(0)).unwrap();
        as_m10(c);

        // Same block time as the snapshot, so draw odds and accruals compare exactly.
        ctx(accounts(0), 6_000);
        let m = Contract::migrate(vec![relayer()]);
        assert_eq!(serde_json::to_value(m.get_account(accounts(1))).unwrap(), a1);
        assert_eq!(serde_json::to_value(m.get_account(accounts(2))).unwrap(), a2);
        assert_eq!(liabilities(&m), total);
        assert_eq!(serde_json::to_value(m.get_state()).unwrap(), state, "round, court, yield and params survive");
        assert_eq!(serde_json::to_value(m.get_events(0)).unwrap(), events, "stored events still decode");
        assert_eq!(m.get_relayers(), vec![relayer()]);
    }

    // ---- trusted relayers --------------------------------------------------------------

    fn relayer() -> AccountId {
        "relayer.test".parse().unwrap()
    }

    /// A meta transaction: `player`'s delegate action, relayed (and signed) by `relayed_by`.
    fn relayed(relayed_by: AccountId, player: AccountId, ms: u64) {
        testing_env!(VMContextBuilder::new().signer_account_id(relayed_by).predecessor_account_id(player).block_timestamp(ms * 1_000_000).build());
    }

    fn refused(code: &str, f: impl FnOnce()) {
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("should be refused");
        let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(msg.contains(code), "expected {code}, got {msg}");
    }

    #[test]
    fn spending_calls_relayed_by_anyone_but_the_game_relayer_are_refused() {
        let mut c = setup();
        c.relayers = vec![relayer()];
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        let thief: AccountId = "thief.test".parse().unwrap();
        relayed(thief.clone(), accounts(1), 3_000);
        refused("UNTRUSTED_RELAYER", || c.challenge(U128(10 * USDC)));
        relayed(thief.clone(), accounts(1), 3_000);
        refused("UNTRUSTED_RELAYER", || c.set_auto_defend(U128(10 * USDC)));
        relayed(thief, accounts(1), 3_000);
        refused("UNTRUSTED_RELAYER", || c.join_court(U128(10 * USDC)));
        assert_eq!(c.get_account(accounts(1)).balance.0, 20 * USDC, "nothing was spent");
    }

    #[test]
    fn the_game_relayer_and_direct_calls_can_play() {
        let mut c = setup();
        c.relayers = vec![relayer()];
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 20 * USDC);
        relayed(relayer(), accounts(1), 3_000);
        c.challenge(U128(10 * USDC));
        assert_eq!(c.round.king, Some(accounts(1)));
        challenge_at(&mut c, accounts(2), 4_000);
        assert_eq!(c.round.king, Some(accounts(2)), "the player's own key, direct");
    }

    #[test]
    fn any_relayer_can_pay_out_what_is_due_but_only_the_game_relayer_can_start_a_withdrawal() {
        let mut c = setup();
        c.relayers = vec![relayer()];
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        let stranger: AccountId = "stranger.test".parse().unwrap();
        // A thief can't keep restarting the player's cooldown.
        relayed(stranger.clone(), accounts(1), 3_000);
        refused("UNTRUSTED_RELAYER", || c.request_withdraw(U128(1)));
        relayed(relayer(), accounts(1), 3_000);
        c.request_withdraw(U128(30 * USDC));
        relayed(stranger.clone(), accounts(1), 3_100);
        let _ = c.claim();
        assert_eq!(c.get_account(accounts(1)).balance.0, 0, "claimed through a relayer that isn't the game's");
        relayed(stranger, accounts(1), 3_000 + 60_000);
        let _ = c.withdraw();
        assert_eq!(c.get_account(accounts(1)).withdraw_pending.0, 0, "withdrawn through a relayer that isn't the game's");
    }

    #[test]
    fn only_the_owner_sets_the_relayers() {
        let mut c = setup();
        ctx(accounts(1), 3_000);
        refused("NOT_OWNER", || c.set_relayers(vec![accounts(1)]));
        ctx(accounts(0), 3_000);
        c.set_relayers(vec![relayer()]);
        assert_eq!(c.get_relayers(), vec![relayer()]);
    }

    // ---- M8: yield reserve, registration fee, empty accounts --------------------------

    const HALF_YEAR: u64 = 365 * 24 * 3_600_000 / 2;

    fn fund(c: &mut Contract, amount: u128) {
        ctx(token(), 2_000);
        let _ = c.ft_on_transfer(accounts(5), U128(amount), r#"{"action":"fund_yield"}"#.into());
    }

    fn poke_at(c: &mut Contract, ms: u64) {
        ctx(accounts(4), ms);
        c.poke();
    }

    #[test]
    fn yield_pays_the_court_and_seeds_the_jackpot_from_the_reserve() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 0);
        player(&mut c, accounts(2), 30 * USDC, 0);
        fund(&mut c, 100 * USDC);
        let total = liabilities(&c);
        // 60 in the Court at 5% for half a year: 1.5 USDC, split 50/30/20; no King, so the
        // King's 20% seeds the Jackpot too.
        let later = 2_000 + HALF_YEAR;
        testing_env!(VMContextBuilder::new().block_timestamp(later * 1_000_000).build());
        let (view_earned, view_jackpot) = (c.get_account(accounts(1)).court_earned.0, c.get_state().round.jackpot.0);
        assert_eq!((view_earned, view_jackpot), (375_000, 450_000 + 300_000), "views include yield not yet written");
        poke_at(&mut c, later);
        assert_eq!(c.yield_reserve, 100 * USDC - 1_500_000);
        assert_eq!(c.get_account(accounts(1)).court_earned.0, 375_000, "the same once written");
        assert_eq!(c.round.jackpot, 750_000);
        assert_eq!(liabilities(&c), total, "yield only moves money out of the reserve");
        assert_eq!(c.get_state().court.apy_bps_live, 250);
    }

    #[test]
    fn the_king_streams_yield_and_claims_it_with_his_balance() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 0);
        fund(&mut c, 100 * USDC);
        challenge_at(&mut c, accounts(1), 3_000);
        let later = 3_000 + HALF_YEAR;
        testing_env!(VMContextBuilder::new().block_timestamp(later * 1_000_000).build());
        assert_eq!(c.get_account(accounts(1)).king_stream.0, 300_000);
        assert_eq!(c.get_account(accounts(2)).king_stream.0, 0);
        let a = c.get_account(accounts(1));
        let due = a.balance.0 + a.court_earned.0 + a.king_stream.0;
        let before = liabilities(&c);
        ctx(accounts(1), later);
        let _ = c.claim();
        assert_eq!(liabilities(&c), before - due, "exactly balance + earnings + stream leave");
        assert_eq!((c.streams_total, c.get_account(accounts(1)).king_stream.0), (0, 0));
    }

    #[test]
    fn yield_stops_when_the_reserve_runs_out_and_never_touches_principal() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 0);
        fund(&mut c, MIN_DEPOSIT);
        let (court, balances) = (c.court_total, c.balances_total);
        poke_at(&mut c, 2_000 + 20 * HALF_YEAR);
        assert_eq!(c.yield_reserve, 0, "the reserve pays what it has, no more");
        assert_eq!(c.round.jackpot + c.rewards_pool, MIN_DEPOSIT);
        assert_eq!((c.court_total, c.balances_total), (court, balances));
        assert_eq!(c.get_state().court.apy_bps_live, 0);
        let jackpot = c.round.jackpot;
        poke_at(&mut c, 2_000 + 40 * HALF_YEAR);
        assert_eq!(c.round.jackpot, jackpot, "nothing more accrues");
    }

    #[test]
    fn an_empty_court_accrues_nothing() {
        let mut c = setup();
        fund(&mut c, 10 * USDC);
        poke_at(&mut c, 2_000 + HALF_YEAR);
        assert_eq!((c.yield_reserve, c.round.jackpot), (10 * USDC, 0));
        // A later joiner earns only from when they joined.
        player(&mut c, accounts(1), 30 * USDC, 0);
        assert_eq!(c.get_account(accounts(1)).court_earned.0, 0);
    }

    #[test]
    fn a_late_joiner_does_not_share_yield_from_before_they_joined() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 0);
        fund(&mut c, 100 * USDC);
        // Half a year with only accounts(1) in the Court, then accounts(2) joins.
        testing_env!(VMContextBuilder::new().predecessor_account_id(token()).block_timestamp((2_000 + HALF_YEAR) * 1_000_000).build());
        let _ = c.ft_on_transfer(accounts(2), U128(30 * USDC), r#"{"action":"join"}"#.into());
        assert_eq!(c.get_account(accounts(1)).court_earned.0, 375_000, "30 at 5% for half a year, 50% to the Court");
        assert_eq!(c.get_account(accounts(2)).court_earned.0, 0);
    }

    #[test]
    fn the_king_streams_until_the_crowning() {
        let timing = Timing { trigger_bps: 20, trigger_fixed: Some(U128(u128::MAX)), backstop_ms: 1_000, showdown_ms: 1_000, snipe_ms: 0 };
        ctx(accounts(0), 1_000);
        let mut c = Contract::new(token(), 60_000, 5_000, Some(timing), None, None, None, None, None, None);
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        fund(&mut c, 100 * USDC);
        challenge_at(&mut c, accounts(1), 2_500);
        let end = c.round.showdown_ends_at.unwrap();
        // Settled half a year later: the King's stream runs up to the settlement.
        ctx(accounts(4), end + HALF_YEAR);
        c.settle_round();
        // Only accounts(1) is in the Court: 30 at 5% for half a year is 0.75, so 0.15 streams to
        // the King and 0.225 seeds the Jackpot he wins (4.00 from his own ticket, plus seed).
        assert_eq!(c.streams.get(&accounts(1)).copied(), Some(150_000));
        let last = serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap();
        assert_eq!(last["data"]["jackpot"], "4225000");
        assert!(c.accounts.contains_key(&accounts(1)));
    }

    #[test]
    fn intents_can_fund_the_reserve_and_the_owner_can_take_it_back() {
        let mut c = setup();
        deliver(&mut c, 7 * USDC, r#"{"action":"fund_yield"}"#);
        assert_eq!(c.yield_reserve, 7 * USDC);
        ctx(accounts(0), 3_000);
        let _ = c.withdraw_reserve(accounts(3), U128(7 * USDC));
        assert_eq!(c.yield_reserve, 0);
        assert!(!answer(&mut c, accounts(3), 7 * USDC, PayoutKind::Reserve, false));
        assert_eq!(c.yield_reserve, 7 * USDC, "a failed return puts it back");
    }

    #[test]
    #[should_panic(expected = "NOT_OWNER")]
    fn only_the_owner_takes_the_reserve_back() {
        let mut c = setup();
        fund(&mut c, 7 * USDC);
        ctx(accounts(1), 3_000);
        let _ = c.withdraw_reserve(accounts(1), U128(USDC));
    }

    #[test]
    fn a_new_account_pays_the_registration_fee_once() {
        let mut c = setup();
        c.registration_fee = 50_000;
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        let a = c.get_account(accounts(1));
        assert_eq!((a.balance.0, a.court.0, c.treasury), (0, 30 * USDC - 50_000, 50_000));
        deposit(&mut c, accounts(1), 5 * USDC, "");
        assert_eq!((c.get_account(accounts(1)).balance.0, c.treasury), (5 * USDC, 50_000), "no fee the second time");
        // Intents deliveries for a new account pay it too.
        deliver(&mut c, 2 * USDC, &json!({ "action": "balance", "beneficiary": accounts(2) }).to_string());
        assert_eq!((c.get_account(accounts(2)).balance.0, c.treasury), (2 * USDC - 50_000, 100_000));
    }

    #[test]
    fn an_emptied_account_is_deleted_after_its_payout() {
        let mut c = setup();
        c.registration_fee = 50_000;
        deposit(&mut c, accounts(1), 5 * USDC, "");
        arm(&mut c, accounts(1), 6 * USDC);
        ctx(accounts(1), 3_000);
        let _ = c.claim();
        ctx(accounts(0), 3_100);
        assert!(answer(&mut c, accounts(1), 5 * USDC - 50_000, PayoutKind::Claim, true));
        assert!(!c.accounts.contains_key(&accounts(1)), "storage freed");
        assert!(c.defenders.get(&accounts(1)).is_none());
        // Coming back pays the fee again.
        deposit(&mut c, accounts(1), 5 * USDC, "");
        assert_eq!(c.treasury, 100_000);
    }

    #[test]
    fn frequent_accruals_lose_no_yield_to_rounding() {
        let mut c = setup();
        player(&mut c, accounts(1), 60 * USDC, 0);
        fund(&mut c, 100 * USDC);
        // At 60 USDC and 5%, one micro takes ~10.5 s; a poke every 5 s must not floor it away.
        let hour = 3_600_000u64;
        for t in (5_000..=hour).step_by(5_000) {
            poke_at(&mut c, 2_000 + t);
        }
        let expected = 60 * USDC * 500 * hour as u128 / (10_000 * YEAR_MS);
        assert_eq!(100 * USDC - c.yield_reserve, expected, "the same as one accrual over the hour");
    }

    #[test]
    fn a_failed_payout_after_the_account_was_deleted_is_restored() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 5 * USDC);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(30 * USDC));
        // Both payouts in flight at once.
        ctx(accounts(1), 70_000);
        let _ = c.withdraw();
        let _ = c.claim();
        let owed = liabilities(&c);
        ctx(accounts(0), 70_100);
        assert!(answer(&mut c, accounts(1), 5 * USDC, PayoutKind::Claim, true));
        assert!(!c.accounts.contains_key(&accounts(1)), "the claim emptied it");
        assert!(!answer(&mut c, accounts(1), 30 * USDC, PayoutKind::Withdraw, false));
        assert_eq!(c.get_account(accounts(1)).withdraw_pending.0, 30 * USDC, "the refund is back on the books");
        assert_eq!(liabilities(&c), owed + 30 * USDC, "only the failed payout came back");
    }

    #[test]
    fn the_reserve_can_be_funded_while_paused_and_shows_no_apy_once_drained() {
        let mut c = setup();
        player(&mut c, accounts(1), 60 * USDC, 0);
        ctx(accounts(0), 2_000);
        c.set_paused(true);
        fund(&mut c, USDC);
        assert_eq!(c.yield_reserve, USDC);
        ctx(accounts(0), 2_000);
        assert_eq!(c.get_state().court.apy_bps_live, 250);
        // 3 USDC due against 1 in the reserve: drained, though nothing has accrued it yet.
        ctx(accounts(0), 2_000 + 2 * HALF_YEAR);
        assert_eq!(c.yield_reserve, USDC);
        assert_eq!(c.get_state().court.apy_bps_live, 0);
    }

    #[test]
    fn accounts_with_anything_left_are_kept() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        challenge_at(&mut c, accounts(1), 3_000);
        // The King claims his balance but stays King, with Court principal too.
        ctx(accounts(1), 4_000);
        let _ = c.claim();
        ctx(accounts(0), 4_100);
        // 15 left of his balance, plus his Court share of his own ticket.
        assert!(answer(&mut c, accounts(1), 15 * USDC + 375_000, PayoutKind::Claim, true));
        assert!(c.accounts.contains_key(&accounts(1)));
    }

    #[test]
    fn a_king_who_empties_his_account_keeps_it_until_the_crowning() {
        let timing = Timing { trigger_bps: 20, trigger_fixed: Some(U128(u128::MAX)), backstop_ms: 1_000, showdown_ms: 200_000, snipe_ms: 0 };
        ctx(accounts(0), 1_000);
        let mut c = Contract::new(token(), 1_000, 5_000, Some(timing), None, None, None, None, None, None);
        player(&mut c, accounts(1), 30 * USDC, 5 * USDC);
        challenge_at(&mut c, accounts(1), 2_500);
        // The King takes everything out while still on the throne.
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(30 * USDC));
        ctx(accounts(1), 3_500);
        let _ = c.claim();
        assert!(answer(&mut c, accounts(1), 375_000, PayoutKind::Claim, true));
        ctx(accounts(1), 5_000);
        let _ = c.withdraw();
        assert!(answer(&mut c, accounts(1), 30 * USDC, PayoutKind::Withdraw, true));
        let a = c.accounts.get(&accounts(1)).expect("the Jackpot still has to be paid in");
        assert_eq!((a.balance, a.court, a.withdraw_pending, a.earned), (0, 0, 0, 0), "otherwise empty");
        let end = c.round.showdown_ends_at.unwrap();
        ctx(accounts(4), end);
        c.settle_round();
        assert_eq!(c.get_account(accounts(1)).balance.0, 4 * USDC);
    }

    #[test]
    #[should_panic(expected = "registration fee")]
    fn the_fee_cannot_eat_a_minimum_deposit() {
        ctx(accounts(0), 1_000);
        Contract::new(token(), 60_000, 5_000, None, None, None, None, None, Some(U128(MIN_DEPOSIT / 2 + 1)), None);
    }

    #[test]
    #[should_panic(expected = "Yield params")]
    fn the_yield_split_must_add_up() {
        ctx(accounts(0), 1_000);
        Contract::new(token(), 60_000, 5_000, None, None, None, None, Some(YieldParams { apy_bps: 500, split_bps: [5000, 3000, 1000] }), None, None);
    }

    // ---- M6: unbonding, rounding, Intents, owner controls, the draw -------------------

    #[test]
    fn a_withdrawal_request_leaves_the_court_at_once() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        let total = liabilities(&c);
        ctx(accounts(1), 2_500);
        c.request_withdraw(U128(10 * USDC));
        let a = c.get_account(accounts(1));
        assert_eq!((a.court.0, a.withdraw_pending.0), (20 * USDC, 10 * USDC));
        assert_eq!(liabilities(&c), total, "pending is still owed");
        // Pending money earns nothing: a ticket's Court share now splits 20:30.
        challenge(&mut c, accounts(2));
        assert_eq!(c.get_account(accounts(1)).court_earned.0, 150_000, "375000 x 20/50");
        assert_eq!(c.get_account(accounts(2)).court_earned.0, 225_000);
        // ...and doesn't count toward the minimum: 20 left in the Court can't challenge.
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| challenge(&mut c, accounts(1)))).unwrap_err();
        assert!(err.downcast_ref::<String>().unwrap().contains("COURT_TOO_SMALL"));
    }

    #[test]
    fn a_second_request_adds_to_pending_and_restarts_the_cooldown() {
        let mut c = setup();
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(10 * USDC));
        ctx(accounts(1), 40_000);
        c.request_withdraw(U128(5 * USDC));
        let a = c.get_account(accounts(1));
        assert_eq!((a.court.0, a.withdraw_pending.0, a.withdraw_ready_at), (15 * USDC, 15 * USDC, Some(100_000)));
        ctx(accounts(1), 99_999);
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.withdraw();
        }))
        .unwrap_err();
        assert!(err.downcast_ref::<String>().unwrap().contains("COOLDOWN"));
    }

    #[test]
    fn the_odd_micro_of_the_court_share_goes_to_the_draw_pot() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        let before = c.draw_pot;
        c.pay_court(7);
        assert_eq!((c.draw_pot - before, c.rewards_pool), (4, 3));
    }

    #[test]
    fn intents_deliveries_are_credited_even_when_paused_or_over_a_cap() {
        let mut c = setup();
        c.limits = Limits { max_account: U128(10 * USDC), max_total: U128(10 * USDC), draw_min: U128(USDC), draw_every_ms: DRAW_EVERY_MS };
        c.paused = true;
        let msg = json!({ "action": "join", "beneficiary": accounts(1) }).to_string();
        deliver(&mut c, 40 * USDC, &msg);
        let a = c.get_account(accounts(1));
        assert_eq!((a.balance.0, a.court.0), (40 * USDC, 0), "credited, but no join while paused");
        // Dust can't be sent back either, but it's held rather than credited (see below).
        deliver(&mut c, 1, &json!({ "action": "balance", "beneficiary": accounts(1) }).to_string());
        assert_eq!((c.get_account(accounts(1)).balance.0, c.get_liabilities().recovery.0), (40 * USDC, 1));
    }

    #[test]
    fn intents_deliveries_without_a_beneficiary_are_held_for_recovery() {
        let mut c = setup();
        for msg in ["", "garbage", r#"{"action":"join"}"#, r#"{"action":"join","beneficiary":"x","extra":1}"#] {
            deliver(&mut c, 2 * USDC, msg);
        }
        assert_eq!(c.get_liabilities().recovery.0, 8 * USDC);
        assert_eq!(c.get_account(intents()).balance.0, 0, "never credited to the Intents account itself");
        assert_eq!(event_types(&c), ["deposit_held"; 4]);
        ctx(accounts(0), 3_000);
        let _ = c.recover(accounts(3), U128(8 * USDC));
        assert_eq!(c.get_liabilities().recovery.0, 0);
        // A failed return puts it back.
        ctx(accounts(0), 3_500);
        assert!(!answer(&mut c, accounts(3), 8 * USDC, PayoutKind::Recovery, false));
        assert_eq!(c.get_liabilities().recovery.0, 8 * USDC);
    }

    #[test]
    fn intents_dust_is_held_not_credited() {
        let mut c = setup();
        deliver(&mut c, MIN_DEPOSIT - 1, &json!({ "action": "join", "beneficiary": accounts(1) }).to_string());
        assert_eq!(c.get_liabilities().recovery.0, MIN_DEPOSIT - 1);
        assert!(!c.accounts.contains_key(&accounts(1)), "no account is created for dust");
    }

    #[test]
    fn a_full_court_still_credits_intents_but_refuses_direct_joins() {
        let mut c = setup();
        for i in 0..MAX_DEPOSITORS {
            let id: AccountId = format!("p{i}.test").parse().unwrap();
            deposit(&mut c, id, DRAW_MIN_COURT, r#"{"action":"join"}"#);
        }
        // An existing depositor can still add to the Court.
        deposit(&mut c, "p0.test".parse().unwrap(), MIN_DEPOSIT, r#"{"action":"join"}"#);
        // A newcomer's Intents delivery is credited, without joining.
        deliver(&mut c, 5 * USDC, &json!({ "action": "join", "beneficiary": accounts(1) }).to_string());
        let a = c.get_account(accounts(1));
        assert_eq!((a.balance.0, a.court.0), (5 * USDC, 0));
        // ...and a direct join is refused.
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| deposit(&mut c, accounts(2), 5 * USDC, r#"{"action":"join"}"#))).unwrap_err();
        assert!(err.downcast_ref::<String>().unwrap().contains("COURT_FULL"));
    }

    #[test]
    fn a_court_seat_under_five_dollars_takes_no_draw_slot() {
        let mut c = setup();
        player(&mut c, accounts(1), 4 * USDC, 1 * USDC);
        assert!(!c.depositors.contains(&accounts(1)), "$4 earns fees but holds no draw slot");
        ctx(accounts(1), 3_000);
        c.join_court(U128(USDC));
        assert!(c.depositors.contains(&accounts(1)), "$5 takes a slot");
    }

    #[test]
    fn squatting_the_draw_costs_five_dollars_a_slot_and_small_joins_still_get_in() {
        let mut c = setup();
        for i in 0..MAX_DEPOSITORS {
            let id: AccountId = format!("p{i}.test").parse().unwrap();
            deposit(&mut c, id, USDC, r#"{"action":"join"}"#);
        }
        assert_eq!(c.depositors.len(), 0, "$1 joins can't fill the draw");
        for i in 0..MAX_DEPOSITORS {
            let id: AccountId = format!("p{i}.test").parse().unwrap();
            deposit(&mut c, id, 4 * USDC, r#"{"action":"join"}"#);
        }
        assert_eq!(c.depositors.len(), MAX_DEPOSITORS);
        // With every slot taken, a newcomer can still join below the draw minimum, net of the fee.
        c.registration_fee = 50_000;
        deposit(&mut c, accounts(1), DRAW_MIN_COURT + 40_000, r#"{"action":"join"}"#);
        assert_eq!(c.get_account(accounts(1)).court.0, DRAW_MIN_COURT - 10_000);
        deliver(&mut c, 4 * USDC, &json!({ "action": "join", "beneficiary": accounts(2) }).to_string());
        assert_eq!(c.get_account(accounts(2)).court.0, 4 * USDC - 50_000, "Intents joins below the minimum too");
        // Topping up to the minimum needs a slot.
        ctx(accounts(1), 3_000);
        let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| deposit(&mut c, accounts(1), USDC, r#"{"action":"join"}"#))).unwrap_err();
        assert!(err.downcast_ref::<String>().unwrap().contains("COURT_FULL"));
    }

    #[test]
    fn dropping_under_five_dollars_gives_up_the_draw_slot() {
        let mut c = setup();
        player(&mut c, accounts(1), 10 * USDC, 0);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(5 * USDC));
        assert!(c.depositors.contains(&accounts(1)), "$5 left keeps the slot");
        ctx(accounts(1), 4_000);
        c.request_withdraw(U128(USDC));
        assert!(!c.depositors.contains(&accounts(1)), "$4 left frees it");
        assert_eq!(c.get_account(accounts(1)).draw_weight_bps, 0);
    }

    #[test]
    fn weight_counts_only_while_holding_a_slot() {
        let mut c = setup();
        player(&mut c, accounts(1), 10 * USDC, 1 * USDC);
        player(&mut c, accounts(2), 4 * USDC, 1 * USDC);
        // Dropping under $5 forfeits the weight; topping back up starts it again from zero.
        ctx(accounts(1), 50_000);
        c.request_withdraw(U128(6 * USDC));
        ctx(accounts(1), 90_000);
        c.join_court(U128(USDC));
        assert_eq!(c.weight_at(&accounts(1), 91_000), 5 * USDC * 1_000, "the forfeited weight stays forfeited");
        // Time spent under $5 never counts.
        ctx(accounts(2), 90_000);
        c.join_court(U128(USDC));
        assert_eq!(c.weight_at(&accounts(2), 91_000), 5 * USDC * 1_000);
    }

    #[test]
    #[should_panic(expected = "CAP_REACHED")]
    fn direct_deposits_respect_the_account_cap() {
        let mut c = setup();
        c.limits.max_account = U128(30 * USDC);
        deposit(&mut c, accounts(1), 25 * USDC, r#"{"action":"join"}"#);
        deposit(&mut c, accounts(1), 6 * USDC, "");
    }

    #[test]
    #[should_panic(expected = "CAP_REACHED")]
    fn direct_deposits_respect_the_total_cap() {
        let mut c = setup();
        c.limits.max_total = U128(50 * USDC);
        deposit(&mut c, accounts(1), 30 * USDC, "");
        deposit(&mut c, accounts(2), 21 * USDC, "");
    }

    #[test]
    fn pausing_stops_play_but_never_stops_leaving() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        ctx(accounts(1), 2_500);
        c.request_withdraw(U128(5 * USDC));
        ctx(accounts(0), 3_000);
        c.set_paused(true);
        assert!(c.get_state().paused);
        for (code, call) in [
            ("PAUSED", Box::new(|c: &mut Contract| challenge(c, accounts(1))) as Box<dyn Fn(&mut Contract)>),
            ("PAUSED", Box::new(|c: &mut Contract| { ctx(accounts(1), 3_100); c.join_court(U128(USDC)) })),
            ("PAUSED", Box::new(|c: &mut Contract| arm(c, accounts(1), USDC))),
            ("PAUSED", Box::new(|c: &mut Contract| deposit(c, accounts(2), 5 * USDC, ""))),
        ] {
            let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&mut c))).unwrap_err();
            assert!(err.downcast_ref::<String>().unwrap().contains(code));
        }
        // Leaving still works: disarm, claim and withdraw.
        arm(&mut c, accounts(1), 0);
        ctx(accounts(1), 70_000);
        let _ = c.withdraw();
        ctx(accounts(1), 70_100);
        let _ = c.claim();
        let a = c.get_account(accounts(1));
        assert_eq!((a.balance.0, a.withdraw_pending.0), (0, 0));
    }

    #[test]
    #[should_panic(expected = "NOT_OWNER")]
    fn only_the_owner_pauses() {
        let mut c = setup();
        ctx(accounts(1), 3_000);
        c.set_paused(true);
    }

    #[test]
    fn the_treasury_goes_to_the_owner_and_comes_back_on_failure() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        challenge(&mut c, accounts(1));
        assert_eq!(c.treasury, 250_000);
        ctx(accounts(0), 4_000);
        let _ = c.claim_treasury(accounts(3));
        assert_eq!(c.treasury, 0);
        assert!(!answer(&mut c, accounts(3), 250_000, PayoutKind::Treasury, false));
        assert_eq!(c.treasury, 250_000);
    }

    /// Closes the draw at `ms` and, if one is pending, pays it with randomness derived from
    /// `seed`. Only one fixture round has a real drand signature, so the statistical tests feed
    /// `pay_draw` directly; `a_real_drand_round_pays_the_draw` covers `finalize_draw` itself.
    fn draw_at(c: &mut Contract, ms: u64, seed: u8) {
        ctx(accounts(4), ms);
        c.close_draw();
        if c.pending_draw.is_some() {
            // A hash, so seeds spread like real randomness.
            c.pay_draw(env::sha256_array([seed]));
        }
    }

    /// The block time at which `close_draw` names the fixture round.
    fn fixture_close_ms() -> u64 {
        drand::GENESIS_MS + (drand::tests::ROUND - 1) * drand::PERIOD_MS - DRAW_ROUND_MARGIN_MS
    }

    /// Two depositors with challenges behind them, so the pot is over the draw minimum.
    fn draw_ready() -> Contract {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        for i in 0..4 {
            challenge(&mut c, accounts(1 + i % 2));
        }
        c
    }

    fn last_event(c: &Contract) -> serde_json::Value {
        serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap()
    }

    #[test]
    fn a_real_drand_round_pays_the_draw() {
        let mut c = draw_ready();
        let pot = c.draw_pot;
        let total = liabilities(&c);
        let balances = c.balances_total;
        ctx(accounts(4), fixture_close_ms());
        c.close_draw();
        let pending = c.get_state().court.pending_draw.expect("a pending draw");
        assert_eq!((pending.round, pending.pot.0), (drand::tests::ROUND, pot));
        assert_eq!(last_event(&c)["type"], "draw_closed");
        assert_eq!(c.draw_pot, 0, "next week's pot starts empty");
        assert_eq!(liabilities(&c), total, "the pending pot is still owed");

        ctx(accounts(3), fixture_close_ms() + 40_000);
        c.finalize_draw(drand::tests::SIG.into());
        assert!(c.pending_draw.is_none() && c.draw_entries.is_none());
        assert_eq!(c.balances_total, balances + pot);
        assert_eq!(liabilities(&c), total, "the pot moves into a balance");
        let won = last_event(&c);
        assert_eq!((won["type"].as_str(), won["data"]["amount"].as_str()), (Some("draw_won"), Some(pot.to_string().as_str())));
    }

    #[test]
    fn the_named_round_is_still_unpublished_at_the_close() {
        let mut c = draw_ready();
        let close = fixture_close_ms() + 1_234;
        ctx(accounts(4), close);
        c.close_draw();
        let round = c.pending_draw.as_ref().unwrap().round;
        let published = drand::GENESIS_MS + (round - 1) * drand::PERIOD_MS;
        assert!(published >= close + DRAW_ROUND_MARGIN_MS, "{published} vs {close}");
        assert!(published < close + DRAW_ROUND_MARGIN_MS + drand::PERIOD_MS);
    }

    #[test]
    #[should_panic(expected = "BAD_SIGNATURE")]
    fn finalize_refuses_another_rounds_signature() {
        let mut c = draw_ready();
        // One round later: the fixture is no longer the named round's signature.
        ctx(accounts(4), fixture_close_ms() + drand::PERIOD_MS);
        c.close_draw();
        c.finalize_draw(drand::tests::SIG.into());
    }

    #[test]
    #[should_panic(expected = "BAD_SIGNATURE")]
    fn finalize_refuses_garbage() {
        let mut c = draw_ready();
        ctx(accounts(4), fixture_close_ms());
        c.close_draw();
        c.finalize_draw("not hex".into());
    }

    #[test]
    #[should_panic(expected = "NO_DRAW")]
    fn finalize_needs_a_closed_draw() {
        let mut c = draw_ready();
        ctx(accounts(4), fixture_close_ms());
        c.finalize_draw(drand::tests::SIG.into());
    }

    #[test]
    #[should_panic(expected = "DRAW_PENDING")]
    fn the_next_close_waits_for_the_pending_draw() {
        let mut c = draw_ready();
        ctx(accounts(4), fixture_close_ms());
        c.close_draw();
        ctx(accounts(4), fixture_close_ms() + DRAW_EVERY_MS);
        c.close_draw();
    }

    #[test]
    fn money_moved_after_the_close_does_not_change_the_odds() {
        // Each run: accounts(2) leaves the Court entirely after the close, and accounts(3)
        // joins with far more. The frozen entries still decide: both original depositors win
        // sometimes, the newcomer never.
        let mut wins = [0u32; 2];
        for seed in 0..=127u8 {
            near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
            let mut c = draw_ready();
            ctx(accounts(4), 1_000 + DRAW_EVERY_MS);
            c.close_draw();
            ctx(accounts(2), 1_000 + DRAW_EVERY_MS + 1);
            c.request_withdraw(U128(30 * USDC));
            deposit(&mut c, accounts(3), 500 * USDC, r#"{"action":"join"}"#);
            c.pay_draw(env::sha256_array([seed]));
            let by = last_event(&c)["data"]["by"].clone();
            assert_ne!(by, json!(accounts(3)), "seed {seed}");
            wins[usize::from(by == json!(accounts(2)))] += 1;
        }
        assert!(wins[0] > 30 && wins[1] > 30, "{wins:?}");
    }

    #[test]
    fn a_winner_whose_account_was_deleted_still_gets_the_pot() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 0);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(3), 30 * USDC, 50 * USDC);
        for i in 0..4 {
            challenge(&mut c, accounts(2 + i % 2));
        }
        let pot = c.draw_pot;
        assert!(pot >= USDC, "{pot}");
        let close = 1_000 + DRAW_EVERY_MS;
        ctx(accounts(4), close);
        c.close_draw();
        // accounts(1) leaves entirely: takes out its principal, then claims its earnings.
        ctx(accounts(1), close + 1);
        c.request_withdraw(U128(30 * USDC));
        ctx(accounts(1), close + 60_001);
        let _ = c.withdraw();
        ctx(accounts(0), close + 60_002);
        assert!(answer(&mut c, accounts(1), 30 * USDC, PayoutKind::Withdraw, true));
        let earned = c.get_account(accounts(1)).court_earned;
        ctx(accounts(1), close + 60_003);
        let _ = c.claim();
        ctx(accounts(0), close + 60_004);
        assert!(answer(&mut c, accounts(1), earned.0, PayoutKind::Claim, true));
        assert!(!c.accounts.contains_key(&accounts(1)), "deleted");
        let total = liabilities(&c);
        // Zero randomness lands on the first entry, accounts(1).
        c.pay_draw([0; 32]);
        assert_eq!(c.get_account(accounts(1)).balance.0, pot);
        assert_eq!(liabilities(&c), total);
    }

    #[test]
    #[should_panic(expected = "NOT_READY")]
    fn the_draw_waits_for_its_week() {
        let mut c = setup();
        draw_at(&mut c, 1_000 + DRAW_EVERY_MS - 1, 0);
    }

    #[test]
    fn draw_weight_is_principal_times_time() {
        let mut c = setup();
        // accounts(1) joins at the epoch start with 10; accounts(2) joins with 60 at 6/7 of the
        // week, so 10 x 7 days beats 60 x 1 day... only just: 70 vs 60 parts.
        deposit(&mut c, accounts(1), 10 * USDC, r#"{"action":"join"}"#);
        testing_env!(VMContextBuilder::new().predecessor_account_id(token()).block_timestamp((1_000 + DRAW_EVERY_MS / 7 * 6) * 1_000_000).build());
        let _ = c.ft_on_transfer(accounts(2), U128(60 * USDC), r#"{"action":"join"}"#.into());
        testing_env!(VMContextBuilder::new().block_timestamp((1_000 + DRAW_EVERY_MS) * 1_000_000).build());
        let (w1, w2) = (c.get_account(accounts(1)).draw_weight_bps, c.get_account(accounts(2)).draw_weight_bps);
        assert!((5_380..=5_390).contains(&w1), "{w1}");
        assert!((4_610..=4_620).contains(&w2), "{w2}");
    }

    #[test]
    fn a_pending_withdrawal_stops_gaining_draw_weight() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 0);
        player(&mut c, accounts(2), 30 * USDC, 0);
        // accounts(2) takes half out halfway through the week: 30 x 0.5 + 15 x 0.5 = 22.5
        // against 30 for accounts(1).
        ctx(accounts(2), 1_000 + DRAW_EVERY_MS / 2);
        c.request_withdraw(U128(15 * USDC));
        testing_env!(VMContextBuilder::new().block_timestamp((1_000 + DRAW_EVERY_MS) * 1_000_000).build());
        let (w1, w2) = (c.get_account(accounts(1)).draw_weight_bps, c.get_account(accounts(2)).draw_weight_bps);
        assert!((5_710..=5_720).contains(&w1) && (4_280..=4_290).contains(&w2), "{w1} {w2}");
    }

    #[test]
    fn leaving_the_court_entirely_forfeits_the_draw() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        for i in 0..4 {
            challenge(&mut c, accounts(1 + i % 2));
        }
        // accounts(2) held 30 for most of the week, then left entirely before the draw.
        ctx(accounts(2), 1_000 + DRAW_EVERY_MS - 10);
        c.request_withdraw(U128(30 * USDC));
        testing_env!(VMContextBuilder::new().block_timestamp((1_000 + DRAW_EVERY_MS) * 1_000_000).build());
        assert_eq!(c.get_account(accounts(2)).draw_weight_bps, 0);
        for seed in 0..=40u8 {
            near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
            let mut c2 = setup();
            player(&mut c2, accounts(1), 30 * USDC, 50 * USDC);
            player(&mut c2, accounts(2), 30 * USDC, 50 * USDC);
            for i in 0..4 {
                challenge(&mut c2, accounts(1 + i % 2));
            }
            ctx(accounts(2), 1_000 + DRAW_EVERY_MS - 10);
            c2.request_withdraw(U128(30 * USDC));
            draw_at(&mut c2, 1_000 + DRAW_EVERY_MS, seed);
            let by = serde_json::to_value(c2.get_events(0).events.last().unwrap()).unwrap()["data"]["by"].clone();
            assert_eq!(by, json!(accounts(1)), "seed {seed}");
        }
    }

    #[test]
    fn the_draw_pays_one_winner_and_starts_a_new_epoch() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        for i in 0..4 {
            challenge(&mut c, accounts(1 + i % 2));
        }
        let pot = c.draw_pot;
        assert!(pot >= USDC, "{pot}");
        let total = liabilities(&c);
        let balances = c.balances_total;
        let week = 1_000 + DRAW_EVERY_MS;
        draw_at(&mut c, week, 7);
        assert_eq!((c.draw_pot, c.balances_total), (0, balances + pot));
        assert_eq!(liabilities(&c), total, "the pot moves into a balance");
        let last = serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap();
        assert_eq!(last["type"], "draw_won");
        assert_eq!(last["data"]["amount"], pot.to_string());
        assert_eq!(c.get_state().court.next_draw_at, week + DRAW_EVERY_MS);
        // Both seeds pick a depositor; over many seeds both win sometimes.
        let mut wins = [0u32; 2];
        for seed in 0..=255u8 {
            // The mock keeps storage across contexts; each run needs a clean contract.
            near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
            let mut c2 = setup();
            player(&mut c2, accounts(1), 30 * USDC, 50 * USDC);
            player(&mut c2, accounts(2), 30 * USDC, 50 * USDC);
            for i in 0..4 {
                challenge(&mut c2, accounts(1 + i % 2));
            }
            draw_at(&mut c2, week, seed);
            let by = serde_json::to_value(c2.get_events(0).events.last().unwrap()).unwrap()["data"]["by"].clone();
            wins[usize::from(by == json!(accounts(2)))] += 1;
        }
        assert!(wins[0] > 50 && wins[1] > 50, "{wins:?}");
    }

    #[test]
    fn a_small_pot_rolls_over() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        challenge(&mut c, accounts(1));
        let pot = c.draw_pot;
        assert!(pot < USDC);
        draw_at(&mut c, 1_000 + DRAW_EVERY_MS, 0);
        assert_eq!(c.draw_pot, pot, "kept for next week");
        assert!(!event_types(&c).contains(&"draw_won".to_string()));
        assert_eq!(c.get_state().court.next_draw_at, 1_000 + 2 * DRAW_EVERY_MS);
    }

    #[test]
    fn leavers_drop_out_of_the_next_draw() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 0);
        player(&mut c, accounts(2), 30 * USDC, 0);
        ctx(accounts(2), 2_500);
        c.request_withdraw(U128(30 * USDC));
        assert!(!c.depositors.contains(&accounts(2)), "a full exit frees the slot at once");
        draw_at(&mut c, 1_000 + DRAW_EVERY_MS, 0);
        assert!(c.depositors.contains(&accounts(1)));
        assert_eq!(c.get_account(accounts(2)).draw_weight_bps, 0);
        assert_eq!(c.get_account(accounts(1)).draw_weight_bps, 10_000, "the only one left in the Court");
    }

    fn arm(c: &mut Contract, who: AccountId, max: u128) {
        ctx(who, 2_500);
        c.set_auto_defend(U128(max));
    }

    #[test]
    fn auto_defend_retakes_in_the_same_transaction() {
        let mut c = setup_timed();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 20 * USDC);
        challenge_at(&mut c, accounts(1), 3_000);
        arm(&mut c, accounts(1), 7 * USDC);
        assert_eq!(c.get_account(accounts(1)).auto_defend_max.0, 7 * USDC);
        let total = liabilities(&c);

        challenge_at(&mut c, accounts(2), 4_000);
        // Bob paid 5.15 (Alice gets 1.2875), then Alice retook at 5.3045 (Bob gets 1.326125).
        assert_eq!(c.round.king, Some(accounts(1)));
        assert_eq!(c.round.challenges, 3);
        assert_eq!(c.get_account(accounts(1)).balance.0, 15 * USDC + 1_287_500 - 5_304_500);
        assert_eq!(c.get_account(accounts(2)).balance.0, 20 * USDC - 5_150_000 + 1_326_125);
        assert_eq!(liabilities(&c), total);
        // The retake also pushed the Jackpot past the $8 trigger, so the showdown event follows it.
        assert_eq!(event_types(&c)[event_types(&c).len() - 2..], ["auto_defended", "showdown_started"]);
        let events = c.get_events(0).events;
        let retake = serde_json::to_value(&events[events.len() - 2]).unwrap();
        assert_eq!(retake["data"], json!({ "by": accounts(1), "price": "5304500", "against": accounts(2) }));
    }

    #[test]
    fn a_war_stops_at_the_retake_cap() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 900 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 900 * USDC);
        challenge(&mut c, accounts(1));
        arm(&mut c, accounts(1), 999 * USDC);
        arm(&mut c, accounts(2), 999 * USDC);
        let total = liabilities(&c);
        challenge(&mut c, accounts(2));
        // Bob's ticket plus 25 retakes: 27 tickets this round, and the war ends on Alice.
        assert_eq!(c.round.challenges, 1 + 1 + MAX_RETAKES);
        assert_eq!(c.round.king, Some(accounts(1)));
        assert_eq!(c.round.next_price, price_at(27));
        assert_eq!(liabilities(&c), total, "a war only moves money between buckets");
        let types = event_types(&c);
        assert_eq!(types.iter().filter(|t| *t == "auto_defended").count() as u32, MAX_RETAKES);
    }

    #[test]
    fn the_war_ends_when_a_defender_cannot_pay() {
        let mut c = setup();
        // Bob can afford his challenge and two retakes (5.15 + 5.4636 + 5.7963) but not a third.
        player(&mut c, accounts(1), 30 * USDC, 900 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 17 * USDC);
        challenge(&mut c, accounts(1));
        arm(&mut c, accounts(1), 999 * USDC);
        arm(&mut c, accounts(2), 999 * USDC);
        challenge(&mut c, accounts(2));
        assert_eq!(c.round.king, Some(accounts(1)), "Alice holds the throne once Bob runs dry");
        let bob = c.get_account(accounts(2)).balance.0;
        assert!(bob < c.round.next_price, "Bob stopped because he could not pay {}", c.round.next_price);
    }

    #[test]
    fn the_war_ends_at_the_max_price() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 900 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 900 * USDC);
        challenge(&mut c, accounts(1));
        arm(&mut c, accounts(1), 5_627_544); // covers retakes at 5.3045 and exactly 5.627544, not 5.97
        arm(&mut c, accounts(2), 999 * USDC);
        challenge(&mut c, accounts(2));
        // Alice 5.00, Bob 5.15, Alice 5.3045, Bob 5.4636, Alice 5.6275, Bob 5.7964; Alice stops at 5.9703.
        assert_eq!(c.round.challenges, 6);
        assert_eq!(c.round.king, Some(accounts(2)));
    }

    #[test]
    fn disarming_and_court_minimum_stop_retakes() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        challenge(&mut c, accounts(1));
        arm(&mut c, accounts(1), 50 * USDC);
        arm(&mut c, accounts(1), 0);
        assert_eq!(c.get_account(accounts(1)).auto_defend_max.0, 0);
        challenge(&mut c, accounts(2));
        assert_eq!(c.round.king, Some(accounts(2)), "disarmed: no retake");

        // Armed but under the Court minimum after a withdrawal: no retake either.
        arm(&mut c, accounts(2), 50 * USDC);
        ctx(accounts(2), 3_000);
        c.request_withdraw(U128(10 * USDC));
        ctx(accounts(2), 63_000);
        let _ = c.withdraw();
        challenge_at(&mut c, accounts(1), 63_500);
        assert_eq!(c.round.king, Some(accounts(1)));
    }

    #[test]
    #[should_panic(expected = "INSUFFICIENT_BALANCE")]
    fn arming_needs_an_account() {
        let mut c = setup();
        arm(&mut c, accounts(5), USDC);
    }

    #[test]
    #[should_panic(expected = "Timing out of range")]
    fn rejects_a_snipe_window_longer_than_the_showdown() {
        ctx(accounts(0), 1_000);
        let timing = Timing { trigger_bps: 20, trigger_fixed: None, backstop_ms: 300_000, showdown_ms: 10_000, snipe_ms: 20_000 };
        Contract::new(token(), 60_000, 5_000, Some(timing), None, None, None, None, None, None);
    }

    #[test]
    #[should_panic(expected = "NOTHING_TO_CLAIM")]
    fn claim_from_an_unknown_account_has_nothing_to_claim() {
        let mut c = setup();
        ctx(accounts(5), 2_000);
        let _ = c.claim();
    }

    #[test]
    #[should_panic(expected = "NOTHING_TO_WITHDRAW")]
    fn withdraw_from_an_unknown_account_has_nothing_to_withdraw() {
        let mut c = setup();
        ctx(accounts(5), 2_000);
        let _ = c.withdraw();
    }

    #[test]
    #[should_panic(expected = "INVALID_AMOUNT")]
    fn request_withdraw_from_an_unknown_account_is_invalid() {
        let mut c = setup();
        ctx(accounts(5), 2_000);
        c.request_withdraw(U128(1));
    }

    #[test]
    fn deposit_with_join_credits_court_and_logs_event() {
        let mut c = setup();
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        let a = c.get_account(accounts(1));
        assert_eq!((a.balance.0, a.court.0, a.draw_weight_bps), (0, 30 * USDC, 10_000));
        let page = c.get_events(0);
        assert_eq!(page.cursor, 1);
        assert_eq!(serde_json::to_value(&page.events[0]).unwrap(), json!({
            "id": 1, "at": 2_000, "type": "court_join", "data": { "by": accounts(1), "amount": "30000000" }
        }));
    }

    #[test]
    fn beneficiary_receives_the_credit() {
        let mut c = setup();
        let msg = json!({ "action": "balance", "beneficiary": accounts(2) }).to_string();
        deposit(&mut c, accounts(1), 5 * USDC, &msg);
        assert_eq!(c.get_account(accounts(2)).balance.0, 5 * USDC);
        assert_eq!(c.get_account(accounts(1)).balance.0, 0);
    }

    #[test]
    #[should_panic(expected = "WRONG_TOKEN")]
    fn rejects_other_tokens() {
        let mut c = setup();
        ctx(accounts(3), 2_000);
        let _ = c.ft_on_transfer(accounts(1), U128(5 * USDC), String::new());
    }

    #[test]
    #[should_panic(expected = "INVALID_AMOUNT")]
    fn rejects_dust() {
        let mut c = setup();
        deposit(&mut c, accounts(1), MIN_DEPOSIT - 1, "");
    }

    #[test]
    #[should_panic(expected = "INVALID_MSG")]
    fn rejects_unknown_msg() {
        let mut c = setup();
        deposit(&mut c, accounts(1), 5 * USDC, "join");
    }

    #[test]
    #[should_panic(expected = "COOLDOWN")]
    fn withdraw_waits_for_cooldown() {
        let mut c = setup();
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(10 * USDC));
        ctx(accounts(1), 62_999);
        let _ = c.withdraw();
    }

    #[test]
    fn failed_payout_restores_funds() {
        let mut c = setup();
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(10 * USDC));
        ctx(accounts(1), 63_000);
        let _ = c.withdraw();
        assert_eq!((c.get_liabilities().court.0, c.get_liabilities().pending.0), (20 * USDC, 0));
        ctx(accounts(0), 64_000);
        assert!(!answer(&mut c, accounts(1), 10 * USDC, PayoutKind::Withdraw, false));
        let a = c.get_account(accounts(1));
        assert_eq!((a.court.0, a.withdraw_pending.0, a.withdraw_ready_at), (20 * USDC, 10 * USDC, Some(64_000)));
        assert_eq!(c.get_liabilities().pending.0, 10 * USDC, "back in pending, withdrawable at once");
        assert_eq!(c.get_events(0).events.len(), 1, "no withdraw event for a failed payout");
    }

    #[test]
    fn failed_payout_keeps_a_newer_withdrawal_request() {
        let mut c = setup();
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(10 * USDC));
        ctx(accounts(1), 63_000);
        let _ = c.withdraw();
        // While the payout is in flight, the player asks for 5 more.
        ctx(accounts(1), 63_500);
        c.request_withdraw(U128(5 * USDC));
        ctx(accounts(0), 64_000);
        assert!(!answer(&mut c, accounts(1), 10 * USDC, PayoutKind::Withdraw, false));
        // The failed 10 joins the newer 5 and waits out its cooldown; it doesn't unlock it early.
        let a = c.get_account(accounts(1));
        assert_eq!((a.court.0, a.withdraw_pending.0, a.withdraw_ready_at), (15 * USDC, 15 * USDC, Some(123_500)));
    }

    #[test]
    fn yield_carrying_the_jackpot_over_the_trigger_starts_the_showdown() {
        let mut c = setup_timed();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 30 * USDC, 50 * USDC);
        fund(&mut c, 100 * USDC);
        challenge_at(&mut c, accounts(1), 3_000);
        challenge_at(&mut c, accounts(2), 4_000);
        // 100 s of yield on a $60 Court seeds the Jackpot with 2 micro: just enough.
        c.timing.trigger_fixed = Some(U128(c.round.jackpot + 2));
        poke_at(&mut c, 104_000);
        assert_eq!(c.round.showdown_ends_at, Some(194_000), "well before the 5 min backstop");
        let last = serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap();
        assert_eq!(last["data"], json!({ "reason": "size", "ends_at": 194_000 }));
        // Later yield doesn't restart it.
        poke_at(&mut c, 150_000);
        assert_eq!(c.round.showdown_ends_at, Some(194_000));
    }

    #[test]
    fn yield_starts_no_showdown_while_the_game_is_paused() {
        let mut c = setup_timed();
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        fund(&mut c, 100 * USDC);
        challenge_at(&mut c, accounts(1), 3_000);
        c.timing.trigger_fixed = Some(U128(c.round.jackpot + 1));
        c.paused = true;
        // A claim still works while paused, and accrues yield.
        ctx(accounts(1), 104_000);
        let _ = c.claim();
        assert!(c.round.jackpot >= c.trigger());
        assert_eq!(c.round.showdown_ends_at, None, "nobody could challenge, so no clock starts");
        // Once play resumes, the next accrual starts it.
        c.paused = false;
        poke_at(&mut c, 150_000);
        assert_eq!(c.round.showdown_ends_at, Some(240_000));
    }

    #[test]
    fn yield_starts_no_showdown_while_the_throne_is_empty() {
        let mut c = setup_timed();
        player(&mut c, accounts(1), 30 * USDC, 0);
        fund(&mut c, 100 * USDC);
        c.timing.trigger_fixed = Some(U128(1));
        poke_at(&mut c, 104_000);
        assert!(c.round.jackpot >= 1, "yield reached the Jackpot");
        assert_eq!(c.round.showdown_ends_at, None, "a showdown needs a King; the next challenge checks the trigger");
    }

    /// An Intents delivery at `ms`, with the contract holding `spare` bytes' worth of NEAR
    /// beyond what its storage already costs.
    fn deliver_with_spare(c: &mut Contract, amount: u128, msg: &str, ms: u64, spare: u64) {
        let used = 10_000;
        let balance = env::storage_byte_cost().saturating_mul((used + spare) as u128);
        testing_env!(VMContextBuilder::new().predecessor_account_id(token()).block_timestamp(ms * 1_000_000).storage_usage(used).account_balance(balance).build());
        let _ = c.ft_on_transfer(intents(), U128(amount), msg.into());
    }

    fn flush(c: &mut Contract) -> u64 {
        c.accounts.flush();
        c.events.flush();
        c.depositors.flush();
        c.draw_weights.flush();
        c.streams.flush();
        env::storage_usage()
    }

    #[test]
    fn an_intents_delivery_the_contract_cannot_store_is_held_and_writes_nothing() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 0);
        flush(&mut c);
        let events = c.last_event_id;
        // An existing account joining the Court still writes: an event, maybe a draw slot.
        let msg = json!({ "action": "join", "beneficiary": accounts(1) }).to_string();
        deliver_with_spare(&mut c, 10 * USDC, &msg, 3_000, STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES - 1);
        assert_eq!((c.get_liabilities().recovery.0, c.get_account(accounts(1)).court.0), (10 * USDC, 30 * USDC), "held, not credited");
        assert_eq!((c.last_event_id, flush(&mut c)), (events, 10_000), "nothing new is stored");
        // Funding the yield reserve accrues yield, which can write too.
        deliver_with_spare(&mut c, 10 * USDC, r#"{"action":"fund_yield"}"#, 3_000, STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES - 1);
        assert_eq!((c.get_liabilities().recovery.0, c.yield_reserve), (20 * USDC, 0));
        // With the buffer in place it is credited as usual.
        deliver_with_spare(&mut c, 10 * USDC, &msg, 3_000, STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES);
        assert_eq!((c.get_liabilities().recovery.0, c.get_account(accounts(1)).court.0), (20 * USDC, 40 * USDC));
    }

    #[test]
    fn storage_growth_stops_before_exits_and_challenges_when_the_buffer_is_short() {
        let mut c = setup();
        player(&mut c, accounts(1), 30 * USDC, 20 * USDC);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(5 * USDC));
        let short = |who: AccountId, ms: u64| {
            let balance = env::storage_byte_cost().saturating_mul((10_000 + STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES - 1) as u128);
            testing_env!(VMContextBuilder::new().signer_account_id(who.clone()).predecessor_account_id(who).block_timestamp(ms * 1_000_000).storage_usage(10_000).account_balance(balance).build());
        };
        short(accounts(1), 70_000);
        refused("PAUSED", || c.join_court(U128(USDC)));
        refused("PAUSED", || c.set_auto_defend(U128(6 * USDC)));
        short(token(), 70_000);
        refused("PAUSED", || {
            let _ = c.ft_on_transfer(accounts(2), U128(5 * USDC), "".into());
        });
        // Challenging still works: the round's clock doesn't stop for a storage shortage.
        short(accounts(1), 70_000);
        c.challenge(U128(START_PRICE));
        assert_eq!(c.round.king, Some(accounts(1)));
        // So does leaving.
        let _ = c.withdraw();
        let _ = c.claim();
        assert_eq!(c.get_liabilities().in_flight.0, 5 * USDC + 15 * USDC + 375_000);
    }

    #[test]
    fn the_storage_buffer_covers_the_largest_delivery() {
        let long = |c: char| -> AccountId { c.to_string().repeat(64).parse().unwrap() };
        ctx(accounts(0), 1_000);
        let timing = Timing { trigger_fixed: Some(U128(1_000 * USDC)), ..Timing::spec() };
        let mut c = Contract::new(token(), 60_000, 5_000, Some(timing), None, Some(intents()), None, None, None, None);
        player(&mut c, long('a'), 30 * USDC, 50 * USDC);
        player(&mut c, long('b'), 30 * USDC, 50 * USDC);
        fund(&mut c, 100 * USDC);
        // A King with no stream entry yet, and a Jackpot that this delivery's yield tips over
        // the trigger: the delivery writes a new account, its draw slot and weight, the King's
        // stream, a join event and a showdown event.
        challenge_at(&mut c, long('a'), 3_000);
        assert_eq!(c.round.showdown_ends_at, None);
        c.timing.trigger_fixed = Some(U128(c.round.jackpot + 1));
        flush(&mut c);
        let msg = json!({ "action": "join", "beneficiary": long('c') }).to_string();
        deliver_with_spare(&mut c, 30 * USDC, &msg, 200_000, STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES);
        let grew = flush(&mut c) - 10_000;
        assert_eq!(event_types(&c).iter().rev().take(2).collect::<Vec<_>>(), ["court_join", "showdown_started"]);
        assert!(c.streams.contains_key(&long('a')) && c.depositors.contains(&long('c')));
        assert!(grew > 0 && grew * 2 <= STORAGE_BUFFER_BYTES, "the largest delivery stored {grew} bytes");
    }

    /// A $10 withdrawal in flight as payout 1, started at 63 s.
    fn withdrawal_in_flight() -> Contract {
        let mut c = setup();
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(10 * USDC));
        ctx(accounts(1), 63_000);
        let _ = c.withdraw();
        c
    }

    #[test]
    fn a_payout_stays_on_the_books_until_its_callback_books_it() {
        let mut c = withdrawal_in_flight();
        let l = c.get_liabilities();
        assert_eq!((l.pending.0, l.in_flight.0), (0, 10 * USDC), "moved from pending to in flight, not dropped");
        let p = c.get_payout(1).unwrap();
        assert_eq!((p.account_id, p.amount.0, p.started_at), (accounts(1), 10 * USDC, 63_000));
        ctx(accounts(0), 64_000);
        assert!(c.on_payout(Some(1), None, None, None, Ok(())));
        assert_eq!(c.get_liabilities().in_flight.0, 0);
        assert!(c.get_payout(1).is_none());
        // A second answer to the same payout changes nothing.
        let before = liabilities(&c);
        assert!(!c.on_payout(Some(1), None, None, None, Err(PromiseError::Failed)));
        assert_eq!((liabilities(&c), c.get_liabilities().in_flight.0), (before, 0));
    }

    #[test]
    fn the_owner_settles_a_payout_whose_callback_never_ran() {
        // The transfer failed and the callback was lost: the funds go back to the player.
        let mut c = withdrawal_in_flight();
        ctx(accounts(0), 63_000 + PAYOUT_STUCK_MS);
        c.resolve_payout(1, false);
        let a = c.get_account(accounts(1));
        assert_eq!((a.withdraw_pending.0, c.get_liabilities().pending.0, c.get_liabilities().in_flight.0), (10 * USDC, 10 * USDC, 0));
        // A callback arriving after all finds nothing to do.
        assert!(c.on_payout(Some(1), None, None, None, Ok(())));
        assert_eq!((c.get_liabilities().pending.0, c.get_liabilities().in_flight.0), (10 * USDC, 0));

        // The transfer went through and the callback was lost: the record is dropped.
        let mut c = withdrawal_in_flight();
        ctx(accounts(0), 63_000 + PAYOUT_STUCK_MS);
        c.resolve_payout(1, true);
        let l = c.get_liabilities();
        assert_eq!((l.court.0, l.pending.0, l.in_flight.0), (20 * USDC, 0, 0));
        assert_eq!(event_types(&c).last().unwrap(), "withdraw");
    }

    #[test]
    fn only_the_owner_settles_a_payout_and_only_once_it_is_stuck() {
        let mut c = withdrawal_in_flight();
        ctx(accounts(0), 63_000 + PAYOUT_STUCK_MS - 1);
        refused("NOT_READY", || c.resolve_payout(1, false));
        ctx(accounts(1), 63_000 + PAYOUT_STUCK_MS);
        refused("NOT_OWNER", || c.resolve_payout(1, false));
        ctx(accounts(0), 63_000 + PAYOUT_STUCK_MS);
        refused("NO_PAYOUT", || c.resolve_payout(2, false));
        c.resolve_payout(1, false);
        refused("NO_PAYOUT", || c.resolve_payout(1, false));
    }

    /// The context for a call by `who` at `ms`, with the storage buffer one byte short.
    fn short_of_storage(who: AccountId, ms: u64, block: u64) {
        let balance = env::storage_byte_cost().saturating_mul((10_000 + STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES - 1) as u128);
        testing_env!(VMContextBuilder::new().signer_account_id(who.clone()).predecessor_account_id(who).block_timestamp(ms * 1_000_000).block_height(block).storage_usage(10_000).account_balance(balance).build());
    }

    #[test]
    fn challenges_store_no_events_or_streams_while_the_buffer_is_short_and_exits_fit() {
        let long = |c: char| -> AccountId { c.to_string().repeat(64).parse().unwrap() };
        let mut c = setup();
        // Short ids first, so the stored log holds short events for long ones to replace.
        player(&mut c, accounts(1), 30 * USDC, 0);
        for id in ['a', 'b', 'c', 'd'] {
            player(&mut c, long(id), 30 * USDC, 100 * USDC);
        }
        fund(&mut c, 100 * USDC);
        challenge_at(&mut c, long('a'), 3_000);
        flush(&mut c);
        let (events, root, owed) = (c.last_event_id, near_sdk::borsh::to_vec(&c).unwrap().len(), liabilities(&c));
        // New Kings with the longest ids, each after yield has accrued: a first stream entry
        // and a longer event each, if they were stored.
        for (i, id) in ['b', 'c', 'd', 'a', 'b', 'c'].into_iter().enumerate() {
            let i = i as u64;
            short_of_storage(long(id), 100_000 + i * 50_000, 10 + i * 5);
            let price = c.round.next_price;
            c.challenge(U128(price));
        }
        assert_eq!(c.round.king, Some(long('c')));
        assert_eq!(flush(&mut c), 10_000, "the challenges stored nothing new");
        assert_eq!((c.last_event_id, near_sdk::borsh::to_vec(&c).unwrap().len()), (events, root), "no stored events, and the contract's own record is no longer");
        assert!(!c.streams.contains_key(&long('d')), "no new stream entry");
        assert_eq!(liabilities(&c), owed, "the Kings' yield went to their balances; nothing left the books");
        // Leaving fits in the buffer: a request, a withdrawal and a claim in flight together.
        short_of_storage(long('d'), 500_000, 100);
        c.request_withdraw(U128(30 * USDC));
        assert!(flush(&mut c) <= 10_000, "asking to withdraw frees the draw slot; it stores nothing");
        short_of_storage(long('d'), 600_000, 101);
        let _ = c.withdraw();
        let _ = c.claim();
        c.payouts.flush();
        let grew = flush(&mut c) - 10_000;
        assert!(c.get_liabilities().in_flight.0 > 30 * USDC);
        assert!(grew > 0 && grew * 4 <= STORAGE_BUFFER_BYTES, "two payouts in flight stored {grew} bytes");
    }

    /// Storage once the call just made is written out as the generated export writes it: the
    /// collections, then the contract's own record.
    fn written(c: &mut Contract) -> u64 {
        flush(c);
        c.defenders.flush();
        c.payouts.flush();
        c.draw_entries.flush();
        env::state_write(c);
        env::storage_usage()
    }

    /// The context for a call by `who` at `ms`, with `spare` bytes' worth of NEAR beyond the
    /// 10,000 bytes the contract is counted as using.
    fn with_spare(who: AccountId, ms: u64, block: u64, spare: u64) {
        let balance = env::storage_byte_cost().saturating_mul((10_000 + spare) as u128);
        testing_env!(VMContextBuilder::new().signer_account_id(who.clone()).predecessor_account_id(who).block_timestamp(ms * 1_000_000).block_height(block).storage_usage(10_000).account_balance(balance).build());
    }

    #[test]
    fn draw_finalization_storage_is_measured_with_existing_and_deleted_winners() {
        // One entry is the worst case for how little frozen storage finalization releases.
        // Exercise the real drand verifier, account deletion through payout callbacks, and
        // the final collection/root writes. A mock does NOT enforce NEAR receipt solvency.
        for length in [2, 64] {
            for deleted in [false, true] {
                for spare in [0, STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES] {
                    near_sdk::mock::with_mocked_blockchain(|b| b.take_storage());
                    let winner: AccountId = "a".repeat(length).parse().unwrap();
                    let mut c = setup();
                    player(&mut c, winner.clone(), 30 * USDC, 0);
                    // Seed a valid pot without adding other eligible Court accounts.
                    c.draw_pot = USDC;
                    let close = fixture_close_ms();
                    ctx(accounts(4), close);
                    c.close_draw();
                    assert_eq!(c.pending_draw.as_ref().unwrap().round, drand::tests::ROUND);
                    if deleted {
                        ctx(winner.clone(), close + 1);
                        c.request_withdraw(U128(30 * USDC));
                        ctx(winner.clone(), close + 60_001);
                        let _ = c.withdraw();
                        ctx(accounts(0), close + 60_002);
                        assert!(answer(&mut c, winner.clone(), 30 * USDC, PayoutKind::Withdraw, true));
                        assert!(!c.accounts.contains_key(&winner));
                    }
                    written(&mut c);
                    with_spare(accounts(4), close + 70_000, 200, spare);
                    let before = written(&mut c);
                    let owed = liabilities(&c);
                    let balance = c.get_account(winner.clone()).balance.0;
                    c.finalize_draw(drand::tests::SIG.into());
                    let after = written(&mut c);
                    let delta = after as i64 - before as i64;
                    println!("draw finalization: id_len={length} deleted={deleted} spare={spare} delta_bytes={delta}");
                    assert!(c.pending_draw.is_none() && c.draw_entries.is_none());
                    assert_eq!(c.get_account(winner).balance.0, balance + USDC);
                    assert_eq!(liabilities(&c), owed);
                    assert!(delta <= STORAGE_BUFFER_BYTES as i64, "finalization exceeded the storage buffer");
                    if !deleted {
                        assert!(delta <= 0, "existing winner unexpectedly grew storage");
                    }
                }
            }
        }
    }

    #[test]
    fn freezing_a_draw_needs_room_for_its_entries_on_top_of_the_buffer() {
        let long = |c: char| -> AccountId { c.to_string().repeat(64).parse().unwrap() };
        let buffer = STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES;
        let mut c = draw_ready();
        c.timing.trigger_fixed = Some(U128(1_000 * USDC));
        for id in ['a', 'b', 'c', 'd'] {
            player(&mut c, long(id), 30 * USDC, 100 * USDC);
        }
        // Six entries: two short ids and four of the longest.
        let entries: u64 = 4 + [accounts(1), accounts(2), long('a'), long('b'), long('c'), long('d')].iter().map(|id| 4 + id.len() as u64 + 16).sum::<u64>();
        let needs = entries + DRAW_FREEZE_OVERHEAD_BYTES;
        let close = fixture_close_ms();
        with_spare(accounts(4), close, 100, buffer);
        written(&mut c);
        let (pot, epoch, weight) = (c.draw_pot, c.draw_epoch, c.draw_weights.get(&long('a')).map(|w| (w.acc, w.last_touch, w.epoch)));

        // One byte short of the entries plus the buffer: refused, and the draw is as it was.
        with_spare(accounts(4), close, 100, buffer + needs - 1);
        refused("PAUSED", || c.close_draw());
        assert!(c.pending_draw.is_none() && c.draw_entries.is_none());
        assert_eq!((c.draw_pot, c.draw_epoch, c.draw_weights.get(&long('a')).map(|w| (w.acc, w.last_touch, w.epoch))), (pot, epoch, weight));

        // With exactly that much it freezes, and what it stored fits what was budgeted, so
        // the buffer is whole afterwards.
        with_spare(accounts(4), close, 100, buffer + needs);
        c.close_draw();
        let stored = written(&mut c) - 10_000;
        assert!(c.pending_draw.is_some());
        assert!(stored > entries && stored <= needs, "freezing stored {stored} bytes against {needs} budgeted");

        // While the draw waits for drand, one byte short of the buffer: the old round settles,
        // then a first King with the longest id and a first showdown grow only the reserved
        // record, and leaving still works.
        short_of_storage(accounts(4), close + 500, 199);
        c.settle_round();
        assert_eq!(c.round.king, None);
        written(&mut c);
        c.timing.trigger_fixed = Some(U128(1));
        short_of_storage(long('a'), close + 1_000, 200);
        let price = c.round.next_price;
        c.challenge(U128(price));
        assert_eq!(flush(&mut c), 10_000, "nothing new in the collections");
        let grew = written(&mut c) - 10_000;
        assert!(c.round.showdown_ends_at.is_some() && c.round.king == Some(long('a')));
        assert_eq!(grew, 4 + 64 + 8 + 8, "the King, `king_since` and the showdown's end; the first buy block was set long ago");
        short_of_storage(long('b'), close + 2_000, 201);
        let _ = c.claim();
        assert!(c.get_liabilities().in_flight.0 > 0 && c.pending_draw.is_some());
    }

    #[test]
    fn a_first_king_a_longer_king_and_a_first_showdown_grow_only_the_reserved_record() {
        let long = |c: char| -> AccountId { c.to_string().repeat(64).parse().unwrap() };
        let mut c = setup();
        // Set before measuring: only its value changes later, not its length.
        c.timing.trigger_fixed = Some(U128(1_000 * USDC));
        player(&mut c, accounts(1), 30 * USDC, 100 * USDC);
        for id in ['a', 'b'] {
            player(&mut c, long(id), 30 * USDC, 100 * USDC);
        }
        arm(&mut c, long('b'), 50 * USDC);
        fund(&mut c, 100 * USDC);
        assert_eq!((c.round.king.clone(), c.round.king_since, c.round.showdown_ends_at, c.last_buy_block), (None, None, None, None), "the record is at its shortest");
        let shortest = near_sdk::borsh::to_vec(&c).unwrap().len() as u64;
        short_of_storage(accounts(1), 3_000, 0);
        written(&mut c);
        // Each call runs one byte short of the buffer. `short_of_storage` restarts the count at
        // 10,000, so what `written` returns above that is what the call stored.
        let step = |c: &mut Contract, who: AccountId, ms: u64, block: u64| -> u64 {
            short_of_storage(who, ms, block);
            let price = c.round.next_price;
            c.challenge(U128(price));
            assert_eq!(flush(c), 10_000, "nothing new in the collections");
            written(c) - 10_000
        };
        // A first King: his id, `king_since` and the first buy block.
        let short_id = accounts(1).as_str().len() as u64;
        assert_eq!(step(&mut c, accounts(1), 100_000, 10), 4 + short_id + 8 + 8);
        // A King with the longest id replaces him, after yield accrued for the first.
        assert_eq!(step(&mut c, long('a'), 150_000, 15), 64 - short_id);
        // The Jackpot is at the trigger, so the next challenge starts the first showdown.
        c.timing.trigger_fixed = Some(U128(c.round.jackpot));
        assert_eq!(step(&mut c, long('b'), 200_000, 20), 8);
        assert!(c.round.showdown_ends_at.is_some());
        // A challenge that is retaken at once: two more crownings, nothing more stored.
        assert_eq!(step(&mut c, long('a'), 210_000, 25), 0);
        assert_eq!((c.round.king.clone(), c.round.challenges), (Some(long('b')), 5), "long('b') retook the throne");
        // That is all of it: the record is at its longest, and it grew by exactly the reserve.
        assert_eq!(near_sdk::borsh::to_vec(&c).unwrap().len() as u64 - shortest, ROOT_GROWTH_BYTES);
    }

    #[test]
    fn the_draw_waits_while_the_storage_buffer_is_short() {
        let mut c = draw_ready();
        short_of_storage(accounts(4), fixture_close_ms(), 100);
        refused("PAUSED", || c.close_draw());
        assert!(c.pending_draw.is_none());
        ctx(accounts(4), fixture_close_ms());
        c.close_draw();
        assert!(c.pending_draw.is_some());
    }

    #[test]
    fn the_newest_payout_id_is_readable() {
        assert_eq!(setup().get_last_payout_id(), 0);
        let c = withdrawal_in_flight();
        assert_eq!(c.get_last_payout_id(), 1);
    }

    #[test]
    fn a_payout_sent_before_the_upgrade_is_booked_from_its_old_arguments() {
        // M10 took the amount off the books and kept no record; its callback names the account.
        let mut c = setup();
        deposit(&mut c, accounts(1), 30 * USDC, r#"{"action":"join"}"#);
        ctx(accounts(1), 3_000);
        c.request_withdraw(U128(10 * USDC));
        let a = c.accounts.get_mut(&accounts(1)).unwrap();
        a.withdraw_pending = 0;
        a.withdraw_ready_at = None;
        c.pending_total = 0;
        ctx(accounts(0), 64_000);
        assert!(!c.on_payout(None, Some(accounts(1)), Some(U128(10 * USDC)), Some(PayoutKind::Withdraw), Err(PromiseError::Failed)));
        let a = c.get_account(accounts(1));
        assert_eq!((a.withdraw_pending.0, a.withdraw_ready_at, c.get_liabilities().pending.0, c.get_liabilities().in_flight.0), (10 * USDC, Some(64_000), 10 * USDC, 0));
        // Paid: only the event, as M10 did.
        assert!(c.on_payout(None, Some(accounts(1)), Some(U128(5 * USDC)), Some(PayoutKind::Withdraw), Ok(())));
        assert_eq!((c.get_liabilities().pending.0, event_types(&c).last().unwrap().as_str()), (10 * USDC, "withdraw"));
        // Neither shape: nothing happens.
        let before = liabilities(&c);
        assert!(!c.on_payout(None, Some(accounts(1)), None, None, Err(PromiseError::Failed)));
        assert_eq!(liabilities(&c), before);
    }

    #[test]
    fn a_withdrawal_that_lowers_the_trigger_to_the_jackpot_starts_the_showdown_at_the_next_poke() {
        // The default trigger: 0.2% of the Court. No yield reserve, so only the poke can see it.
        ctx(accounts(0), 1_000);
        let timing = Timing { trigger_bps: 20, trigger_fixed: None, backstop_ms: 300_000, showdown_ms: 90_000, snipe_ms: 15_000 };
        let mut c = Contract::new(token(), 60_000, 5_000, Some(timing), None, None, None, None, None, None);
        player(&mut c, accounts(1), 30 * USDC, 50 * USDC);
        player(&mut c, accounts(2), 5_000 * USDC, 0);
        challenge_at(&mut c, accounts(1), 3_000);
        assert_eq!((c.round.jackpot, c.round.showdown_ends_at), (4 * USDC, None), "4 is under 0.2% of 5,030");
        ctx(accounts(2), 4_000);
        c.request_withdraw(U128(4_000 * USDC));
        assert_eq!(c.round.showdown_ends_at, None);
        poke_at(&mut c, 5_000);
        assert_eq!(c.round.showdown_ends_at, Some(95_000), "4 is over 0.2% of 1,030");
        assert_eq!(serde_json::to_value(c.get_events(0).events.last().unwrap()).unwrap()["data"]["reason"], "size");
    }

    #[test]
    fn event_log_is_bounded_and_paged() {
        let mut c = setup();
        for _ in 0..(EVENT_LOG_MAX + 10) {
            // One context per call: the mock caps logs per call, like the chain does.
            deposit(&mut c, accounts(1), MIN_DEPOSIT, r#"{"action":"join"}"#);
        }
        let page = c.get_events(0);
        assert_eq!(page.events.len() as u64, PAGE_MAX);
        assert_eq!(page.events.last().unwrap().id, EVENT_LOG_MAX + 10);
        assert!(c.events.get(&10).is_none());
        assert_eq!(c.get_events(EVENT_LOG_MAX + 8).events.len(), 2);
        // A client ahead of the log (after a redeploy) gets the real cursor back; no overflow.
        assert_eq!(c.get_events(u64::MAX).cursor, EVENT_LOG_MAX + 10);
    }
}
