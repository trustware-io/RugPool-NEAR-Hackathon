//! Independent black-box sandbox tests for the M6 features (unbonding, Court-share rounding,
//! liabilities, owner controls, caps, Intents deliveries and the Court draw), written from the
//! M6 spec only. Every value-moving step re-checks that RugPool's token balance equals the sum of
//! its reported liabilities. M10 split `run_draw` into `close_draw` and `finalize_draw`; the
//! draw tests now fetch real drand beacons, so they need the network.

use near_api::types::transaction::result::ExecutionSuccess;
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_api::types::transaction::result::TransactionResult;
use near_sdk::serde_json::{Value, json};
use std::sync::{Arc, OnceLock};

type R<T> = Result<T, Box<dyn std::error::Error>>;

const U: u128 = 1_000_000;
const HUGE: &str = "1000000000000000000";

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

fn limits(max_account: u128, max_total: u128, draw_min: u128, draw_every_ms: u64) -> Value {
    json!({"max_account": max_account.to_string(), "max_total": max_total.to_string(),
           "draw_min": draw_min.to_string(), "draw_every_ms": draw_every_ms})
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

/// Expected ticket price after `n` tickets in a round: 5 USDC, then +3% floored per ticket.
fn model_price(n: usize) -> u128 {
    let mut p = 5 * U;
    for _ in 0..n {
        p = p * 10300 / 10000;
    }
    p
}

struct T {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    usdc: AccountId,
    pool: AccountId,
}

const QUICKNET: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/// Quicknet's signature for `round`, from drand's public API, waiting until it's published.
async fn drand_signature(round: u64) -> String {
    let url = format!("https://api.drand.sh/{QUICKNET}/public/{round}");
    for _ in 0..200 {
        let out = tokio::process::Command::new("curl").args(["-sf", &url]).output().await.expect("curl runs");
        if out.status.success() {
            let beacon: Value = near_sdk::serde_json::from_slice(&out.stdout).expect("drand JSON");
            return beacon["signature"].as_str().unwrap().to_string();
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    panic!("drand round {round} never appeared");
}

impl T {
    /// Closes the draw and, when that leaves one pending, finalizes it with the real drand
    /// signature for its round. Returns the last call's result.
    async fn draw(&self, from: &str) -> R<TransactionResult> {
        let res = self.call(from, "close_draw", json!({})).await?;
        assert!(res.is_success(), "{from} close_draw failed: {res:?}");
        let Some(round) = self.st().await?["court"]["pending_draw"]["round"].as_u64() else { return Ok(res) };
        let signature = drand_signature(round).await;
        self.call(from, "finalize_draw", json!({ "signature": signature })).await
    }
    /// Deploys tUSDC and RugPool, registers and funds every user with 1,000 tUSDC.
    async fn new(cooldown_ms: u64, draw_bps: u32, extra: Value, users: &[&str]) -> R<T> {
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
        let mut args = json!({"token": usdc, "withdraw_cooldown_ms": cooldown_ms,
                              "court_draw_bps": draw_bps, "timing": timing()});
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        Contract::deploy(pool.clone())
            .use_code(pool_wasm)
            .with_init_call("new", args)?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        let t = T { sandbox, net, signer, usdc, pool };
        let pool_id = t.pool.clone();
        t.register(&pool_id).await?;
        for u in users {
            t.register(&id(u)).await?;
            t.call_on(&t.usdc.clone(), "usdc", "mint",
                json!({"account_id": id(u), "amount": (1000 * U).to_string()}), NearToken::from_yoctonear(0))
                .await?
                .assert_success();
        }
        Ok(t)
    }

    async fn register(&self, who: &AccountId) -> R<()> {
        self.call_on(&self.usdc, "usdc", "storage_deposit", json!({"account_id": who}),
            NearToken::from_millinear(10)).await?.assert_success();
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

    async fn ok(&self, from: &str, m: &str, args: Value) -> R<ExecutionSuccess> {
        let res = self.call(from, m, args.clone()).await?;
        assert!(res.is_success(), "{from} {m}({args}) failed: {res:?}");
        Ok(res.assert_success())
    }

    async fn refused(&self, from: &str, m: &str, args: Value, code: &str) -> R<()> {
        let res = self.call(from, m, args.clone()).await?;
        assert!(!res.is_success(), "{from} {m}({args}) should fail with {code}, but succeeded");
        let err = format!("{:?}", res.assert_failure());
        assert!(err.contains(code), "{from} {m}({args}): expected {code}, got {err}");
        Ok(())
    }

    /// `ft_transfer_call` to RugPool; returns (kept, full result).
    async fn ft_call(&self, from: &str, amount: u128, msg: &str) -> R<(u128, TransactionResult)> {
        let usdc = self.usdc.clone();
        let res = self.call_on(&usdc, from, "ft_transfer_call",
            json!({"receiver_id": self.pool, "amount": amount.to_string(), "msg": msg}),
            NearToken::from_yoctonear(1)).await?;
        assert!(res.is_success(), "ft_transfer_call from {from} failed: {res:?}");
        let kept: String = res.clone().assert_success().json()?;
        Ok((kept.parse()?, res))
    }

    /// A deposit that must be kept in full.
    async fn deposit_ok(&self, from: &str, amount: u128, msg: &str) -> R<Vec<String>> {
        let w0 = self.ft(&id(from)).await?;
        let (kept, res) = self.ft_call(from, amount, msg).await?;
        assert_eq!(kept, amount, "deposit {amount} from {from} msg {msg:?} not kept in full: {res:?}");
        assert_eq!(w0 - self.ft(&id(from)).await?, amount);
        self.inv().await?;
        Ok(logs(&res))
    }

    /// A direct deposit that must be refused with `code` and refunded in full.
    async fn deposit_refused(&self, from: &str, amount: u128, msg: &str, code: &str) -> R<()> {
        let w0 = self.ft(&id(from)).await?;
        let l0 = self.liab().await?;
        let (kept, res) = self.ft_call(from, amount, msg).await?;
        assert_eq!(kept, 0, "deposit {amount} msg {msg:?} from {from} should be refunded");
        assert_eq!(self.ft(&id(from)).await?, w0, "wallet changed after refused deposit");
        let dbg = format!("{res:?}");
        assert!(dbg.contains(code), "refused deposit msg {msg:?}: expected {code} in {dbg}");
        assert_eq!(self.liab().await?, l0, "liabilities changed after refused deposit");
        self.inv().await?;
        Ok(())
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
        let keys = ["balances", "court", "jackpot", "rewards", "draw_pot", "treasury", "pending", "recovery"];
        let obj = l.as_object().unwrap();
        for k in keys {
            assert!(obj.contains_key(k), "liabilities missing {k}: {l}");
        }
        let sum: u128 = keys.iter().map(|k| num(&l[*k])).sum();
        let held = self.ft(&self.pool).await?;
        assert_eq!(held, sum, "invariant broken: ft_balance_of(pool)={held}, liabilities={l}");
        Ok(())
    }

    async fn now_ms(&self) -> R<u64> {
        let b = near_api::Chain::block().fetch_from(&self.net).await?;
        Ok(b.header.timestamp / 1_000_000)
    }

    async fn advance_to(&self, target_ms: u64) -> R<()> {
        for _ in 0..400 {
            if self.now_ms().await? >= target_ms {
                return Ok(());
            }
            self.sandbox.fast_forward(50).await?;
        }
        panic!("could not reach block time {target_ms}");
    }

    /// Buys the next ticket at the quoted price; returns the price paid.
    async fn challenge(&self, from: &str) -> R<u128> {
        let p = num(&self.st().await?["round"]["next_price"]);
        self.ok(from, "challenge", json!({"max_price": p.to_string()})).await?;
        self.inv().await?;
        Ok(p)
    }
}

fn logs(res: &TransactionResult) -> Vec<String> {
    res.logs().into_iter().map(String::from).collect()
}

/// Every `data` entry of NEP-297 events named `name` in the logs.
fn events(logs: &[String], name: &str) -> Vec<Value> {
    let mut out = vec![];
    for log in logs {
        let Some(j) = log.strip_prefix("EVENT_JSON:") else { continue };
        let v: Value = near_sdk::serde_json::from_str(j).unwrap();
        if v["event"] == name {
            match &v["data"] {
                Value::Array(a) => out.extend(a.iter().cloned()),
                d => out.push(d.clone()),
            }
        }
    }
    out
}

fn join(beneficiary: Option<&str>) -> String {
    match beneficiary {
        Some(b) => json!({"action": "join", "beneficiary": id(b)}).to_string(),
        None => json!({"action": "join"}).to_string(),
    }
}

fn bal(beneficiary: &str) -> String {
    json!({"action": "balance", "beneficiary": id(beneficiary)}).to_string()
}

#[tokio::test]
async fn unbonding_withdrawals() -> R<()> {
    let cd = 30_000u64;
    let t = T::new(cd, 5000, json!({}), &["alice", "bob", "carol", "erin"]).await?;
    t.inv().await?;
    // Challenging needs 25 USDC of the challenger's own active Court.
    t.deposit_ok("alice", 25 * U, &join(None)).await?;
    t.deposit_ok("bob", 45 * U, &join(None)).await?;
    t.deposit_ok("carol", 25 * U, &join(None)).await?;
    assert_eq!(t.a("alice", "court").await?, 25 * U);
    assert_eq!(t.a("bob", "court").await?, 45 * U);

    // Court and pending move at request time.
    let l0 = t.liab().await?;
    t.ok("bob", "request_withdraw", json!({"amount": (20 * U).to_string()})).await?;
    let b = t.acct("bob").await?;
    assert_eq!(num(&b["court"]), 25 * U, "{b}");
    assert_eq!(num(&b["withdraw_pending"]), 20 * U, "{b}");
    let l1 = t.liab().await?;
    assert_eq!(num(&l0["court"]) - num(&l1["court"]), 20 * U);
    assert_eq!(num(&l1["pending"]) - num(&l0["pending"]), 20 * U);
    assert_eq!(num(&l1["balances"]), num(&l0["balances"]));
    assert_eq!(num(&t.st().await?["court"]["total"]), 75 * U, "court.total counts active only");
    t.inv().await?;
    let ready1 = b["withdraw_ready_at"].as_u64().expect("ready_at set");

    // Refusals.
    t.refused("bob", "request_withdraw", json!({"amount": "0"}), "INVALID_AMOUNT").await?;
    t.refused("bob", "request_withdraw", json!({"amount": (25 * U + 1).to_string()}), "INVALID_AMOUNT").await?;
    t.refused("erin", "request_withdraw", json!({"amount": U.to_string()}), "INVALID_AMOUNT").await?;
    t.refused("alice", "withdraw", json!({}), "NOTHING_TO_WITHDRAW").await?;
    t.refused("bob", "withdraw", json!({}), "COOLDOWN").await?;

    // Pending earns nothing: a 5 USDC ticket gives c = 750_000; depositors get 375_000, split
    // 25:25:25 across ACTIVE Court only, so 125_000 each (counting bob's pending would give
    // alice/carol 98_684 and bob 177_631).
    t.deposit_ok("carol", 20 * U, "").await?;
    let l0 = t.liab().await?;
    let p = t.challenge("carol").await?;
    assert_eq!(p, 5 * U);
    let l1 = t.liab().await?;
    assert_eq!(num(&l1["rewards"]) - num(&l0["rewards"]), 375_000);
    assert_eq!(num(&l1["draw_pot"]) - num(&l0["draw_pot"]), 375_000);
    for n in ["alice", "bob", "carol"] {
        assert_eq!(t.a(n, "court_earned").await?, 125_000, "{n} court_earned");
    }
    let w0 = t.ft(&id("alice")).await?;
    let r = t.ok("alice", "claim", json!({})).await?;
    assert!(r.json::<bool>()?);
    assert_eq!(t.ft(&id("alice")).await? - w0, 125_000, "claim pays Court earnings");
    assert_eq!(t.a("alice", "court").await?, 25 * U, "claim leaves the Court principal");
    t.inv().await?;

    // Let the first cooldown fully elapse, then request again: the cooldown restarts for everything.
    t.advance_to(ready1 + 2_000).await?;
    let before = t.now_ms().await?;
    t.ok("bob", "request_withdraw", json!({"amount": (10 * U).to_string()})).await?;
    let b = t.acct("bob").await?;
    assert_eq!(num(&b["court"]), 15 * U);
    assert_eq!(num(&b["withdraw_pending"]), 30 * U);
    let ready2 = b["withdraw_ready_at"].as_u64().unwrap();
    assert!(ready2 > ready1 && ready2 >= before + cd, "ready_at not restarted: {ready1} -> {ready2}");
    t.refused("bob", "withdraw", json!({}), "COOLDOWN").await?;
    t.inv().await?;

    // Bob has 15 active + 30 pending: pending must not count toward the 25 USDC minimum.
    t.deposit_ok("bob", 10 * U, "").await?;
    t.refused("bob", "challenge", json!({"max_price": HUGE}), "COURT_TOO_SMALL").await?;
    t.ok("alice", "request_withdraw", json!({"amount": (25 * U).to_string()})).await?;
    assert_eq!(t.a("alice", "court").await?, 0);
    assert_eq!(num(&t.st().await?["court"]["total"]), 40 * U);
    t.inv().await?;

    // After the restarted cooldown, withdraw pays exactly the whole pending amount.
    t.advance_to(ready2 + 2_000).await?;
    let w0 = t.ft(&id("bob")).await?;
    let l0 = t.liab().await?;
    let r = t.ok("bob", "withdraw", json!({})).await?;
    assert!(r.json::<bool>()?);
    assert_eq!(t.ft(&id("bob")).await? - w0, 30 * U);
    assert_eq!(num(&l0["pending"]) - t.l("pending").await?, 30 * U);
    assert_eq!(t.a("bob", "withdraw_pending").await?, 0);
    assert_eq!(t.a("bob", "court").await?, 15 * U);
    t.inv().await?;
    t.refused("bob", "withdraw", json!({}), "NOTHING_TO_WITHDRAW").await?;

    let ready_a = t.acct("alice").await?["withdraw_ready_at"].as_u64().unwrap();
    t.advance_to(ready_a + 2_000).await?;
    let w0 = t.ft(&id("alice")).await?;
    t.ok("alice", "withdraw", json!({})).await?;
    assert_eq!(t.ft(&id("alice")).await? - w0, 25 * U);
    t.inv().await?;
    Ok(())
}

#[tokio::test]
async fn court_share_rounding() -> R<()> {
    let t = T::new(1000, 5000, json!({}), &["alice", "carol", "dave"]).await?;
    t.deposit_ok("alice", 100 * U, &join(None)).await?;
    t.deposit_ok("carol", 25 * U, &join(None)).await?;
    t.deposit_ok("carol", 100 * U, "").await?;
    t.deposit_ok("dave", 25 * U, &join(None)).await?;
    t.deposit_ok("dave", 100 * U, "").await?;
    let mut odd = 0;
    let mut earned = 0u128;
    for i in 0..5 {
        let who = if i % 2 == 0 { "carol" } else { "dave" };
        let l0 = t.liab().await?;
        let p = t.challenge(who).await?;
        assert_eq!(p, model_price(i), "ticket {i} price");
        let l1 = t.liab().await?;
        let c = p * 1500 / 10000;
        odd += (c % 2) as usize;
        let d_rewards = num(&l1["rewards"]) - num(&l0["rewards"]);
        let d_pot = num(&l1["draw_pot"]) - num(&l0["draw_pot"]);
        let d_treasury = num(&l1["treasury"]) - num(&l0["treasury"]);
        assert_eq!(d_rewards, c / 2, "ticket {i}: price {p}, c {c}: rewards delta");
        assert_eq!(d_pot, c - c / 2, "ticket {i}: price {p}, c {c}: draw pot delta");
        assert_eq!(d_treasury, p * 500 / 10000, "ticket {i}: treasury delta");
        earned += c / 2;
    }
    assert!(odd >= 2, "test needs odd Court shares");
    let mut e = 0;
    for n in ["alice", "carol", "dave"] {
        e += t.a(n, "court_earned").await?;
    }
    assert!(e <= earned && e + 15 >= earned, "depositors earned {e} in total, expected about {earned}");
    Ok(())
}

#[tokio::test]
async fn pause_controls() -> R<()> {
    let every = 20_000u64;
    let t = T::new(3000, 5000,
        json!({"owner": id("owner"), "intents": id("intents"), "limits": limits(1u128 << 100, 1u128 << 100, U, every)}),
        &["owner", "intents", "alice", "bob", "carol", "eve"]).await?;
    t.deposit_ok("alice", 50 * U, &join(None)).await?;
    t.deposit_ok("bob", 30 * U, "").await?;
    t.ok("bob", "set_auto_defend", json!({"max_price": (10 * U).to_string()})).await?;
    t.ok("alice", "request_withdraw", json!({"amount": (10 * U).to_string()})).await?;

    t.refused("alice", "set_paused", json!({"paused": true}), "NOT_OWNER").await?;
    t.refused("pool", "set_paused", json!({"paused": true}), "NOT_OWNER").await?;
    t.ok("owner", "set_paused", json!({"paused": true})).await?;
    assert_eq!(t.st().await?["paused"], json!(true));

    // Refused while paused.
    t.refused("bob", "challenge", json!({"max_price": HUGE}), "PAUSED").await?;
    t.refused("bob", "join_court", json!({"amount": (5 * U).to_string()}), "PAUSED").await?;
    t.refused("bob", "set_auto_defend", json!({"max_price": (20 * U).to_string()}), "PAUSED").await?;
    t.deposit_refused("eve", 5 * U, "", "PAUSED").await?;
    t.deposit_refused("eve", 5 * U, &join(None), "PAUSED").await?;
    t.deposit_refused("eve", 5 * U, &bal("alice"), "PAUSED").await?;

    // Never paused.
    t.ok("bob", "set_auto_defend", json!({"max_price": "0"})).await?;
    assert_eq!(t.a("bob", "auto_defend_max").await?, 0);
    t.ok("alice", "request_withdraw", json!({"amount": (5 * U).to_string()})).await?;
    t.inv().await?;
    let ready = t.acct("alice").await?["withdraw_ready_at"].as_u64().unwrap();
    t.advance_to(ready + 1500).await?;
    let w0 = t.ft(&id("alice")).await?;
    t.ok("alice", "withdraw", json!({})).await?;
    assert_eq!(t.ft(&id("alice")).await? - w0, 15 * U);
    t.inv().await?;
    let w0 = t.ft(&id("bob")).await?;
    t.ok("bob", "claim", json!({})).await?;
    assert_eq!(t.ft(&id("bob")).await? - w0, 30 * U);
    t.inv().await?;
    for m in ["poke", "settle_round"] {
        let res = t.call("carol", m, json!({})).await?;
        let dbg = format!("{res:?}");
        assert!(!dbg.contains("PAUSED"), "{m} refused while paused: {dbg}");
        if res.is_success() {
            println!("{m} while paused: success");
        } else {
            println!("{m} while paused: {:?}", res.assert_failure());
        }
        t.inv().await?;
    }
    let next = t.st().await?["court"]["next_draw_at"].as_u64().unwrap();
    t.advance_to(next + 1500).await?;
    let res = t.draw("carol").await?;
    assert!(res.is_success(), "{res:?}");
    t.inv().await?;
    let (kept, _) = t.ft_call("intents", 2 * U, &bal("carol")).await?;
    assert_eq!(kept, 2 * U);
    assert_eq!(t.a("carol", "balance").await?, 2 * U);
    t.inv().await?;

    t.refused("alice", "set_paused", json!({"paused": false}), "NOT_OWNER").await?;
    t.ok("owner", "set_paused", json!({"paused": false})).await?;
    assert_eq!(t.st().await?["paused"], json!(false));
    t.deposit_ok("eve", 5 * U, "").await?;
    Ok(())
}

#[tokio::test]
async fn deposit_caps() -> R<()> {
    let t = T::new(60_000, 5000,
        json!({"limits": limits(100 * U, 150 * U, U, 604_800_000)}),
        &["alice", "bob", "carol", "dave"]).await?;
    t.deposit_ok("alice", 60 * U, &join(None)).await?;
    t.ok("alice", "request_withdraw", json!({"amount": (20 * U).to_string()})).await?;
    // 40 Court + 20 pending + 41 > 100.
    t.deposit_refused("alice", 41 * U, "", "CAP_REACHED").await?;
    t.deposit_ok("alice", 40 * U, "").await?; // exactly 100
    // Account cap uses the beneficiary, not the sender.
    t.deposit_refused("dave", U, &bal("alice"), "CAP_REACHED").await?;
    t.deposit_refused("dave", U, &join(Some("alice")), "CAP_REACHED").await?;
    // Total: 100 + 50 = 150 exactly.
    t.deposit_ok("bob", 50 * U, &join(None)).await?;
    t.deposit_refused("carol", U, "", "CAP_REACHED").await?;
    t.deposit_refused("carol", U, &join(None), "CAP_REACHED").await?;
    assert_eq!(t.a("carol", "balance").await?, 0);
    Ok(())
}

#[tokio::test]
async fn intents_deliveries_and_recovery() -> R<()> {
    // Owner defaults to the contract account itself.
    let t = T::new(1000, 5000,
        json!({"intents": id("intents"), "limits": limits(10 * U, 1000 * U, U, 604_800_000)}),
        &["intents", "alice", "bob", "carol", "dave", "erin", "rec"]).await?;
    let iw0 = t.ft(&id("intents")).await?;
    let mut sent = 0u128;

    // Over the 10 USDC account cap.
    t.deposit_ok("intents", 20 * U, &bal("alice")).await?;
    sent += 20 * U;
    assert_eq!(t.a("alice", "balance").await?, 20 * U);
    // Exactly the 1 USDC minimum is credited.
    t.deposit_ok("intents", U, &bal("bob")).await?;
    sent += U;
    assert_eq!(t.a("bob", "balance").await?, U);
    // Join while unpaused.
    t.deposit_ok("intents", 30 * U, &join(Some("dave"))).await?;
    sent += 30 * U;
    let d = t.acct("dave").await?;
    assert_eq!(num(&d["court"]), 30 * U, "{d}");
    assert_eq!(num(&d["balance"]), 0, "{d}");

    t.refused("alice", "set_paused", json!({"paused": true}), "NOT_OWNER").await?;
    t.ok("pool", "set_paused", json!({"paused": true})).await?;
    // Join while paused: credited to the game balance, no Court.
    t.deposit_ok("intents", 30 * U, &join(Some("carol"))).await?;
    sent += 30 * U;
    let c = t.acct("carol").await?;
    assert_eq!(num(&c["balance"]), 30 * U, "{c}");
    assert_eq!(num(&c["court"]), 0, "{c}");

    let bad = [
        String::new(),
        "not json".to_string(),
        json!({"action": "balance"}).to_string(),
        json!({"action": "join"}).to_string(),
        json!({"action": "balance", "beneficiary": id("alice"), "extra": 1}).to_string(),
        json!({"action": "steal", "beneficiary": id("alice")}).to_string(),
        json!({"beneficiary": id("alice")}).to_string(),
        // Valid msgs below 1 USDC are held, not credited.
        bal("alice"),
        join(Some("alice")),
    ];
    let mut held = 0u128;
    for (i, msg) in bad.iter().enumerate() {
        if i == 4 {
            t.ok("pool", "set_paused", json!({"paused": false})).await?;
        }
        let amount = match i {
            3 => 7,
            7 => 999_999,
            8 => 500_000,
            _ => 1_234_567 + i as u128,
        };
        let r0 = t.l("recovery").await?;
        let a0 = t.acct("alice").await?;
        let res = t.deposit_ok("intents", amount, msg).await?;
        sent += amount;
        held += amount;
        assert_eq!(t.l("recovery").await? - r0, amount, "msg {msg:?} not held in recovery");
        assert_eq!(t.acct("alice").await?, a0, "msg {msg:?} credited alice");
        let ev = events(&res, "deposit_held");
        assert!(ev.iter().any(|d| num(&d["amount"]) == amount), "msg {msg:?}: no deposit_held {amount}: {res:?}");
    }
    assert_eq!(iw0 - t.ft(&id("intents")).await?, sent, "nothing is ever refunded to Intents");

    // Direct deposits from other senders keep the old rules.
    t.deposit_refused("erin", 999_999, "", "INVALID_AMOUNT").await?;
    t.deposit_refused("erin", 2 * U, "garbage", "INVALID_MSG").await?;
    t.deposit_refused("erin", 2 * U, &json!({"action": "steal"}).to_string(), "INVALID_MSG").await?;

    // Recovery.
    assert_eq!(t.l("recovery").await?, held);
    t.refused("alice", "recover", json!({"receiver_id": id("rec"), "amount": "1"}), "NOT_OWNER").await?;
    t.refused("pool", "recover", json!({"receiver_id": id("rec"), "amount": "0"}), "INVALID_AMOUNT").await?;
    t.refused("pool", "recover", json!({"receiver_id": id("rec"), "amount": (held + 1).to_string()}), "INVALID_AMOUNT").await?;
    let w0 = t.ft(&id("rec")).await?;
    let r = t.ok("pool", "recover", json!({"receiver_id": id("rec"), "amount": (held - 1000).to_string()})).await?;
    assert!(r.json::<bool>()?);
    assert_eq!(t.ft(&id("rec")).await? - w0, held - 1000);
    assert_eq!(t.l("recovery").await?, 1000);
    t.inv().await?;
    t.ok("pool", "recover", json!({"receiver_id": id("rec"), "amount": "1000"})).await?;
    assert_eq!(t.ft(&id("rec")).await? - w0, held);
    assert_eq!(t.l("recovery").await?, 0);
    t.inv().await?;
    t.refused("pool", "recover", json!({"receiver_id": id("rec"), "amount": "1"}), "INVALID_AMOUNT").await?;
    Ok(())
}

#[tokio::test]
async fn treasury_claim() -> R<()> {
    let t = T::new(1000, 5000, json!({"owner": id("owner")}), &["owner", "alice", "carol", "dave", "rec"]).await?;
    t.refused("owner", "claim_treasury", json!({"receiver_id": id("rec")}), "NOTHING_TO_CLAIM").await?;
    t.deposit_ok("alice", 50 * U, &join(None)).await?;
    t.deposit_ok("carol", 25 * U, &join(None)).await?;
    t.deposit_ok("carol", 50 * U, "").await?;
    t.deposit_ok("dave", 25 * U, &join(None)).await?;
    t.deposit_ok("dave", 50 * U, "").await?;
    let mut model = 0u128;
    for i in 0..4 {
        let p = t.challenge(if i % 2 == 0 { "carol" } else { "dave" }).await?;
        assert_eq!(p, model_price(i));
        model += p * 500 / 10000;
    }
    assert_eq!(t.l("treasury").await?, model);
    t.refused("carol", "claim_treasury", json!({"receiver_id": id("carol")}), "NOT_OWNER").await?;
    t.refused("pool", "claim_treasury", json!({"receiver_id": id("rec")}), "NOT_OWNER").await?;
    let w0 = t.ft(&id("rec")).await?;
    let r = t.ok("owner", "claim_treasury", json!({"receiver_id": id("rec")})).await?;
    assert!(r.json::<bool>()?);
    assert_eq!(t.ft(&id("rec")).await? - w0, model);
    assert_eq!(t.l("treasury").await?, 0);
    t.inv().await?;
    t.refused("owner", "claim_treasury", json!({"receiver_id": id("rec")}), "NOTHING_TO_CLAIM").await?;
    Ok(())
}

#[tokio::test]
async fn draw_pays_active_court_only() -> R<()> {
    let every = 15_000u64;
    let t = T::new(1000, 5000,
        json!({"limits": limits(1u128 << 100, 1u128 << 100, 300_000, every)}),
        &["alice", "bob", "carol", "dave"]).await?;
    t.refused("carol", "close_draw", json!({}), "NOT_READY").await?;
    t.deposit_ok("alice", 30 * U, &join(None)).await?;
    t.deposit_ok("bob", 30 * U, &join(None)).await?;
    t.deposit_ok("carol", 25 * U, &join(None)).await?;
    t.deposit_ok("carol", 100 * U, "").await?;
    t.deposit_ok("dave", 25 * U, &join(None)).await?;
    t.deposit_ok("dave", 100 * U, "").await?;
    t.challenge("carol").await?;
    let start = t.now_ms().await?;
    // alice, carol and dave keep active Court; bob will unbond fully.
    t.advance_to(start + 3_000).await?;
    let ab = t.a("alice", "draw_weight_bps").await?;
    let bb = t.a("bob", "draw_weight_bps").await?;
    assert!(ab > 0 && bb > 0, "both accrue weight: alice {ab}, bob {bb}");
    // Bob unbonds everything after accruing weight: he is dropped from the draw.
    t.ok("bob", "request_withdraw", json!({"amount": (30 * U).to_string()})).await?;
    t.inv().await?;
    // Weight violations are collected so every draw still runs; the test fails at the end.
    let mut errors: Vec<String> = vec![];

    for i in 0..5 {
        if i > 0 {
            t.challenge(if i % 2 == 0 { "carol" } else { "dave" }).await?;
        }
        let bb = t.a("bob", "draw_weight_bps").await?;
        let others: Vec<u128> = [t.a("alice", "draw_weight_bps").await?, t.a("carol", "draw_weight_bps").await?,
            t.a("dave", "draw_weight_bps").await?].into();
        println!("draw {i}: bps bob {bb}, alice/carol/dave {others:?}");
        if bb != 0 {
            errors.push(format!("draw {i}: unbonded bob has draw_weight_bps {bb} (expected 0)"));
        }
        let next = t.st().await?["court"]["next_draw_at"].as_u64().unwrap();
        t.advance_to(next + 1500).await?;
        let pot = t.l("draw_pot").await?;
        assert!(pot >= 300_000, "draw {i}: pot {pot} below draw_min");
        let names = ["alice", "bob", "carol", "dave"];
        let mut before = vec![];
        for n in names {
            before.push(t.a(n, "balance").await?);
        }
        let res = t.draw("dave").await?;
        assert!(res.is_success(), "draw {i}: {res:?}");
        let ev = events(&logs(&res), "draw_won");
        assert_eq!(ev.len(), 1, "draw {i}: {:?}", res.logs());
        let by = ev[0]["by"].as_str().unwrap().to_string();
        assert_eq!(num(&ev[0]["amount"]), pot, "draw {i}: event amount");
        println!("draw {i}: pot {pot} won by {by}");
        if by == id("bob").as_str() {
            errors.push(format!("draw {i}: unbonded bob won {pot}"));
        }
        for (k, n) in names.iter().enumerate() {
            let d = t.a(n, "balance").await? - before[k];
            let expect = if id(n).as_str() == by { pot } else { 0 };
            assert_eq!(d, expect, "draw {i}: {n} balance delta (winner {by})");
        }
        assert_eq!(t.l("draw_pot").await?, 0);
        let next2 = t.st().await?["court"]["next_draw_at"].as_u64().unwrap();
        assert!(next2 >= next + every, "draw {i}: next_draw_at {next} -> {next2}");
        t.inv().await?;
        // Waiting for drand takes longer than `every`, so the next draw may already be due;
        // what can't happen is paying this one twice.
        t.refused("carol", "finalize_draw", json!({"signature": "00"}), "NO_DRAW").await?;
    }
    assert!(errors.is_empty(), "{errors:#?}");
    Ok(())
}

#[tokio::test]
async fn draw_rolls_over_below_min() -> R<()> {
    let every = 15_000u64;
    let t = T::new(1000, 5000,
        json!({"limits": limits(1u128 << 100, 1u128 << 100, 10 * U, every)}),
        &["alice", "carol"]).await?;
    t.deposit_ok("alice", 30 * U, &join(None)).await?;
    t.deposit_ok("carol", 25 * U, &join(None)).await?;
    t.deposit_ok("carol", 100 * U, "").await?;
    t.challenge("carol").await?;
    let pot = t.l("draw_pot").await?;
    assert_eq!(pot, 375_000);
    let next = t.st().await?["court"]["next_draw_at"].as_u64().unwrap();
    t.advance_to(next + 1500).await?;
    let a0 = t.acct("alice").await?;
    let res = t.call("carol", "close_draw", json!({})).await?;
    assert!(res.is_success(), "{res:?}");
    assert!(events(&logs(&res), "draw_closed").is_empty(), "{:?}", res.logs());
    assert!(t.st().await?["court"]["pending_draw"].is_null(), "nothing to draw");
    assert_eq!(t.l("draw_pot").await?, pot, "pot rolls over");
    assert_eq!(num(&t.acct("alice").await?["balance"]), num(&a0["balance"]));
    let next2 = t.st().await?["court"]["next_draw_at"].as_u64().unwrap();
    assert!(next2 >= next + every, "next_draw_at {next} -> {next2}");
    t.inv().await?;
    t.refused("carol", "close_draw", json!({}), "NOT_READY").await?;
    Ok(())
}
