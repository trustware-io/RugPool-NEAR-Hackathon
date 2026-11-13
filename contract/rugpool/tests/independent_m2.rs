//! Independent black-box tests for RugPool Milestone 2, written from the spec only.
//!
//! Every expected value comes from the `Model` below (a port of `priceAt` / `splitTicket` in
//! `src/game/curve.ts` plus the Court rules in the spec), never from the contract's own output.

use near_api::types::transaction::result::TransactionResult;
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use testresult::TestResult;

type R<T> = Result<T, Box<dyn std::error::Error>>;

const USDC: u128 = 1_000_000;
const START_PRICE: u128 = 5_000_000;
const STEP_BPS: u128 = 300;
const SPLIT_BPS: [u128; 4] = [5500, 2500, 1500, 500];
const COURT_DRAW_BPS: u128 = 5000;
const MIN_COURT: u128 = 25_000_000;
const MINT_CAP: u128 = 1_000_000_000;
/// Fixed-point scale for the exact pro-rata upper bound of each account's Court earnings.
const SCALE: u128 = 1_000_000_000_000_000_000;

// ---------------------------------------------------------------- reference curve (curve.ts)

fn price_at(k: u64) -> u128 {
    let mut p = START_PRICE;
    for _ in 0..k {
        p = p * (10_000 + STEP_BPS) / 10_000;
    }
    p
}

/// [Jackpot, King, Court, protocol], each share floored, remainder to the Jackpot.
fn split_ticket(price: u128) -> [u128; 4] {
    let king = price * SPLIT_BPS[1] / 10_000;
    let court = price * SPLIT_BPS[2] / 10_000;
    let protocol = price * SPLIT_BPS[3] / 10_000;
    [price - king - court - protocol, king, court, protocol]
}

#[test]
fn reference_curve_port_matches_hand_values() {
    assert_eq!(price_at(0), 5_000_000);
    assert_eq!(price_at(1), 5_150_000);
    assert_eq!(price_at(2), 5_304_500);
    assert_eq!(price_at(3), 5_463_635);
    // 5_463_635 * 1.03 = 5_627_544.05
    assert_eq!(price_at(4), 5_627_544);
    assert_eq!(
        split_ticket(5_000_000),
        [2_750_000, 1_250_000, 750_000, 250_000]
    );
    // 5_627_544: king 1_406_886, court 844_131.6 -> 844_131, protocol 281_377.2 -> 281_377
    assert_eq!(
        split_ticket(5_627_544),
        [3_095_150, 1_406_886, 844_131, 281_377]
    );
}

// ---------------------------------------------------------------- independent model

#[derive(Default, Clone, Debug)]
struct Acct {
    balance: u128,
    court: u128,
    /// Upper bound of exact pro-rata Court earnings, scaled by SCALE (each term rounded up).
    earned_upper: u128,
}

#[derive(Default, Debug)]
struct Model {
    accts: BTreeMap<AccountId, Acct>,
    jackpot: u128,
    draw_pot: u128,
    treasury: u128,
    /// Court rewards set aside minus Court earnings paid out.
    rewards: u128,
    /// Expected `ft_balance_of(RugPool)`.
    pool_tokens: u128,
    challenges: u64,
    king: Option<AccountId>,
    /// (by, price, dethroned) for every successful challenge, oldest first.
    challenged: Vec<(AccountId, u128, Option<AccountId>)>,
}

impl Model {
    fn acct(&mut self, who: &AccountId) -> &mut Acct {
        self.accts.entry(who.clone()).or_default()
    }

    fn price(&self) -> u128 {
        price_at(self.challenges)
    }

    fn credit_balance(&mut self, who: &AccountId, amount: u128) {
        self.acct(who).balance += amount;
        self.pool_tokens += amount;
    }

    fn credit_court(&mut self, who: &AccountId, amount: u128) {
        self.acct(who).court += amount;
        self.pool_tokens += amount;
    }

    fn join_court(&mut self, who: &AccountId, amount: u128) {
        let a = self.acct(who);
        a.balance -= amount;
        a.court += amount;
    }

