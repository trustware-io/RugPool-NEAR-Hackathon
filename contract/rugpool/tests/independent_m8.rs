//! Independent black-box sandbox tests for the M8 features (finite yield reserve, registration
//! fee, deletion of empty accounts), written from the M8 spec only. Value-moving steps re-check
//! that RugPool's token balance equals the sum of its reported liabilities, which now include
//! `yield_reserve` and `streams`.
//!
//! Exact accrual checks read views at the block where an accrual trigger (`poke`) executed, so the
//! elapsed time is the difference of two known block timestamps.

use near_api::types::transaction::result::{ExecutionSuccess, TransactionResult};
use near_api::{AccountId, Chain, Contract, CryptoHash, NearGas, NearToken, NetworkConfig, Reference, Signer};
use near_sdk::serde_json::{Value, json};
use std::cell::Cell;
use std::sync::{Arc, OnceLock};

type R<T> = Result<T, Box<dyn std::error::Error>>;

const U: u128 = 1_000_000;
const YEAR_MS: u128 = 365 * 24 * 3600 * 1000;
const BIG: u128 = 1u128 << 100;
const BUCKETS: [&str; 10] = [
    "balances", "court", "jackpot", "rewards", "draw_pot", "treasury", "pending", "recovery",
    "yield_reserve", "streams",
];

/// Caps concurrent sandboxes: several tests fast-forward by close to an hour of block time.
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

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

fn timing() -> Value {
    json!({"trigger_bps": 20, "trigger_fixed": "1000000000000000", "backstop_ms": 31536000000u64,
           "showdown_ms": 600000, "snipe_ms": 60000})
}

/// No caps, and the periodic draw is a week away so it never interferes.
fn limits() -> Value {
    json!({"max_account": BIG.to_string(), "max_total": BIG.to_string(),
           "draw_min": U.to_string(), "draw_every_ms": 604_800_000u64})
}

fn yp(apy_bps: u32, split: [u32; 3]) -> Value {
    json!({"apy_bps": apy_bps, "split_bps": split})
}

fn num(v: &Value) -> u128 {
    match v {
        Value::String(s) => s.parse().unwrap_or_else(|_| panic!("not a number: {v}")),
        Value::Number(n) => n.as_u64().unwrap_or_else(|| panic!("not u64: {v}")) as u128,
        _ => panic!("not a number: {v}"),
    }
}

fn id(name: &str) -> AccountId {
    format!("{name}.sandbox").parse().unwrap()
}

/// Yield due for `court_total` over `dms` milliseconds, per the spec formula (floored).
fn due(court_total: u128, apy_bps: u128, dms: u64) -> u128 {
    court_total * apy_bps * dms as u128 / (10_000 * YEAR_MS)
}

fn sum_all(l: &Value) -> u128 {
    BUCKETS.iter().map(|k| num(&l[*k])).sum()
}

fn ok_fund() -> String {
    json!({"action": "fund_yield"}).to_string()
}

fn join() -> String {
    json!({"action": "join"}).to_string()
}

fn bal(beneficiary: &str) -> String {
    json!({"action": "balance", "beneficiary": id(beneficiary)}).to_string()
}

fn base_args(usdc: &AccountId, cooldown_ms: u64, extra: &Value) -> Value {
    let mut args = json!({"token": usdc, "withdraw_cooldown_ms": cooldown_ms,
                          "court_draw_bps": 5000, "timing": timing(), "limits": limits()});
    for (k, v) in extra.as_object().unwrap() {
        args[k] = v.clone();
    }
    args
}

struct T {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    usdc: AccountId,
    pool: AccountId,
    ms_per_block: Cell<Option<f64>>,
}

