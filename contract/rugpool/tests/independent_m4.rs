//! Independent black-box sandbox tests for M4 auto-defend, written from the spec.

use std::sync::{Arc, OnceLock};

use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{Value, json};
use testresult::TestResult;

const USDC: u128 = 1_000_000;

fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    static W: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    W.get_or_init(|| {
        let dir = env!("CARGO_MANIFEST_DIR");
        let build = |p: String| {
            let path = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts {
                manifest_path: Some(p.into()),
                ..Default::default()
            })
            .expect("build");
            std::fs::read(path).expect("read wasm")
        };
        let usdc = build(format!("{dir}/../test-usdc/Cargo.toml"));
        let pool = build(format!("{dir}/Cargo.toml"));
        (usdc, pool)
    })
}

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    usdc: AccountId,
    pool: AccountId,
}

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("not a u128 string: {v}")).parse().unwrap()
}

impl Env {
    async fn new() -> TestResult<Env> {
        let (usdc_wasm, pool_wasm) = tokio::task::spawn_blocking(wasms).await?.clone();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        let usdc = id("usdc.sandbox");
        let pool = id("rugpool.sandbox");
        for a in [&usdc, &pool] {
            sandbox.create_account(a.clone()).initial_balance(NearToken::from_near(20)).send().await?;
        }
        Contract::deploy(usdc.clone())
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
                json!({
                    "token": usdc,
                    "withdraw_cooldown_ms": 1000,
                    "court_draw_bps": 5000,
                    "timing": {
                        "trigger_bps": 20,
                        "trigger_fixed": "1000000000000000",
                        "backstop_ms": 31_536_000_000u64,
                        "showdown_ms": 600_000,
                        "snipe_ms": 60_000
                    }
                }),
            )?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        let env = Env { sandbox, net, signer, usdc, pool };
        env.register(&env.pool.clone()).await?;
        Ok(env)
    }

    async fn call(
        &self,
        contract: &AccountId,
        from: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> TestResult<near_api::types::transaction::result::TransactionResult> {
        Ok(Contract(contract.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(300))
            .with_signer(from.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn view(&self, contract: &AccountId, method: &str, args: Value) -> TestResult<Value> {
        let d: near_api::Data<Value> =
            Contract(contract.clone()).call_function(method, args).read_only().fetch_from(&self.net).await?;
        Ok(d.data)
    }

    async fn register(&self, who: &AccountId) -> TestResult {
        self.call(
            &self.usdc,
            who,
            "storage_deposit",
            json!({"account_id": who}),
            NearToken::from_millinear(10),
        )
        .await?
        .assert_success();
        Ok(())
    }

    /// Creates a player, registers it on the token and mints `amount` to its wallet.
    async fn player(&self, name: &str, amount: u128) -> TestResult<AccountId> {
        let who = id(&format!("{name}.sandbox"));
        self.sandbox.create_account(who.clone()).initial_balance(NearToken::from_near(20)).send().await?;
        self.register(&who).await?;
        let mut left = amount;
        while left > 0 {
            let m = left.min(1_000_000_000);
            self.call(&self.usdc, &who, "mint", json!({"account_id": who, "amount": m.to_string()}), NearToken::from_yoctonear(0))
                .await?
                .assert_success();
            left -= m;
        }
        Ok(who)
    }

    async fn transfer_call(&self, from: &AccountId, amount: u128, msg: &str) -> TestResult {
        self.call(
            &self.usdc,
            from,
            "ft_transfer_call",
            json!({"receiver_id": self.pool, "amount": amount.to_string(), "msg": msg}),
            NearToken::from_yoctonear(1),
        )
        .await?
        .assert_success();
        Ok(())
    }

    async fn ft_balance(&self, who: &AccountId) -> TestResult<u128> {
        Ok(u(&self.view(&self.usdc, "ft_balance_of", json!({"account_id": who})).await?))
    }

    async fn state(&self) -> TestResult<Value> {
        self.view(&self.pool, "get_state", json!({})).await
    }

    async fn account(&self, who: &AccountId) -> TestResult<Value> {
        self.view(&self.pool, "get_account", json!({"account_id": who})).await
    }

    async fn liabilities(&self) -> TestResult<Value> {
        self.view(&self.pool, "get_liabilities", json!({})).await
    }

    async fn events(&self, from: u64) -> TestResult<Value> {
        self.view(&self.pool, "get_events", json!({"from": from})).await
    }
}


// ---- independent integer model of the spec ---------------------------------------

const MIN_COURT: u128 = 25 * USDC;
const MAX_RETAKES: u32 = 25;
/// Court earnings are tracked pro rata at this extra precision.
const SCALE: u128 = 1_000_000_000_000;

/// `priceAt` from curve.ts: 5 USDC, then +3% floored per ticket.
fn price_at(k: u32) -> u128 {
    let mut p = 5 * USDC;
    for _ in 0..k {
        p = p * 10_300 / 10_000;
    }
    p
}

/// [Jackpot (55% plus remainder), King 25%, Court 15%, protocol 5%], each share floored.
fn split(p: u128) -> (u128, u128, u128, u128) {
    let king = p * 2_500 / 10_000;
    let court = p * 1_500 / 10_000;
    let protocol = p * 500 / 10_000;
    (p - king - court - protocol, king, court, protocol)
}

#[derive(Default, Clone)]
struct Acct {
    bal: u128,
    court: u128,
    /// Scaled by `SCALE`.
    earned: u128,
    max: u128,
}

#[derive(Default)]
struct Model {
    k: u32,
    king: Option<AccountId>,
    accts: std::collections::BTreeMap<AccountId, Acct>,
    jackpot: u128,
    rewards: u128,
    draw_pot: u128,
    treasury: u128,
    /// USDC held by RugPool according to the model.
    held: u128,
    tickets: u32,
    events: Vec<Value>,
}

impl Model {
    fn a(&mut self, who: &AccountId) -> &mut Acct {
        self.accts.entry(who.clone()).or_default()
    }

    fn court_total(&self) -> u128 {
        self.accts.values().map(|a| a.court).sum()
    }

    fn price(&self) -> u128 {
        price_at(self.k)
    }

    fn ticket(&mut self, who: &AccountId, auto: bool) -> Option<AccountId> {
        let p = self.price();
        let (jack, king_share, court, protocol) = split(p);
        let a = self.a(who);
        assert!(a.bal >= p, "model: {who} cannot pay {p}");
        a.bal -= p;
        self.jackpot += jack;
        let prev = self.king.clone();
        match &prev {
            Some(d) => self.a(d).bal += king_share,
            None => self.jackpot += king_share,
        }
        // `court_draw_bps` = 5000. Decision 6 (M6): depositors' half is floored and the odd
        // micro goes to the draw pot, as in mockStore.ts.
        let to_rewards = court * 5_000 / 10_000;
        let to_draw = court - to_rewards;
        self.draw_pot += to_draw;
        self.rewards += to_rewards;
        let total = self.court_total();
        assert!(total > 0);
        for acct in self.accts.values_mut() {
            acct.earned += to_rewards * acct.court * SCALE / total;
        }
        self.treasury += protocol;
        self.king = Some(who.clone());
        self.k += 1;
        self.tickets += 1;
        self.events.push(if auto {
            json!({"type": "auto_defended", "data": {"by": who, "price": p.to_string(), "against": prev.clone().unwrap()}})
        } else {
            json!({"type": "challenged", "data": {"by": who, "price": p.to_string(), "dethroned": prev.clone()}})
        });
        prev
    }

    /// A user challenge followed by the auto-defend war. Returns the number of retakes.
    fn challenge(&mut self, who: &AccountId, max_price: u128) -> u32 {
        let p = self.price();
        let a = self.a(who).clone();
        assert!(p <= max_price && a.bal >= p && a.court >= MIN_COURT && self.king.as_ref() != Some(who));
        let mut dethroned = self.ticket(who, false);
        let mut retakes = 0;
        while let Some(d) = dethroned {
            if retakes == MAX_RETAKES {
                break;
            }
            let np = self.price();
            let da = self.a(&d).clone();
            if !(da.max > 0 && np <= da.max && da.bal >= np && da.court >= MIN_COURT) {
                break;
            }
            dethroned = self.ticket(&d, true);
            retakes += 1;
        }
        retakes
    }
}

// ---- test helpers ------------------------------------------------------------------

static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

const ZERO: NearToken = NearToken::from_yoctonear(0);
const BIG: u128 = 1_000_000 * USDC;

fn refusal(r: near_api::types::transaction::result::TransactionResult, code: &str) {
    let dbg = format!("{:?}", r.assert_failure());
    assert!(dbg.contains(code), "expected refusal {code}, got: {dbg}");
}

impl Env {
    /// Creates a player with `court` in the Court and `bal` in the game balance.
    async fn seat(&self, m: &mut Model, name: &str, court: u128, bal: u128) -> TestResult<AccountId> {
        let who = self.player(name, court + bal).await?;
        if court > 0 {
            self.transfer_call(&who, court, r#"{"action":"join"}"#).await?;
        }
        if bal > 0 {
            self.transfer_call(&who, bal, "").await?;
        }
        let a = m.a(&who);
        a.court += court;
        a.bal += bal;
        m.held += court + bal;
        // ft_transfer_call refunds silently, so prove the deposit landed.
        let v = self.account(&who).await?;
        assert_eq!(u(&v["court"]), court, "court deposit of {who}");
        assert_eq!(u(&v["balance"]), bal, "game deposit of {who}");
        Ok(who)
    }

    async fn arm(&self, m: &mut Model, who: &AccountId, max: u128) -> TestResult {
        self.call(&self.pool, who, "set_auto_defend", json!({"max_price": max.to_string()}), ZERO)
            .await?
            .assert_success();
        m.a(who).max = max;
        assert_eq!(u(&self.account(who).await?["auto_defend_max"]), max);
        Ok(())
    }

    async fn cursor(&self) -> TestResult<u64> {
        Ok(self.events(0).await?["cursor"].as_u64().unwrap())
    }

    /// Sends a challenge, applies it to the model and asserts the transaction's events.
    /// Returns (retakes, gas burnt in Tgas).
    async fn challenge(&self, m: &mut Model, who: &AccountId, max_price: u128) -> TestResult<(u32, f64)> {
        let before = self.cursor().await?;
        let k_before = self.state().await?["round"]["challenges"].as_u64().unwrap();
        let ok = self
            .call(&self.pool, who, "challenge", json!({"max_price": max_price.to_string()}), ZERO)
            .await?
            .assert_success();
        let gas = ok.total_gas_burnt.as_gas() as f64 / 1e12;
        m.events.clear();
        let retakes = m.challenge(who, max_price);
        let page = self.events(before).await?;
        let got = page["events"].as_array().unwrap();
        assert!(got.len() < 50, "page may be truncated");
        let mut last = before;
        for e in got {
            let id = e["id"].as_u64().unwrap();
            assert!(id > last, "event ids must increase");
            last = id;
        }
        let got: Vec<Value> = got.iter().map(|e| json!({"type": e["type"], "data": e["data"]})).collect();
        assert_eq!(got, m.events, "events of {who}'s challenge");
        let k_after = self.state().await?["round"]["challenges"].as_u64().unwrap();
        assert_eq!(k_after - k_before, 1 + retakes as u64, "challenge count delta");
        Ok((retakes, gas))
    }

    /// Compares every observable value with the model and checks the solvency invariant.
    async fn check(&self, m: &Model) -> TestResult {
        let s = self.state().await?;
        let r = &s["round"];
        assert_eq!(r["challenges"].as_u64().unwrap(), m.k as u64, "challenges");
        assert_eq!(r["king"].as_str().map(id), m.king, "king");
        assert_eq!(u(&r["next_price"]), m.price(), "next_price");
        assert_eq!(u(&r["jackpot"]), m.jackpot, "round jackpot");
        assert_eq!(u(&s["court"]["total"]), m.court_total(), "court total");
        assert_eq!(u(&s["court"]["draw_pot"]), m.draw_pot, "court draw_pot");

        let l = self.liabilities().await?;
        let bal_sum: u128 = m.accts.values().map(|a| a.bal).sum();
        assert_eq!(u(&l["balances"]), bal_sum, "liabilities.balances");
        assert_eq!(u(&l["court"]), m.court_total(), "liabilities.court");
        assert_eq!(u(&l["jackpot"]), m.jackpot, "liabilities.jackpot");
        assert_eq!(u(&l["draw_pot"]), m.draw_pot, "liabilities.draw_pot");
        assert_eq!(u(&l["treasury"]), m.treasury, "liabilities.treasury");
        assert_eq!(u(&l["rewards"]), m.rewards, "liabilities.rewards");

        let mut earned_sum = 0;
        for (who, a) in &m.accts {
            let v = self.account(who).await?;
            assert_eq!(u(&v["balance"]), a.bal, "balance of {who}");
            assert_eq!(u(&v["court"]), a.court, "court of {who}");
            assert_eq!(u(&v["auto_defend_max"]), a.max, "auto_defend_max of {who}");
            let obs = u(&v["court_earned"]);
            let lo = a.earned / SCALE;
            let hi = a.earned.div_ceil(SCALE);
            assert!(
                obs <= hi && lo.saturating_sub(obs) <= m.tickets as u128 + 1,
                "court_earned of {who}: observed {obs}, model {lo}..={hi}"
            );
            earned_sum += obs;
        }
        assert!(earned_sum <= u(&l["rewards"]), "court_earned sum {earned_sum} exceeds rewards");

        let liab_sum: u128 = ["balances", "court", "jackpot", "rewards", "draw_pot", "treasury"]
            .iter()
            .map(|k| u(&l[*k]))
            .sum();
        assert_eq!(self.ft_balance(&self.pool).await?, liab_sum, "ft_balance_of(RugPool) == liabilities");
        assert_eq!(liab_sum, m.held, "model holdings");
        Ok(())
    }

    /// request_withdraw, wait out the 1 s cooldown, then withdraw. Asserts the payout.
    async fn withdraw_court(&self, m: &mut Model, who: &AccountId, amount: u128) -> TestResult {
        self.call(&self.pool, who, "request_withdraw", json!({"amount": amount.to_string()}), ZERO)
            .await?
            .assert_success();
        let wallet = self.ft_balance(who).await?;
        let mut paid = None;
        for _ in 0..10 {
            self.sandbox.fast_forward(5).await?;
            let r = self.call(&self.pool, who, "withdraw", json!({}), ZERO).await?;
            if r.is_success() {
                paid = Some(r.assert_success().json::<bool>()?);
                break;
            }
            let dbg = format!("{:?}", r.assert_failure());
            assert!(dbg.contains("COOLDOWN"), "unexpected withdraw failure: {dbg}");
        }
        assert_eq!(paid, Some(true), "withdraw paid out");
        assert_eq!(self.ft_balance(who).await? - wallet, amount, "withdraw payout");
        m.a(who).court -= amount;
        m.held -= amount;
        Ok(())
    }
}

// ---- 1. single retake ----------------------------------------------------------------

#[tokio::test]
async fn single_retake() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.seat(&mut m, "a", 100 * USDC, 200 * USDC).await?;
    let b = env.seat(&mut m, "b", 50 * USDC, 200 * USDC).await?;
    let _c = env.seat(&mut m, "c", 77 * USDC, 0).await?;

    assert_eq!(env.challenge(&mut m, &a, price_at(0)).await?.0, 0);
    env.arm(&mut m, &a, 100 * USDC).await?;
    env.check(&m).await?;

    let (retakes, _) = env.challenge(&mut m, &b, price_at(1)).await?;
    assert_eq!(retakes, 1);
    assert_eq!(
        m.events,
        vec![
            json!({"type": "challenged", "data": {"by": b, "price": price_at(1).to_string(), "dethroned": a}}),
            json!({"type": "auto_defended", "data": {"by": a, "price": price_at(2).to_string(), "against": b}}),
        ]
    );
    assert_eq!(m.king, Some(a.clone()));
    assert_eq!(m.k, 3);
    // Hand-derived: A paid p0 + p2 and got 25% of p1; B paid p1 and got 25% of p2.
    let (_, k1, _, _) = split(price_at(1));
    let (_, k2, _, _) = split(price_at(2));
    assert_eq!(m.accts[&a].bal, 200 * USDC - price_at(0) - price_at(2) + k1);
    assert_eq!(m.accts[&b].bal, 200 * USDC - price_at(1) + k2);
    env.check(&m).await?;
    Ok(())
}

// ---- 2. war to the cap -----------------------------------------------------------------

#[tokio::test]
async fn war_runs_to_cap() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.seat(&mut m, "a", 100 * USDC, 900 * USDC).await?;
    let b = env.seat(&mut m, "b", 100 * USDC, 900 * USDC).await?;

    env.challenge(&mut m, &a, price_at(0)).await?;
    env.arm(&mut m, &a, BIG).await?;
    env.arm(&mut m, &b, BIG).await?;
    // B's max_price equals its own ticket price; it must not cap B's later retakes.
    let (retakes, gas) = env.challenge(&mut m, &b, price_at(1)).await?;
    println!("war_runs_to_cap: 1 challenge + {retakes} retakes burnt {gas:.2} Tgas");
    assert_eq!(retakes, 25);
    let autos = m.events.iter().filter(|e| e["type"] == "auto_defended").count();
    assert_eq!(autos, 25);
    assert_eq!(m.events[0]["type"], "challenged");
    // Retakes alternate A, B, A, ... so the 25th is A's.
    assert_eq!(m.king, Some(a.clone()));
    assert_eq!(m.k, 27);
    assert_eq!(m.events.last().unwrap()["data"]["price"], price_at(26).to_string());
    assert!(gas < 150.0, "war gas {gas} Tgas is not far below 300");
    env.check(&m).await?;

    // The cap is per transaction: a second war in the same round runs 25 retakes again.
    let (retakes, gas) = env.challenge(&mut m, &b, BIG).await?;
    println!("war_runs_to_cap: second war, 1 challenge + {retakes} retakes burnt {gas:.2} Tgas");
    assert_eq!(retakes, 25);
    assert_eq!(m.king, Some(a.clone()));
    assert_eq!(m.k, 53);
    env.check(&m).await?;
    Ok(())
}

// ---- 3. stop conditions ----------------------------------------------------------------

/// B's balance after its challenge and first retake, given its starting balance.
fn balance_war_start(extra: u128) -> u128 {
    let (_, k2, _, _) = split(price_at(2));
    let (_, k4, _, _) = split(price_at(4));
    price_at(1) - k2 + price_at(3) - k4 + price_at(5) + extra - 1
}

#[tokio::test]
async fn war_stops_on_insufficient_balance() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.seat(&mut m, "a", 100 * USDC, 900 * USDC).await?;
    // B can pay p1 and p3 but has exactly p5 - 1 when its second retake comes up.
    let b = env.seat(&mut m, "b", 100 * USDC, balance_war_start(0)).await?;
    env.challenge(&mut m, &a, price_at(0)).await?;
    env.arm(&mut m, &a, BIG).await?;
    env.arm(&mut m, &b, BIG).await?;

    let (retakes, _) = env.challenge(&mut m, &b, price_at(1)).await?;
    assert_eq!(retakes, 3, "A, B, A retake; B is 1 micro short at p5");
    assert_eq!(m.king, Some(a.clone()));
    assert_eq!(m.accts[&b].bal, price_at(5) - 1);
    env.check(&m).await?;

    // B also cannot challenge by hand with 1 micro short.
    let r = env.call(&env.pool, &b, "challenge", json!({"max_price": BIG.to_string()}), ZERO).await?;
    refusal(r, "INSUFFICIENT_BALANCE");
    env.check(&m).await?;
    Ok(())
}

#[tokio::test]
async fn war_retakes_with_exact_balance() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.seat(&mut m, "a", 100 * USDC, 900 * USDC).await?;
    // B has exactly p5 when its second retake comes up.
    let b = env.seat(&mut m, "b", 100 * USDC, balance_war_start(1)).await?;
    env.challenge(&mut m, &a, price_at(0)).await?;
    env.arm(&mut m, &a, BIG).await?;
    env.arm(&mut m, &b, BIG).await?;

    let (retakes, _) = env.challenge(&mut m, &b, price_at(1)).await?;
    // A p2, B p3, A p4, B p5 (balance == price), A p6; B then holds only 25% of p6.
    assert_eq!(retakes, 5);
    assert_eq!(m.king, Some(a.clone()));
    assert_eq!(m.accts[&b].bal, split(price_at(6)).1);
    env.check(&m).await?;
    Ok(())
}

