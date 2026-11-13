//! Independent black-box sandbox tests for the M3 round lifecycle (showdown, snipe, settle).
//!
//! Written from the M3 spec, not from the contract source. Expected values come from this
//! file's own model of the curve and split, never from values the contract reports.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, Chain, Contract, NearGas, NearToken, NetworkConfig, Reference, Signer};
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

type R<T> = Result<T, Box<dyn std::error::Error>>;

const USDC: u128 = 1_000_000;
const START_PRICE: u128 = 5_000_000;
const STEP_BPS: u128 = 300;
const SPLIT_BPS: [u128; 4] = [5_500, 2_500, 1_500, 500];

static WASMS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
/// The tests depend on block time relative to real time, so they run one at a time to keep
/// their timing preconditions comfortable on a loaded machine.
static SERIAL: Mutex<()> = Mutex::new(());

fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    WASMS.get_or_init(|| {
        let dir = env!("CARGO_MANIFEST_DIR");
        let build = |manifest: String| {
            let path = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
                manifest_path: Some(manifest.into()),
                ..Default::default()
            })
            .expect("build wasm");
            std::fs::read(path).expect("read wasm")
        };
        let usdc = build(format!("{dir}/../test-usdc/Cargo.toml"));
        let pool = build(format!("{dir}/Cargo.toml"));
        (usdc, pool)
    })
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- independent model ------------------------------------------------------------

fn next_price(p: u128) -> u128 {
    p * (10_000 + STEP_BPS) / 10_000
}

/// [Jackpot, King, Court, protocol], each floored, remainder to the Jackpot.
fn split(p: u128) -> [u128; 4] {
    let king = p * SPLIT_BPS[1] / 10_000;
    let court = p * SPLIT_BPS[2] / 10_000;
    let protocol = p * SPLIT_BPS[3] / 10_000;
    [p - king - court - protocol, king, court, protocol]
}

/// round-half-up(jackpot * 100 / last_price): the multiple in hundredths.
fn multiple_x100(jackpot: u128, last_price: u128) -> u128 {
    (2 * jackpot * 100 + last_price) / (2 * last_price)
}

struct RoundModel {
    k: u32,
    price: u128,
    jackpot: u128,
    king: Option<AccountId>,
    last_price: u128,
}

impl RoundModel {
    fn new() -> Self {
        Self { k: 0, price: START_PRICE, jackpot: 0, king: None, last_price: 0 }
    }

    /// Applies a successful challenge and returns the price paid.
    fn challenge(&mut self, by: &AccountId) -> u128 {
        let p = self.price;
        let [jack, king_share, _, _] = split(p);
        // On the round's first challenge there is no King, so the King share joins the Jackpot.
        self.jackpot += if self.king.is_none() { jack + king_share } else { jack };
        self.king = Some(by.clone());
        self.k += 1;
        self.last_price = p;
        self.price = next_price(p);
        p
    }
}

/// Jackpot after `k` tickets of a fresh round.
fn jackpot_after(k: u32) -> u128 {
    let players: [AccountId; 2] = ["a.sandbox".parse().unwrap(), "b.sandbox".parse().unwrap()];
    let mut m = RoundModel::new();
    for i in 0..k as usize {
        m.challenge(&players[i % 2]);
    }
    m.jackpot
}

// ---- harness ------------------------------------------------------------------------

fn u(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("expected a U128 string, got {v}")).parse().expect("U128 string")
}

fn ms(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("expected an integer, got {v}"))
}

fn timing(trigger_fixed: Option<u128>, trigger_bps: u32, backstop_ms: u64, showdown_ms: u64, snipe_ms: u64) -> Value {
    json!({
        "trigger_bps": trigger_bps,
        "trigger_fixed": trigger_fixed.map(|t| t.to_string()),
        "backstop_ms": backstop_ms,
        "showdown_ms": showdown_ms,
        "snipe_ms": snipe_ms,
    })
}

fn expect_err(tx: TransactionResult, code: &str) {
    assert!(!tx.is_success(), "expected failure with {code}, but the call succeeded");
    let dbg = format!("{:?}", tx.assert_failure());
    assert!(dbg.contains(code), "expected failure with {code}, got: {dbg}");
}

fn of_type<'a>(events: &'a [Value], ty: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["type"] == ty).collect()
}

fn one_of_type<'a>(events: &'a [Value], ty: &str) -> &'a Value {
    let found = of_type(events, ty);
    assert_eq!(found.len(), 1, "expected exactly one {ty} event in {events:?}");
    found[0]
}

fn multiple_of(settled: &Value) -> f64 {
    settled["data"]["multiple"].as_f64().unwrap_or_else(|| panic!("multiple must be a JSON number: {settled}"))
}

/// The emitted multiple must be exactly x100 / 100 (already rounded), not the raw ratio.
fn assert_multiple(settled: &Value, x100: u128) {
    let mult = multiple_of(settled);
    let expected = x100 as f64 / 100.0;
    assert!((mult - expected).abs() < 1e-9, "multiple: expected {expected}, got {mult}");
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    usdc: AccountId,
    pool: AccountId,
    cursor: u64,
    ms_per_block: Option<f64>,
}

