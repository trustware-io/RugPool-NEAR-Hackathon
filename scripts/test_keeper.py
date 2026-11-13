"""What `keeper.py --once` exits with, against a chain that is faked at the JSON-RPC call.

    python3 -m unittest discover -s scripts -p 'test_keeper.py'
"""

import contextlib
import io
import json
import unittest
from typing import Any, Optional
from unittest import mock

import keeper

NOW_MS = 1_000_000
ARGV = ["pool.test", "keeper.test", "--token", "usdc.test", "--rpc", "http://rpc.invalid", "--once"]
QUIET = {"round": {"id": 1, "showdown_ends_at": None, "backstop_at": NOW_MS + 1}}


def chain(fail: Optional[str] = None, state: Any = QUIET, held: str = "100", in_flight: str = "0", payouts: Optional[dict[int, Any]] = None, near: str = str(10**24), fail_payout: Optional[int] = None):
    """A stand-in for `keeper.rpc`. `fail` names the one read that gets no answer, and
    `fail_payout` the one payout id whose lookup gets none."""
    payouts = payouts or {}

    def get_payout(args: dict[str, Any]) -> Any:
        if args["payout_id"] == fail_payout:
            raise RuntimeError("no RPC endpoint answered get_payout")
        return payouts.get(args["payout_id"])

    views = {
        "get_state": lambda args: state,
        "get_liabilities": lambda args: {"balances": str(100 - int(in_flight)), "in_flight": in_flight, "recovery": "0"},
        "ft_balance_of": lambda args: held,
        "get_last_payout_id": lambda args: max(payouts, default=0),
        "get_payout": get_payout,
    }

    def rpc(urls: list[str], method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "block":
            name = "final block" if params == {"finality": "final"} else "latest block"
            result: dict[str, Any] = {"header": {"hash": "H", "timestamp_nanosec": str(NOW_MS * 1_000_000)}}
        elif params["request_type"] == "view_account":
            name = "account"
            result = {"amount": near, "storage_usage": 50_000}
        else:
            name = params["method_name"]
            args = json.loads(keeper.base64.b64decode(params["args_base64"]))
            result = {"result": list(json.dumps(views[name](args)).encode())}
        if name != "get_state" and name != "latest block":
            assert params.get("block_id") == "H" or params == {"finality": "final"}, f"{name} was not read at the pinned block"
        if name == fail:
            raise RuntimeError(f"no RPC endpoint answered {name}")
        return result

    return rpc


def once(**kwargs: Any) -> tuple[int, str]:
    """The exit code and what was printed to stderr."""
    err = io.StringIO()
    with mock.patch.object(keeper, "rpc", chain(**kwargs)), mock.patch.object(keeper, "call", return_value=True) as call, contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
        code = keeper.main(ARGV)
    assert not call.called, "nothing was due, so nothing should be sent"
    return code, err.getvalue()


class Once(unittest.TestCase):
    def test_healthy_is_0(self) -> None:
        self.assertEqual(once(), (0, ""))

    def test_an_alert_is_2(self) -> None:
        code, err = once(held="99")
        self.assertEqual(code, 2)
        self.assertIn("ALERT INSOLVENT: holds 99, owes 100", err)

    def test_any_monitor_read_that_fails_is_3_not_healthy(self) -> None:
        for read in ["final block", "get_liabilities", "ft_balance_of", "account"]:
            with self.subTest(read=read):
                code, err = once(fail=read)
                self.assertEqual(code, 3)
                self.assertIn("health unknown", err)
                self.assertNotIn("ALERT", err)

    def test_a_payout_read_that_fails_is_3(self) -> None:
        old = {"account_id": "b.test", "amount": "20", "kind": "Withdraw", "started_at": 0}
        for read in ["get_last_payout_id", "get_payout"]:
            with self.subTest(read=read):
                code, err = once(fail=read, held="80", in_flight="20", payouts={1: old})
                self.assertEqual(code, 3)
                self.assertIn("payout ages unknown", err)
                self.assertNotIn("ALERT", err)

    def test_an_alert_found_before_a_payout_read_fails_is_kept(self) -> None:
        old = {"account_id": "b.test", "amount": "20", "kind": "Withdraw", "started_at": 0}
        # Owes 100 with 20 in flight, so it must hold at least 80. With 9,999 spare bytes too.
        cases = {"INSOLVENT: holds 79, owes 100 (20 in flight)": {"held": "79"}, "STORAGE LOW": {"held": "80", "near": str(59_999 * keeper.YOCTO_PER_BYTE)}}
        for alert, chain_args in cases.items():
            for read in ["get_last_payout_id", "get_payout"]:
                with self.subTest(alert=alert, read=read):
                    code, err = once(fail=read, in_flight="20", payouts={1: old}, **chain_args)
                    self.assertEqual(code, 2)
                    self.assertIn(f"ALERT {alert}", err)
                    self.assertIn("payout ages unknown", err)

    def test_an_old_payout_found_before_a_later_lookup_fails_is_still_named(self) -> None:
        old = {"account_id": "b.test", "amount": "10", "kind": "Withdraw", "started_at": 0}
        code, err = once(fail_payout=41, held="80", in_flight="20", payouts={42: old, 40: old})
        self.assertEqual(code, 2)
        self.assertIn("PAYOUT STUCK: payout 42 ", err)
        self.assertNotIn("payout 40 ", err)
        self.assertNotIn("UNTRACED", err)
        self.assertIn("payout ages unknown: payout 41", err)

    def test_a_keeper_read_that_fails_is_3_even_if_the_monitor_is_clean(self) -> None:
        for read in ["get_state", "latest block"]:
            with self.subTest(read=read):
                code, err = once(fail=read)
                self.assertEqual(code, 3)
                self.assertNotIn("ALERT", err)

    def test_an_alert_outranks_a_failed_keeper_read(self) -> None:
        self.assertEqual(once(fail="get_state", held="99")[0], 2)

    def test_overlapping_young_payouts_are_not_stuck(self) -> None:
        young = {"account_id": "a.test", "amount": "10", "kind": "Claim", "started_at": NOW_MS - 5_000}
        self.assertEqual(once(held="80", in_flight="20", payouts={41: young, 42: young}), (0, ""))

    def test_one_old_payout_is_named_on_the_first_check_after_a_restart(self) -> None:
        young = {"account_id": "a.test", "amount": "10", "kind": "Claim", "started_at": NOW_MS - 5_000}
        old = {"account_id": "b.test", "amount": "10", "kind": "Withdraw", "started_at": NOW_MS - keeper.PAYOUT_STUCK_MS}
        code, err = once(held="80", in_flight="20", payouts={40: old, 42: young})
        self.assertEqual(code, 2)
        self.assertIn("PAYOUT STUCK: payout 40 (Withdraw, 10 to b.test)", err)
        self.assertEqual(err.count("ALERT"), 1)


if __name__ == "__main__":
    unittest.main()