    fn challenge(&mut self, by: &AccountId) {
        let p = self.price();
        let [jackpot, king, court, protocol] = split_ticket(p);
        self.acct(by).balance -= p;
        match self.king.clone() {
            None => self.jackpot += king,
            Some(k) => self.acct(&k).balance += king,
        }
        self.jackpot += jackpot;
        self.treasury += protocol;
        // Decision 6 (M6): depositors' share is floored; the odd micro goes to the draw pot.
        let reward = court * (10_000 - COURT_DRAW_BPS) / 10_000;
        let draw = court - reward;
        self.draw_pot += draw;
        self.rewards += reward;
        let total: u128 = self.accts.values().map(|a| a.court).sum();
        assert!(total > 0, "model: challenge with empty Court");
        for a in self.accts.values_mut().filter(|a| a.court > 0) {
            a.earned_upper += (reward * a.court * SCALE).div_ceil(total);
        }
        self.challenged.push((by.clone(), p, self.king.clone()));
        self.king = Some(by.clone());
        self.challenges += 1;
    }

    fn claim(&mut self, who: &AccountId, observed_earned: u128) -> u128 {
        let a = self.acct(who);
        let paid = a.balance + observed_earned;
        a.balance = 0;
        // Keep any sub-unit remainder so a carried fraction is not mistaken for an overpay later.
        a.earned_upper -= observed_earned * SCALE;
        self.rewards -= observed_earned;
        self.pool_tokens -= paid;
        paid
    }

    /// Inclusive bounds the contract's `court_earned` must fall in for `who`.
    fn earned_bounds(&self, who: &AccountId) -> (u128, u128) {
        let upper = self.accts.get(who).map_or(0, |a| a.earned_upper / SCALE);
        let dust = self.challenges as u128 + 1;
        (upper.saturating_sub(dust), upper)
    }
}

// ---------------------------------------------------------------- JSON helpers

/// u128 money fields must be JSON strings per the spec.
fn u(v: &Value) -> u128 {
    v.as_str()
        .unwrap_or_else(|| panic!("expected u128 as JSON string, got {v}"))
        .parse()
        .unwrap_or_else(|e| panic!("bad u128 {v}: {e}"))
}

/// Counters and ids: accept a number or a numeric string.
fn n(v: &Value) -> u64 {
    match v {
        Value::Number(x) => x.as_u64().unwrap_or_else(|| panic!("bad number {v}")),
        Value::String(s) => s.parse().unwrap_or_else(|e| panic!("bad number {v}: {e}")),
        _ => panic!("expected number, got {v}"),
    }
}

fn opt_account(v: &Value) -> Option<AccountId> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.parse().expect("account id")),
        _ => panic!("expected account id or null, got {v}"),
    }
}

fn failure_text(res: TransactionResult) -> String {
    format!("{:?}", res.assert_failure())
}

// ---------------------------------------------------------------- sandbox harness

static WASMS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();

fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    WASMS.get_or_init(|| {
        let build = |crate_dir: &str| {
            let manifest = format!("{}/{crate_dir}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
            let wasm = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
                manifest_path: Some(manifest.into()),
                ..Default::default()
            })
            .expect("wasm build");
            std::fs::read(&wasm).expect("read wasm")
        };
        (build("../test-usdc"), build("."))
    })
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    token: AccountId,
    pool: AccountId,
}

impl Env {
    async fn new() -> R<Self> {
        let (usdc_wasm, pool_wasm) = wasms().clone();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let token: AccountId = "usdc.sandbox".parse()?;
        let pool: AccountId = "rugpool.sandbox".parse()?;
        for id in [&token, &pool] {
            sandbox
                .create_account(id.clone())
                .initial_balance(NearToken::from_near(50))
                .send()
                .await?;
        }
        Contract::deploy(token.clone())
            .use_code(usdc_wasm)
            .with_init_call("new", json!({}))?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        Contract::deploy(pool.clone())
            .use_code(pool_wasm)
            .with_init_call(
                "new",
                // M2 has no round end. Since M3, rounds can end, so these M2 checks run with
                // a trigger and backstop that never fire.
                json!({"token": token, "withdraw_cooldown_ms": 1000, "court_draw_bps": 5000,
                    "timing": {"trigger_bps": 20, "trigger_fixed": "1000000000000000", "backstop_ms": 31536000000u64, "showdown_ms": 600000, "snipe_ms": 60000}}),
            )?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        let env = Self {
            sandbox,
            net,
            signer,
            token,
            pool,
        };
        let pool = env.pool.clone();
        env.register(&pool).await?;
        Ok(env)
    }

