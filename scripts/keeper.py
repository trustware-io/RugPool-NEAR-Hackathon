#!/usr/bin/env python3
"""Keeper and solvency monitor for the RugPool contract.

Keeper: starts the showdown when a round reaches its backstop age or its Jackpot reaches the
size trigger (`poke`), settles the round once the showdown is over (`settle_round`), closes
the weekly draw when it's due (`close_draw`) and pays it once drand publishes the round it
named (`finalize_draw`, with that round's signature), so rounds and draws happen with no
player present.

It keeps no state worth losing. Every check reads the contract and decides again, and the
contract refuses each call unless it is due, so a call that is repeated, sent twice by two
keepers, or sent after a restart does nothing. A call that didn't change what is due is
retried with a growing delay, since every attempt costs gas.

Monitor (with --token): at one final block, compares the USDC the contract holds with what
it owes, and its NEAR with what its storage needs, and prints an ALERT line for each problem.

With --once the exit code says what the check found: 0 nothing wrong, 2 an alert, 3 a read
failed, so the check is incomplete and nothing is known to be wrong or right. A call that was
sent and refused is not a failure: another keeper may have made it first.

Reads over JSON-RPC, falling back between the --rpc endpoints, fetches drand beacons over
HTTPS, and signs with near-cli-rs from the legacy keychain (~/.near-credentials).

    scripts/keeper.py pool2.rugpool-rehearsal-1021.testnet rugpool-rehearsal-1021.testnet \
        --token tusdc.rugpool-rehearsal-1021.testnet
"""

import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.request
from typing import Any, Callable, Optional

# drand quicknet: the beacon `finalize_draw` verifies. Any of these serves the same beacons,
# and the contract checks the signature itself, so a bad mirror can't pick the winner.
QUICKNET = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
DRAND_MIRRORS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"]
QUICKNET_GENESIS_MS = 1_692_803_367_000
QUICKNET_PERIOD_MS = 3_000
# Closing walks every depositor: about 120 Tgas at the 500 cap (sandbox test `draw_gas_per_depositor`).
GAS = {"close_draw": "200 Tgas", "finalize_draw": "50 Tgas"}
# Free public testnet endpoints (docs.near.org/api/rpc/providers, 2026-11-09).
DEFAULT_RPCS = "https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs"
# The protocol's storage price, and the contract's STORAGE_BUFFER_BYTES + ROOT_GROWTH_BYTES:
# the spare storage it wants before it stores anything new.
YOCTO_PER_BYTE = 10**19
STORAGE_BUFFER_BYTES = 2_092
MAX_RETRY_DELAY_S = 300.0
# A payout's callback lands within a few blocks. One still in flight after this long needs
# looking at; the contract lets the owner settle it after an hour.
PAYOUT_STUCK_MS = 600_000
# How many payout ids one check looks through for the ones in flight.
PAYOUT_SCAN_MAX = 200


def rpc(urls: list[str], method: str, params: dict[str, Any]) -> dict[str, Any]:
    """One JSON-RPC call, trying each endpoint in turn. Whichever answers moves to the front."""
    errors = []
    for url in list(urls):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                reply = json.load(res)
        except (OSError, ValueError) as e:
            errors.append(f"{url}: {e!r}")
            continue
        if "error" in reply:
            errors.append(f"{url}: {reply['error']}")
            continue
        urls.remove(url)
        urls.insert(0, url)
        return reply["result"]
    raise RuntimeError(f"no RPC endpoint answered {method}: {errors}")


def chain_now_ms(urls: list[str]) -> int:
    """Timestamp of the latest block: the clock the contract checks against."""
    header = rpc(urls, "block", {"finality": "optimistic"})["header"]
    return int(header["timestamp_nanosec"]) // 1_000_000


def view(urls: list[str], contract: str, method: str, args: dict[str, Any], at: dict[str, Any]) -> Any:
    """A view call at `at`: {"finality": ...} or {"block_id": ...}."""
    result = rpc(urls, "query", {
        "request_type": "call_function",
        "account_id": contract,
        "method_name": method,
        "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        **at,
    })
    return json.loads(bytes(result["result"]))