#[tokio::test]
async fn war_stops_at_max_price_boundary() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.seat(&mut m, "a", 100 * USDC, 500 * USDC).await?;
    let b = env.seat(&mut m, "b", 100 * USDC, 500 * USDC).await?;
    env.challenge(&mut m, &a, price_at(0)).await?;
    env.arm(&mut m, &a, price_at(4)).await?;
    env.arm(&mut m, &b, BIG).await?;

    let (retakes, _) = env.challenge(&mut m, &b, price_at(1)).await?;
    // A retakes at p2 and at p4 (== max), B at p3 and p5, A stops at p6 > max.
    assert_eq!(retakes, 4);
    assert_eq!(m.king, Some(b.clone()));
    assert_eq!(m.k, 6);
    env.check(&m).await?;

    // Overwrite both maxes: B (defender) gets exactly p7, A gets p8 - 1. A challenges with
    // a huge max_price, which must not stand in for A's own auto-defend max.
    env.arm(&mut m, &b, price_at(7)).await?;
    env.arm(&mut m, &a, price_at(8) - 1).await?;
    let (retakes, _) = env.challenge(&mut m, &a, BIG).await?;
    assert_eq!(retakes, 1, "B retakes at p7 == max; A stops at p8 > p8 - 1");
    assert_eq!(m.king, Some(b.clone()));
    assert_eq!(m.k, 8);
    env.check(&m).await?;
    Ok(())
}