    async fn call(
        &self,
        from: &AccountId,
        contract: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> R<TransactionResult> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(300))
            .with_signer(from.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn pool_call(&self, from: &AccountId, method: &str, args: Value) -> R<TransactionResult> {
        let pool = self.pool.clone();
        self.call(from, &pool, method, args, NearToken::from_yoctonear(0))
            .await
    }

    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> R<Value> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .read_only::<Value>()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn pool_view(&self, method: &str, args: Value) -> R<Value> {
        let pool = self.pool.clone();
        self.view(&pool, method, args).await
    }

    async fn tokens_of(&self, who: &AccountId) -> R<u128> {
        let token = self.token.clone();
        Ok(u(&self
            .view(&token, "ft_balance_of", json!({"account_id": who}))
            .await?))
    }

    async fn register(&self, who: &AccountId) -> R<()> {
        let token = self.token.clone();
        self.call(
            who,
            &token,
            "storage_deposit",
            json!({"account_id": who}),
            NearToken::from_millinear(10),
        )
        .await?
        .assert_success();
        Ok(())
    }

    /// A new sandbox account registered on the token.
    async fn user(&self, name: &str) -> R<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self.sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(20))
            .send()
            .await?;
        self.register(&id).await?;
        Ok(id)
    }

    async fn mint(&self, who: &AccountId, mut amount: u128) -> R<()> {
        let token = self.token.clone();
        while amount > 0 {
            let chunk = amount.min(MINT_CAP);
            self.call(
                who,
                &token,
                "mint",
                json!({"account_id": who, "amount": chunk.to_string()}),
                NearToken::from_yoctonear(0),
            )
            .await?
            .assert_success();
            amount -= chunk;
        }
        Ok(())
    }

    /// Mints `amount` to `who` and sends it to RugPool with `msg`; asserts RugPool kept it all.
    async fn deposit(&self, who: &AccountId, amount: u128, msg: &str) -> R<()> {
        self.mint(who, amount).await?;
        let token = self.token.clone();
        let kept: String = self
            .call(
                who,
                &token,
                "ft_transfer_call",
                json!({"receiver_id": self.pool, "amount": amount.to_string(), "msg": msg}),
                NearToken::from_yoctonear(1),
            )
            .await?
            .assert_success()
            .json()?;
        assert_eq!(
            kept,
            amount.to_string(),
            "RugPool refused deposit of {amount} with msg {msg:?}"
        );
        Ok(())
    }

    async fn challenge(&self, who: &AccountId, max_price: u128) -> R<TransactionResult> {
        self.pool_call(
            who,
            "challenge",
            json!({"max_price": max_price.to_string()}),
        )
        .await
    }

    async fn account(&self, who: &AccountId) -> R<Value> {
        self.pool_view("get_account", json!({"account_id": who}))
            .await
    }

    async fn events(&self) -> R<Vec<Value>> {
        let mut out: Vec<Value> = Vec::new();
        let mut from = 0u64;
        for _ in 0..1000 {
            let page = self.pool_view("get_events", json!({"from": from})).await?;
            let evs = page["events"].as_array().cloned().unwrap_or_default();
            if evs.is_empty() {
                break;
            }
            for e in evs {
                if !out.iter().any(|o| o["id"] == e["id"]) {
                    out.push(e);
                }
            }
            let next = n(&page["cursor"]);
            if next <= from {
                break;
            }
            from = next;
        }
        Ok(out)
    }

    async fn challenged_events(&self) -> R<Vec<(AccountId, u128, Option<AccountId>)>> {
        Ok(self
            .events()
            .await?
            .into_iter()
            .filter(|e| e["type"] == "challenged")
            .map(|e| {
                let d = &e["data"];
                (
                    opt_account(&d["by"]).expect("challenged.by"),
                    u(&d["price"]),
                    opt_account(&d["dethroned"]),
                )
            })
            .collect())
    }

    /// Compares every observable number with the model, and checks the solvency invariant.
    async fn check(&self, m: &Model, step: &str) -> R<()> {
        let pool = self.pool.clone();
        let tokens = self.tokens_of(&pool).await?;
        let l = self.pool_view("get_liabilities", json!({})).await?;
        let (bal, court, jp, rw, dp, tr) = (
            u(&l["balances"]),
            u(&l["court"]),
            u(&l["jackpot"]),
            u(&l["rewards"]),
            u(&l["draw_pot"]),
            u(&l["treasury"]),
        );
        assert_eq!(
            tokens,
            bal + court + jp + rw + dp + tr,
            "[{step}] SOLVENCY: ft_balance_of(RugPool) != sum of liabilities {l}"
        );
        assert_eq!(
            tokens, m.pool_tokens,
            "[{step}] RugPool token balance vs model"
        );
        let model_bal: u128 = m.accts.values().map(|a| a.balance).sum();
        let model_court: u128 = m.accts.values().map(|a| a.court).sum();
        assert_eq!(bal, model_bal, "[{step}] liabilities.balances");
        assert_eq!(court, model_court, "[{step}] liabilities.court");
        assert_eq!(jp, m.jackpot, "[{step}] liabilities.jackpot");
        assert_eq!(dp, m.draw_pot, "[{step}] liabilities.draw_pot");
        assert_eq!(tr, m.treasury, "[{step}] liabilities.treasury");
        assert_eq!(rw, m.rewards, "[{step}] liabilities.rewards");

        let s = self.pool_view("get_state", json!({})).await?;
        let round = &s["round"];
        assert_eq!(
            n(&round["challenges"]),
            m.challenges,
            "[{step}] round.challenges"
        );
        assert_eq!(
            u(&round["next_price"]),
            price_at(m.challenges),
            "[{step}] round.next_price vs priceAt"
        );
        assert_eq!(opt_account(&round["king"]), m.king, "[{step}] round.king");
        assert_eq!(
            round["king_since"].is_null(),
            m.king.is_none(),
            "[{step}] round.king_since"
        );
        assert_eq!(u(&round["jackpot"]), m.jackpot, "[{step}] round.jackpot");
        assert!(
            round["showdown_ends_at"].is_null(),
            "[{step}] showdown_ends_at must be null in M2"
        );
        assert_eq!(u(&s["court"]["total"]), model_court, "[{step}] court.total");
        assert_eq!(
            u(&s["court"]["draw_pot"]),
            m.draw_pot,
            "[{step}] court.draw_pot"
        );
        let p = &s["params"];
        assert_eq!(
            u(&p["start_price"]),
            START_PRICE,
            "[{step}] params.start_price"
        );
        assert_eq!(
            n(&p["step_bps"]) as u128,
            STEP_BPS,
            "[{step}] params.step_bps"
        );
        let split: Vec<u128> = p["split_bps"]
            .as_array()
            .expect("split_bps")
            .iter()
            .map(|x| n(x) as u128)
            .collect();
        assert_eq!(split, SPLIT_BPS.to_vec(), "[{step}] params.split_bps");
        assert_eq!(u(&p["min_court"]), MIN_COURT, "[{step}] params.min_court");

        let mut earned_sum = 0;
        for (who, a) in &m.accts {
            let v = self.account(who).await?;
            assert_eq!(u(&v["balance"]), a.balance, "[{step}] {who} balance");
            assert_eq!(u(&v["court"]), a.court, "[{step}] {who} court");
            let earned = u(&v["court_earned"]);
            let (lo, hi) = m.earned_bounds(who);
            assert!(
                (lo..=hi).contains(&earned),
                "[{step}] {who} court_earned {earned} outside model bounds [{lo}, {hi}]"
            );
            earned_sum += earned;
        }
        assert!(
            earned_sum <= rw,
            "[{step}] sum court_earned {earned_sum} > rewards {rw}"
        );
        Ok(())
    }

    async fn do_challenge(&self, m: &mut Model, who: &AccountId, step: &str) -> R<()> {
        let price = m.price();
        self.challenge(who, price).await?.assert_success();
        m.challenge(who);
        self.check(m, step).await
    }
}

