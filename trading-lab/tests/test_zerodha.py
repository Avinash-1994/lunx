from datetime import datetime

import pytest

from lab import zerodha
from lab.zerodha import IST, plan_orders, target_quantities, tick_round


class FakeKite:
    def __init__(self, holdings, positions=(), cash=5000.0):
        self._holdings, self._positions, self._cash = holdings, list(positions), cash
        self.placed = []

    def holdings(self):
        return self._holdings

    def positions(self):
        return {"net": self._positions, "day": []}

    def margins(self, segment):
        return {"net": self._cash}

    def place_order(self, **kw):
        self.placed.append(kw)
        return f"id{len(self.placed)}"


def test_snapshot_counts_settled_unsettled_and_todays_trades():
    kite = FakeKite(
        holdings=[{"tradingsymbol": "ITC", "exchange": "NSE", "quantity": 5, "t1_quantity": 2},
                  {"tradingsymbol": "TCS", "exchange": "NSE", "quantity": 1, "t1_quantity": 0}],
        positions=[{"tradingsymbol": "TCS", "product": "CNC", "quantity": -1},     # sold today
                   {"tradingsymbol": "SBIN", "product": "CNC", "quantity": 3},     # bought today
                   {"tradingsymbol": "NIFTY", "product": "NRML", "quantity": 50}],  # F&O ignored
        cash=1234.5)
    qty, cash = zerodha.account_snapshot(kite)
    assert qty == {"ITC": 7, "SBIN": 3} and cash == 1234.5


def test_target_applies_pending_orders():
    t = target_quantities({"ITC": 10, "SBIN": 4}, [{"symbol": "SBIN", "side": "SELL", "qty": 4},
                                                   {"symbol": "INFY", "side": "BUY", "qty": 2}])
    assert t == {"ITC": 10, "INFY": 2}


def test_plan_never_touches_unmanaged_holdings_and_respects_cash():
    real = {"ITC": 10, "RELIANCE": 50}  # RELIANCE is the user's own long-term holding
    target = {"ITC": 4, "INFY": 3, "SBIN": 5}
    managed = {"ITC", "INFY", "SBIN"}
    prices = {"ITC": 400.0, "INFY": 1500.0, "SBIN": 800.0, "RELIANCE": 1400.0}
    orders, warnings = plan_orders(target, real, managed, prices, cash=2000.0)
    by = {(o["side"], o["symbol"]): o for o in orders}
    assert ("SELL", "ITC") in by and by[("SELL", "ITC")]["qty"] == 6
    assert not any(o["symbol"] == "RELIANCE" for o in orders)
    spend = sum(o["qty"] * o["price"] for o in orders if o["side"] == "BUY")
    assert spend <= 2000 + 6 * by[("SELL", "ITC")]["price"]
    assert warnings  # not enough cash for everything


def test_limit_prices_are_on_valid_ticks():
    assert tick_round(123.456) == 123.45
    assert tick_round(1234.567) == 1234.6
    assert tick_round(7777.3) == 7777.5


def test_orders_go_as_amo_outside_market_hours():
    kite = FakeKite([])
    order = [{"symbol": "ITC", "side": "BUY", "qty": 1, "price": 400.0}]
    zerodha.place(kite, order, now=datetime(2026, 10, 9, 20, 0, tzinfo=IST))
    zerodha.place(kite, order, now=datetime(2026, 10, 9, 10, 0, tzinfo=IST))
    assert [p["variety"] for p in kite.placed] == ["amo", "regular"]
    assert all(p["product"] == "CNC" and p["order_type"] == "LIMIT" for p in kite.placed)


def test_missing_credentials_explain_what_to_do(tmp_path, monkeypatch):
    monkeypatch.delenv("KITE_API_KEY", raising=False)
    monkeypatch.delenv("KITE_API_SECRET", raising=False)
    with pytest.raises(SystemExit, match="KITE_API_KEY"):
        zerodha.read_env(tmp_path / ".env")


def test_stale_data_detection():
    import pandas as pd

    import run
    from lab.data import synthetic_panel
    p = synthetic_panel(n_symbols=1, n_days=30, seed=0, benchmark=None)  # ends Feb 2015
    three_days_later = p.dates[-1] + pd.Timedelta(days=3)
    assert run.is_stale("nse-official", p)
    assert not run.is_stale("nse-official", p, today=three_days_later)
    assert run.is_stale("binance", p, today=three_days_later)