#[tokio::test]
async fn disarmed_defender_does_not_retake() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.seat(&mut m, "a", 100 * USDC, 300 * USDC).await?;
    let b = env.seat(&mut m, "b", 100 * USDC, 300 * USDC).await?;
    env.challenge(&mut m, &a, price_at(0)).await?;
    env.arm(&mut m, &a, BIG).await?;
    env.arm(&mut m, &a, 0).await?;
    env.arm(&mut m, &b, BIG).await?;

    let (retakes, _) = env.challenge(&mut m, &b, price_at(1)).await?;
    assert_eq!(retakes, 0);
    assert_eq!(m.events.len(), 1);
    assert_eq!(m.king, Some(b.clone()));
    env.check(&m).await?;
    Ok(())
}

#[tokio::test]
async fn defender_under_min_court_does_not_retake() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    let a = env.seat(&mut m, "a", 31 * USDC, 300 * USDC).await?;
    let b = env.seat(&mut m, "b", 100 * USDC, 300 * USDC).await?;
    env.challenge(&mut m, &a, price_at(0)).await?;
    env.arm(&mut m, &a, BIG).await?;

    // Court exactly 25 USDC still retakes.
    env.withdraw_court(&mut m, &a, 6 * USDC).await?;
    env.check(&m).await?;
    let (retakes, _) = env.challenge(&mut m, &b, price_at(1)).await?;
    assert_eq!(retakes, 1, "A retakes with exactly 25 USDC in the Court");
    assert_eq!(m.king, Some(a.clone()));
    env.check(&m).await?;

    // 24 USDC does not.
    env.withdraw_court(&mut m, &a, USDC).await?;
    env.check(&m).await?;
    let (retakes, _) = env.challenge(&mut m, &b, price_at(3)).await?;
    assert_eq!(retakes, 0, "A is under the 25 USDC Court minimum");
    assert_eq!(m.king, Some(b.clone()));
    env.check(&m).await?;

    let r = env.call(&env.pool, &a, "challenge", json!({"max_price": BIG.to_string()}), ZERO).await?;
    refusal(r, "COURT_TOO_SMALL");
    Ok(())
}