def get_state(urls: list[str], contract: str) -> dict[str, Any]:
    return view(urls, contract, "get_state", {}, {"finality": "optimistic"})


def due(state: dict[str, Any], now_ms: int) -> Optional[str]:
    """The call the round needs right now, if any.

    >>> due({"round": {"showdown_ends_at": None, "backstop_at": 100}}, 99) is None
    True
    >>> due({"round": {"showdown_ends_at": None, "backstop_at": 100}}, 100)
    'poke'
    >>> due({"round": {"showdown_ends_at": 500, "backstop_at": 100}}, 499) is None
    True
    >>> due({"round": {"showdown_ends_at": 500, "backstop_at": 100}}, 500)
    'settle_round'
    >>> due({"round": {"showdown_ends_at": None, "backstop_at": 900}, "court": {"next_draw_at": 400}}, 450)
    'close_draw'
    >>> pending = {"round": 2, "pot": "5"}
    >>> due({"round": {"showdown_ends_at": None, "backstop_at": 10**15}, "court": {"next_draw_at": 400, "pending_draw": pending}}, QUICKNET_GENESIS_MS + 2_999) is None
    True
    >>> due({"round": {"showdown_ends_at": None, "backstop_at": 10**15}, "court": {"next_draw_at": 400, "pending_draw": pending}}, QUICKNET_GENESIS_MS + 3_000)
    'finalize_draw'

    The Jackpot at the size trigger, with a King and the game live, also needs a poke:

    >>> at_trigger = {"showdown_ends_at": None, "backstop_at": 900, "king": "a.near", "jackpot": "8", "showdown_trigger": "8"}
    >>> due({"round": at_trigger}, 1)
    'poke'
    >>> due({"round": {**at_trigger, "jackpot": "7"}}, 1) is None
    True
    >>> due({"round": {**at_trigger, "king": None}}, 1) is None
    True
    >>> due({"round": at_trigger, "paused": True}, 1) is None
    True
    """
    r = state["round"]
    ends_at = r["showdown_ends_at"]
    if ends_at is None and now_ms >= r["backstop_at"]:
        return "poke"
    at_trigger = r.get("king") and not state.get("paused") and "showdown_trigger" in r and int(r["jackpot"]) >= int(r["showdown_trigger"])
    if ends_at is None and at_trigger:
        return "poke"
    if ends_at is not None and now_ms >= ends_at:
        return "settle_round"
    court = state.get("court", {})
    pending = court.get("pending_draw")
    if pending:
        published_at = QUICKNET_GENESIS_MS + (pending["round"] - 1) * QUICKNET_PERIOD_MS
        return "finalize_draw" if now_ms >= published_at else None
    if now_ms >= court.get("next_draw_at", now_ms + 1):
        return "close_draw"
    return None


def due_key(state: dict[str, Any], method: str) -> str:
    """Names what is due, so a retry of the same thing can be told from the next thing.

    >>> due_key({"round": {"id": 7}}, "settle_round")
    'settle_round:7'
    >>> due_key({"round": {"id": 7}, "court": {"next_draw_at": 400, "pending_draw": {"round": 9}}}, "finalize_draw")
    'finalize_draw:9'
    """
    court = state.get("court", {})
    if method == "finalize_draw":
        return f"{method}:{court['pending_draw']['round']}"
    if method == "close_draw":
        return f"{method}:{court.get('next_draw_at')}"
    return f"{method}:{state['round']['id']}"


class Retry:
    """When the same call may be tried again: after `first` seconds, then twice as long each
    time, up to MAX_RETRY_DELAY_S. A different key starts over.

    >>> r = Retry(5.0)
    >>> r.ready("poke:1", 0.0)
    True
    >>> r.tried("poke:1", 0.0); (r.ready("poke:1", 4.9), r.ready("poke:1", 5.0))
    (False, True)
    >>> r.tried("poke:1", 5.0); (r.ready("poke:1", 14.9), r.ready("poke:1", 15.0))
    (False, True)
    >>> r.ready("settle_round:1", 6.0)
    True
    >>> for t in range(20): r.tried("poke:1", 0.0)
    >>> (r.ready("poke:1", 299.0), r.ready("poke:1", 300.0))
    (False, True)
    """

    def __init__(self, first: float) -> None:
        self.first = first
        self.key: Optional[str] = None
        self.delay = first
        self.next_at = 0.0

    def ready(self, key: str, now: float) -> bool:
        return key != self.key or now >= self.next_at

    def tried(self, key: str, now: float) -> None:
        self.delay = min(self.delay * 2, MAX_RETRY_DELAY_S) if key == self.key else self.first
        self.key = key
        self.next_at = now + self.delay