impl Env {
    /// Sandbox with test USDC deployed; no RugPool yet.
    async fn start() -> R<Self> {
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        let env = Self {
            sandbox,
            net,
            signer,
            usdc: "usdc.sandbox".parse()?,
            pool: "pool.sandbox".parse()?,
            cursor: 0,
            ms_per_block: None,
        };
        env.create(&env.usdc).await?;
        Contract::deploy(env.usdc.clone())
            .use_code(wasms().0.clone())
            .with_init_call("new", json!({}))?
            .with_signer(env.signer.clone())
            .send_to(&env.net)
            .await?
            .assert_success();
        Ok(env)
    }

    /// Sandbox, test USDC and a RugPool at `pool.sandbox` initialised with `timing`.
    async fn new(timing: Value) -> R<Self> {
        let mut env = Self::start().await?;
        let pool = env.pool.clone();
        env.deploy_pool(&pool, timing).await?.assert_success();
        env.sync_events().await?;
        Ok(env)
    }

    async fn create(&self, id: &AccountId) -> R<()> {
        self.sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(20)).send().await?;
        Ok(())
    }

    /// Creates `id`, registers it on the token and deploys RugPool with `new(..)`.
    async fn deploy_pool(&self, id: &AccountId, timing: Value) -> R<TransactionResult> {
        self.create(id).await?;
        self.call(id, &self.usdc, "storage_deposit", json!({ "account_id": id }), NearToken::from_millinear(10))
            .await?
            .assert_success();
        let args = json!({
            "token": self.usdc,
            "withdraw_cooldown_ms": 1_000u64,
            "court_draw_bps": 3_000u32,
            "timing": timing,
        });
        Ok(Contract::deploy(id.clone())
            .use_code(wasms().1.clone())
            .with_init_call("new", args)?
            .with_signer(self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn call(&self, from: &AccountId, contract: &AccountId, method: &str, args: Value, deposit: NearToken) -> R<TransactionResult> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(150))
            .with_signer(from.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn pool_call(&self, from: &AccountId, method: &str) -> R<TransactionResult> {
        self.call(from, &self.pool, method, json!({}), NearToken::from_yoctonear(0)).await
    }

    async fn challenge(&self, from: &AccountId, max_price: u128) -> R<TransactionResult> {
        let args = json!({ "max_price": max_price.to_string() });
        self.call(from, &self.pool, "challenge", args, NearToken::from_yoctonear(0)).await
    }

    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> R<Value> {
        Ok(Contract(contract.clone()).call_function(method, args).read_only::<Value>().fetch_from(&self.net).await?.data)
    }

    async fn state(&self) -> R<Value> {
        self.view(&self.pool, "get_state", json!({})).await
    }

    async fn round(&self) -> R<Value> {
        Ok(self.state().await?["round"].clone())
    }

    async fn liabilities(&self) -> R<Value> {
        self.view(&self.pool, "get_liabilities", json!({})).await
    }

    async fn account(&self, id: &AccountId) -> R<Value> {
        self.view(&self.pool, "get_account", json!({ "account_id": id })).await
    }

    async fn ft_balance(&self, id: &AccountId) -> R<u128> {
        Ok(u(&self.view(&self.usdc, "ft_balance_of", json!({ "account_id": id })).await?))
    }

    async fn game_balance(&self, id: &AccountId) -> R<u128> {
        Ok(u(&self.account(id).await?["balance"]))
    }

    /// With no payout in flight: ft_balance_of(RugPool) == sum of get_liabilities().
    async fn check_invariant(&self, when: &str) -> R<()> {
        let l = self.liabilities().await?;
        let sum: u128 = ["balances", "court", "jackpot", "rewards", "draw_pot", "treasury"].iter().map(|k| u(&l[*k])).sum();
        let held = self.ft_balance(&self.pool).await?;
        assert_eq!(held, sum, "invariant broken after {when}: token balance {held} != liabilities {l}");
        Ok(())
    }

    /// Events newer than the cursor; advances the cursor.
    async fn events(&mut self) -> R<Vec<Value>> {
        let page = self.view(&self.pool, "get_events", json!({ "from": self.cursor })).await?;
        let events = page["events"].as_array().cloned().unwrap_or_default();
        for e in &events {
            assert!(ms(&e["id"]) > self.cursor, "get_events returned an old event: {e}");
        }
        self.cursor = ms(&page["cursor"]).max(self.cursor);
        Ok(events)
    }

    async fn sync_events(&mut self) -> R<()> {
        self.events().await?;
        Ok(())
    }

    /// Timestamp (ms) of the latest block.
    async fn now_ms(&self) -> R<u64> {
        Ok(Chain::block().fetch_from(&self.net).await?.header.timestamp / 1_000_000)
    }

    /// Block time (ms) of the block that executed the RugPool receipt of `tx`.
    async fn exec_ms(&self, tx: &TransactionResult) -> R<u64> {
        let full = tx.clone().into_full().expect("full result");
        let outcome = full
            .receipt_outcomes()
            .iter()
            .find(|o| o.executor_id == self.pool)
            .expect("a receipt executed on RugPool");
        let block = Chain::block().at(Reference::AtBlockHash(outcome.block_hash)).fetch_from(&self.net).await?;
        Ok(block.header.timestamp / 1_000_000)
    }

    /// Fast-forwards until the latest block time is at least `target_ms`.
    async fn advance_to(&mut self, target_ms: u64) -> R<u64> {
        for _ in 0..200 {
            let now = self.now_ms().await?;
            if now >= target_ms {
                return Ok(now);
            }
            let remaining = (target_ms - now) as f64;
            let n = match self.ms_per_block {
                None => 10,
                Some(rate) => ((remaining / rate).ceil() as u64).clamp(1, 5_000),
            };
            self.sandbox.fast_forward(n).await?;
            let after = self.now_ms().await?;
            if after > now {
                self.ms_per_block = Some((after - now) as f64 / n as f64);
            }
        }
        Err("advance_to did not reach the target".into())
    }

    /// A funded player with `court` in the Court and `game` in the game balance.
    async fn player(&mut self, name: &str, court: u128, game: u128) -> R<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self.create(&id).await?;
        self.call(&id, &self.usdc, "storage_deposit", json!({ "account_id": id }), NearToken::from_millinear(10))
            .await?
            .assert_success();
        let mut left = court + game;
        while left > 0 {
            let chunk = left.min(1_000 * USDC);
            let args = json!({ "account_id": id, "amount": chunk.to_string() });
            self.call(&id, &self.usdc, "mint", args, NearToken::from_yoctonear(0)).await?.assert_success();
            left -= chunk;
        }
        for (amount, msg) in [(court, r#"{"action":"join"}"#), (game, "")] {
            if amount == 0 {
                continue;
            }
            let args = json!({ "receiver_id": self.pool, "amount": amount.to_string(), "msg": msg });
            self.call(&id, &self.usdc, "ft_transfer_call", args, NearToken::from_yoctonear(1)).await?.assert_success();
        }
        let acc = self.account(&id).await?;
        assert_eq!(u(&acc["court"]), court, "court deposit for {id}");
        assert_eq!(u(&acc["balance"]), game, "game deposit for {id}");
        assert_eq!(self.ft_balance(&id).await?, 0, "all minted funds deposited for {id}");
        self.check_invariant("deposits").await?;
        self.sync_events().await?;
        Ok(id)
    }

    /// Everything a ROUND_CLOSED challenge must leave untouched.
    async fn snapshot(&self, who: &[&AccountId]) -> R<Vec<Value>> {
        let mut v = vec![self.state().await?, self.liabilities().await?, json!(self.ft_balance(&self.pool).await?.to_string())];
        for id in who {
            // Draw odds grow with time since M6, so they aren't part of "nothing moved".
            let mut a = self.account(id).await?;
            a.as_object_mut().unwrap().remove("draw_weight_bps");
            v.push(a);
            v.push(json!(self.ft_balance(id).await?.to_string()));
        }
        Ok(v)
    }
}

/// Challenges at the modelled price, applies the model, and checks the event and round view.
/// Returns (new events, challenged.at).
async fn checked_challenge(env: &mut Env, m: &mut RoundModel, by: &AccountId) -> R<(Vec<Value>, u64)> {
    let tx = env.challenge(by, m.price).await?;
    assert!(tx.is_success(), "challenge by {by} at {} failed: {:?}", m.price, tx.clone().assert_failure());
    let paid = m.challenge(by);
    let events = env.events().await?;
    let ch = one_of_type(&events, "challenged");
    assert_eq!(ch["data"]["by"], by.to_string());
    assert_eq!(u(&ch["data"]["price"]), paid, "ticket price");
    let at = ms(&ch["at"]);
    let r = env.round().await?;
    assert_eq!(r["challenges"].as_u64(), Some(m.k as u64), "challenge count");
    assert_eq!(u(&r["jackpot"]), m.jackpot, "Jackpot after ticket {}", m.k);
    assert_eq!(u(&r["next_price"]), m.price, "next price after ticket {}", m.k);
    assert_eq!(r["king"], by.to_string());
    assert_eq!(r["king_since"].as_u64(), Some(at), "king_since is the challenge time");
    env.check_invariant(&format!("challenge {} by {by}", m.k)).await?;
    Ok((events, at))
}

/// The round view is a freshly opened round `id` with an empty Jackpot, started at `at`.
fn assert_fresh_round(r: &Value, id: u64, at: u64, backstop_ms: u64) {
    assert_eq!(r["id"].as_u64(), Some(id), "round id: {r}");
    assert_eq!(r["challenges"].as_u64(), Some(0), "challenges reset: {r}");
    assert_eq!(u(&r["next_price"]), START_PRICE, "price resets to the start price: {r}");
    assert!(r["king"].is_null(), "king reset: {r}");
    assert!(r["showdown_ends_at"].is_null(), "showdown reset: {r}");
    assert_eq!(u(&r["jackpot"]), 0, "Jackpot after a settle with a King (or an empty carry): {r}");
    assert_eq!(ms(&r["started_at"]), at, "started_at is the settle time: {r}");
    assert_eq!(ms(&r["backstop_at"]), at + backstop_ms, "backstop_at = started_at + backstop_ms: {r}");
}

/// claim() pays exactly balance + court_earned to the wallet and zeroes both.
async fn checked_claim(env: &Env, who: &AccountId) -> R<()> {
    let before = env.account(who).await?;
    let owed = u(&before["balance"]) + u(&before["court_earned"]);
    let wallet = env.ft_balance(who).await?;
    env.pool_call(who, "claim").await?.assert_success();
    assert_eq!(env.ft_balance(who).await?, wallet + owed, "claim pays balance + court earnings exactly ({before})");
    let after = env.account(who).await?;
    assert_eq!(u(&after["balance"]), 0, "balance after claim");
    assert_eq!(u(&after["court_earned"]), 0, "court earnings after claim");
    assert_eq!(after["court"], before["court"], "Court principal stays");
    env.check_invariant(&format!("claim by {who}")).await?;
    Ok(())
}

// ---- tests --------------------------------------------------------------------------

/// 1. The size showdown starts on exactly the ticket whose Jackpot reaches a fixed trigger.
#[tokio::test]
async fn size_trigger_starts_showdown_on_crossing_ticket() -> TestResult {
    let _g = lock();
    // Trigger equal to the modelled Jackpot after ticket 4 separates >= from >.
    let trigger = jackpot_after(4);
    assert_eq!(trigger, 12_754_976);
    assert!(jackpot_after(3) < trigger);
    let (showdown_ms, snipe_ms) = (600_000, 60_000);
    let mut env = Env::new(timing(Some(trigger), 20, 3_600_000, showdown_ms, snipe_ms)).await?;
    let a = env.player("alice", 30 * USDC, 100 * USDC).await?;
    let b = env.player("bob", 30 * USDC, 100 * USDC).await?;

    let s = env.state().await?;
    assert_eq!(u(&s["round"]["showdown_trigger"]), trigger, "fixed trigger is reported");
    assert_eq!(s["params"]["showdown_ms"].as_u64(), Some(showdown_ms));
    assert_eq!(s["params"]["snipe_ms"].as_u64(), Some(snipe_ms));

    let mut m = RoundModel::new();
    for who in [&a, &b, &a] {
        let (events, _) = checked_challenge(&mut env, &mut m, who).await?;
        assert!(of_type(&events, "showdown_started").is_empty(), "no showdown before the crossing ticket ({})", m.k);
        assert!(env.round().await?["showdown_ends_at"].is_null());
    }

    let tx = env.challenge(&b, m.price).await?;
    let exec = env.exec_ms(&tx).await?;
    tx.assert_success();
    m.challenge(&b);
    assert_eq!(m.jackpot, trigger);
    let events = env.events().await?;
    let at = ms(&one_of_type(&events, "challenged")["at"]);
    let sd = one_of_type(&events, "showdown_started");
    assert_eq!(at, exec, "event time is the block time of the challenge");
    assert_eq!(sd["data"]["reason"], "size");
    let ends = ms(&sd["data"]["ends_at"]);
    assert_eq!(ends, at + showdown_ms, "ends_at = challenge block time + showdown_ms");
    let r = env.round().await?;
    assert_eq!(r["showdown_ends_at"].as_u64(), Some(ends));
    assert_eq!(u(&r["jackpot"]), trigger);
    env.check_invariant("crossing ticket").await?;

    // A later ticket with plenty of time left neither restarts nor extends the showdown.
    let (events, at5) = checked_challenge(&mut env, &mut m, &a).await?;
    assert!(ends - at5 >= snipe_ms, "precondition: outside the snipe window");
    assert!(of_type(&events, "showdown_started").is_empty(), "showdown must not restart");
    assert_eq!(env.round().await?["showdown_ends_at"].as_u64(), Some(ends));
    Ok(())
}

/// 2. NOT_READY with no showdown and mid-showdown; ROUND_CLOSED after the end moves nothing.
#[tokio::test]
async fn round_closed_and_not_ready() -> TestResult {
    let _g = lock();
    let trigger = jackpot_after(3);
    let showdown_ms = 15_000;
    let mut env = Env::new(timing(Some(trigger), 20, 3_600_000, showdown_ms, 1_000)).await?;
    let a = env.player("alice", 30 * USDC, 100 * USDC).await?;
    let b = env.player("bob", 30 * USDC, 100 * USDC).await?;
    let c = env.player("carol", 30 * USDC, 100 * USDC).await?;

    expect_err(env.pool_call(&c, "settle_round").await?, "NOT_READY");

    let mut m = RoundModel::new();
    checked_challenge(&mut env, &mut m, &a).await?;
    checked_challenge(&mut env, &mut m, &b).await?;
    let (events, _) = checked_challenge(&mut env, &mut m, &a).await?;
    let ends = ms(&one_of_type(&events, "showdown_started")["data"]["ends_at"]);

    let tx = env.pool_call(&c, "settle_round").await?;
    let exec = env.exec_ms(&tx).await?;
    assert!(exec < ends, "precondition: settle attempt landed before the end");
    expect_err(tx, "NOT_READY");
    assert!(env.events().await?.is_empty(), "a failed settle emits nothing");

    env.advance_to(ends).await?;
    let before = env.snapshot(&[&a, &b, &c]).await?;
    // Each would be valid if the round were open: Court >= 25, funds, not King, max >= price.
    for who in [&c, &b] {
        let tx = env.challenge(who, m.price * 2).await?;
        let exec = env.exec_ms(&tx).await?;
        assert!(exec >= ends, "precondition: challenge landed after the end");
        expect_err(tx, "ROUND_CLOSED");
    }
    assert_eq!(env.snapshot(&[&a, &b, &c]).await?, before, "ROUND_CLOSED moved funds or state");
    assert!(env.events().await?.is_empty(), "ROUND_CLOSED emits nothing");
    env.check_invariant("ROUND_CLOSED").await?;

    let a_before = env.game_balance(&a).await?;
    env.pool_call(&c, "settle_round").await?.assert_success();
    let events = env.events().await?;
    let st = one_of_type(&events, "round_settled");
    assert_eq!(st["data"]["winner"], a.to_string());
    assert_eq!(u(&st["data"]["jackpot"]), trigger);
    assert_eq!(multiple_x100(m.jackpot, m.last_price), 184);
    assert_multiple(st, 184);
    assert_eq!(env.game_balance(&a).await?, a_before + trigger);
    env.check_invariant("settle").await?;
    Ok(())
}

/// 3. Settle with a King: exact payout, multiple, reset, no double settle, exact claim.
#[tokio::test]
async fn settle_pays_king_and_opens_next_round() -> TestResult {
    let _g = lock();
    let trigger = jackpot_after(5);
    let (backstop_ms, showdown_ms) = (3_600_000, 10_000);
    let mut env = Env::new(timing(Some(trigger), 20, backstop_ms, showdown_ms, 1_000)).await?;
    let a = env.player("alice", 30 * USDC, 100 * USDC).await?;
    let b = env.player("bob", 30 * USDC, 100 * USDC).await?;
    let keeper: AccountId = "keeper.sandbox".parse()?;
    env.create(&keeper).await?;

    let mut m = RoundModel::new();
    let mut ends = None;
    for who in [&a, &b, &a, &b, &a] {
        let (events, _) = checked_challenge(&mut env, &mut m, who).await?;
        if let Some(sd) = of_type(&events, "showdown_started").first() {
            assert_eq!(m.k, 5, "size showdown on ticket 5");
            ends = Some(ms(&sd["data"]["ends_at"]));
        }
    }
    let ends = ends.expect("size showdown started");
    let jackpot = m.jackpot;
    assert_eq!(jackpot, 15_850_126);
    let expected_x100 = multiple_x100(jackpot, m.last_price);
    assert_eq!(expected_x100, 282, "half-up (2.82) differs from floor (2.81) here");

    env.advance_to(ends).await?;
    let winner_before = env.game_balance(&a).await?;
    let loser_before = env.game_balance(&b).await?;
    let tx = env.pool_call(&keeper, "settle_round").await?;
    let exec = env.exec_ms(&tx).await?;
    tx.assert_success();
    let events = env.events().await?;
    let st = one_of_type(&events, "round_settled");
    assert_eq!(st["data"]["winner"], a.to_string());
    assert_eq!(u(&st["data"]["jackpot"]), jackpot);
    assert_multiple(st, expected_x100);
    assert_eq!(ms(&st["at"]), exec);
    assert_eq!(env.game_balance(&a).await?, winner_before + jackpot, "King receives exactly the Jackpot");
    assert_eq!(env.game_balance(&b).await?, loser_before);

    let r = env.round().await?;
    assert_fresh_round(&r, 2, exec, backstop_ms);
    assert!(r["king_since"].is_null(), "king_since reset: {r}");
    assert_eq!(u(&env.liabilities().await?["jackpot"]), 0);
    env.check_invariant("settle").await?;

    // Settling again pays nothing twice.
    expect_err(env.pool_call(&keeper, "settle_round").await?, "NOT_READY");
    assert_eq!(env.game_balance(&a).await?, winner_before + jackpot);
    assert!(env.events().await?.is_empty());

    checked_claim(&env, &a).await?;
    checked_claim(&env, &b).await?;
    Ok(())
}

/// 4. Time showdown via poke at the backstop, settle with no King; then in round 2 a challenge
///    past the backstop starts the showdown (reason "time") before the challenge is processed.
#[tokio::test]
async fn time_trigger_poke_and_challenge() -> TestResult {
    let _g = lock();
    // A tiny fixed trigger: a challenge processed before the time check would start "size".
    let (backstop_ms, showdown_ms, snipe_ms) = (30_000, 6_000, 1_000);
    let mut env = Env::new(timing(Some(1), 20, backstop_ms, showdown_ms, snipe_ms)).await?;
    let keeper: AccountId = "keeper.sandbox".parse()?;
    env.create(&keeper).await?;

    let r = env.round().await?;
    let backstop_at = ms(&r["backstop_at"]);
    assert_eq!(backstop_at, ms(&r["started_at"]) + backstop_ms);
    assert!(r["showdown_ends_at"].is_null());

    let tx = env.pool_call(&keeper, "poke").await?;
    let exec = env.exec_ms(&tx).await?;
    tx.assert_success();
    assert!(exec < backstop_at, "precondition: poke landed before the backstop");
    assert!(env.round().await?["showdown_ends_at"].is_null(), "poke before the backstop does nothing");
    assert!(env.events().await?.is_empty(), "poke before the backstop emits nothing");

    let a = env.player("alice", 30 * USDC, 50 * USDC).await?;

    env.advance_to(backstop_at).await?;
    let tx = env.pool_call(&keeper, "poke").await?;
    let exec = env.exec_ms(&tx).await?;
    tx.assert_success();
    let events = env.events().await?;
    let sd = one_of_type(&events, "showdown_started");
    assert_eq!(sd["data"]["reason"], "time");
    let ends = ms(&sd["data"]["ends_at"]);
    assert_eq!(ends, exec + showdown_ms, "ends_at = poke block time + showdown_ms");
    assert_eq!(env.round().await?["showdown_ends_at"].as_u64(), Some(ends));

    let tx = env.pool_call(&keeper, "poke").await?;
    let exec2 = env.exec_ms(&tx).await?;
    tx.assert_success();
    assert!(exec2 < ends, "precondition: second poke during the showdown");
    assert!(env.events().await?.is_empty(), "a second poke does not restart the showdown");
    assert_eq!(env.round().await?["showdown_ends_at"].as_u64(), Some(ends));

    env.advance_to(ends).await?;
    let tx = env.pool_call(&keeper, "settle_round").await?;
    let settled_at = env.exec_ms(&tx).await?;
    tx.assert_success();
    let events = env.events().await?;
    let st = one_of_type(&events, "round_settled");
    assert!(st["data"]["winner"].is_null(), "no King, winner null: {st}");
    assert_eq!(multiple_of(st), 0.0, "multiple 0");
    assert_eq!(u(&st["data"]["jackpot"]), 0);
    let r = env.round().await?;
    assert_fresh_round(&r, 2, settled_at, backstop_ms);
    env.check_invariant("settle with no King").await?;

    // Round 2: the first challenge arrives after the backstop.
    env.advance_to(ms(&r["backstop_at"])).await?;
    let tx = env.challenge(&a, START_PRICE).await?;
    let exec = env.exec_ms(&tx).await?;
    assert!(tx.is_success(), "a challenge after the backstop is processed: {:?}", tx.clone().assert_failure());
    let events = env.events().await?;
    let sd = one_of_type(&events, "showdown_started");
    let ch = one_of_type(&events, "challenged");
    assert_eq!(sd["data"]["reason"], "time", "the showdown starts before the challenge is processed");
    assert!(ms(&sd["id"]) < ms(&ch["id"]), "showdown_started precedes challenged");
    assert_eq!(ms(&ch["at"]), exec);
    let ends = ms(&sd["data"]["ends_at"]);
    assert_eq!(ends, exec + showdown_ms);
    let r = env.round().await?;
    assert_eq!(r["showdown_ends_at"].as_u64(), Some(ends), "no snipe: showdown_ms left >= snipe_ms");
    assert_eq!(r["challenges"].as_u64(), Some(1));
    assert_eq!(u(&r["jackpot"]), split(START_PRICE)[0] + split(START_PRICE)[1]);
    env.check_invariant("time-started challenge").await?;
    Ok(())
}

/// 5. Snipe: no extension with >= snipe_ms left; inside the window ends_at = at + snipe_ms;
///    the King stays challengeable past the original end; ROUND_CLOSED after the final end.
#[tokio::test]
async fn snipe_extends_showdown() -> TestResult {
    let _g = lock();
    let trigger = jackpot_after(2);
    let (showdown_ms, snipe_ms) = (60_000, 30_000);
    let mut env = Env::new(timing(Some(trigger), 20, 3_600_000, showdown_ms, snipe_ms)).await?;
    let a = env.player("alice", 30 * USDC, 100 * USDC).await?;
    let b = env.player("bob", 30 * USDC, 100 * USDC).await?;

    let mut m = RoundModel::new();
    checked_challenge(&mut env, &mut m, &a).await?;
    let (events, at2) = checked_challenge(&mut env, &mut m, &b).await?;
    let e0 = ms(&one_of_type(&events, "showdown_started")["data"]["ends_at"]);
    assert_eq!(e0, at2 + showdown_ms);

    // Outside the window: unchanged.
    let (events, at3) = checked_challenge(&mut env, &mut m, &a).await?;
    assert!(e0 - at3 >= snipe_ms, "precondition: at least snipe_ms left");
    assert!(of_type(&events, "showdown_started").is_empty());
    assert_eq!(env.round().await?["showdown_ends_at"].as_u64(), Some(e0), "no extension outside the window");

    // Inside the window: ends_at = at + snipe_ms.
    env.advance_to(e0 - 15_000).await?;
    let (events, at4) = checked_challenge(&mut env, &mut m, &b).await?;
    assert!(at4 < e0 && e0 - at4 < snipe_ms, "precondition: inside the snipe window (at {at4}, end {e0})");
    assert!(of_type(&events, "showdown_started").is_empty(), "a snipe is not a new showdown");
    let e1 = at4 + snipe_ms;
    assert_eq!(env.round().await?["showdown_ends_at"].as_u64(), Some(e1), "snipe sets ends_at = now + snipe_ms");

    // Past the original end but before the extended one: the King can still be challenged.
    env.advance_to(e0 + 2_000).await?;
    let (_, at5) = checked_challenge(&mut env, &mut m, &a).await?;
    assert!(at5 >= e0 && at5 < e1, "precondition: between the original and the extended end");
    let e2 = at5 + snipe_ms;
    assert_eq!(env.round().await?["showdown_ends_at"].as_u64(), Some(e2), "re-extended");

    env.advance_to(e2).await?;
    let before = env.snapshot(&[&a, &b]).await?;
    expect_err(env.challenge(&b, m.price).await?, "ROUND_CLOSED");
    assert_eq!(env.snapshot(&[&a, &b]).await?, before);

    let a_before = env.game_balance(&a).await?;
    env.pool_call(&b, "settle_round").await?.assert_success();
    let events = env.events().await?;
    let st = one_of_type(&events, "round_settled");
    assert_eq!(st["data"]["winner"], a.to_string());
    assert_eq!(u(&st["data"]["jackpot"]), m.jackpot);
    assert_multiple(st, multiple_x100(m.jackpot, m.last_price));
    assert_eq!(env.game_balance(&a).await?, a_before + m.jackpot);
    env.check_invariant("settle after snipes").await?;
    Ok(())
}

/// Challenge step for the multi-round run: also checks every player's game balance.
async fn step(env: &mut Env, m: &mut RoundModel, bal: &mut HashMap<AccountId, u128>, who: &AccountId) -> R<(Vec<Value>, u64)> {
    let price = m.price;
    let prev = m.king.clone();
    let out = checked_challenge(env, m, who).await?;
    *bal.get_mut(who).unwrap() -= price;
    if let Some(prev) = prev {
        *bal.get_mut(&prev).unwrap() += split(price)[1];
    }
    for (id, v) in bal.iter() {
        assert_eq!(env.game_balance(id).await?, *v, "game balance of {id}");
    }
    Ok(out)
}

/// 6. Two full rounds back to back (size, then time via a challenge) and the start of a third,
///    with balances modelled and the invariant checked after every transaction.
#[tokio::test]
async fn multi_round_run() -> TestResult {
    let _g = lock();
    let (backstop_ms, showdown_ms) = (90_000, 6_000);
    let mut env = Env::new(timing(None, 2_000, backstop_ms, showdown_ms, 1_000)).await?;
    let a = env.player("alice", 30 * USDC, 100 * USDC).await?;
    let b = env.player("bob", 30 * USDC, 100 * USDC).await?;
    let trigger = 60 * USDC * 2_000 / 10_000;
    assert_eq!(u(&env.round().await?["showdown_trigger"]), trigger, "bps trigger = floor(court * bps / 1e4)");
    assert!(jackpot_after(3) < trigger && jackpot_after(4) >= trigger);
    let mut bal = HashMap::from([(a.clone(), 100 * USDC), (b.clone(), 100 * USDC)]);

    // Round 1: size showdown on ticket 4, won by bob.
    let backstop1 = ms(&env.round().await?["backstop_at"]);
    let mut m = RoundModel::new();
    let mut ends = 0;
    for who in [&a, &b, &a, &b] {
        let (events, at) = step(&mut env, &mut m, &mut bal, who).await?;
        let sds = of_type(&events, "showdown_started");
        if m.k < 4 {
            assert!(sds.is_empty(), "no showdown on ticket {}", m.k);
        } else {
            assert!(at < backstop1, "precondition: round 1 crossed the trigger before its backstop");
            assert_eq!(sds.len(), 1);
            assert_eq!(sds[0]["data"]["reason"], "size");
            ends = ms(&sds[0]["data"]["ends_at"]);
        }
    }
    env.advance_to(ends).await?;
    let tx = env.pool_call(&a, "settle_round").await?;
    let settled1 = env.exec_ms(&tx).await?;
    tx.assert_success();
    env.check_invariant("settle 1").await?;
    let st = one_of_type(&env.events().await?, "round_settled").clone();
    assert_eq!(st["data"]["winner"], b.to_string());
    assert_eq!(u(&st["data"]["jackpot"]), m.jackpot);
    assert_multiple(&st, multiple_x100(m.jackpot, m.last_price));
    *bal.get_mut(&b).unwrap() += m.jackpot;
    let r = env.round().await?;
    assert_fresh_round(&r, 2, settled1, backstop_ms);
    for (id, v) in bal.iter() {
        assert_eq!(env.game_balance(id).await?, *v, "game balance of {id} after round 1");
    }

    // Round 2: last round's winner opens at the start price; the King share goes to the Jackpot.
    let mut m = RoundModel::new();
    step(&mut env, &mut m, &mut bal, &b).await?;
    assert_eq!(m.jackpot, 4 * USDC);
    env.advance_to(ms(&r["backstop_at"])).await?;
    let (events, at) = step(&mut env, &mut m, &mut bal, &a).await?;
    let sd = one_of_type(&events, "showdown_started");
    assert_eq!(sd["data"]["reason"], "time");
    assert!(ms(&sd["id"]) < ms(&one_of_type(&events, "challenged")["id"]));
    let ends = ms(&sd["data"]["ends_at"]);
    assert_eq!(ends, at + showdown_ms);
    env.advance_to(ends).await?;
    let tx = env.pool_call(&b, "settle_round").await?;
    let settled2 = env.exec_ms(&tx).await?;
    tx.assert_success();
    env.check_invariant("settle 2").await?;
    let st = one_of_type(&env.events().await?, "round_settled").clone();
    assert_eq!(st["data"]["winner"], a.to_string());
    assert_eq!(m.jackpot, 6_832_500);
    assert_eq!(u(&st["data"]["jackpot"]), m.jackpot);
    assert_eq!(multiple_x100(m.jackpot, m.last_price), 133, "half-up 1.33 vs floor 1.32");
    assert_multiple(&st, 133);
    *bal.get_mut(&a).unwrap() += m.jackpot;
    assert_fresh_round(&env.round().await?, 3, settled2, backstop_ms);
    for (id, v) in bal.iter() {
        assert_eq!(env.game_balance(id).await?, *v, "game balance of {id} after round 2");
    }

    // Round 3 opens at the start price again; then both players cash out exactly.
    let mut m = RoundModel::new();
    step(&mut env, &mut m, &mut bal, &a).await?;
    checked_claim(&env, &a).await?;
    checked_claim(&env, &b).await?;
    Ok(())
}

/// 7. Init validates timing and applies the spec defaults when it is omitted.
#[tokio::test]
async fn init_validates_timing_and_defaults() -> TestResult {
    let _g = lock();
    let mut env = Env::start().await?;
    let bad = [
        ("bad-snipe", timing(None, 20, 60_000, 10_000, 10_001)),
        ("bad-backstop", timing(None, 20, 0, 10_000, 1_000)),
        ("bad-showdown", timing(None, 20, 60_000, 0, 0)),
    ];
    for (name, t) in bad {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        expect_err(env.deploy_pool(&id, t).await?, "Timing out of range");
    }
    let equal: AccountId = "equal.sandbox".parse()?;
    env.deploy_pool(&equal, timing(None, 20, 60_000, 10_000, 10_000)).await?.assert_success();
    let s = env.view(&equal, "get_state", json!({})).await?;
    assert_eq!(s["params"]["snipe_ms"].as_u64(), Some(10_000), "snipe_ms == showdown_ms is allowed");

    // Defaults: 20 bps of the Court, 6h backstop, 10 min showdown, 60 s snipe.
    let pool = env.pool.clone();
    env.deploy_pool(&pool, Value::Null).await?.assert_success();
    let s = env.state().await?;
    let (p, r) = (&s["params"], &s["round"]);
    assert_eq!(p["showdown_ms"].as_u64(), Some(600_000));
    assert_eq!(p["snipe_ms"].as_u64(), Some(60_000));
    assert_eq!(u(&p["start_price"]), START_PRICE);
    assert_eq!(p["step_bps"].as_u64(), Some(STEP_BPS as u64));
    assert_eq!(p["split_bps"], json!(SPLIT_BPS));
    assert_eq!(u(&p["min_court"]), 25 * USDC);
    assert_eq!(ms(&r["backstop_at"]) - ms(&r["started_at"]), 21_600_000);
    assert_eq!(r["id"].as_u64(), Some(1));
    assert!(r["showdown_ends_at"].is_null());
    assert_eq!(u(&r["showdown_trigger"]), 0, "empty Court");
    env.player("dora", 25 * USDC + 1, 0).await?;
    assert_eq!(u(&env.round().await?["showdown_trigger"]), 50_000, "floor(25_000_001 * 20 / 10_000)");
    Ok(())
}