// ---- 4. accounting through a war ----------------------------------------------------------

#[tokio::test]
async fn accounting_through_war_and_claims() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    // Odd Court sizes so pro-rata shares do not divide evenly.
    let a = env.seat(&mut m, "a", 37_000_003, 300 * USDC).await?;
    let b = env.seat(&mut m, "b", 53_000_007, 300 * USDC).await?;
    let c = env.seat(&mut m, "c", 101_000_011, 0).await?;
    env.challenge(&mut m, &a, price_at(0)).await?;
    env.arm(&mut m, &a, price_at(10)).await?;
    env.arm(&mut m, &b, BIG).await?;

    let (retakes, _) = env.challenge(&mut m, &b, price_at(1)).await?;
    // A retakes at p2..p10 (5), B at p3..p11 (5); A stops at p12.
    assert_eq!(retakes, 10);
    assert_eq!(m.tickets, 12);
    assert_eq!(m.king, Some(b.clone()));
    env.check(&m).await?;

    // Hand-derived totals over tickets 0..12 as a cross-check of the model itself.
    let prices: Vec<u128> = (0..12).map(price_at).collect();
    let treasury: u128 = prices.iter().map(|&p| split(p).3).sum();
    let rewards: u128 = prices.iter().map(|&p| split(p).2 / 2).sum();
    let draw: u128 = prices.iter().map(|&p| split(p).2 - split(p).2 / 2).sum();
    let jackpot: u128 = prices.iter().map(|&p| split(p).0).sum::<u128>() + split(prices[0]).1;
    assert_eq!((m.treasury, m.draw_pot, m.rewards, m.jackpot), (treasury, draw, rewards, jackpot));

    for who in [&a, &b, &c] {
        let v = env.account(who).await?;
        let owed = u(&v["balance"]) + u(&v["court_earned"]) + u(&v["king_stream"]);
        assert_eq!(u(&v["king_stream"]), 0, "no yield is configured");
        let wallet = env.ft_balance(who).await?;
        let r = env.call(&env.pool, who, "claim", json!({}), ZERO).await?.assert_success();
        assert_eq!(r.json::<bool>()?, true, "claim by {who} paid out");
        assert_eq!(env.ft_balance(who).await? - wallet, owed, "claim payout of {who}");
        let after = env.account(who).await?;
        assert_eq!(u(&after["balance"]), 0);
        assert_eq!(u(&after["court_earned"]), 0);
        let earned = u(&v["court_earned"]);
        let acct = m.a(who);
        assert_eq!(acct.bal + earned, owed);
        acct.bal = 0;
        acct.earned = acct.earned.saturating_sub(earned * SCALE);
        m.rewards -= earned;
        m.held -= owed;
    }
    env.check(&m).await?;
    Ok(())
}

// ---- 5. arming ------------------------------------------------------------------------

#[tokio::test]
async fn arming_rules() -> TestResult {
    let _slot = SLOTS.acquire().await?;
    let env = Env::new().await?;
    let mut m = Model::default();
    // Registered on the token but never deposited into RugPool.
    let stranger = env.player("stranger", 10 * USDC).await?;
    let r = env.call(&env.pool, &stranger, "set_auto_defend", json!({"max_price": "7000000"}), ZERO).await?;
    refusal(r, "INSUFFICIENT_BALANCE");
    assert_eq!(u(&env.account(&stranger).await?["auto_defend_max"]), 0);

    let a = env.seat(&mut m, "a", 30 * USDC, 10 * USDC).await?;
    assert_eq!(u(&env.account(&a).await?["auto_defend_max"]), 0);
    env.arm(&mut m, &a, 7 * USDC).await?;
    env.arm(&mut m, &a, 9 * USDC).await?;
    env.arm(&mut m, &a, 0).await?;
    assert_eq!(env.account(&a).await?["auto_defend_max"], json!("0"));
    env.check(&m).await?;
    Ok(())
}
