"""Zerodha Kite Connect (free "Personal" API): read your holdings and cash, place delivery orders.

The free Personal plan covers orders, holdings and funds but not market data, so
prices come from the tool's own data store (last close), and orders are LIMIT
orders with a small buffer. Unfilled orders simply expire; the next run sees the
real holdings and re-issues whatever is still missing.

How targets are set: the strategy's paper portfolio (started with your configured
capital) says exactly how many shares the bot should own. Orders are the
difference between that and your real holdings of the SAME symbols. Stocks
outside the strategy's universe are never touched.

Credentials live in trading-lab/.env (git-ignored):
    KITE_API_KEY=...
    KITE_API_SECRET=...
Never paste them into a chat or commit them.
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
HERE = Path(__file__).resolve().parent.parent
ENV_FILE = HERE / ".env"
SESSION_FILE = HERE / "data" / "kite_session.json"
ORDER_TAG = "tradinglab"


# --------------------------------------------------------------------------- credentials / session

def read_env(path: Path = ENV_FILE) -> dict:
    env = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("KITE_API_KEY", "KITE_API_SECRET"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    missing = [k for k in ("KITE_API_KEY", "KITE_API_SECRET") if not env.get(k)]
    if missing:
        raise SystemExit(f"Missing {', '.join(missing)}. Create {path} with:\n"
                         "  KITE_API_KEY=your_key\n  KITE_API_SECRET=your_secret\n"
                         "(from https://developers.kite.trade; keep this file private)")
    return env


def _kite(api_key: str):
    try:
        from kiteconnect import KiteConnect
    except ImportError as e:  # pragma: no cover
        raise SystemExit("pip install kiteconnect") from e
    return KiteConnect(api_key=api_key)


def login(request_token: str | None = None, session_file: Path = SESSION_FILE) -> None:
    """Daily login: Zerodha access tokens expire every morning."""
    env = read_env()
    kite = _kite(env["KITE_API_KEY"])
    if not request_token:
        print("1. Open this URL and log in to Zerodha:\n   " + kite.login_url())
        print("2. You will be redirected to your app's redirect URL. Copy the value of "
              "'request_token' from the address bar.")
        request_token = input("request_token: ").strip()
    data = kite.generate_session(request_token, api_secret=env["KITE_API_SECRET"])
    session_file.parent.mkdir(parents=True, exist_ok=True)
    session_file.write_text(json.dumps({"access_token": data["access_token"],
                                        "date": datetime.now(IST).date().isoformat()}))
    try:
        session_file.chmod(0o600)
    except OSError:
        pass
    print(f"Logged in as {data.get('user_name') or data.get('user_id')}. Session valid until tomorrow morning.")


def client(session_file: Path = SESSION_FILE):
    env = read_env()
    if not session_file.exists():
        raise SystemExit("Not logged in. Run: python run.py zerodha-login")
    sess = json.loads(session_file.read_text())
    if sess.get("date") != datetime.now(IST).date().isoformat():
        raise SystemExit("Zerodha session expired (they last one day). Run: python run.py zerodha-login")
    kite = _kite(env["KITE_API_KEY"])
    kite.set_access_token(sess["access_token"])
    return kite


# --------------------------------------------------------------------------- account

def account_snapshot(kite) -> tuple[dict[str, int], float]:
    """Real delivery holdings {symbol: qty} (incl. unsettled T1 and today's trades) and free cash."""
    qty: dict[str, int] = {}
    for h in kite.holdings():
        if h.get("exchange", "NSE") in ("NSE", "BSE"):
            sym = h["tradingsymbol"]
            qty[sym] = qty.get(sym, 0) + int(h.get("quantity", 0)) + int(h.get("t1_quantity", 0))
    for p in kite.positions().get("net", []):
        if p.get("product") == "CNC":
            sym = p["tradingsymbol"]
            qty[sym] = qty.get(sym, 0) + int(p.get("quantity", 0))
    cash = float(kite.margins("equity")["net"])
    return {s: q for s, q in qty.items() if q}, cash


# --------------------------------------------------------------------------- orders

def tick_round(price: float) -> float:
    """Round to a price step that is a multiple of NSE's tick size in every price band."""
    step = 0.05 if price < 1000 else 0.10 if price < 5000 else 0.50 if price < 10000 else 1.0 if price < 20000 else 5.0
    return round(round(price / step) * step, 2)


def target_quantities(paper_holdings: dict[str, float], pending: list[dict]) -> dict[str, int]:
    """Shares the bot should own after the paper portfolio's next orders fill."""
    target = {s: int(q) for s, q in paper_holdings.items()}
    for o in pending:
        sign = 1 if o["side"] == "BUY" else -1
        target[o["symbol"]] = target.get(o["symbol"], 0) + sign * int(o["qty"])
    return {s: q for s, q in target.items() if q > 0}


def plan_orders(target: dict[str, int], real: dict[str, int], managed: set[str], prices: dict[str, float],
                cash: float, buffer: float = 0.01, max_order_value: float | None = None) -> tuple[list[dict], list[str]]:
    """Orders that move real holdings of `managed` symbols to `target`. Returns (orders, warnings)."""
    orders, warnings = [], []
    for sym in sorted(managed):
        diff = target.get(sym, 0) - real.get(sym, 0)
        if diff >= 0 or sym not in prices:
            continue
        orders.append({"symbol": sym, "side": "SELL", "qty": -diff, "price": tick_round(prices[sym] * (1 - buffer))})
    budget = cash + sum(o["qty"] * o["price"] for o in orders) * 0.998  # sells settle into buying power
    for sym in sorted(managed, key=lambda s: -(target.get(s, 0) - real.get(s, 0)) * prices.get(s, 0)):
        diff = target.get(sym, 0) - real.get(sym, 0)
        if diff <= 0:
            continue
        if sym not in prices:
            warnings.append(f"{sym}: no recent price, skipped")
            continue
        px = tick_round(prices[sym] * (1 + buffer))
        qty = diff
        if max_order_value and qty * px > max_order_value:
            qty = math.floor(max_order_value / px)
            warnings.append(f"{sym}: capped at {qty} shares by the per-order limit")
        if qty * px * 1.002 > budget:
            qty = math.floor(budget / (px * 1.002))
            warnings.append(f"{sym}: only enough cash for {qty} of {diff} shares")
        if qty > 0:
            orders.append({"symbol": sym, "side": "BUY", "qty": qty, "price": px})
            budget -= qty * px * 1.002
    return orders, warnings


def market_open_now(now: datetime | None = None) -> bool:
    now = now or datetime.now(IST)
    return now.weekday() < 5 and dtime(9, 15) <= now.time() <= dtime(15, 30)


def place(kite, orders: list[dict], now: datetime | None = None) -> list[str]:
    """Send LIMIT delivery orders; outside market hours they go as after-market orders (AMO)."""
    variety = "regular" if market_open_now(now) else "amo"
    results = []
    for o in orders:
        try:
            oid = kite.place_order(variety=variety, exchange="NSE", tradingsymbol=o["symbol"],
                                   transaction_type=o["side"], quantity=int(o["qty"]), product="CNC",
                                   order_type="LIMIT", price=o["price"], validity="DAY", tag=ORDER_TAG)
            results.append(f"OK   {o['side']:<4} {o['symbol']:<12} {o['qty']} @ {o['price']} ({variety}) id {oid}")
        except Exception as e:
            hint = " (SEBI rules may require API orders from a static IP registered with Zerodha)" \
                if "ip" in str(e).lower() else ""
            results.append(f"FAIL {o['side']:<4} {o['symbol']:<12} {o['qty']}: {e}{hint}")
    return results