impl T {
    /// Deploys tUSDC and RugPool, registers and funds every user with 1,000 tUSDC.
    async fn new(cooldown_ms: u64, extra: Value, users: &[&str]) -> R<T> {
        let (usdc_wasm, pool_wasm) = wasms().clone();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let usdc = id("usdc");
        let pool = id("pool");
        for a in [&usdc, &pool] {
            sandbox.create_account(a.clone()).initial_balance(NearToken::from_near(20)).send().await?;
        }
        for u in users {
            sandbox.create_account(id(u)).initial_balance(NearToken::from_near(20)).send().await?;
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
            .with_init_call("new", base_args(&usdc, cooldown_ms, &extra))?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        let t = T { sandbox, net, signer, usdc, pool, ms_per_block: Cell::new(None) };
        let pool_id = t.pool.clone();
        t.register(&pool_id).await?;
        for u in users {
            t.register(&id(u)).await?;
            t.mint(u, 1000 * U).await?;
        }
        Ok(t)
    }

    async fn register(&self, who: &AccountId) -> R<()> {
        self.call_on(&self.usdc, "usdc", "storage_deposit", json!({"account_id": who}),
            NearToken::from_millinear(10)).await?.assert_success();
        Ok(())
    }

    async fn mint(&self, name: &str, mut amount: u128) -> R<()> {
        let usdc = self.usdc.clone();
        while amount > 0 {
            let chunk = amount.min(1000 * U);
            self.call_on(&usdc, "usdc", "mint",
                json!({"account_id": id(name), "amount": chunk.to_string()}), NearToken::from_yoctonear(0))
                .await?
                .assert_success();
            amount -= chunk;
        }
        Ok(())
    }

    async fn call_on(&self, contract: &AccountId, from: &str, m: &str, args: Value, dep: NearToken)
        -> R<TransactionResult> {
        Ok(Contract(contract.clone())
            .call_function(m, args)
            .transaction()
            .deposit(dep)
            .gas(NearGas::from_tgas(300))
            .with_signer(id(from), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn call(&self, from: &str, m: &str, args: Value) -> R<TransactionResult> {
        let pool = self.pool.clone();
        self.call_on(&pool, from, m, args, NearToken::from_yoctonear(0)).await
    }

    async fn ok_tx(&self, from: &str, m: &str, args: Value) -> R<TransactionResult> {
        let res = self.call(from, m, args.clone()).await?;
        assert!(res.is_success(), "{from} {m}({args}) failed: {res:?}");
        Ok(res)
    }

    async fn ok(&self, from: &str, m: &str, args: Value) -> R<ExecutionSuccess> {
        Ok(self.ok_tx(from, m, args).await?.assert_success())
    }

    async fn refused(&self, from: &str, m: &str, args: Value, code: &str) -> R<()> {
        let res = self.call(from, m, args.clone()).await?;
        assert!(!res.is_success(), "{from} {m}({args}) should fail with {code}, but succeeded");
        let err = format!("{:?}", res.assert_failure());
        assert!(err.contains(code), "{from} {m}({args}): expected {code}, got {err}");
        Ok(())
    }

    /// `ft_transfer_call` to RugPool that must be kept in full; returns the result.
    async fn deposit(&self, from: &str, amount: u128, msg: &str) -> R<()> {
        let _ = self.deposit_tx(from, amount, msg).await?;
        Ok(())
    }

    async fn deposit_tx(&self, from: &str, amount: u128, msg: &str) -> R<TransactionResult> {
        let usdc = self.usdc.clone();
        let w0 = self.ft(&id(from)).await?;
        let res = self.call_on(&usdc, from, "ft_transfer_call",
            json!({"receiver_id": self.pool, "amount": amount.to_string(), "msg": msg}),
            NearToken::from_yoctonear(1)).await?;
        assert!(res.is_success(), "ft_transfer_call from {from} failed: {res:?}");
        let kept: String = res.clone().assert_success().json()?;
        assert_eq!(kept.parse::<u128>()?, amount, "deposit {amount} from {from} msg {msg:?} not kept: {res:?}");
        assert_eq!(w0 - self.ft(&id(from)).await?, amount);
        self.inv().await?;
        Ok(res)
    }

    async fn ft(&self, who: &AccountId) -> R<u128> {
        let v: String = Contract(self.usdc.clone())
            .call_function("ft_balance_of", json!({"account_id": who}))
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data;
        Ok(v.parse()?)
    }

    async fn view(&self, m: &str, args: Value) -> R<Value> {
        Ok(Contract(self.pool.clone()).call_function(m, args).read_only().fetch_from(&self.net).await?.data)
    }

    async fn view_at(&self, m: &str, args: Value, at: CryptoHash) -> R<Value> {
        Ok(Contract(self.pool.clone())
            .call_function(m, args)
            .read_only()
            .at(Reference::AtBlockHash(at))
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn acct(&self, name: &str) -> R<Value> {
        self.view("get_account", json!({"account_id": id(name)})).await
    }

    async fn a(&self, name: &str, field: &str) -> R<u128> {
        Ok(num(&self.acct(name).await?[field]))
    }

    async fn st(&self) -> R<Value> {
        self.view("get_state", json!({})).await
    }

    async fn liab(&self) -> R<Value> {
        self.view("get_liabilities", json!({})).await
    }

    async fn l(&self, field: &str) -> R<u128> {
        Ok(num(&self.liab().await?[field]))
    }

    /// RugPool's token balance must equal the sum of every liability bucket.
    async fn inv(&self) -> R<()> {
        let l = self.liab().await?;
        let obj = l.as_object().unwrap();
        for k in BUCKETS {
            assert!(obj.contains_key(k), "liabilities missing {k}: {l}");
        }
        let held = self.ft(&self.pool).await?;
        assert_eq!(held, sum_all(&l), "invariant broken: ft_balance_of(pool)={held}, liabilities={l}");
        Ok(())
    }

    /// Every numeric field of the account view reads 0.
    async fn zeros(&self, name: &str, ctx: &str) -> R<()> {
        let v = self.acct(name).await?;
        for f in ["balance", "court", "court_earned", "withdraw_pending", "king_stream", "auto_defend_max",
                  "draw_weight_bps"] {
            assert_eq!(num(&v[f]), 0, "{ctx}: {name}.{f} should be 0: {v}");
        }
        Ok(())
    }

    async fn now_ms(&self) -> R<u64> {
        Ok(Chain::block().fetch_from(&self.net).await?.header.timestamp / 1_000_000)
    }

    /// Block hash and time (ms) of the first RugPool receipt of `tx`.
    async fn exec(&self, tx: &TransactionResult) -> R<(CryptoHash, u64)> {
        let full = tx.clone().into_full().expect("full result");
        let outcome = full
            .receipt_outcomes()
            .iter()
            .find(|o| o.executor_id == self.pool)
            .expect("a receipt executed on RugPool");
        let block = Chain::block().at(Reference::AtBlockHash(outcome.block_hash)).fetch_from(&self.net).await?;
        Ok((outcome.block_hash, block.header.timestamp / 1_000_000))
    }

    /// Runs `poke` (an accrual trigger); returns views at its execution block.
    async fn poke(&self) -> R<Snap> {
        let tx = self.ok_tx("keeper", "poke", json!({})).await?;
        let (h, ms) = self.exec(&tx).await?;
        self.snap(h, ms).await
    }

    async fn snap(&self, h: CryptoHash, ms: u64) -> R<Snap> {
        Ok(Snap {
            ms,
            liab: self.view_at("get_liabilities", json!({}), h).await?,
            state: self.view_at("get_state", json!({}), h).await?,
            hash: h,
        })
    }

    async fn acct_at(&self, name: &str, h: CryptoHash) -> R<Value> {
        self.view_at("get_account", json!({"account_id": id(name)}), h).await
    }

    /// Fast-forwards until the latest block time is at least `target_ms` (rate-calibrated).
    async fn advance_to(&self, target_ms: u64) -> R<u64> {
        for _ in 0..300 {
            let now = self.now_ms().await?;
            if now >= target_ms {
                return Ok(now);
            }
            let remaining = (target_ms - now) as f64;
            let n = match self.ms_per_block.get() {
                None => 10,
                Some(rate) => ((remaining / rate).ceil() as u64).clamp(1, 5_000),
            };
            self.sandbox.fast_forward(n).await?;
            let after = self.now_ms().await?;
            if after > now {
                self.ms_per_block.set(Some((after - now) as f64 / n as f64));
            }
        }
        Err("advance_to did not reach the target".into())
    }

    async fn advance(&self, ms: u64) -> R<u64> {
        let now = self.now_ms().await?;
        self.advance_to(now + ms).await
    }

    /// Buys the next ticket at the quoted price; returns the price paid.
    async fn challenge(&self, from: &str) -> R<u128> {
        let p = num(&self.st().await?["round"]["next_price"]);
        self.ok(from, "challenge", json!({"max_price": p.to_string()})).await?;
        self.inv().await?;
        Ok(p)
    }

    async fn live(&self) -> R<u128> {
        Ok(num(&self.st().await?["court"]["apy_bps_live"]))
    }
}

struct Snap {
    ms: u64,
    liab: Value,
    state: Value,
    hash: CryptoHash,
}

impl Snap {
    fn l(&self, k: &str) -> u128 {
        num(&self.liab[k])
    }
    fn jackpot(&self) -> u128 {
        num(&self.state["round"]["jackpot"])
    }
    fn court_total(&self) -> u128 {
        num(&self.state["court"]["total"])
    }
    fn live(&self) -> u128 {
        num(&self.state["court"]["apy_bps_live"])
    }
}

async fn deploy_raw(t: &T, name: &str, args: Value) -> R<TransactionResult> {
    let acc = id(name);
    t.sandbox.create_account(acc.clone()).initial_balance(NearToken::from_near(20)).send().await?;
    let wasm = wasms().1.clone();
    Ok(Contract::deploy(acc)
        .use_code(wasm)
        .with_init_call("new", args)?
        .with_signer(t.signer.clone())
        .send_to(&t.net)
        .await?)
}

// ------------------------------------------------------------------------------------- tests

/// 1 + 6: `fund_yield` credits no account and fills `yield_reserve`; Intents can fund too;
/// default params report a 0 fee and live APY = 500 x 5000 / 10000 = 250 only while funded.
#[tokio::test]
async fn fund_yield_credits_no_account() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let t = T::new(1000, json!({"intents": id("intents")}), &["funder", "intents", "alice"]).await?;
    t.inv().await?;
    let s = t.st().await?;
    assert_eq!(num(&s["params"]["registration_fee"]), 0, "default fee: {}", s["params"]);
    assert_eq!(num(&s["court"]["apy_bps_live"]), 0, "empty reserve: {}", s["court"]);
    assert_eq!(t.l("yield_reserve").await?, 0);
    assert_eq!(t.l("streams").await?, 0);

    t.deposit("funder", 50 * U, &ok_fund()).await?;
    let l = t.liab().await?;
    assert_eq!(num(&l["yield_reserve"]), 50 * U, "{l}");
    for k in BUCKETS.iter().filter(|k| **k != "yield_reserve") {
        assert_eq!(num(&l[*k]), 0, "fund_yield moved {k}: {l}");
    }
    t.zeros("funder", "after fund_yield").await?;
    assert_eq!(t.live().await?, 250, "live APY with default params and a funded reserve");

    // Intents delivery with the same msg funds the reserve too (no Court yet, so no accrual).
    t.deposit("intents", 3 * U, &ok_fund()).await?;
    assert_eq!(t.l("yield_reserve").await?, 53 * U);
    t.zeros("intents", "after Intents fund_yield").await?;
    assert_eq!(t.l("balances").await?, 0);

    // With the default fee of 0, a first deposit is credited in full.
    t.deposit("alice", 10 * U, "").await?;
    assert_eq!(t.a("alice", "balance").await?, 10 * U);
    assert_eq!(t.l("treasury").await?, 0);
    // A second funding adds on top.
    t.deposit("funder", 2 * U, &ok_fund()).await?;
    assert_eq!(t.l("yield_reserve").await?, 55 * U);
    t.zeros("funder", "after second fund_yield").await?;
    Ok(())
}

/// 2: yield accrues over block time; exact amount and split between two pokes, first with no King
/// (King share to the Jackpot), then with a King (King share to the King's stream).
#[tokio::test]
async fn yield_accrues_and_splits() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let t = T::new(1000, json!({"yield_params": yp(10_000, [5000, 3000, 2000])}),
        &["funder", "alice", "bob", "keeper"]).await?;
    t.mint("alice", 9000 * U).await?;
    t.deposit("funder", 200 * U, &ok_fund()).await?;
    t.deposit("alice", 10_000 * U, &join()).await?;
    assert_eq!(t.live().await?, 5000);

    // Phase A: no King.
    let a1 = t.poke().await?;
    let e1 = num(&t.acct_at("alice", a1.hash).await?["court_earned"]);
    t.advance(10 * 60 * 1000).await?;
    // Unlagged views: court_earned and round.jackpot grow with block time alone.
    let e_mid = t.a("alice", "court_earned").await?;
    let j_mid = num(&t.st().await?["round"]["jackpot"]);
    assert!(e_mid > e1, "court_earned did not grow with block time: {e1} -> {e_mid}");
    assert!(j_mid > a1.jackpot(), "round.jackpot did not grow with block time: {} -> {j_mid}", a1.jackpot());
    let a2 = t.poke().await?;
    let e2 = num(&t.acct_at("alice", a2.hash).await?["court_earned"]);
    let c = a1.court_total();
    assert_eq!(c, 10_000 * U);
    let paid = a1.l("yield_reserve") - a2.l("yield_reserve");
    let dms = a2.ms - a1.ms;
    // The remainder carried from earlier accruals can add at most one micro.
    assert!(paid - due(c, 10_000, dms) <= 1, "no King: paid {paid} over {dms} ms");
    let court_part = paid * 5000 / 10_000;
    assert_eq!(a2.l("rewards") - a1.l("rewards"), court_part, "court part to rewards (paid {paid})");
    assert_eq!(a2.l("jackpot") - a1.l("jackpot"), paid - court_part, "seed + King share to the Jackpot");
    assert_eq!(a2.jackpot() - a1.jackpot(), paid - court_part, "round.jackpot");
    assert_eq!(a2.l("streams"), 0, "no King, no stream");
    assert!(e2 - e1 <= court_part && e2 - e1 + 2 >= court_part, "alice (sole Court) earned {} of {court_part}", e2 - e1);
    assert_eq!(a2.live(), 5000);
    t.inv().await?;

    // Phase B: bob becomes King.
    t.deposit("bob", 25 * U, &join()).await?;
    t.deposit("bob", 5 * U, "").await?;
    t.challenge("bob").await?;
    assert_eq!(t.st().await?["round"]["king"], json!(id("bob")));
    let b1 = t.poke().await?;
    let bob1 = t.acct_at("bob", b1.hash).await?;
    t.advance(10 * 60 * 1000).await?;
    let stream_mid = t.a("bob", "king_stream").await?;
    assert!(stream_mid > num(&bob1["king_stream"]), "king_stream did not grow with block time");
    let b2 = t.poke().await?;
    let bob2 = t.acct_at("bob", b2.hash).await?;
    let c = b1.court_total();
    assert_eq!(c, 10_025 * U);
    let paid = b1.l("yield_reserve") - b2.l("yield_reserve");
    let dms = b2.ms - b1.ms;
    // The remainder carried from earlier accruals can add at most one micro.
    assert!(paid - due(c, 10_000, dms) <= 1, "with King: paid {paid} over {dms} ms");
    let court_part = paid * 5000 / 10_000;
    let seed = paid * 3000 / 10_000;
    let king = paid - court_part - seed;
    assert_eq!(b2.l("rewards") - b1.l("rewards"), court_part, "court part (paid {paid})");
    assert_eq!(b2.l("jackpot") - b1.l("jackpot"), seed, "Jackpot seed");
    assert_eq!(b2.jackpot() - b1.jackpot(), seed, "round.jackpot seed");
    assert_eq!(b2.l("streams") - b1.l("streams"), king, "streams bucket");
    assert_eq!(num(&bob2["king_stream"]) - num(&bob1["king_stream"]), king, "bob's king_stream");
    assert!(num(&bob2["court_earned"]) > num(&bob1["court_earned"]), "bob's Court yield");
    assert!(b2.state["round"]["showdown_ends_at"].is_null(), "no showdown expected");
    t.inv().await?;
    Ok(())
}

/// 3 + 6: a tiny reserve with a huge APY: total yield paid equals what was funded, never more; the
/// reserve stays at 0, live APY drops to 0, and refunding does not back-pay the empty period.
#[tokio::test]
async fn accrual_capped_by_reserve() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let t = T::new(1000, json!({"yield_params": yp(10_000, [5000, 3000, 2000])}),
        &["funder", "alice", "keeper"]).await?;
    t.mint("alice", 19_000 * U).await?;
    t.deposit("funder", U, &ok_fund()).await?;
    assert_eq!(t.l("yield_reserve").await?, U);
    assert_eq!(t.live().await?, 5000);
    t.deposit("alice", 20_000 * U, &join()).await?;
    let c = 20_000 * U;
    // Due on 20,000 USDC at 100% is ~0.63 units/ms: 1 USDC lasts ~26 minutes.
    let p0 = t.poke().await?;
    assert!(p0.l("yield_reserve") > 0, "reserve should not be empty yet: {}", p0.liab);
    t.advance(60 * 60 * 1000).await?;
    let p1 = t.poke().await?;
    assert_eq!(p1.l("yield_reserve"), 0, "reserve should be exhausted after an hour: {}", p1.liab);
    assert_eq!(p1.l("jackpot") + p1.l("rewards") + p1.l("streams"), U,
        "total yield paid must equal the 1 USDC funded: {}", p1.liab);
    assert_eq!(p1.jackpot(), p1.l("jackpot"));
    assert_eq!(p1.live(), 0, "live APY with an empty reserve");
    let e1 = num(&t.acct_at("alice", p1.hash).await?["court_earned"]);
    assert!(e1 <= p1.l("rewards") && e1 > 0, "alice earned {e1}, rewards {}", p1.l("rewards"));
    t.inv().await?;

    // Stays at 0: nothing more accrues.
    t.advance(30 * 60 * 1000).await?;
    assert_eq!(t.a("alice", "court_earned").await?, e1, "court_earned grew with an empty reserve");
    assert_eq!(num(&t.st().await?["round"]["jackpot"]), p1.jackpot(), "jackpot grew with an empty reserve");
    let p2 = t.poke().await?;
    assert_eq!(p2.l("yield_reserve"), 0);
    assert_eq!(p2.l("jackpot"), p1.l("jackpot"));
    assert_eq!(p2.l("rewards"), p1.l("rewards"));
    assert_eq!(p2.live(), 0);
    t.inv().await?;

    // The clock kept advancing while empty: refunding pays only from the last accrual onward.
    let p3 = t.poke().await?;
    let ftx = t.deposit_tx("funder", U, &ok_fund()).await?;
    let (_, f_ms) = t.exec(&ftx).await?;
    t.advance(2 * 60 * 1000).await?;
    let p4 = t.poke().await?;
    let paid = U - p4.l("yield_reserve");
    let hi = due(c, 10_000, p4.ms - p3.ms);
    let lo = due(c, 10_000, p4.ms - f_ms);
    assert!(paid <= hi && paid >= lo, "after refunding: paid {paid}, expected within [{lo}, {hi}]");
    assert!(paid < U, "the empty period was back-paid");
    assert_eq!(p4.live(), 5000);
    t.inv().await?;
    Ok(())
}

/// 4: `claim` pays exactly balance + court_earned + king_stream; the liability drop equals the
/// wallet delta; the three fields read 0 at the claim block.
#[tokio::test]
async fn claim_pays_balance_earned_and_stream() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let t = T::new(1000, json!({"yield_params": yp(10_000, [5000, 3000, 2000])}),
        &["funder", "alice", "bob", "keeper"]).await?;
    t.mint("alice", 9000 * U).await?;
    t.deposit("funder", 200 * U, &ok_fund()).await?;
    t.deposit("alice", 10_000 * U, &join()).await?;
    t.deposit("bob", 25 * U, &join()).await?;
    t.deposit("bob", 8 * U, "").await?;
    t.challenge("bob").await?;
    t.advance(10 * 60 * 1000).await?;
    let c = num(&t.st().await?["court"]["total"]);

    for who in ["bob", "alice"] {
        let tp = t.now_ms().await?;
        let v = t.acct(who).await?;
        let pre = num(&v["balance"]) + num(&v["court_earned"]) + num(&v["king_stream"]);
        let court = num(&v["court"]);
        assert!(num(&v["court_earned"]) > 0, "{who}: {v}");
        if who == "bob" {
            assert!(num(&v["king_stream"]) > 0 && num(&v["balance"]) > 0, "bob: {v}");
        }
        let s0 = sum_all(&t.liab().await?);
        let w0 = t.ft(&id(who)).await?;
        let tx = t.ok_tx(who, "claim", json!({})).await?;
        let (h, tb) = t.exec(&tx).await?;
        let d = t.ft(&id(who)).await? - w0;
        let s1 = sum_all(&t.liab().await?);
        assert_eq!(s0 - s1, d, "{who}: liability drop vs wallet delta");
        let slack = due(c, 10_000, tb - tp) + 2;
        assert!(d >= pre && d <= pre + slack, "{who}: paid {d}, views showed {pre} (+ up to {slack} accrued since)");
        let after = t.acct_at(who, h).await?;
        for f in ["balance", "court_earned", "king_stream"] {
            assert_eq!(num(&after[f]), 0, "{who}.{f} at the claim block: {after}");
        }
        assert_eq!(num(&after["court"]), court, "{who}: claim leaves Court principal");
        t.inv().await?;
    }
    Ok(())
}

/// 5 + 6: `withdraw_reserve` is owner-only, bounded by the reserve, pays out, and a failed payout
/// restores the reserve.
#[tokio::test]
async fn withdraw_reserve_rules() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let t = T::new(1000, json!({"owner": id("owner")}), &["owner", "funder", "alice", "rec"]).await?;
    t.deposit("funder", 10 * U, &ok_fund()).await?;
    assert_eq!(t.live().await?, 250);
    let arg = |to: &str, a: u128| json!({"receiver_id": id(to), "amount": a.to_string()});
    t.refused("alice", "withdraw_reserve", arg("alice", U), "NOT_OWNER").await?;
    t.refused("funder", "withdraw_reserve", arg("funder", U), "NOT_OWNER").await?;
    t.refused("pool", "withdraw_reserve", arg("rec", U), "NOT_OWNER").await?;
    t.refused("owner", "withdraw_reserve", arg("rec", 10 * U + 1), "INVALID_AMOUNT").await?;
    assert_eq!(t.l("yield_reserve").await?, 10 * U);

    let w0 = t.ft(&id("rec")).await?;
    t.ok("owner", "withdraw_reserve", arg("rec", 4 * U)).await?;
    assert_eq!(t.ft(&id("rec")).await? - w0, 4 * U);
    assert_eq!(t.l("yield_reserve").await?, 6 * U);
    t.inv().await?;

    // Payout to an account not registered on the token fails; the reserve is restored.
    let res = t.call("owner", "withdraw_reserve", arg("ghost", 2 * U)).await?;
    println!("withdraw_reserve to unregistered receiver: success={} {:?}", res.is_success(), res.logs());
    assert_eq!(t.l("yield_reserve").await?, 6 * U, "failed payout must restore the reserve");
    t.inv().await?;

    t.refused("owner", "withdraw_reserve", arg("rec", 6 * U + 1), "INVALID_AMOUNT").await?;
    t.ok("owner", "withdraw_reserve", arg("rec", 6 * U)).await?;
    assert_eq!(t.ft(&id("rec")).await? - w0, 10 * U);
    assert_eq!(t.l("yield_reserve").await?, 0);
    assert_eq!(t.live().await?, 0, "live APY with an empty reserve");
    t.inv().await?;
    t.refused("owner", "withdraw_reserve", arg("rec", 1), "INVALID_AMOUNT").await?;
    Ok(())
}

/// 7: registration fee: kept in treasury on the first credit that creates an account (direct or
/// Intents), not on later deposits, not on `fund_yield`; reported in `params`.
#[tokio::test]
async fn registration_fee() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let f = 50_000u128;
    let t = T::new(1000, json!({"intents": id("intents"), "registration_fee": f.to_string()}),
        &["intents", "funder", "alice", "bob"]).await?;
    assert_eq!(num(&t.st().await?["params"]["registration_fee"]), f);