def health(liabilities: dict[str, str], held: int, near: int, storage_usage: int) -> list[str]:
    """Problems with what the contract holds, read at one block.

    `liabilities` is `get_liabilities()`: everything owed, including payouts in flight. A
    payout in flight may already have left, so the contract may hold up to that much less.

    >>> ok = {"balances": "70", "court": "30", "in_flight": "0", "recovery": "0"}
    >>> health(ok, 100, 10**24, 50_000)
    []
    >>> health(ok, 99, 10**24, 50_000)
    ['INSOLVENT: holds 99, owes 100 (0 in flight)']
    >>> health({**ok, "balances": "50", "in_flight": "20"}, 80, 10**24, 50_000)
    []
    >>> health({**ok, "balances": "50", "in_flight": "20"}, 79, 10**24, 50_000)
    ['INSOLVENT: holds 79, owes 100 (20 in flight)']
    >>> health(ok, 105, 10**24, 50_000)
    ['SURPLUS: holds 5 more than it owes (tokens sent without a deposit call?)']
    >>> health({**ok, "balances": "60", "recovery": "10"}, 100, 10**24, 50_000)
    ['HELD: 10 in recovery for the owner to return']
    >>> health(ok, 100, 51_999 * YOCTO_PER_BYTE, 50_000)
    ['STORAGE: NEAR covers 1999 spare bytes, under the 2092 buffer: deposits, joins and draws are paused, Intents deliveries are held']
    >>> health(ok, 100, 59_999 * YOCTO_PER_BYTE, 50_000)
    ['STORAGE LOW: NEAR covers 9999 spare bytes; top up before it reaches 2092']
    """
    alerts = []
    owed = sum(int(v) for v in liabilities.values())
    in_flight = int(liabilities.get("in_flight", "0"))
    if held < owed - in_flight:
        alerts.append(f"INSOLVENT: holds {held}, owes {owed} ({in_flight} in flight)")
    elif held > owed:
        alerts.append(f"SURPLUS: holds {held - owed} more than it owes (tokens sent without a deposit call?)")
    recovery = int(liabilities.get("recovery", "0"))
    if recovery:
        alerts.append(f"HELD: {recovery} in recovery for the owner to return")
    spare = near // YOCTO_PER_BYTE - storage_usage
    if spare < STORAGE_BUFFER_BYTES:
        alerts.append(f"STORAGE: NEAR covers {spare} spare bytes, under the {STORAGE_BUFFER_BYTES} buffer: deposits, joins and draws are paused, Intents deliveries are held")
    elif spare < 5 * STORAGE_BUFFER_BYTES:
        alerts.append(f"STORAGE LOW: NEAR covers {spare} spare bytes; top up before it reaches {STORAGE_BUFFER_BYTES}")
    return alerts


READ_ERRORS = (OSError, KeyError, ValueError, RuntimeError)


