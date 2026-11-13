//! Sandbox tests for the Court and challenges: real token contract, real promises and
//! callbacks. After every settled step the RugPool contract's token balance must equal what it owes.

use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{Value, json};
use std::sync::{Arc, OnceLock};

const USDC: u128 = 1_000_000;
const COOLDOWN_MS: u64 = 3_000;

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    usdc: AccountId,
    pool: AccountId,
}

impl Env {
    async fn call(&self, from: &AccountId, to: &AccountId, method: &str, args: Value, deposit: NearToken) -> near_api::types::transaction::result::TransactionResult {
        near_api::Contract(to.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(150))
            .with_signer(from.clone(), self.signer.clone())
            .send_to(&self.net)
            .await
            .expect("transaction sent")
    }

    async fn view(&self, on: &AccountId, method: &str, args: Value) -> Value {
        near_api::Contract(on.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await
            .expect("view")
            .data
    }

    async fn ft_balance(&self, token: &AccountId, who: &AccountId) -> u128 {
        let v = self.view(token, "ft_balance_of", json!({ "account_id": who })).await;
        v.as_str().unwrap().parse().unwrap()
    }

    /// Deposits through `ft_transfer_call` and returns the amount the token reports as used.
    async fn deposit(&self, token: &AccountId, from: &AccountId, amount: u128, msg: &str) -> u128 {
        let used: String = self
            .call(from, token, "ft_transfer_call", json!({ "receiver_id": self.pool, "amount": amount.to_string(), "msg": msg }), NearToken::from_yoctonear(1))
            .await
            .assert_success()
            .json()
            .expect("ft_transfer_call returns the used amount");
        used.parse().unwrap()
    }

    async fn account(&self, who: &AccountId) -> Value {
        self.view(&self.pool, "get_account", json!({ "account_id": who })).await
    }

    async fn liabilities(&self) -> Value {
        self.view(&self.pool, "get_liabilities", json!({})).await
    }

    async fn assert_solvent(&self) {
        let l = self.liabilities().await;
        let owed: u128 = l.as_object().unwrap().values().map(num).sum();
        assert_eq!(self.ft_balance(&self.usdc, &self.pool).await, owed, "token balance must equal liabilities");
    }

    /// Challenges at the current price and returns the gas burnt.
    async fn challenge(&self, who: &AccountId) -> u64 {
        let price = num(&self.view(&self.pool, "get_state", json!({})).await["round"]["next_price"]);
        self.call(who, &self.pool, "challenge", json!({ "max_price": price.to_string() }), NearToken::from_yoctonear(0))
            .await
            .assert_success()
            .total_gas_burnt
            .as_gas()
    }

    /// Asserts the call fails with the given contract error code.
    async fn assert_refused(&self, who: &AccountId, method: &str, args: Value, code: &str) {
        let err = self.call(who, &self.pool, method, args, NearToken::from_yoctonear(0)).await.assert_failure();
        assert!(format!("{err:?}").contains(code), "expected {code}, got {err:?}");
    }

    async fn register_and_mint(&self, token: &AccountId, who: &AccountId, amount: u128) {
        self.call(who, token, "storage_deposit", json!({ "account_id": who }), NearToken::from_millinear(10)).await.assert_success();
        if amount > 0 {
            self.call(who, token, "mint", json!({ "account_id": who, "amount": amount.to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
        }
    }
}

async fn account(sandbox: &near_sandbox::Sandbox, name: &str) -> AccountId {
    let id: AccountId = format!("{name}.sandbox").parse().unwrap();
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(20)).send().await.unwrap();
    id
}

fn num(v: &Value) -> u128 {
    v.as_str().expect("u128 as a string").parse().unwrap()
}

fn build(crate_dir: &str) -> Vec<u8> {
    let manifest = format!("{}/../{crate_dir}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
    let path = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
        manifest_path: Some(manifest.as_str().into()),
        ..Default::default()
    })
    .expect("contract builds");
    std::fs::read(path).unwrap()
}

/// Builds both contracts once. Tests run in parallel, and concurrent cargo-near builds of one
/// workspace race on the ABI step ("No NEAR ABI symbols found in the dylib").
fn wasm(crate_dir: &str) -> Vec<u8> {
    static WASMS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    let (usdc, pool) = WASMS.get_or_init(|| (build("test-usdc"), build("rugpool")));
    match crate_dir {
        "test-usdc" => usdc.clone(),
        _ => pool.clone(),
    }
}

async fn deploy(e: &Env, id: &AccountId, code: Vec<u8>, init: &str, args: Value) {
    near_api::Contract::deploy(id.clone())
        .use_code(code)
        .with_init_call(init, args)
        .unwrap()
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
}

async fn setup() -> Env {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await.unwrap();
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse().unwrap());
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap()).unwrap();
    let usdc = account(&sandbox, "usdc").await;
    let pool = account(&sandbox, "rugpool").await;
    let e = Env { sandbox, net, signer, usdc, pool };
    deploy(&e, &e.usdc, wasm("test-usdc"), "new", json!({})).await;
    let intents: AccountId = "intents.sandbox".parse().unwrap();
    deploy(&e, &e.pool, wasm("rugpool"), "new", json!({ "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000, "intents": intents })).await;
    e.register_and_mint(&e.usdc, &e.pool, 0).await;
    e
}

#[tokio::test]
async fn court_round_trip_conserves_funds() {
    let e = setup().await;
    let alice = account(&e.sandbox, "alice").await;
    let bob = account(&e.sandbox, "bob").await;
    e.register_and_mint(&e.usdc, &alice, 100 * USDC).await;
    e.register_and_mint(&e.usdc, &bob, 100 * USDC).await;

    // Join the Court straight from a deposit.
    assert_eq!(e.deposit(&e.usdc, &alice, 30 * USDC, r#"{"action":"join"}"#).await, 30 * USDC);
    let a = e.account(&alice).await;
    assert_eq!((a["court"].as_str(), a["balance"].as_str()), (Some("30000000"), Some("0")));
    e.assert_solvent().await;

    // Deposit to the game balance, then join from it.
    assert_eq!(e.deposit(&e.usdc, &bob, 5 * USDC, "").await, 5 * USDC);
    e.call(&bob, &e.pool, "join_court", json!({ "amount": (2 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
    let b = e.account(&bob).await;
    assert_eq!((b["court"].as_str(), b["balance"].as_str()), (Some("2000000"), Some("3000000")));
    e.assert_solvent().await;

    // Refused deposits come back in full: unknown msg, dust.
    assert_eq!(e.deposit(&e.usdc, &alice, 5 * USDC, "join").await, 0);
    assert_eq!(e.deposit(&e.usdc, &alice, USDC / 2, "").await, 0);
    assert_eq!(e.ft_balance(&e.usdc, &alice).await, 70 * USDC);
    e.assert_solvent().await;

    // Withdraw waits for the cooldown, then pays the wallet.
    e.call(&alice, &e.pool, "request_withdraw", json!({ "amount": (10 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
    e.call(&alice, &e.pool, "withdraw", json!({}), NearToken::from_yoctonear(0)).await.assert_failure();
    e.sandbox.fast_forward(100).await.unwrap();
    let paid: bool = e.call(&alice, &e.pool, "withdraw", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(paid);
    assert_eq!(e.ft_balance(&e.usdc, &alice).await, 80 * USDC);
    assert_eq!(e.account(&alice).await["court"].as_str(), Some("20000000"));
    e.assert_solvent().await;

    // Claim pays out the game balance.
    let paid: bool = e.call(&bob, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(paid);
    assert_eq!(e.ft_balance(&e.usdc, &bob).await, 98 * USDC);
    e.assert_solvent().await;

    // The feed sees joins and the completed withdrawal.
    let page = e.view(&e.pool, "get_events", json!({ "from": 0 })).await;
    let types: Vec<&str> = page["events"].as_array().unwrap().iter().map(|ev| ev["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["court_join", "court_join", "withdraw"]);
    assert_eq!(page["events"][2]["data"], json!({ "by": alice, "amount": "10000000" }));
}

#[tokio::test]
async fn failed_payout_keeps_funds_in_the_court() {
    let e = setup().await;
    let carol = account(&e.sandbox, "carol").await;
    e.register_and_mint(&e.usdc, &carol, 10 * USDC).await;
    assert_eq!(e.deposit(&e.usdc, &carol, 10 * USDC, r#"{"action":"join"}"#).await, 10 * USDC);
    // Carol leaves the token, so the payout transfer to her must fail.
    e.call(&carol, &e.usdc, "storage_unregister", json!({}), NearToken::from_yoctonear(1)).await.assert_success();

    e.call(&carol, &e.pool, "request_withdraw", json!({ "amount": (10 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
    e.sandbox.fast_forward(100).await.unwrap();
    let paid: bool = e.call(&carol, &e.pool, "withdraw", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(!paid);
    // The request took it out of the Court; the failed payout puts it back in pending.
    let c = e.account(&carol).await;
    assert_eq!((c["court"].as_str(), c["withdraw_pending"].as_str()), (Some("0"), Some("10000000")));
    assert!(c["withdraw_ready_at"].is_u64(), "the withdrawal can be retried at once");
    e.assert_solvent().await;
    let page = e.view(&e.pool, "get_events", json!({ "from": 0 })).await;
    assert_eq!(page["events"].as_array().unwrap().len(), 1, "no withdraw event for a failed payout");
}

#[tokio::test]
async fn other_tokens_are_refused() {
    let e = setup().await;
    let fake: AccountId = account(&e.sandbox, "fake").await;
    deploy(&e, &fake, wasm("test-usdc"), "new", json!({})).await;
    let mallory = account(&e.sandbox, "mallory").await;
    e.register_and_mint(&fake, &e.pool, 0).await;
    e.register_and_mint(&fake, &mallory, 50 * USDC).await;
    assert_eq!(e.deposit(&fake, &mallory, 50 * USDC, r#"{"action":"join"}"#).await, 0);
    assert_eq!(e.ft_balance(&fake, &mallory).await, 50 * USDC);
    assert_eq!(e.account(&mallory).await["court"].as_str(), Some("0"));
}

#[tokio::test]
async fn challenge_war_conserves_funds() {
    let e = setup().await;
    let players = [account(&e.sandbox, "alice").await, account(&e.sandbox, "bob").await, account(&e.sandbox, "carol").await];
    let dave = account(&e.sandbox, "dave").await;
    let eve = account(&e.sandbox, "eve").await;
    for p in &players {
        e.register_and_mint(&e.usdc, p, 200 * USDC).await;
        e.deposit(&e.usdc, p, 30 * USDC, r#"{"action":"join"}"#).await;
        e.deposit(&e.usdc, p, 150 * USDC, "").await;
    }
    // Dave only sits in the Court; Eve is below the Court minimum.
    e.register_and_mint(&e.usdc, &dave, 61 * USDC).await;
    e.deposit(&e.usdc, &dave, 60 * USDC, r#"{"action":"join"}"#).await;
    e.register_and_mint(&e.usdc, &eve, 20 * USDC).await;
    e.deposit(&e.usdc, &eve, 10 * USDC, r#"{"action":"join"}"#).await;
    e.deposit(&e.usdc, &eve, 10 * USDC, "").await;
    e.assert_solvent().await;

    // The four refusals move nothing.
    e.assert_refused(&eve, "challenge", json!({ "max_price": "5000000" }), "COURT_TOO_SMALL").await;
    e.assert_refused(&players[0], "challenge", json!({ "max_price": "4999999" }), "PRICE_MOVED").await;
    e.challenge(&players[0]).await;
    e.assert_refused(&players[0], "challenge", json!({ "max_price": "99000000" }), "ALREADY_KING").await;
    e.call(&players[1], &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    e.assert_refused(&players[1], "challenge", json!({ "max_price": "99000000" }), "INSUFFICIENT_BALANCE").await;
    e.deposit(&e.usdc, &players[1], 100 * USDC, "").await;
    e.assert_solvent().await;

    // Bob dethrones Alice: she gets 25% of his 5.15 ticket.
    let before = num(&e.account(&players[0]).await["balance"]);
    e.challenge(&players[1]).await;
    assert_eq!(num(&e.account(&players[0]).await["balance"]), before + 1_287_500);
    e.assert_solvent().await;

    // A 20-challenge war, checking solvency after every ticket.
    let mut gas = Vec::new();
    for i in 0..20 {
        gas.push(e.challenge(&players[(i + 2) % 3]).await);
        e.assert_solvent().await;
        if i == 9 {
            // Dave adds to the Court mid-war; what he earned so far must not move.
            let earned = num(&e.account(&dave).await["court_earned"]);
            e.deposit(&e.usdc, &dave, 1 * USDC, "").await;
            e.call(&dave, &e.pool, "join_court", json!({ "amount": USDC.to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
            assert_eq!(num(&e.account(&dave).await["court_earned"]), earned);
        }
    }
    println!("challenge gas burnt: min {} max {} Tgas", gas.iter().min().unwrap() / 1_000_000_000_000, gas.iter().max().unwrap() / 1_000_000_000_000);
    let state = e.view(&e.pool, "get_state", json!({})).await;
    assert_eq!(state["round"]["challenges"], 22);

    // Earnings never exceed the pool set aside for them.
    let mut owed = 0;
    for p in players.iter().chain([&dave, &eve]) {
        owed += num(&e.account(p).await["court_earned"]);
    }
    let pool = num(&e.liabilities().await["rewards"]);
    assert!(owed <= pool && pool - owed <= 50, "owed {owed}, pool {pool}");

    // Everyone claims: each wallet rises by exactly balance + earnings.
    for p in players.iter().chain([&dave]) {
        let a = e.account(p).await;
        let due = num(&a["balance"]) + num(&a["court_earned"]);
        let wallet = e.ft_balance(&e.usdc, p).await;
        let paid: bool = e.call(p, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
        assert!(paid);
        assert_eq!(e.ft_balance(&e.usdc, p).await, wallet + due);
        e.assert_solvent().await;
    }
}

#[tokio::test]
async fn a_round_ends_and_pays_the_king() {
    let e = setup().await;
    // A second pool with demo timings: $8 trigger, 3s showdown.
    let timed = account(&e.sandbox, "timed").await;
    let timing = json!({ "trigger_bps": 20, "trigger_fixed": (8 * USDC).to_string(), "backstop_ms": 3_600_000, "showdown_ms": 3_000, "snipe_ms": 500 });
    deploy(&e, &timed, wasm("rugpool"), "new", json!({ "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000, "timing": timing })).await;
    e.register_and_mint(&e.usdc, &timed, 0).await;
    let e = Env { pool: timed, ..e };
    let alice = account(&e.sandbox, "alice").await;
    let bob = account(&e.sandbox, "bob").await;
    for p in [&alice, &bob] {
        e.register_and_mint(&e.usdc, p, 100 * USDC).await;
        e.deposit(&e.usdc, p, 30 * USDC, r#"{"action":"join"}"#).await;
        e.deposit(&e.usdc, p, 50 * USDC, "").await;
    }
    e.challenge(&alice).await;
    e.challenge(&bob).await;
    e.assert_refused(&bob, "settle_round", json!({}), "NOT_READY").await;
    e.challenge(&alice).await;
    let state = e.view(&e.pool, "get_state", json!({})).await;
    assert!(state["round"]["showdown_ends_at"].is_u64(), "9.749975 reached the $8 trigger");
    let jackpot = num(&state["round"]["jackpot"]);
    assert_eq!(jackpot, 9_749_975);

    e.sandbox.fast_forward(100).await.unwrap();
    e.assert_refused(&bob, "challenge", json!({ "max_price": "99000000" }), "ROUND_CLOSED").await;
    let before = num(&e.account(&alice).await["balance"]);
    e.call(&bob, &e.pool, "settle_round", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    assert_eq!(num(&e.account(&alice).await["balance"]), before + jackpot);
    e.assert_solvent().await;
    let state = e.view(&e.pool, "get_state", json!({})).await;
    assert_eq!((state["round"]["id"].as_u64(), num(&state["round"]["next_price"]), num(&state["round"]["jackpot"])), (Some(2), 5 * USDC, 0));

    // The winner takes it all home.
    let a = e.account(&alice).await;
    let due = num(&a["balance"]) + num(&a["court_earned"]);
    let wallet = e.ft_balance(&e.usdc, &alice).await;
    e.call(&alice, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    assert_eq!(e.ft_balance(&e.usdc, &alice).await, wallet + due);
    e.assert_solvent().await;
}

#[tokio::test]
async fn a_full_auto_defend_war_fits_in_one_transaction() {
    let e = setup().await;
    let alice = account(&e.sandbox, "alice").await;
    let bob = account(&e.sandbox, "bob").await;
    for p in [&alice, &bob] {
        e.register_and_mint(&e.usdc, p, 1_000 * USDC).await;
        e.deposit(&e.usdc, p, 30 * USDC, r#"{"action":"join"}"#).await;
        e.deposit(&e.usdc, p, 900 * USDC, "").await;
    }
    e.challenge(&alice).await;
    for p in [&alice, &bob] {
        e.call(p, &e.pool, "set_auto_defend", json!({ "max_price": (999 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
    }
    let gas = e.challenge(&bob).await;
    println!("25-retake war burnt {:.1} Tgas", gas as f64 / 1e12);
    assert!(gas < 150_000_000_000_000, "a full war must fit well inside 300 Tgas");
    let state = e.view(&e.pool, "get_state", json!({})).await;
    assert_eq!(state["round"]["challenges"], 27, "Alice, Bob, then 25 retakes");
    assert_eq!(state["round"]["king"], json!(alice));
    e.assert_solvent().await;
    let page = e.view(&e.pool, "get_events", json!({ "from": 0 })).await;
    let retakes = page["events"].as_array().unwrap().iter().filter(|ev| ev["type"] == "auto_defended").count();
    assert_eq!(retakes, 25);
}

/// A stand-in for NEAR Intents: an account that delivers USDC with `ft_transfer_call` and a msg,
/// as 1Click's `customRecipientMsg` does. Its deliveries must never be refused.
#[tokio::test]
async fn intents_deliveries_are_never_refused() {
    let e = setup().await;
    let intents = account(&e.sandbox, "intents").await;
    let alice = account(&e.sandbox, "alice").await;
    e.register_and_mint(&e.usdc, &intents, 100 * USDC).await;

    // Credited to the beneficiary and joined to the Court.
    let msg = json!({ "action": "join", "beneficiary": alice }).to_string();
    assert_eq!(e.deposit(&e.usdc, &intents, 30 * USDC, &msg).await, 30 * USDC);
    assert_eq!(e.account(&alice).await["court"].as_str(), Some("30000000"));
    e.assert_solvent().await;

    // While paused: still credited (no join), where a direct deposit is refunded.
    let owner: AccountId = e.pool.clone();
    e.call(&owner, &e.pool, "set_paused", json!({ "paused": true }), NearToken::from_yoctonear(0)).await.assert_success();
    assert_eq!(e.deposit(&e.usdc, &intents, 5 * USDC, &msg).await, 5 * USDC);
    let a = e.account(&alice).await;
    assert_eq!((a["court"].as_str(), a["balance"].as_str()), (Some("30000000"), Some("5000000")));
    e.register_and_mint(&e.usdc, &alice, 10 * USDC).await;
    assert_eq!(e.deposit(&e.usdc, &alice, 5 * USDC, "").await, 0, "a direct deposit is refunded while paused");
    e.assert_solvent().await;

    // No usable beneficiary: held for recovery, never refunded, never lost.
    assert_eq!(e.deposit(&e.usdc, &intents, 7 * USDC, "not json").await, 7 * USDC);
    assert_eq!(num(&e.liabilities().await["recovery"]), 7 * USDC);
    e.assert_solvent().await;
    let paid: bool = e.call(&owner, &e.pool, "recover", json!({ "receiver_id": intents, "amount": (7 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(paid);
    assert_eq!(e.ft_balance(&e.usdc, &intents).await, (100 - 30 - 5) * USDC);
    e.assert_solvent().await;

    // Leaving still works while paused.
    e.call(&alice, &e.pool, "request_withdraw", json!({ "amount": (30 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
    e.sandbox.fast_forward(100).await.unwrap();
    let paid: bool = e.call(&alice, &e.pool, "withdraw", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(paid);
    let paid: bool = e.call(&alice, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(paid);
    assert_eq!(e.ft_balance(&e.usdc, &alice).await, 10 * USDC + 35 * USDC);
    e.assert_solvent().await;
}

const QUICKNET: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/// Quicknet's signature for `round`, from drand's public API, waiting until it's published.
async fn drand_signature(round: u64) -> String {
    let url = format!("https://api.drand.sh/{QUICKNET}/public/{round}");
    for _ in 0..200 {
        let out = tokio::process::Command::new("curl").args(["-sf", &url]).output().await.expect("curl runs");
        if out.status.success() {
            let beacon: Value = near_sdk::serde_json::from_slice(&out.stdout).expect("drand JSON");
            assert_eq!(beacon["round"], json!(round));
            return beacon["signature"].as_str().unwrap().to_string();
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    panic!("drand round {round} never appeared");
}

/// The round `close_draw` named.
async fn pending_round(e: &Env) -> u64 {
    e.view(&e.pool, "get_state", json!({})).await["court"]["pending_draw"]["round"].as_u64().expect("a pending draw")
}

/// Fetches real drand beacons, so it needs the network.
#[tokio::test]
async fn the_draw_pays_a_depositor_on_chain() {
    let e = setup().await;
    // A second pool with a draw every 2 seconds.
    let drawn = account(&e.sandbox, "drawn").await;
    let limits = json!({ "max_account": u128::MAX.to_string(), "max_total": u128::MAX.to_string(), "draw_min": USDC.to_string(), "draw_every_ms": 2_000 });
    deploy(&e, &drawn, wasm("rugpool"), "new", json!({ "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000, "limits": limits })).await;
    e.register_and_mint(&e.usdc, &drawn, 0).await;
    let e = Env { pool: drawn, ..e };
    let players = [account(&e.sandbox, "alice").await, account(&e.sandbox, "bob").await];
    for p in &players {
        e.register_and_mint(&e.usdc, p, 200 * USDC).await;
        e.deposit(&e.usdc, p, 30 * USDC, r#"{"action":"join"}"#).await;
        e.deposit(&e.usdc, p, 100 * USDC, "").await;
    }
    for i in 0..6 {
        e.challenge(&players[i % 2]).await;
    }
    let pot = num(&e.view(&e.pool, "get_state", json!({})).await["court"]["draw_pot"]);
    assert!(pot >= USDC, "{pot}");
    e.sandbox.fast_forward(100).await.unwrap();
    let balances = num(&e.liabilities().await["balances"]);
    e.assert_refused(&players[0], "finalize_draw", json!({ "signature": "00" }), "NO_DRAW").await;
    e.call(&players[0], &e.pool, "close_draw", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    let round = pending_round(&e).await;
    let l = e.liabilities().await;
    assert_eq!((num(&l["draw_pot"]), num(&l["balances"])), (pot, balances), "the pending pot is still owed");
    e.assert_solvent().await;
    e.assert_refused(&players[0], "close_draw", json!({}), "DRAW_PENDING").await;

    let sig = drand_signature(round).await;
    let earlier = drand_signature(round - 1).await;
    e.assert_refused(&players[1], "finalize_draw", json!({ "signature": earlier }), "BAD_SIGNATURE").await;
    let gas = e.call(&players[1], &e.pool, "finalize_draw", json!({ "signature": sig }), NearToken::from_yoctonear(0)).await.assert_success().total_gas_burnt.as_gas();
    println!("finalize_draw with 2 entries: {:.2} Tgas", gas as f64 / 1e12);
    let l = e.liabilities().await;
    assert_eq!((num(&l["draw_pot"]), num(&l["balances"])), (0, balances + pot));
    e.assert_solvent().await;
    let page = e.view(&e.pool, "get_events", json!({ "from": 0 })).await;
    let won = page["events"].as_array().unwrap().iter().rev().find(|ev| ev["type"] == "draw_won").expect("a draw_won event");
    assert!(players.iter().any(|p| won["data"]["by"] == json!(p)));
    assert_eq!(won["data"]["amount"], pot.to_string());
    e.assert_refused(&players[0], "finalize_draw", json!({ "signature": sig }), "NO_DRAW").await;
}

/// `close_draw` and `finalize_draw` walk every depositor, so `MAX_DEPOSITORS` has to keep a
/// full Court's draw well inside the 300 Tgas limit. Measures the gas per depositor and
/// projects it to the cap. Fetches real drand beacons, so it needs the network.
#[tokio::test]
async fn draw_gas_per_depositor() {
    let e = setup().await;
    let drawn = account(&e.sandbox, "drawn").await;
    let intents = account(&e.sandbox, "intents").await;
    let limits = json!({ "max_account": u128::MAX.to_string(), "max_total": u128::MAX.to_string(), "draw_min": "0", "draw_every_ms": 1 });
    deploy(&e, &drawn, wasm("rugpool"), "new", json!({ "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000, "intents": intents, "limits": limits })).await;
    e.register_and_mint(&e.usdc, &drawn, 0).await;
    let e = Env { pool: drawn, ..e };
    e.register_and_mint(&e.usdc, &intents, 400 * USDC).await;
    // DRAW_MIN_COURT each, so every one of them holds a draw slot.
    let join = |i: usize| json!({ "action": "join", "beneficiary": format!("p{i}.sandbox") }).to_string();
    let draw = async |e: &Env| -> (u64, u64) {
        let close = e.call(&e.pool, &e.pool, "close_draw", json!({}), NearToken::from_yoctonear(0)).await.assert_success().total_gas_burnt.as_gas();
        let sig = drand_signature(pending_round(e).await).await;
        let finalize = e.call(&e.pool, &e.pool, "finalize_draw", json!({ "signature": sig }), NearToken::from_yoctonear(0)).await.assert_success().total_gas_burnt.as_gas();
        (close, finalize)
    };
    for i in 0..10 {
        e.deposit(&e.usdc, &intents, 5 * USDC, &join(i)).await;
    }
    let small = draw(&e).await;
    for i in 10..70 {
        e.deposit(&e.usdc, &intents, 5 * USDC, &join(i)).await;
    }
    let big = draw(&e).await;
    for (name, small, big) in [("close_draw", small.0, big.0), ("finalize_draw", small.1, big.1)] {
        let per = (big - small) / 60;
        let at_cap = small + per * (500 - 10);
        println!("{name}: {:.2} Tgas at 10 depositors, {:.2} at 70; {:.3} Tgas each; ~{:.0} Tgas at 500", small as f64 / 1e12, big as f64 / 1e12, per as f64 / 1e12, at_cap as f64 / 1e12);
        assert!(per > 0, "{name} must cost more with more depositors, or nothing was measured");
        assert!(at_cap < 150_000_000_000_000, "a full Court's {name} must stay well inside 300 Tgas");
    }
    // The account view walks the same set; it must still answer.
    let a = e.account(&"p0.sandbox".parse().unwrap()).await;
    assert!(a["draw_weight_bps"].is_u64());
    e.assert_solvent().await;
}

/// `new` is private: once the code is deployed, nobody else can initialize it first.
#[tokio::test]
async fn only_the_contract_can_initialize_itself() {
    let e = setup().await;
    let target = account(&e.sandbox, "target").await;
    let mallory = account(&e.sandbox, "mallory").await;
    near_api::Contract::deploy(target.clone()).use_code(wasm("rugpool")).without_init_call().with_signer(e.signer.clone()).send_to(&e.net).await.unwrap().assert_success();
    let args = json!({ "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000, "owner": mallory });
    let err = e.call(&mallory, &target, "new", args.clone(), NearToken::from_yoctonear(0)).await.assert_failure();
    assert!(format!("{err:?}").contains("private"), "{err:?}");
    e.call(&target, &target, "new", args, NearToken::from_yoctonear(0)).await.assert_success();
}

/// Yield from a funded reserve on the real runtime: a high APY so seconds of block time show.
#[tokio::test]
async fn yield_and_the_registration_fee_on_chain() {
    let e = setup().await;
    let pool = account(&e.sandbox, "yieldy").await;
    let args = json!({
        "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000,
        "yield_params": { "apy_bps": 10_000, "split_bps": [5_000, 3_000, 2_000] },
        "registration_fee": "50000",
    });
    deploy(&e, &pool, wasm("rugpool"), "new", args).await;
    e.register_and_mint(&e.usdc, &pool, 0).await;
    let e = Env { pool, ..e };
    let funder = account(&e.sandbox, "funder").await;
    let alice = account(&e.sandbox, "alice").await;
    let bob = account(&e.sandbox, "bob").await;
    e.register_and_mint(&e.usdc, &funder, 50 * USDC).await;
    assert_eq!(e.deposit(&e.usdc, &funder, 20 * USDC, r#"{"action":"fund_yield"}"#).await, 20 * USDC);
    assert_eq!(num(&e.liabilities().await["yield_reserve"]), 20 * USDC);
    e.assert_solvent().await;

    for p in [&alice, &bob] {
        e.register_and_mint(&e.usdc, p, 200 * USDC).await;
        e.deposit(&e.usdc, p, 100 * USDC, r#"{"action":"join"}"#).await;
        e.deposit(&e.usdc, p, 20 * USDC, "").await;
    }
    // Each first deposit kept the 0.05 fee.
    assert_eq!(num(&e.account(&alice).await["court"]), 100 * USDC - 50_000);
    assert_eq!(num(&e.liabilities().await["treasury"]), 100_000);
    e.assert_solvent().await;

    e.challenge(&alice).await;
    e.sandbox.fast_forward(200).await.unwrap();
    e.call(&bob, &e.pool, "poke", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    let l = e.liabilities().await;
    assert!(num(&l["yield_reserve"]) < 20 * USDC, "yield flowed out of the reserve");
    assert!(num(&l["streams"]) > 0, "the King streams");
    e.assert_solvent().await;

    // The King claims balance + earnings + stream, exactly.
    let a = e.account(&alice).await;
    assert!(num(&a["king_stream"]) > 0);
    let wallet = e.ft_balance(&e.usdc, &alice).await;
    let before = e.liabilities().await;
    e.call(&alice, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    let paid = e.ft_balance(&e.usdc, &alice).await - wallet;
    let after = e.liabilities().await;
    let owed = |l: &Value| -> u128 { l.as_object().unwrap().values().map(num).sum() };
    assert_eq!(owed(&before) - owed(&after), paid, "the claim paid exactly what left the books");
    assert!(paid >= num(&a["balance"]) + num(&a["court_earned"]) + num(&a["king_stream"]), "views never overstate");
    e.assert_solvent().await;

    // Bob leaves entirely: his account is deleted, and coming back pays the fee again.
    e.call(&bob, &e.pool, "request_withdraw", json!({ "amount": (100 * USDC - 50_000).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
    e.call(&bob, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    e.sandbox.fast_forward(100).await.unwrap();
    e.call(&bob, &e.pool, "withdraw", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    let b = e.account(&bob).await;
    assert_eq!((num(&b["balance"]), num(&b["court"]), num(&b["withdraw_pending"])), (0, 0, 0));
    let treasury = num(&e.liabilities().await["treasury"]);
    e.deposit(&e.usdc, &bob, 5 * USDC, "").await;
    assert_eq!(num(&e.liabilities().await["treasury"]), treasury + 50_000, "a deleted account pays the fee again");
    e.assert_solvent().await;
}

/// Real receipt check: the reserve alone cannot pay for a six-entry frozen draw.
#[tokio::test]
async fn draw_freeze_preserves_storage_buffer_on_chain() {
    const BYTE: u128 = 10_000_000_000_000_000_000;
    let e = setup().await;
    let drawn = account(&e.sandbox, "drawn").await;
    let intents = account(&e.sandbox, "intents").await;
    let limits = json!({ "max_account": u128::MAX.to_string(), "max_total": u128::MAX.to_string(), "draw_min": "0", "draw_every_ms": 1 });
    deploy(&e, &drawn, wasm("rugpool"), "new", json!({ "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000, "intents": intents, "limits": limits })).await;
    e.register_and_mint(&e.usdc, &drawn, 0).await;
    let e = Env { pool: drawn, ..e };
    e.register_and_mint(&e.usdc, &intents, 30 * USDC).await;
    for i in 0..6 {
        let beneficiary = format!("{}{}.sandbox", "p".repeat(55), i);
        assert_eq!(beneficiary.len(), 64);
        let msg = json!({ "action": "join", "beneficiary": beneficiary }).to_string();
        assert_eq!(e.deposit(&e.usdc, &intents, 5 * USDC, &msg).await, 5 * USDC);
    }
    let liabilities = e.liabilities().await;
    let (used, held) = pool_storage(&e).await;
    near_api::Tokens::account(e.pool.clone())
        .send_to(intents.clone())
        .near(NearToken::from_yoctonear(held - (used as u128 + 2_200) * BYTE))
        .with_signer(e.signer.clone()).send_to(&e.net).await.unwrap().assert_success();
    let (before, held) = pool_storage(&e).await;
    let spare = held / BYTE - before as u128;
    assert!((2_092..2_300).contains(&spare), "{spare} spare bytes");
    e.assert_refused(&intents, "close_draw", json!({}), "PAUSED: The draw waits until the contract's storage is topped up.").await;
    assert!(e.view(&e.pool, "get_state", json!({})).await["court"]["pending_draw"].is_null());
    assert_eq!(pool_storage(&e).await.0, before, "refusal cannot store entries");
    assert_eq!(e.liabilities().await, liabilities);
    e.assert_solvent().await;

    near_api::Tokens::account(intents.clone()).send_to(e.pool.clone())
        .near(NearToken::from_millinear(20)).with_signer(e.signer.clone())
        .send_to(&e.net).await.unwrap().assert_success();
    e.call(&intents, &e.pool, "close_draw", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
    assert!(e.view(&e.pool, "get_state", json!({})).await["court"]["pending_draw"].is_object());
    let (after, held) = pool_storage(&e).await;
    assert!(after > before, "the frozen entries must actually be stored");
    assert!(held / BYTE - after as u128 >= 2_092, "freeze must retain the full reserve");
    assert_eq!(e.liabilities().await, liabilities);
    e.assert_solvent().await;
    println!("six-entry freeze: {} new bytes; {} reserve bytes remain", after - before, held / BYTE - after as u128);
}

/// Offline receipt-boundary fixture, NOT a proof of the live future-beacon lifecycle.
/// Only the pending round/pot and native headroom are sandbox-patched. Entrant freeze,
/// withdrawal/deletion, BLS verification, finalization and payout use production WASM.
#[tokio::test]
async fn draw_finalization_storage_boundary_on_chain() {
    use near_sdk::base64::{Engine, engine::general_purpose::STANDARD as B64};
    const BYTE: u128 = 10_000_000_000_000_000_000;
    // Same historical quicknet beacon as src/drand.rs (no network fetch).
    const ROUND: u64 = 33_478_462;
    const SIG: &str = "8879131e59bccbe48a1c4b600518932bd1da47c50b31510d774ca1f4d72b07630a80f75fef655c5598105200d619e3ee";
    for deleted in [false, true] {
        for headroom in [2_092u64, 0] {
            let e = setup().await;
            let drawn = account(&e.sandbox, "drawn").await;
            let caller = account(&e.sandbox, "caller").await;
            let winner = account(&e.sandbox, &"w".repeat(56)).await;
            assert_eq!(winner.as_str().len(), 64);
            let limits = json!({ "max_account": u128::MAX.to_string(), "max_total": u128::MAX.to_string(), "draw_min": "0", "draw_every_ms": 1 });
            deploy(&e, &drawn, wasm("rugpool"), "new", json!({ "token": e.usdc, "withdraw_cooldown_ms": COOLDOWN_MS, "court_draw_bps": 5_000, "limits": limits })).await;
            e.register_and_mint(&e.usdc, &drawn, 0).await;
            let e = Env { pool: drawn, ..e };
            e.register_and_mint(&e.usdc, &winner, 30 * USDC).await;
            assert_eq!(e.deposit(&e.usdc, &winner, 30 * USDC, r#"{"action":"join"}"#).await, 30 * USDC);
            e.call(&caller, &e.pool, "close_draw", json!({}), NearToken::from_yoctonear(0)).await.assert_success();
            let live_round = pending_round(&e).await;
            // A genuine signature for the wrong round must fail before fixture seeding.
            e.assert_refused(&caller, "finalize_draw", json!({ "signature": SIG }), "BAD_SIGNATURE").await;
            let raw = pool_raw_storage(&e).await;
            // Locate the unique Account value by its production Borsh layout: balance,
            // court, then the remaining default fields. Prove actual key deletion below.
            let mut winner_record = near_sdk::borsh::to_vec(&rugpool::Account::default()).unwrap();
            winner_record[16..32].copy_from_slice(&(30 * USDC).to_le_bytes());
            let account_records: Vec<_> = raw.iter().filter(|v| v["value"] == B64.encode(&winner_record)).collect();
            assert_eq!(account_records.len(), 1, "unique funded winner account");
            let winner_key = account_records[0]["key"].clone();
            let root_key = B64.encode(b"STATE");
            let root = raw.iter().find(|v| v["key"] == root_key).expect("STATE");
            let mut bytes = B64.decode(root["value"].as_str().unwrap()).unwrap();
            // Fail closed on layout drift/ambiguity; match the Option tag, round and zero pot.
            let mut needle = vec![1];
            needle.extend_from_slice(&live_round.to_le_bytes());
            needle.extend_from_slice(&0u128.to_le_bytes());
            let offsets: Vec<_> = bytes.windows(needle.len()).enumerate().filter_map(|(i, b)| (b == needle).then_some(i)).collect();
            assert_eq!(offsets.len(), 1, "unique pending-draw encoding required");
            let at = offsets[0];
            bytes[at + 1..at + 9].copy_from_slice(&ROUND.to_le_bytes());
            bytes[at + 9..at + 25].copy_from_slice(&USDC.to_le_bytes());
            let storage_before_seed = pool_storage(&e).await.0;
            let encoded = B64.encode(bytes);
            let mut expected_raw = raw.clone();
            expected_raw.iter_mut().find(|v| v["key"] == root_key).unwrap()["value"] = json!(encoded);
            e.sandbox.patch_state(e.pool.clone()).storage(root_key, encoded).send().await.unwrap();
            assert_eq!(pool_raw_storage(&e).await, expected_raw, "seed changes only the chosen root bytes");
            assert_eq!(pool_storage(&e).await.0, storage_before_seed, "same-size seed must not alter storage accounting");
            assert_eq!(pending_round(&e).await, ROUND);
            assert_eq!(num(&e.liabilities().await["draw_pot"]), USDC);
            // Back the seeded pot with real test-token units (no fabricated solvency).
            e.call(&caller, &e.usdc, "mint", json!({ "account_id": e.pool, "amount": USDC.to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
            e.assert_solvent().await;
            if deleted {
                let before_exit = pool_storage(&e).await.0;
                e.call(&winner, &e.pool, "request_withdraw", json!({ "amount": (30 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
                e.sandbox.fast_forward(100).await.unwrap();
                let paid: bool = e.call(&winner, &e.pool, "withdraw", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
                assert!(paid);
                assert_eq!(e.ft_balance(&e.usdc, &winner).await, 30 * USDC);
                assert!(pool_storage(&e).await.0 < before_exit, "empty winner storage is released");
                assert_eq!(num(&e.account(&winner).await["court"]), 0);
                assert!(!pool_raw_storage(&e).await.iter().any(|v| v["key"] == winner_key), "winner Account key must be deleted");
            }
            e.assert_solvent().await;
            let used = pool_storage(&e).await.0;
            // Set the raw decimal yoctoNEAR amount: the sandbox helper's initial_balance
            // path formats NearToken for display, which this RPC rejects as an amount.
            let native = e.sandbox.patch_state(e.pool.clone())
                .fetch_from(&e.sandbox.rpc_addr, near_sandbox::FetchData::new().account()).await.unwrap();
            let record = near_sdk::serde_json::to_value(&native.state[0]).unwrap();
            let mut native_account = record["Account"]["account"].clone();
            native_account["amount"] = json!(((used + headroom) as u128 * BYTE).to_string());
            e.sandbox.patch_state(e.pool.clone()).account(native_account).send().await.unwrap();
            let (before, held) = pool_storage(&e).await;
            assert_eq!(held, (before + headroom) as u128 * BYTE);
            let liabilities = e.liabilities().await;
            let raw_before = pool_raw_storage(&e).await;
            let balance = num(&e.account(&winner).await["balance"]);
            let result = e.call(&caller, &e.pool, "finalize_draw", json!({ "signature": SIG }), NearToken::from_yoctonear(0)).await;
            if deleted && headroom == 0 {
                let failed = result.assert_failure();
                let failure = format!("{failed:?}");
                println!("deleted winner zero-headroom receipt failure: {}", failure.rsplit("value: ").next().unwrap());
                assert!(failure.contains("LackBalanceForState"), "must be NEAR's storage check, not a contract/signature failure: {failure}");
                assert_eq!(pool_storage(&e).await.0, before);
                assert_eq!(pool_raw_storage(&e).await, raw_before, "all contract writes must roll back");
                assert_eq!(e.liabilities().await, liabilities);
                assert_eq!(pending_round(&e).await, ROUND);
                assert_eq!(num(&e.account(&winner).await["balance"]), balance);
                e.assert_solvent().await;
                // Recovery is a real transfer, not a patch, and retries the same pending draw.
                near_api::Tokens::account(caller.clone()).send_to(e.pool.clone())
                    .near(NearToken::from_millinear(30)).with_signer(e.signer.clone())
                    .send_to(&e.net).await.unwrap().assert_success();
                e.call(&caller, &e.pool, "finalize_draw", json!({ "signature": SIG }), NearToken::from_yoctonear(0)).await.assert_success();
            } else {
                result.assert_success();
            }
            let (after, held) = pool_storage(&e).await;
            let delta = after as i64 - before as i64;
            println!("finalization receipt: deleted={deleted} headroom={headroom} delta={delta} remaining_bytes={}", held / BYTE - after as u128);
            if deleted { assert!(delta > 0 && delta <= 2_092); } else { assert!(delta <= 0); }
            assert!(e.view(&e.pool, "get_state", json!({})).await["court"]["pending_draw"].is_null());
            assert_eq!(num(&e.account(&winner).await["balance"]), balance + USDC);
            assert!(pool_raw_storage(&e).await.iter().any(|v| v["key"] == winner_key), "winner Account key exists after finalization");
            let mut expected = liabilities.clone();
            expected["draw_pot"] = json!("0");
            expected["balances"] = json!((num(&liabilities["balances"]) + USDC).to_string());
            assert_eq!(e.liabilities().await, expected);
            e.assert_solvent().await;
            e.assert_refused(&caller, "finalize_draw", json!({ "signature": SIG }), "NO_DRAW").await;
            let wallet = e.ft_balance(&e.usdc, &winner).await;
            let paid: bool = e.call(&winner, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
            assert!(paid);
            assert_eq!(e.ft_balance(&e.usdc, &winner).await, wallet + USDC);
            assert_eq!(num(&e.liabilities().await["in_flight"]), 0);
            e.assert_solvent().await;
        }
    }
}

/// Local sandbox RPC only; compare raw trie values to prove rollback beyond view fields.
async fn pool_raw_storage(e: &Env) -> Vec<Value> {
    // fetch_from only reads; never send this builder (that would write the snapshot).
    let snapshot = e.sandbox.patch_state(e.pool.clone())
        .fetch_from(&e.sandbox.rpc_addr, near_sandbox::FetchData::new().storage()).await.unwrap();
    let mut values: Vec<Value> = snapshot.state.into_iter().map(|record| {
        let v = near_sdk::serde_json::to_value(record).unwrap();
        let data = &v["Data"];
        assert!(data.is_object());
        json!({ "key": data["data_key"], "value": data["value"] })
    }).collect();
    values.sort_by_key(|v| v["key"].as_str().unwrap().to_owned());
    values
}

/// The pool's stored bytes and the NEAR it holds.
async fn pool_storage(e: &Env) -> (u64, u128) {
    let a = near_api::Account(e.pool.clone()).view().fetch_from(&e.net).await.expect("account").data;
    (a.storage_usage, a.amount.as_yoctonear())
}

#[tokio::test]
async fn short_of_storage_challenges_grow_only_the_reserved_record_and_exits_work() {
    const BYTE: u128 = 10_000_000_000_000_000_000;
    let e = setup().await;
    let alice = account(&e.sandbox, "alice").await;
    // The longest account id: 64 characters.
    let long = account(&e.sandbox, &"k".repeat(56)).await;
    let dave = account(&e.sandbox, "dave").await;
    assert_eq!(long.as_str().len(), 64);
    for p in [&alice, &long] {
        e.register_and_mint(&e.usdc, p, 200 * USDC).await;
        e.deposit(&e.usdc, p, 30 * USDC, r#"{"action":"join"}"#).await;
        e.deposit(&e.usdc, p, 100 * USDC, "").await;
    }
    e.register_and_mint(&e.usdc, &dave, 50 * USDC).await;
    let events = e.view(&e.pool, "get_events", json!({ "from": 0 })).await["events"].as_array().unwrap().len();

    // Drain the pool's NEAR to about 1,000 spare bytes: under the 2,092 it wants before it
    // stores anything new. Each later call's gas refund to the contract adds a few bytes back.
    let (used, held) = pool_storage(&e).await;
    let excess = held - (used as u128 + 1_000) * BYTE;
    near_api::Tokens::account(e.pool.clone())
        .send_to(dave.clone())
        .near(NearToken::from_yoctonear(excess))
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await
        .unwrap()
        .assert_success();
    let (used, held) = pool_storage(&e).await;
    let spare = held / BYTE - used as u128;
    assert!((900..=1_000).contains(&spare), "{spare} spare bytes");

    // New storage is refused: the deposit comes back.
    assert_eq!(e.deposit(&e.usdc, &dave, 30 * USDC, r#"{"action":"join"}"#).await, 0);
    assert_eq!(e.ft_balance(&e.usdc, &dave).await, 50 * USDC);

    // A first King, whose ticket also starts the first showdown, then a King with the longest
    // id. Only the contract's own record grows, by its 92-byte reserve in all: the King
    // (4 + 64 bytes), `king_since`, the showdown's end and the first buy block (8 each).
    e.challenge(&alice).await;
    assert!(e.view(&e.pool, "get_state", json!({})).await["round"]["showdown_ends_at"].is_u64());
    assert_eq!(pool_storage(&e).await.0 - used, 4 + alice.as_str().len() as u64 + 24);
    e.challenge(&long).await;
    assert_eq!(pool_storage(&e).await.0 - used, 92);
    assert_eq!(e.view(&e.pool, "get_events", json!({ "from": 0 })).await["events"].as_array().unwrap().len(), events, "no event was stored");
    e.assert_solvent().await;

    // Leaving still works: a withdrawal and a claim, each paid to the wallet.
    e.call(&alice, &e.pool, "request_withdraw", json!({ "amount": (30 * USDC).to_string() }), NearToken::from_yoctonear(0)).await.assert_success();
    e.sandbox.fast_forward(100).await.unwrap();
    let paid: bool = e.call(&alice, &e.pool, "withdraw", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(paid);
    let paid: bool = e.call(&alice, &e.pool, "claim", json!({}), NearToken::from_yoctonear(0)).await.assert_success().json().unwrap();
    assert!(paid);
    assert!(e.ft_balance(&e.usdc, &alice).await > 190 * USDC, "alice has her Court stake and her balance back");
    assert_eq!(num(&e.liabilities().await["in_flight"]), 0);
    e.assert_solvent().await;
    let (used, held) = pool_storage(&e).await;
    assert!(held / BYTE - (used as u128) < 2_092, "still short of the buffer at the end");
}
