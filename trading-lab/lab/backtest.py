"""Daily portfolio backtester.

Rules that keep it honest:
  * A strategy decides at the CLOSE of day t using data up to t only.
  * Orders fill at the OPEN of day t+1, with slippage and full charges.
  * Whole shares only for NSE (you can't buy 0.3 of a Rs 12,000 share).
  * Cash can never go negative: no leverage, no shorting.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .data import Panel


@dataclass
class Result:
    equity: pd.Series
    trades: pd.DataFrame
    holdings: dict[str, float]
    cash: float
    initial_capital: float
    periods_per_year: int
    tax_rate: float
    pending_orders: list[dict] = field(default_factory=list)

    @property
    def fees(self) -> float:
        return float(self.trades["fee"].sum() + self.trades["slippage"].sum()) if len(self.trades) else 0.0


def run(panel: Panel, weights: pd.DataFrame, costs, capital: float, start=None, end=None,
        min_trade_frac: float = 0.0, liquidate_at_end: bool = False) -> Result:
    """Simulate trading `weights` (rows = decision dates, values = target fraction of equity).

    A row present on date t is the full target portfolio decided at t's close; it
    fills at the next bar's open. On the first bar of the window, the latest
    decision made before it is applied, so a window can start mid-month.

    min_trade_frac: skip resizing trades smaller than this fraction of equity
    (entries and full exits always go through). Saves fees on tiny rebalances.
    """
    dates = panel.dates
    mask = np.ones(len(dates), dtype=bool)
    if start is not None:
        mask &= dates >= pd.Timestamp(start)
    if end is not None:
        mask &= dates <= pd.Timestamp(end)
    win_pos = np.nonzero(mask)[0]
    if len(win_pos) == 0:
        raise ValueError("empty backtest window")

    symbols = list(weights.columns)
    opens_df = panel.open.reindex(columns=symbols)
    closes_ff_df = panel.close.reindex(columns=symbols).ffill()
    O = opens_df.to_numpy(dtype=float)
    Cff = closes_ff_df.to_numpy(dtype=float)
    # for valuing/selling symbols whose prices stopped (delisted, demerged): last known price
    Off = opens_df.fillna(closes_ff_df.shift(1)).ffill().to_numpy(dtype=float)

    w = weights[~weights.index.duplicated(keep="last")].sort_index()
    has_dec = dates.isin(w.index)
    W = w.reindex(dates).fillna(0.0).to_numpy(dtype=float)

    shares = np.zeros(len(symbols))
    cash = float(capital)
    buy_fee_rate = costs.fee("buy", 1e6) / 1e6
    trades: list[dict] = []
    equity = np.empty(len(win_pos))

    for n, p in enumerate(win_pos):
        q = None
        if n == 0:
            prior = np.nonzero(has_dec[:p])[0]
            q = prior[-1] if len(prior) else None
        elif has_dec[p - 1]:
            q = p - 1
        if q is not None:
            cash = _rebalance(dates[p], W[q], symbols, shares, cash, O[p], Off[p], costs, buy_fee_rate,
                              min_trade_frac, trades)
        equity[n] = cash + float(np.nansum(shares * Cff[p]))

    win_dates = dates[win_pos]
    equity = pd.Series(equity, index=win_dates, name="equity")

    last = win_pos[-1]
    pending: list[dict] = []
    if last == len(dates) - 1 and has_dec[last]:
        pending = _pending_orders(W[last], symbols, shares, cash, Cff[last], costs, min_trade_frac)

    if liquidate_at_end:
        for k in np.nonzero(shares)[0]:
            cash += _sell(dates[last], symbols[k], shares[k], Cff[last][k], costs, trades)
            shares[k] = 0.0
        equity.iloc[-1] = cash

    trades_df = pd.DataFrame(trades, columns=["date", "symbol", "side", "qty", "price", "notional", "fee", "slippage"])
    holdings = {symbols[k]: float(shares[k]) for k in np.nonzero(shares)[0]}
    return Result(equity, trades_df, holdings, cash, float(capital), panel.periods_per_year,
                  costs.tax_rate_on_gains, pending)


def _qty(value: float, price: float, fractional: bool) -> float:
    q = value / price
    return math.floor(q * 1e6) / 1e6 if fractional else float(math.floor(q))


def _sell(d, sym, qty, ref_price, costs, trades) -> float:
    px = ref_price * (1 - costs.slippage)
    notional = qty * px
    fee = costs.fee("sell", notional)
    trades.append(dict(date=d, symbol=sym, side="sell", qty=qty, price=px, notional=notional, fee=fee,
                       slippage=qty * ref_price * costs.slippage))
    return notional - fee


def _rebalance(d, target, symbols, shares, cash, open_px, open_ff, costs, buy_fee_rate,
               min_trade_frac, trades) -> float:
    held_val = np.nan_to_num(shares * open_ff)
    eq = cash + held_val.sum()
    delta = target * eq - held_val

    # sells first, to free cash
    for k in np.argsort(delta):
        if delta[k] >= 0 or shares[k] <= 0:
            continue
        full_exit = target[k] <= 0
        if not full_exit and -delta[k] < min_trade_frac * eq:
            continue
        px = open_ff[k]
        if not np.isfinite(px) or px <= 0:
            continue
        qty = shares[k] if full_exit else min(shares[k], _qty(-delta[k], px, costs.fractional))
        if qty <= 0:
            continue
        cash += _sell(d, symbols[k], qty, px, costs, trades)
        shares[k] -= qty

    # buys, biggest first, never spending more cash than we have
    for k in np.argsort(-delta):
        if delta[k] <= 0:
            continue
        entry = shares[k] <= 0
        if not entry and delta[k] < min_trade_frac * eq:
            continue
        ref = open_px[k]
        if not np.isfinite(ref) or ref <= 0:
            continue  # no live price today (suspended / not yet listed)
        px = ref * (1 + costs.slippage)
        budget = min(delta[k], cash / (1 + buy_fee_rate) - 0.01)
        qty = _qty(budget, px, costs.fractional)
        if qty <= 0:
            continue
        notional = qty * px
        fee = costs.fee("buy", notional)
        if notional + fee > cash:
            continue
        cash -= notional + fee
        shares[k] += qty
        trades.append(dict(date=d, symbol=symbols[k], side="buy", qty=qty, price=px, notional=notional, fee=fee,
                           slippage=qty * ref * costs.slippage))
    return cash


def _pending_orders(target, symbols, shares, cash, close_px, costs, min_trade_frac) -> list[dict]:
    """Orders to place at the next open, estimated from the latest close."""
    held_val = np.nan_to_num(shares * close_px)
    eq = cash + held_val.sum()
    orders = []
    for k, sym in enumerate(symbols):
        px = close_px[k]
        if not np.isfinite(px) or px <= 0:
            continue
        delta = target[k] * eq - held_val[k]
        if target[k] <= 0 and shares[k] > 0:
            orders.append(dict(symbol=sym, side="SELL", qty=shares[k], approx_price=px))
        elif delta > 0 and (shares[k] <= 0 or delta >= min_trade_frac * eq):
            qty = _qty(delta / (1 + costs.slippage + 0.002), px, costs.fractional)
            if qty > 0:
                orders.append(dict(symbol=sym, side="BUY", qty=qty, approx_price=px))
        elif delta < 0 and -delta >= min_trade_frac * eq:
            qty = min(shares[k], _qty(-delta, px, costs.fractional))
            if qty > 0:
                orders.append(dict(symbol=sym, side="SELL", qty=qty, approx_price=px))
    return orders