    t.deposit("funder", 5 * U, &ok_fund()).await?;
    assert_eq!(t.l("treasury").await?, 0, "fund_yield must not charge the fee");
    assert_eq!(t.l("yield_reserve").await?, 5 * U);
    t.zeros("funder", "after fund_yield").await?;

    t.deposit("alice", 30 * U, &join()).await?;
    assert_eq!(t.a("alice", "court").await?, 30 * U - f, "first deposit joins the rest");
    assert_eq!(t.a("alice", "balance").await?, 0);
    assert_eq!(t.l("treasury").await?, f);
    t.deposit("alice", 5 * U, "").await?;
    assert_eq!(t.a("alice", "balance").await?, 5 * U, "second deposit is not charged");
    assert_eq!(t.l("treasury").await?, f);

    t.deposit("intents", 10 * U, &bal("bob")).await?;
    assert_eq!(t.a("bob", "balance").await?, 10 * U - f, "Intents credit that creates an account");
    assert_eq!(t.l("treasury").await?, 2 * f);
    t.deposit("intents", 3 * U, &bal("bob")).await?;
    assert_eq!(t.a("bob", "balance").await?, 13 * U - f);
    assert_eq!(t.l("treasury").await?, 2 * f);

    // Funding created no account, so the funder's first deposit pays the fee.
    t.deposit("funder", 2 * U, "").await?;
    assert_eq!(t.a("funder", "balance").await?, 2 * U - f);
    assert_eq!(t.l("treasury").await?, 3 * f);
    Ok(())
}