/// Everything a refused call must leave unchanged.
#[derive(Debug, PartialEq)]
struct Snapshot {
    liabilities: Value,
    caller: Value,
    round: (Value, Value, Value, Value),
    court: (Value, Value),
    events: usize,
    pool_tokens: u128,
    caller_tokens: u128,
}

async fn snapshot(env: &Env, caller: &AccountId) -> R<Snapshot> {
    let s = env.pool_view("get_state", json!({})).await?;
    let r = &s["round"];
    let pool = env.pool.clone();
    Ok(Snapshot {
        liabilities: env.pool_view("get_liabilities", json!({})).await?,
        // Draw odds grow with time since M6, so they aren't part of "nothing moved".
        caller: {
            let mut a = env.account(caller).await?;
            a.as_object_mut().unwrap().remove("draw_weight_bps");
            a
        },
        round: (
            r["challenges"].clone(),
            r["next_price"].clone(),
            r["king"].clone(),
            r["jackpot"].clone(),
        ),
        court: (s["court"]["total"].clone(), s["court"]["draw_pot"].clone()),
        events: env.events().await?.len(),
        pool_tokens: env.tokens_of(&pool).await?,
        caller_tokens: env.tokens_of(caller).await?,
    })
}

/// Sends `challenge(max_price)` from `caller`, expects `code`, and checks nothing moved.
async fn expect_refusal(
    env: &Env,
    m: &Model,
    caller: &AccountId,
    max_price: u128,
    code: &str,
) -> R<()> {
    let before = snapshot(env, caller).await?;
    let text = failure_text(env.challenge(caller, max_price).await?);
    assert!(
        text.contains(&format!("{code}:")),
        "challenge(max_price={max_price}) by {caller}: expected {code}, got {text}"
    );
    let after = snapshot(env, caller).await?;
    assert_eq!(before, after, "refused {code} challenge changed state");
    env.check(m, &format!("after refused {code}")).await
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn war_twenty_challenges_three_players_and_a_court_only_depositor() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.user("alice").await?;
    let b = env.user("bob").await?;
    let c = env.user("carol").await?;
    let d = env.user("dave").await?;

    // Different Court principals, A exactly at the minimum.
    env.deposit(&a, MIN_COURT, r#"{"action":"join"}"#).await?;
    m.credit_court(&a, MIN_COURT);
    env.check(&m, "A join").await?;
    env.deposit(&a, 200 * USDC, "").await?;
    m.credit_balance(&a, 200 * USDC);
    env.check(&m, "A balance").await?;

    env.deposit(&b, 40 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&b, 40 * USDC);
    env.check(&m, "B join").await?;
    env.deposit(&b, 200 * USDC, r#"{"action":"balance"}"#)
        .await?;
    m.credit_balance(&b, 200 * USDC);
    env.check(&m, "B balance").await?;

    env.deposit(&c, 60 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&c, 60 * USDC);
    env.check(&m, "C join").await?;
    // D funds C's game balance through the beneficiary field.
    let d_wallet_before = env.tokens_of(&d).await?;
    env.deposit(
        &d,
        200 * USDC,
        &format!(r#"{{"action":"balance","beneficiary":"{c}"}}"#),
    )
    .await?;
    m.credit_balance(&c, 200 * USDC);
    assert_eq!(
        env.tokens_of(&d).await?,
        d_wallet_before,
        "beneficiary deposit left D's wallet changed"
    );
    env.check(&m, "C balance via beneficiary").await?;

    env.deposit(&d, 100 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&d, 100 * USDC);
    env.check(&m, "D join").await?;

    let players = [&a, &b, &c];
    let mut wallets_before = Vec::new();
    for p in players {
        wallets_before.push(env.tokens_of(p).await?);
    }
    for i in 0..20u64 {
        let who = players[(i % 3) as usize];
        assert_eq!(m.price(), price_at(i), "model price drifted from priceAt");
        env.do_challenge(&mut m, who, &format!("challenge #{i} by {who}"))
            .await?;
    }
    for (p, before) in players.iter().zip(wallets_before) {
        assert_eq!(
            env.tokens_of(p).await?,
            before,
            "{p}'s wallet changed during the war"
        );
    }
    assert_eq!(m.challenges, 20);
    assert_eq!(
        env.challenged_events().await?,
        m.challenged,
        "challenged events"
    );

    // The Court-only depositor earned the largest share and never had a game balance.
    let dv = env.account(&d).await?;
    assert_eq!(u(&dv["balance"]), 0);
    assert!(
        u(&dv["court_earned"]) > 0,
        "Court-only depositor earned nothing"
    );
    Ok(())
}

#[tokio::test]
async fn refusal_court_too_small() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let stranger = env.user("stranger").await?;
    let small = env.user("small").await?;

    // No account at all; also price and balance would fail, but this code comes first.
    let acct = env.account(&stranger).await?;
    for f in ["balance", "court", "court_earned"] {
        assert_eq!(u(&acct[f]), 0, "unknown account {f}");
    }
    expect_refusal(&env, &m, &stranger, 0, "COURT_TOO_SMALL").await?;

    // Court one micro-USDC under the minimum, zero balance, stale max_price.
    env.deposit(&small, MIN_COURT - 1, r#"{"action":"join"}"#)
        .await?;
    m.credit_court(&small, MIN_COURT - 1);
    env.check(&m, "small join").await?;
    expect_refusal(&env, &m, &small, 0, "COURT_TOO_SMALL").await?;

    // Same Court, now with a valid price and enough balance.
    env.deposit(&small, 50 * USDC, "").await?;
    m.credit_balance(&small, 50 * USDC);
    env.check(&m, "small balance").await?;
    expect_refusal(&env, &m, &small, START_PRICE, "COURT_TOO_SMALL").await?;
    // A game balance is not Court principal.
    assert_eq!(u(&env.account(&small).await?["court"]), MIN_COURT - 1);
    Ok(())
}

#[tokio::test]
async fn refusal_already_king() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.user("alice").await?;
    env.deposit(&a, MIN_COURT, r#"{"action":"join"}"#).await?;
    m.credit_court(&a, MIN_COURT);
    // Exactly one ticket, so the King's balance is 0 afterwards.
    env.deposit(&a, START_PRICE, "").await?;
    m.credit_balance(&a, START_PRICE);
    env.check(&m, "setup").await?;
    env.do_challenge(&mut m, &a, "A becomes King").await?;

    // Stale price and no balance as well: ALREADY_KING is checked before both.
    expect_refusal(&env, &m, &a, 0, "ALREADY_KING").await?;
    env.deposit(&a, 50 * USDC, "").await?;
    m.credit_balance(&a, 50 * USDC);
    env.check(&m, "A tops up").await?;
    expect_refusal(&env, &m, &a, m.price(), "ALREADY_KING").await?;
    Ok(())
}

#[tokio::test]
async fn refusal_price_moved() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.user("alice").await?;
    let b = env.user("bob").await?;
    env.deposit(&a, MIN_COURT, r#"{"action":"join"}"#).await?;
    m.credit_court(&a, MIN_COURT);
    env.check(&m, "A join").await?;

    // Zero balance as well: PRICE_MOVED is checked before INSUFFICIENT_BALANCE.
    expect_refusal(&env, &m, &a, START_PRICE - 1, "PRICE_MOVED").await?;
    env.deposit(&a, 10 * USDC, "").await?;
    m.credit_balance(&a, 10 * USDC);
    env.check(&m, "A balance").await?;
    expect_refusal(&env, &m, &a, START_PRICE - 1, "PRICE_MOVED").await?;

    env.deposit(&b, 30 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&b, 30 * USDC);
    env.deposit(&b, 10 * USDC, "").await?;
    m.credit_balance(&b, 10 * USDC);
    env.check(&m, "B setup").await?;
    env.do_challenge(&mut m, &b, "B challenges").await?;

    // The price stepped up: the old price and one under the new price are both refused.
    expect_refusal(&env, &m, &a, START_PRICE, "PRICE_MOVED").await?;
    expect_refusal(&env, &m, &a, m.price() - 1, "PRICE_MOVED").await?;
    // max_price above the price is fine; A pays the current price, not max_price.
    env.challenge(&a, m.price() + 1_000_000)
        .await?
        .assert_success();
    m.challenge(&a);
    env.check(&m, "A challenges with headroom").await?;
    Ok(())
}

#[tokio::test]
async fn refusal_insufficient_balance() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.user("alice").await?;
    env.deposit(&a, MIN_COURT, r#"{"action":"join"}"#).await?;
    m.credit_court(&a, MIN_COURT);
    env.deposit(&a, START_PRICE - 1, "").await?;
    m.credit_balance(&a, START_PRICE - 1);
    env.check(&m, "setup").await?;

    expect_refusal(&env, &m, &a, START_PRICE, "INSUFFICIENT_BALANCE").await?;

    // One more USDC: Court exactly at the minimum passes, and the ticket is paid.
    env.deposit(&a, USDC, "").await?;
    m.credit_balance(&a, USDC);
    env.check(&m, "top up").await?;
    env.do_challenge(&mut m, &a, "A challenges").await?;
    assert_eq!(u(&env.account(&a).await?["balance"]), USDC - 1);
    Ok(())
}

#[tokio::test]
async fn first_challenge_king_share_to_jackpot_second_to_dethroned_king() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.user("alice").await?;
    let b = env.user("bob").await?;
    for p in [&a, &b] {
        env.deposit(p, 30 * USDC, r#"{"action":"join"}"#).await?;
        m.credit_court(p, 30 * USDC);
        env.deposit(p, 20 * USDC, "").await?;
        m.credit_balance(p, 20 * USDC);
    }
    env.check(&m, "setup").await?;

    env.do_challenge(&mut m, &a, "first").await?;
    let [jp, king, court, protocol] = split_ticket(START_PRICE);
    let s = env.pool_view("get_state", json!({})).await?;
    assert_eq!(
        u(&s["round"]["jackpot"]),
        jp + king,
        "first ticket: King share must go to the Jackpot"
    );
    assert_eq!(u(&s["round"]["jackpot"]), 4_000_000);
    assert_eq!(u(&s["court"]["draw_pot"]), court - court / 2);
    let l = env.pool_view("get_liabilities", json!({})).await?;
    assert_eq!(u(&l["treasury"]), protocol);
    assert_eq!(
        u(&env.account(&a).await?["balance"]),
        20 * USDC - START_PRICE
    );

    let a_before = u(&env.account(&a).await?["balance"]);
    let p2 = m.price();
    env.do_challenge(&mut m, &b, "second").await?;
    let a_after = u(&env.account(&a).await?["balance"]);
    assert_eq!(
        a_after - a_before,
        p2 * 2500 / 10_000,
        "second ticket: 25% to the dethroned King"
    );
    assert_eq!(a_after - a_before, 1_287_500);
    let s = env.pool_view("get_state", json!({})).await?;
    assert_eq!(u(&s["round"]["jackpot"]), 4_000_000 + split_ticket(p2)[0]);

    assert_eq!(
        env.challenged_events().await?,
        vec![
            (a.clone(), START_PRICE, None),
            (b.clone(), p2, Some(a.clone()))
        ]
    );
    Ok(())
}

#[tokio::test]
async fn claim_pays_balance_plus_court_earnings_then_nothing_to_claim() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.user("alice").await?;
    let b = env.user("bob").await?;
    let d = env.user("dave").await?;
    env.deposit(&a, 50 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&a, 50 * USDC);
    env.deposit(&a, 20 * USDC, "").await?;
    m.credit_balance(&a, 20 * USDC);
    env.deposit(&b, 30 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&b, 30 * USDC);
    env.deposit(&b, 20 * USDC, "").await?;
    m.credit_balance(&b, 20 * USDC);
    env.deposit(&d, 20 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&d, 20 * USDC);
    env.check(&m, "setup").await?;

    env.do_challenge(&mut m, &a, "A").await?;
    env.do_challenge(&mut m, &b, "B").await?;
    env.do_challenge(&mut m, &a, "A again").await?;

    for who in [&a, &b, &d] {
        let v = env.account(who).await?;
        let earned = u(&v["court_earned"]);
        let balance = u(&v["balance"]);
        let expected_balance = m.accts[who].balance;
        assert_eq!(balance, expected_balance, "{who} balance before claim");
        let wallet_before = env.tokens_of(who).await?;

        let paid: bool = env
            .pool_call(who, "claim", json!({}))
            .await?
            .assert_success()
            .json()?;
        assert!(paid, "claim by {who} returned false");
        let want = m.claim(who, earned);
        assert_eq!(want, expected_balance + earned);
        assert_eq!(
            env.tokens_of(who).await?,
            wallet_before + want,
            "{who} wallet after claim"
        );

        let after = env.account(who).await?;
        assert_eq!(u(&after["balance"]), 0, "{who} balance after claim");
        assert_eq!(
            u(&after["court_earned"]),
            0,
            "{who} court_earned after claim"
        );
        assert_eq!(
            u(&after["court"]),
            m.accts[who].court,
            "{who} principal must stay after claim"
        );
        env.check(&m, &format!("{who} claimed")).await?;

        let before = snapshot(&env, who).await?;
        let text = failure_text(env.pool_call(who, "claim", json!({})).await?);
        assert!(
            text.contains("NOTHING_TO_CLAIM:"),
            "second claim by {who}: {text}"
        );
        assert_eq!(
            snapshot(&env, who).await?,
            before,
            "failed claim changed state"
        );
    }
    // D never had a game balance, so D's payout was Court earnings alone and must be non-zero.
    assert!(
        env.tokens_of(&d).await? > 0,
        "Court-only depositor received nothing"
    );
    env.check(&m, "end").await?;
    Ok(())
}

/// Spec: unknown accounts read as all zeros, and `claim` panics NOTHING_TO_CLAIM when the
/// claimable amount is zero, so an account RugPool has never seen gets that code too.
#[tokio::test]
async fn claim_by_unknown_account_is_nothing_to_claim() -> TestResult {
    let env = Env::new().await?;
    let m = Model::default();
    let stranger = env.user("stranger").await?;
    let before = snapshot(&env, &stranger).await?;
    let text = failure_text(env.pool_call(&stranger, "claim", json!({})).await?);
    assert!(
        text.contains("NOTHING_TO_CLAIM:"),
        "claim by unknown account: {text}"
    );
    assert_eq!(
        snapshot(&env, &stranger).await?,
        before,
        "failed claim changed state"
    );
    env.check(&m, "end").await?;
    Ok(())
}

#[tokio::test]
async fn late_joiner_earns_nothing_from_earlier_tickets() -> TestResult {
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.user("alice").await?;
    let b = env.user("bob").await?;
    let e = env.user("erin").await?;
    for p in [&a, &b] {
        env.deposit(p, 40 * USDC, r#"{"action":"join"}"#).await?;
        m.credit_court(p, 40 * USDC);
        env.deposit(p, 50 * USDC, "").await?;
        m.credit_balance(p, 50 * USDC);
    }
    env.check(&m, "setup").await?;
    env.do_challenge(&mut m, &a, "t1 A").await?;
    env.do_challenge(&mut m, &b, "t2 B").await?;

    // E joins through join_court from the game balance.
    env.deposit(&e, 30 * USDC, "").await?;
    m.credit_balance(&e, 30 * USDC);
    env.check(&m, "E balance").await?;
    env.pool_call(&e, "join_court", json!({"amount": (30 * USDC).to_string()}))
        .await?
        .assert_success();
    m.join_court(&e, 30 * USDC);
    env.check(&m, "E join_court").await?;
    assert_eq!(
        u(&env.account(&e).await?["court_earned"]),
        0,
        "late joiner earned from earlier tickets"
    );

    // Adding principal does not change what A already earned.
    let a_earned_before = u(&env.account(&a).await?["court_earned"]);
    assert!(a_earned_before > 0);
    env.deposit(&a, 20 * USDC, r#"{"action":"join"}"#).await?;
    m.credit_court(&a, 20 * USDC);
    assert_eq!(
        u(&env.account(&a).await?["court_earned"]),
        a_earned_before,
        "topping up Court principal changed already-earned rewards"
    );
    env.check(&m, "A tops up Court").await?;

    // Later tickets: E earns pro rata on 30 of 130 USDC (bounds checked inside `check`).
    env.do_challenge(&mut m, &a, "t3 A").await?;
    let e_after_t3 = u(&env.account(&e).await?["court_earned"]);
    let r3 = {
        let c = split_ticket(price_at(2))[2];
        c - c * COURT_DRAW_BPS / 10_000
    };
    let exact_floor = r3 * 30 / 130;
    assert!(
        e_after_t3 <= exact_floor && e_after_t3 + 2 >= exact_floor,
        "E earned {e_after_t3} from t3, expected about {exact_floor} (= floor({r3} * 30/130))"
    );
    env.do_challenge(&mut m, &b, "t4 B").await?;
    Ok(())
}
