import numpy as np
import pandas as pd
import pytest

from lab import backtest
from lab.costs import CryptoSpotCosts, NseDeliveryCosts, ZeroCosts
from lab.data import Panel, synthetic_panel
from lab.metrics import result_stats
from lab.strategies import REGISTRY


@pytest.fixture(scope="module")
def eq_panel():
    return synthetic_panel(n_symbols=20, n_days=700, seed=1, trend_strength=0.002)


@pytest.fixture(scope="module")
def crypto_panel():
    p = synthetic_panel(n_symbols=3, n_days=900, seed=2, trend_strength=0.003, periods_per_year=365,
                        start_price=(10, 1000))
    rng = np.random.default_rng(3)
    p.extra["mvrv"] = pd.DataFrame(rng.uniform(0.5, 4, p.close.shape), index=p.dates, columns=p.symbols)
    p.extra["flow_in"] = pd.DataFrame(rng.uniform(0, 100, p.close.shape), index=p.dates, columns=p.symbols)
    p.extra["flow_out"] = pd.DataFrame(rng.uniform(0, 100, p.close.shape), index=p.dates, columns=p.symbols)
    return p


EQUITY_CASES = [
    ("momentum", dict(benchmark="BENCH", lookback=63, regime_ma=50)),
    ("smooth_momentum", dict(benchmark="BENCH", lookback=63, regime_ma=50)),
    ("meanrev", dict(benchmark="BENCH", trend_ma=50)),
    ("ml", dict(benchmark="BENCH", top_n=3, horizon=21, min_train=2000, model="logit")),
]
CRYPTO_CASES = [
    ("trend", dict(assets=["S00", "S01"], ma=50)),
    ("onchain_trend", dict(assets=["S00", "S01"], ma=50, flow_z=1.0)),
    ("rotation", dict(assets=["S00", "S01", "S02"], regime_asset="BENCH", regime_ma=50)),
    ("ml", dict(assets=["S00", "S01", "S02"], horizon=5, min_train=300)),
]


# ---------------------------------------------------------------- costs

def test_nse_delivery_costs_match_hand_calculation():
    c = NseDeliveryCosts()
    # buy Rs 10,000: STT 10 + stamp 1.5 + exchange 0.297 + SEBI 0.01 + GST on (0.307) 0.055
    assert c.fee("buy", 10_000) == pytest.approx(11.862, abs=0.01)
    # sell Rs 10,000: STT 10 + exchange + SEBI + GST + flat DP 15.34
    assert c.fee("sell", 10_000) == pytest.approx(25.70, abs=0.01)
    # the flat DP charge makes small sells very expensive in % terms
    assert c.fee("sell", 2_000) / 2_000 > 0.008


def test_crypto_costs():
    assert CryptoSpotCosts().fee("buy", 1000) == pytest.approx(1.0)


# ---------------------------------------------------------------- backtester

def test_buy_and_hold_without_costs_tracks_price():
    p = synthetic_panel(n_symbols=1, n_days=300, seed=5, benchmark=None)
    w = REGISTRY["buyhold"](p, 1e6, symbol="S00")
    res = backtest.run(p, w, ZeroCosts(), 1e6)
    # fills at the second bar's open (decision at first close), fractional shares, no fees
    expected = 1e6 * p.close["S00"].iloc[-1] / p.open["S00"].iloc[1]
    assert res.equity.iloc[-1] == pytest.approx(expected, rel=1e-4)


def test_whole_shares_and_cash_never_negative(eq_panel):
    w = REGISTRY["momentum"](eq_panel, 10_000, benchmark="BENCH", lookback=63, regime_ma=50)
    res = backtest.run(eq_panel, w, NseDeliveryCosts(), 10_000)
    assert res.cash >= 0
    assert len(res.trades) > 0
    assert (res.trades["qty"] == res.trades["qty"].round()).all()