/// 7 + 8: init validation of the fee, split and APY bounds.
#[tokio::test]
async fn init_validation() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let t = T::new(1000, json!({}), &[]).await?;
    let usdc = t.usdc.clone();
    let cases: Vec<(&str, Value, bool)> = vec![
        ("fee_half", json!({"registration_fee": "500000"}), true),
        ("fee_over", json!({"registration_fee": "500001"}), false),
        ("apy_max", json!({"yield_params": yp(10_000, [5000, 3000, 2000])}), true),
        ("apy_over", json!({"yield_params": yp(10_001, [5000, 3000, 2000])}), false),
        ("split_low", json!({"yield_params": yp(500, [5000, 3000, 1999])}), false),
        ("split_high", json!({"yield_params": yp(500, [5000, 3000, 2001])}), false),
        ("split_all_court", json!({"yield_params": yp(500, [10_000, 0, 0])}), true),
    ];
    let mut errors = vec![];
    for (name, extra, accept) in cases {
        let res = deploy_raw(&t, name, base_args(&usdc, 1000, &extra)).await?;
        if res.is_success() != accept {
            errors.push(format!("{name} {extra}: expected accept={accept}, got {res:?}"));
        } else if !accept {
            println!("{name}: refused with {:?}", res.assert_failure());
        }
    }
    let fee: Value = Contract(id("fee_half")).call_function("get_state", json!({})).read_only()
        .fetch_from(&t.net).await?.data;
    assert_eq!(num(&fee["params"]["registration_fee"]), 500_000, "{}", fee["params"]);
    assert!(errors.is_empty(), "{errors:#?}");
    Ok(())
}

