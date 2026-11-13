//! A local NEAR chain for RugPool: near-sandbox on a fixed port, tUSDC and RugPool deployed fresh
//! with demo timings, and many funded players, each with $30 in the Court (a draw slot and the
//! challenge minimum) and $70 of tUSDC left in their wallet. It stays up until Ctrl-C.
//!
//!     cd contract && cargo run -p rugpool --example localnet -- [--accounts 500] [--port 3030] [--fund <account>]... [--draw] [--bots] [--exit]
//!
//! `--fund` gives an outside account (a Privy player's 64-hex implicit account, say) 1 NEAR, which
//! creates it on the local chain, plus $100 of tUSDC, so the app can sign in and play here.
//! `--draw` then runs a full draw over every player: a short war between six players fills the
//! draw pot past its $1 minimum, then `close_draw`, the named drand round fetched from drand's
//! public API (needs the network), `finalize_draw`, with gas and solvency printed.
//! `--bots` keeps the game running while it's up: 30 players buy tickets at random every few
//! seconds (every fifth with auto-defend armed, so wars break out), slower during a showdown so
//! rounds can end, and a keeper settles rounds, pokes stale ones and runs the draw every minute.
//! `--exit` stops after setup (and `--draw`) instead of staying up.
//!
//! Everything lands in `.localnet/` at the repo root (gitignored): `localnet.json` (RPC, contract
//! ids, players) and `credentials/<account>.json` for the relayer and the keeper. Every account
//! here uses the sandbox's well-known genesis key: local testing only.

use near_api::types::Action;
use near_api::types::transaction::actions::{FunctionCallAction, TransferAction};
use near_api::types::transaction::result::ExecutionSuccess;
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer, Transaction};
use near_sandbox::config::{DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY, DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY};
use near_sandbox::{Sandbox, SandboxConfig};
use near_sdk::serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

const USDC: u128 = 1_000_000;
const COURT: u128 = 30 * USDC;
const WALLET: u128 = 100 * USDC;
/// Transactions in flight at once while funding players. Each player signs its own, so their
/// nonces never collide.
const PARALLEL: usize = 64;
const QUICKNET: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
/// Players who play in `--bots` mode, and how often the bots and the keeper act.
const BOTS: usize = 30;
const BOT_TICK: Duration = Duration::from_secs(3);

struct Args {
    accounts: usize,
    port: u16,
    fund: Vec<AccountId>,
    draw: bool,
    bots: bool,
    exit: bool,
}

fn args() -> Args {
    let mut a = Args { accounts: 500, port: 3030, fund: vec![], draw: false, bots: false, exit: false };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--accounts" => a.accounts = it.next().and_then(|v| v.parse().ok()).expect("--accounts <n>"),
            "--port" => a.port = it.next().and_then(|v| v.parse().ok()).expect("--port <port>"),
            "--fund" => a.fund.push(it.next().and_then(|v| v.parse().ok()).expect("--fund <account>")),
            "--draw" => a.draw = true,
            "--bots" => a.bots = true,
            "--exit" => a.exit = true,
            other => panic!("unknown flag {other}"),
        }
    }
    a
}

struct Chain {
    _sandbox: Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    usdc: AccountId,
    pool: AccountId,
}

impl Chain {
    /// Sends one transaction of function calls from `from` to `to`; panics if it fails.
    async fn send(&self, from: &AccountId, to: &AccountId, calls: &[(&str, Value, u64, NearToken)]) -> ExecutionSuccess {
        self.try_send(from, to, calls).await.unwrap_or_else(|e| panic!("{from} -> {to} failed: {e}"))
    }