def test_unaffordable_stock_is_never_bought():
    p = synthetic_panel(n_symbols=1, n_days=50, seed=1, start_price=(50_000, 50_001), benchmark=None)
    w = REGISTRY["buyhold"](p, 10_000, symbol="S00")
    res = backtest.run(p, w, NseDeliveryCosts(), 10_000)
    assert len(res.trades) == 0 and res.equity.iloc[-1] == 10_000


def test_orders_fill_next_open_not_same_close():
    p = synthetic_panel(n_symbols=1, n_days=10, seed=1, benchmark=None)
    w = pd.DataFrame({"S00": [1.0]}, index=[p.dates[3]])
    res = backtest.run(p, w, ZeroCosts(), 1000)
    assert res.trades["date"].iloc[0] == p.dates[4]
    assert res.trades["price"].iloc[0] == pytest.approx(p.open["S00"].iloc[4])


def test_pending_orders_reported_for_latest_decision():
    p = synthetic_panel(n_symbols=1, n_days=10, seed=1, benchmark=None)
    w = pd.DataFrame({"S00": [1.0]}, index=[p.dates[-1]])
    res = backtest.run(p, w, CryptoSpotCosts(), 1000)
    assert len(res.trades) == 0
    assert res.pending_orders and res.pending_orders[0]["side"] == "BUY"


def test_costs_always_reduce_returns():
    for seed in range(5):
        p = synthetic_panel(n_symbols=30, n_days=1000, seed=seed, trend_strength=0.0)
        w = REGISTRY["momentum"](p, 10_000, benchmark="BENCH", lookback=63, regime_ma=0)
        nocost = backtest.run(p, w, ZeroCosts(fractional=False), 10_000).equity.iloc[-1]
        cost = backtest.run(p, w, NseDeliveryCosts(), 10_000).equity.iloc[-1]
        assert cost < nocost


def test_regime_exit_goes_to_cash(eq_panel):
    """A 'go to cash' decision must liquidate holdings, not be silently skipped."""
    w = REGISTRY["momentum"](eq_panel, 10_000, benchmark="BENCH", lookback=63, regime_ma=50)
    cash_rows = w.index[(w == 0).all(axis=1)]
    assert len(cash_rows) > 0
    res = backtest.run(eq_panel, w, NseDeliveryCosts(), 10_000, end=eq_panel.dates[eq_panel.dates.get_loc(cash_rows[-1]) + 1])
    assert res.holdings == {}


def test_momentum_finds_planted_trends():
    p = synthetic_panel(n_symbols=30, n_days=1500, seed=7, trend_strength=0.003, regime_days=250)
    w = REGISTRY["momentum"](p, 1e6, benchmark="BENCH", lookback=63, skip=0, regime_ma=0)
    st = result_stats(backtest.run(p, w, ZeroCosts(), 1e6))
    bench = result_stats(backtest.run(p, REGISTRY["buyhold"](p, 1e6, symbol="BENCH"), ZeroCosts(), 1e6))
    assert st["CAGR_%"] > bench["CAGR_%"]


# ---------------------------------------------------------------- no lookahead

def _assert_causal(panel, name, params, capital=10_000):
    full = REGISTRY[name](panel, capital, **params)
    for cut in (len(panel.dates) // 2, len(panel.dates) - 37):
        d = panel.dates[cut]
        part = REGISTRY[name](panel.upto(d), capital, **params)
        a = full.loc[:d].reindex(columns=part.columns)
        daily = name in ("trend", "onchain_trend") or (name == "ml" and not params.get("top_n"))
        a = a[(a != 0).any(axis=1) | a.index.isin(part.index)] if daily else a
        pd.testing.assert_frame_equal(a.loc[part.index], part, check_freq=False, check_names=False)
        assert set(part.index) == set(full.loc[:d].index) or daily


@pytest.mark.parametrize("name,params", EQUITY_CASES)
def test_equity_strategies_do_not_look_ahead(eq_panel, name, params):
    _assert_causal(eq_panel, name, params)


@pytest.mark.parametrize("name,params", CRYPTO_CASES)
def test_crypto_strategies_do_not_look_ahead(crypto_panel, name, params):
    _assert_causal(crypto_panel, name, params)