def payouts_in_flight(get: Callable[[int], Optional[dict[str, Any]]], last_id: int, in_flight: int) -> tuple[dict[int, dict[str, Any]], int, Optional[str]]:
    """The payouts still in flight, how much of `in_flight` wasn't traced to one, and the
    error if a read failed part-way. What was found before the failure is still returned.

    The contract keeps a record per payout in flight and drops it when the payout is booked,
    and `in_flight` is the sum of those records. Ids count up, so walking down from the newest
    until the amounts add up finds them all, with nothing remembered between checks: a
    restart, or a check that was missed, changes nothing.

    >>> records = {9: {"amount": "5"}, 7: {"amount": "20"}, 3: {"amount": "1"}}
    >>> payouts_in_flight(records.get, 9, 25)
    ({9: {'amount': '5'}, 7: {'amount': '20'}}, 0, None)
    >>> payouts_in_flight(records.get, 9, 0)
    ({}, 0, None)
    >>> payouts_in_flight(records.get, 9, 30)
    ({9: {'amount': '5'}, 7: {'amount': '20'}, 3: {'amount': '1'}}, 4, None)
    >>> payouts_in_flight({500: {"amount": "5"}, 300: {"amount": "2"}}.get, 500, 7)
    ({500: {'amount': '5'}}, 2, None)

    A read that fails stops the walk but keeps what it had found:

    >>> def flaky(i):
    ...     if i == 8: raise RuntimeError("no answer")
    ...     return records.get(i)
    >>> payouts_in_flight(flaky, 9, 25)
    ({9: {'amount': '5'}}, 20, "payout 8: RuntimeError('no answer')")
    """
    found: dict[int, dict[str, Any]] = {}
    left = in_flight
    for payout_id in range(last_id, max(last_id - PAYOUT_SCAN_MAX, 0), -1):
        if left <= 0:
            break
        try:
            payout = get(payout_id)
            if payout:
                left -= int(payout["amount"])
                found[payout_id] = payout
        except READ_ERRORS as e:
            return found, left, f"payout {payout_id}: {e!r}"
    return found, left, None


def stuck_payouts(payouts: dict[int, dict[str, Any]], untraced: int, now_ms: int) -> list[str]:
    """An alert for each payout in flight for PAYOUT_STUCK_MS, by its own start time.

    Payouts that overlap, each one young, are ordinary traffic however long some payout or
    other has been in flight:

    >>> young = {"account_id": "a.near", "amount": "5", "kind": "Claim", "started_at": 990_000}
    >>> stuck_payouts({8: young, 9: {**young, "started_at": 999_000}}, 0, 1_000_000)
    []

    One old payout among them is named, and only that one:

    >>> old = {"account_id": "b.near", "amount": "20", "kind": "Withdraw", "started_at": 400_000}
    >>> stuck_payouts({7: old, 9: young}, 0, 1_000_000)
    ['PAYOUT STUCK: payout 7 (Withdraw, 20 to b.near) has been in flight for 600s. Check whether its token transfer went through on chain before settling it with resolve_payout']
    >>> stuck_payouts({7: old}, 0, 999_999)
    []

    An amount in flight with no record found is reported as such, not as stuck:

    >>> stuck_payouts({9: young}, 2, 1_000_000)
    ['PAYOUTS UNTRACED: 2 in flight is not in the newest 200 payout records, so its age is unknown']
    """
    alerts = []
    for payout_id, p in sorted(payouts.items()):
        age_ms = now_ms - int(p["started_at"])
        if age_ms >= PAYOUT_STUCK_MS:
            alerts.append(
                f"PAYOUT STUCK: payout {payout_id} ({p['kind']}, {p['amount']} to {p['account_id']}) has been in flight for {age_ms // 1000}s. "
                "Check whether its token transfer went through on chain before settling it with resolve_payout"
            )
    if untraced:
        alerts.append(f"PAYOUTS UNTRACED: {untraced} in flight is not in the newest {PAYOUT_SCAN_MAX} payout records, so its age is unknown")
    return alerts