    /// Sends one transaction of function calls; a refusal comes back as its "CODE: message".
    async fn try_send(&self, from: &AccountId, to: &AccountId, calls: &[(&str, Value, u64, NearToken)]) -> Result<ExecutionSuccess, String> {
        let actions = calls
            .iter()
            .map(|(method, args, tgas, deposit)| {
                Action::FunctionCall(Box::new(FunctionCallAction {
                    method_name: method.to_string(),
                    args: near_sdk::serde_json::to_vec(args).unwrap(),
                    gas: NearGas::from_tgas(*tgas),
                    deposit: *deposit,
                }))
            })
            .collect();
        Transaction::construct(from.clone(), to.clone())
            .add_actions(actions)
            .with_signer(self.signer.clone())
            .send_to(&self.net)
            .await
            .map_err(|e| format!("not sent: {e}"))?
            .into_result()
            .map_err(|e| {
                let text = format!("{e:?}");
                text.split("panicked: ").nth(1).and_then(|t| t.split('"').next()).map_or(text.clone(), str::to_string)
            })
    }

    async fn view(&self, on: &AccountId, method: &str, args: Value) -> Value {
        near_api::Contract(on.clone()).call_function(method, args).read_only().fetch_from(&self.net).await.expect("view").data
    }

    async fn solvency(&self) -> (u128, u128) {
        let l = self.view(&self.pool, "get_liabilities", json!({})).await;
        let owed = l.as_object().unwrap().values().map(num).sum();
        let held = num(&self.view(&self.usdc, "ft_balance_of", json!({ "account_id": self.pool })).await);
        (owed, held)
    }
}

fn num(v: &Value) -> u128 {
    v.as_str().expect("u128 as a string").parse().unwrap()
}

fn build(crate_dir: &str) -> Vec<u8> {
    let manifest = format!("{}/../{crate_dir}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
    let path = cargo_near_build::build_with_cli(cargo_near_build::BuildOpts { manifest_path: Some(manifest.as_str().into()), ..Default::default() }).expect("contract builds");
    std::fs::read(path).unwrap()
}

async fn create(sandbox: &Sandbox, name: &str, near: u128) -> AccountId {
    let id: AccountId = format!("{name}.sandbox").parse().unwrap();
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(near)).send().await.expect("account created");
    id
}

async fn deploy(c: &Chain, id: &AccountId, code: Vec<u8>, args: Value) {
    near_api::Contract::deploy(id.clone())
        .use_code(code)
        .with_init_call("new", args)
        .unwrap()
        .with_signer(c.signer.clone())
        .send_to(&c.net)
        .await
        .unwrap()
        .assert_success();
}

/// Quicknet's signature for `round`, if drand has published it.
async fn fetch_drand(round: u64) -> Option<String> {
    let url = format!("https://api.drand.sh/{QUICKNET}/public/{round}");
    let out = tokio::process::Command::new("curl").args(["-sf", &url]).output().await.ok()?;
    let beacon: Value = near_sdk::serde_json::from_slice(&out.stdout).ok()?;
    beacon["signature"].as_str().map(str::to_string)
}