/// 9: emptied accounts are deleted after a `claim` or `withdraw` payout (view all zeros, fee paid
/// again, auto-defend and draw entries gone); accounts with anything left and the King are kept.
#[tokio::test]
async fn empty_accounts_deleted() -> R<()> {
    let _slot = SLOTS.acquire().await?;
    let f = 100_000u128;
    let cd = 2000u64;
    let t = T::new(cd, json!({"registration_fee": f.to_string()}), &["alice", "bob", "carol", "dave"]).await?;

    // dave: balance only, armed auto-defend; claim empties it -> deleted.
    t.deposit("dave", 3 * U, "").await?;
    assert_eq!(t.a("dave", "balance").await?, 3 * U - f);
    t.ok("dave", "set_auto_defend", json!({"max_price": (10 * U).to_string()})).await?;
    assert_eq!(t.a("dave", "auto_defend_max").await?, 10 * U);
    let w0 = t.ft(&id("dave")).await?;
    t.ok("dave", "claim", json!({})).await?;
    assert_eq!(t.ft(&id("dave")).await? - w0, 3 * U - f);
    t.zeros("dave", "after claim").await?;
    t.inv().await?;
    let tr0 = t.l("treasury").await?;
    t.deposit("dave", 2 * U, "").await?;
    assert_eq!(t.a("dave", "balance").await?, 2 * U - f, "recreated account pays the fee again");
    assert_eq!(t.l("treasury").await? - tr0, f);
    assert_eq!(t.a("dave", "auto_defend_max").await?, 0, "auto-defend entry should be gone");

    // bob: Court only, withdrawn in full -> deleted (draw entry too).
    t.deposit("bob", 30 * U, &join()).await?;
    let bc = 30 * U - f;
    assert_eq!(t.a("bob", "court").await?, bc);
    t.advance(3000).await?;
    let bw = t.a("bob", "draw_weight_bps").await?;
    println!("bob draw_weight_bps before exit: {bw}");
    t.ok("bob", "request_withdraw", json!({"amount": bc.to_string()})).await?;
    let ready = t.acct("bob").await?["withdraw_ready_at"].as_u64().unwrap();
    t.advance_to(ready + 1500).await?;
    let w0 = t.ft(&id("bob")).await?;
    t.ok("bob", "withdraw", json!({})).await?;
    assert_eq!(t.ft(&id("bob")).await? - w0, bc);
    t.zeros("bob", "after withdraw").await?;
    t.inv().await?;
    let tr0 = t.l("treasury").await?;
    t.deposit("bob", 2 * U, "").await?;
    assert_eq!(t.a("bob", "balance").await?, 2 * U - f, "recreated account pays the fee again");
    assert_eq!(t.l("treasury").await? - tr0, f);
    assert_eq!(t.a("bob", "draw_weight_bps").await?, 0);

    // alice and carol share the Court; carol challenges and becomes King.
    t.deposit("alice", 30 * U, &join()).await?;
    let ac = 30 * U - f;
    t.deposit("carol", 25 * U + f, &join()).await?;
    assert_eq!(t.a("carol", "court").await?, 25 * U);
    t.deposit("carol", 5 * U, "").await?;
    assert_eq!(t.challenge("carol").await?, 5 * U);
    assert_eq!(t.st().await?["round"]["king"], json!(id("carol")));
    assert_eq!(t.a("carol", "balance").await?, 0);
    let ae = t.a("alice", "court_earned").await?;
    assert!(ae > 0 && t.a("carol", "court_earned").await? > 0);

    // alice: withdraw all Court, but earnings remain -> kept (no fee on the next deposit).
    t.ok("alice", "request_withdraw", json!({"amount": ac.to_string()})).await?;
    let ready = t.acct("alice").await?["withdraw_ready_at"].as_u64().unwrap();
    t.advance_to(ready + 1500).await?;
    t.ok("alice", "withdraw", json!({})).await?;
    assert_eq!(t.a("alice", "court_earned").await?, ae, "earnings survive the withdraw");
    let tr0 = t.l("treasury").await?;
    t.deposit("alice", 2 * U, "").await?;
    assert_eq!(t.a("alice", "balance").await?, 2 * U, "kept account is not charged again");
    assert_eq!(t.l("treasury").await?, tr0);
    // Claim empties it -> deleted -> next deposit pays the fee.
    let w0 = t.ft(&id("alice")).await?;
    t.ok("alice", "claim", json!({})).await?;
    assert_eq!(t.ft(&id("alice")).await? - w0, 2 * U + ae);
    t.zeros("alice", "after claim").await?;
    let tr0 = t.l("treasury").await?;
    t.deposit("alice", 2 * U, "").await?;
    assert_eq!(t.a("alice", "balance").await?, 2 * U - f);
    assert_eq!(t.l("treasury").await? - tr0, f);

    // carol (King): empty everything; the King is kept.
    let res = t.call("carol", "request_withdraw", json!({"amount": (25 * U).to_string()})).await?;
    assert!(res.is_success(), "King's full request_withdraw refused (case untestable by this route): {res:?}");
    let ready = t.acct("carol").await?["withdraw_ready_at"].as_u64().unwrap();
    t.advance_to(ready + 1500).await?;
    t.ok("carol", "withdraw", json!({})).await?;
    t.ok("carol", "claim", json!({})).await?;
    let v = t.acct("carol").await?;
    for fld in ["balance", "court", "court_earned", "withdraw_pending", "king_stream"] {
        assert_eq!(num(&v[fld]), 0, "carol.{fld}: {v}");
    }
    assert_eq!(t.st().await?["round"]["king"], json!(id("carol")));
    t.inv().await?;
    let tr0 = t.l("treasury").await?;
    t.deposit("carol", 2 * U, "").await?;
    assert_eq!(t.a("carol", "balance").await?, 2 * U, "the empty King was kept: no fee");
    assert_eq!(t.l("treasury").await?, tr0);
    Ok(())
}