def read_health(urls: list[str], contract: str, token: str) -> tuple[list[str], Optional[str]]:
    """Every problem found at the latest final block, and the error if the payout records
    couldn't all be read. All reads are at that one block. A failed payout read doesn't
    discard the problems already found; it only leaves the payouts' ages unknown.
    """
    header = rpc(urls, "block", {"finality": "final"})["header"]
    at = {"block_id": header["hash"]}
    liabilities = view(urls, contract, "get_liabilities", {}, at)
    held = int(view(urls, token, "ft_balance_of", {"account_id": contract}, at))
    account = rpc(urls, "query", {"request_type": "view_account", "account_id": contract, **at})
    alerts = health(liabilities, held, int(account["amount"]), int(account["storage_usage"]))
    in_flight = int(liabilities.get("in_flight", "0"))
    if not in_flight:
        return alerts, None
    try:
        last_id = int(view(urls, contract, "get_last_payout_id", {}, at))
    except READ_ERRORS as e:
        return alerts, f"get_last_payout_id: {e!r}"
    payouts, untraced, error = payouts_in_flight(lambda i: view(urls, contract, "get_payout", {"payout_id": i}, at), last_id, in_flight)
    # After a failed read the rest is unread, not untraced.
    alerts += stuck_payouts(payouts, 0 if error else untraced, int(header["timestamp_nanosec"]) // 1_000_000)
    return alerts, error


def drand_signature(round_: int) -> str:
    """Quicknet's signature for `round_`, from the first mirror that has it."""
    errors = []
    for base in DRAND_MIRRORS:
        try:
            with urllib.request.urlopen(f"{base}/{QUICKNET}/public/{round_}", timeout=10) as res:
                beacon = json.load(res)
            if beacon.get("round") == round_:
                return beacon["signature"]
            errors.append(f"{base}: round {beacon.get('round')}")
        except (OSError, ValueError, KeyError) as e:
            errors.append(f"{base}: {e!r}")
    raise RuntimeError(f"no mirror served drand round {round_}: {errors}")


def call(contract: str, signer: str, network: str, method: str, args: dict[str, Any]) -> bool:
    cmd = [
        "near", "contract", "call-function", "as-transaction", contract, method, "json-args", json.dumps(args),
        "prepaid-gas", GAS.get(method, "30 Tgas"), "attached-deposit", "0 NEAR", "sign-as", signer,
        "network-config", network, "sign-with-legacy-keychain", "send",
    ]
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        # It may still land. That's fine: the next check reads the state and decides again.
        return False
    return done.returncode == 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("contract")
    parser.add_argument("signer")
    parser.add_argument("--rpc", default=DEFAULT_RPCS, help="comma-separated RPC endpoints, tried in order")
    parser.add_argument("--network", default="testnet", help="near-cli-rs network-config name to sign and send with")
    parser.add_argument("--token", help="the USDC token account; turns the solvency monitor on")
    parser.add_argument("--every", type=float, default=5.0, help="seconds between checks")
    parser.add_argument("--health-every", type=float, default=60.0, help="seconds between monitor checks")
    parser.add_argument("--once", action="store_true", help="check once and exit")
    args = parser.parse_args(argv)
    urls = [u.strip() for u in args.rpc.split(",") if u.strip()]
    retry = Retry(args.every)
    next_health = 0.0
    alerted = failed = False

    while True:
        now = time.monotonic()
        try:
            state = get_state(urls, args.contract)
            method = due(state, chain_now_ms(urls))
            key = due_key(state, method) if method else None
            if method and key and retry.ready(key, now):
                call_args = {}
                if method == "finalize_draw":
                    call_args = {"signature": drand_signature(state["court"]["pending_draw"]["round"])}
                # A refusal (say another keeper got there first) is harmless; the next check
                # reads fresh state and decides again. If the same call is still due then, it
                # waits longer each time.
                retry.tried(key, now)
                ok = call(args.contract, args.signer, args.network, method, call_args)
                print(f"{time.strftime('%H:%M:%S')} {method}: {'ok' if ok else 'refused or not sent'}; if still due, next try in {retry.delay:.0f}s", flush=True)
        except READ_ERRORS as e:
            # Network trouble, an odd RPC reply or a missing `near` binary: log it and keep going.
            failed = True
            print(f"{time.strftime('%H:%M:%S')} error: {e!r}", file=sys.stderr, flush=True)
        if args.token and now >= next_health:
            next_health = now + args.health_every
            try:
                alerts, error = read_health(urls, args.contract, args.token)
                for alert in alerts:
                    alerted = True
                    print(f"{time.strftime('%H:%M:%S')} ALERT {alert}", file=sys.stderr, flush=True)
                if error:
                    failed = True
                    print(f"{time.strftime('%H:%M:%S')} monitor error, payout ages unknown: {error}", file=sys.stderr, flush=True)
            except READ_ERRORS as e:
                # The contract's health was not measured: that is not the same as healthy.
                failed = True
                print(f"{time.strftime('%H:%M:%S')} monitor error, health unknown: {e!r}", file=sys.stderr, flush=True)
        if args.once:
            return 2 if alerted else 3 if failed else 0
        time.sleep(args.every)


if __name__ == "__main__":
    sys.exit(main())