/// Quicknet's signature for `round`, waiting until drand publishes it.
async fn drand_signature(round: u64) -> String {
    for _ in 0..200 {
        if let Some(signature) = fetch_drand(round).await {
            return signature;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    panic!("drand round {round} never appeared");
}

async fn chain_now_ms(c: &Chain) -> u64 {
    let block = near_api::Chain::block().fetch_from(&c.net).await.expect("block");
    block.header.timestamp_nanosec.parse::<u64>().expect("block time") / 1_000_000
}

fn usd(micro: u128) -> String {
    format!("${:.2}", micro as f64 / USDC as f64)
}

/// `--bots`: the first `BOTS` players play, and the keeper keeps rounds and draws moving.
async fn bots(c: Arc<Chain>, keeper: AccountId, players: Vec<AccountId>) {
    let bots: Vec<AccountId> = players.into_iter().take(BOTS).collect();
    for (i, b) in bots.iter().enumerate() {
        top_up(&c, b).await;
        if i % 5 == 0 {
            c.send(b, &c.pool, &[("set_auto_defend", json!({ "max_price": (8 * USDC).to_string() }), 30, NearToken::from_yoctonear(0))]).await;
        }
    }
    println!("bots: {} players with game balances, {} with auto-defend up to $8", bots.len(), bots.len().div_ceil(5));
    // xorshift, seeded from the clock: no rand crate needed for picking players.
    let mut seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64 | 1;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let no_deposit = NearToken::from_yoctonear(0);
    loop {
        tokio::time::sleep(BOT_TICK).await;
        let state = c.view(&c.pool, "get_state", json!({})).await;
        let now = chain_now_ms(&c).await;
        let (round, court) = (&state["round"], &state["court"]);

        // The keeper: settle a finished showdown, start one on a stale round, run the draw.
        if round["showdown_ends_at"].as_u64().is_some_and(|end| now >= end) {
            match c.try_send(&keeper, &c.pool, &[("settle_round", json!({}), 50, no_deposit)]).await {
                Ok(_) => println!("keeper: round {} settled, {} to {}", round["id"], usd(num(&round["jackpot"])), round["king"].as_str().unwrap_or("nobody")),
                Err(e) => println!("keeper: settle_round refused: {e}"),
            }
            continue;
        }
        if round["showdown_ends_at"].is_null() && round["backstop_at"].as_u64().is_some_and(|at| now >= at) {
            let _ = c.try_send(&keeper, &c.pool, &[("poke", json!({}), 30, no_deposit)]).await;
        }
        if let Some(r) = court["pending_draw"]["round"].as_u64() {
            if let Some(signature) = fetch_drand(r).await {
                match c.try_send(&keeper, &c.pool, &[("finalize_draw", json!({ "signature": signature }), 100, no_deposit)]).await {
                    Ok(res) => println!("keeper: draw paid with drand round {r}: {}", res.logs().into_iter().find(|l| l.contains("draw_won")).unwrap_or("")),
                    Err(e) => println!("keeper: finalize_draw refused: {e}"),
                }
            }
        } else if court["next_draw_at"].as_u64().is_some_and(|at| now >= at) {
            match c.try_send(&keeper, &c.pool, &[("close_draw", json!({}), 300, no_deposit)]).await {
                Ok(_) => match c.view(&c.pool, "get_state", json!({})).await["court"]["pending_draw"]["round"].as_u64() {
                    Some(r) => println!("keeper: draw closed, pot {}, drand round {r} picks the winner", usd(num(&court["draw_pot"]))),
                    None => println!("keeper: draw pot {} is under the $1 minimum, rolled over", usd(num(&court["draw_pot"]))),
                },
                Err(e) => println!("keeper: close_draw refused: {e}"),
            }
        }

        // A bot buys: every tick in an open round, one tick in four during a showdown, so the
        // 15 s snipe window can run out and the round can end.
        if round["showdown_ends_at"].is_u64() && next() % 4 != 0 {
            continue;
        }
        let bot = &bots[(next() % bots.len() as u64) as usize];
        if round["king"].as_str() == Some(bot.as_str()) {
            continue;
        }
        let price = num(&round["next_price"]);
        if num(&c.view(&c.pool, "get_account", json!({ "account_id": bot })).await["balance"]) < price {
            top_up(&c, bot).await;
        }
        match c.try_send(bot, &c.pool, &[("challenge", json!({ "max_price": price.to_string() }), 100, no_deposit)]).await {
            Ok(res) => {
                let retakes = res.logs().iter().filter(|l| l.contains("auto_defended")).count();
                let war = if retakes > 0 { format!(", {retakes} auto-defend retakes") } else { String::new() };
                println!("{bot} took the throne for {}{war}", usd(price));
            }
            Err(e) => println!("{bot} refused: {e}"),
        }
    }
}

/// Mints a bot $100 of tUSDC and deposits it into its game balance.
async fn top_up(c: &Chain, bot: &AccountId) {
    c.send(
        bot,
        &c.usdc,
        &[
            ("mint", json!({ "account_id": bot, "amount": WALLET.to_string() }), 10, NearToken::from_yoctonear(0)),
            ("ft_transfer_call", json!({ "receiver_id": c.pool, "amount": WALLET.to_string(), "msg": "" }), 100, NearToken::from_yoctonear(1)),
        ],
    )
    .await;
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.localnet")
}

#[tokio::main]
async fn main() {
    let a = args();
    let started = Instant::now();
    let sandbox = Sandbox::start_sandbox_with_config(SandboxConfig { rpc_port: Some(a.port), ..Default::default() }).await.expect("sandbox starts");
    let net = NetworkConfig::from_rpc_url("localnet", sandbox.rpc_addr.parse().unwrap());
    let signer = Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap()).unwrap();
    println!("sandbox on {}", sandbox.rpc_addr);

    let (usdc_code, pool_code) = (build("test-usdc"), build("rugpool"));
    let usdc = create(&sandbox, "tusdc", 50).await;
    let pool = create(&sandbox, "rugpool", 50).await;
    let relayer = create(&sandbox, "relayer", 1_000).await;
    let keeper = create(&sandbox, "keeper", 100).await;
    let c = Arc::new(Chain { _sandbox: sandbox, net, signer, usdc, pool });
    deploy(&c, &c.usdc, usdc_code, json!({})).await;
    // The testnet demo's timings: an $8 trigger, a 5-minute backstop, a 90 s showdown with a 15 s
    // snipe window. Uncapped, with a draw every minute so `--draw` needn't wait a week.
    let timing = json!({ "trigger_bps": 20, "trigger_fixed": (8 * USDC).to_string(), "backstop_ms": 300_000, "showdown_ms": 90_000, "snipe_ms": 15_000 });
    let limits = json!({ "max_account": u128::MAX.to_string(), "max_total": u128::MAX.to_string(), "draw_min": USDC.to_string(), "draw_every_ms": 60_000 });
    deploy(&c, &c.pool, pool_code, json!({ "token": c.usdc, "withdraw_cooldown_ms": 60_000, "court_draw_bps": 5_000, "timing": timing, "limits": limits, "relayers": [relayer] })).await;
    c.send(&c.pool, &c.usdc, &[("storage_deposit", json!({ "account_id": c.pool }), 10, NearToken::from_millinear(10))]).await;
    println!("tUSDC {} and RugPool {} deployed ({:.0?})", c.usdc, c.pool, started.elapsed());

    // Players: each creates its account, then one transaction to the token registers it, mints
    // $100 and deposits $30 into the Court.
    let gate = Arc::new(Semaphore::new(PARALLEL));
    let mut jobs = JoinSet::new();
    for i in 0..a.accounts {
        let (c, gate) = (c.clone(), gate.clone());
        jobs.spawn(async move {
            let _slot = gate.acquire().await.unwrap();
            let id: AccountId = format!("p{i}.sandbox").parse().unwrap();
            c._sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(10)).send().await.expect("player created");
            c.send(
                &id,
                &c.usdc,
                &[
                    ("storage_deposit", json!({ "account_id": id }), 10, NearToken::from_millinear(10)),
                    ("mint", json!({ "account_id": id, "amount": WALLET.to_string() }), 10, NearToken::from_yoctonear(0)),
                    ("ft_transfer_call", json!({ "receiver_id": c.pool, "amount": COURT.to_string(), "msg": r#"{"action":"join"}"# }), 100, NearToken::from_yoctonear(1)),
                ],
            )
            .await;
            id
        });
    }
    let mut players = Vec::with_capacity(a.accounts);
    while let Some(id) = jobs.join_next().await {
        players.push(id.expect("player job"));
        if players.len() % 100 == 0 {
            println!("  {} players funded ({:.0?})", players.len(), started.elapsed());
        }
    }
    players.sort_by_key(|p| p.as_str()[1..].split('.').next().unwrap().parse::<usize>().unwrap());
    let state = c.view(&c.pool, "get_state", json!({})).await;
    let (owed, held) = c.solvency().await;
    println!("{} players, Court {} USDC, solvent: {} ({:.0?})", players.len(), num(&state["court"]["total"]) / USDC, owed == held, started.elapsed());

    for id in &a.fund {
        Transaction::construct(relayer.clone(), id.clone())
            .add_action(Action::Transfer(TransferAction { deposit: NearToken::from_near(1) }))
            .with_signer(c.signer.clone())
            .send_to(&c.net)
            .await
            .expect("transfer sent")
            .assert_success();
        c.send(
            &relayer,
            &c.usdc,
            &[("storage_deposit", json!({ "account_id": id }), 10, NearToken::from_millinear(10)), ("mint", json!({ "account_id": id, "amount": WALLET.to_string() }), 10, NearToken::from_yoctonear(0))],
        )
        .await;
        println!("funded {id}: 1 NEAR and {} tUSDC", WALLET / USDC);
    }

    let dir = out_dir();
    std::fs::create_dir_all(dir.join("credentials")).unwrap();
    for id in [&relayer, &keeper] {
        let key = json!({ "account_id": id, "public_key": DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY, "private_key": DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY });
        std::fs::write(dir.join("credentials").join(format!("{id}.json")), key.to_string()).unwrap();
    }
    let manifest = json!({
        "rpc": c.net.rpc_endpoints[0].url.to_string(),
        "usdc": c.usdc,
        "rugpool": c.pool,
        "relayer": relayer,
        "keeper": keeper,
        "players": players,
        "funded": a.fund,
        "player_key": DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY,
    });
    std::fs::write(dir.join("localnet.json"), near_sdk::serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    println!("wrote {}", dir.canonicalize().unwrap().join("localnet.json").display());

    if a.draw {
        // Six players move $20 to their game balance and take turns on the throne: each ticket
        // sends 7.5% of its price to the draw pot. Each call waits for its result, so the next
        // lands well past the one-block buy lock.
        let fighters = &players[..6.min(players.len())];
        for p in fighters {
            c.send(p, &c.usdc, &[("ft_transfer_call", json!({ "receiver_id": c.pool, "amount": (20 * USDC).to_string(), "msg": "" }), 100, NearToken::from_yoctonear(1))]).await;
        }
        for (i, p) in fighters.iter().cycle().take(12).enumerate() {
            let price = c.view(&c.pool, "get_state", json!({})).await["round"]["next_price"].clone();
            let r = c.send(p, &c.pool, &[("challenge", json!({ "max_price": price }), 100, NearToken::from_yoctonear(0))]).await;
            if i == 0 {
                println!("challenge: {:.1} Tgas", r.total_gas_burnt.as_gas() as f64 / 1e12);
            }
        }
        let state = c.view(&c.pool, "get_state", json!({})).await;
        println!("war: 12 challenges by {} players, King {}, draw pot {} micro-USDC", fighters.len(), state["round"]["king"], num(&state["court"]["draw_pot"]));
        // The draw comes due a minute after deploy; funding usually takes longer.
        let due = c.view(&c.pool, "get_state", json!({})).await["court"]["next_draw_at"].as_u64().unwrap();
        loop {
            let block = near_api::Chain::block().fetch_from(&c.net).await.expect("block");
            if block.header.timestamp_nanosec.parse::<u64>().expect("block time") / 1_000_000 >= due {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        let close = c.send(&keeper, &c.pool, &[("close_draw", json!({}), 300, NearToken::from_yoctonear(0))]).await;
        let pending = c.view(&c.pool, "get_state", json!({})).await["court"]["pending_draw"].clone();
        println!("close_draw over {} depositors: {:.1} Tgas", players.len(), close.total_gas_burnt.as_gas() as f64 / 1e12);
        let Some(round) = pending["round"].as_u64() else { panic!("no draw pending: the pot rolled over (under draw_min)") };
        println!("drand round {round}, pot {} micro-USDC", num(&pending["pot"]));
        let signature = drand_signature(round).await;
        let finalize = c.send(&keeper, &c.pool, &[("finalize_draw", json!({ "signature": signature }), 100, NearToken::from_yoctonear(0))]).await;
        let won = finalize.logs().into_iter().find(|l| l.contains("draw_won")).unwrap_or("(no draw_won log)").to_string();
        let (owed, held) = c.solvency().await;
        println!("finalize_draw: {:.1} Tgas; {won}", finalize.total_gas_burnt.as_gas() as f64 / 1e12);
        println!("solvent after the draw: {} ({owed} owed, {held} held)", owed == held);
    }

    if a.exit {
        return;
    }
    println!("localnet up on {}. Ctrl-C to stop.", c.net.rpc_endpoints[0].url);
    if a.bots {
        tokio::spawn(bots(c.clone(), keeper.clone(), players.clone()));
    }
    tokio::signal::ctrl_c().await.expect("ctrl-c");
}
