"""Performance statistics."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .backtest import Result


def stats(equity: pd.Series, periods_per_year: int, initial_capital: float | None = None,
          fees: float = 0.0, n_trades: int = 0, tax_rate: float = 0.0) -> dict:
    eq = equity.dropna()
    start = initial_capital if initial_capital is not None else float(eq.iloc[0])
    rets = eq.pct_change().dropna()
    if initial_capital is not None and len(eq):
        rets = pd.concat([pd.Series([eq.iloc[0] / start - 1], index=eq.index[:1]), rets])
    years = max(len(eq) / periods_per_year, 1e-9)
    total = eq.iloc[-1] / start - 1
    cagr = (eq.iloc[-1] / start) ** (1 / years) - 1 if eq.iloc[-1] > 0 else -1.0
    vol = rets.std() * np.sqrt(periods_per_year)
    sharpe = rets.mean() / rets.std() * np.sqrt(periods_per_year) if rets.std() > 0 else 0.0
    peak = np.maximum.accumulate(np.r_[start, eq.to_numpy()])
    dd = (np.r_[start, eq.to_numpy()] / peak - 1).min()
    profit = eq.iloc[-1] - start
    after_tax = start + (profit * (1 - tax_rate) if profit > 0 else profit)
    return {
        "start_capital": round(start, 2),
        "end_equity": round(float(eq.iloc[-1]), 2),
        "total_return_%": round(100 * total, 1),
        "CAGR_%": round(100 * cagr, 1),
        "after_tax_end_equity": round(float(after_tax), 2),
        "volatility_%": round(100 * vol, 1),
        "sharpe": round(float(sharpe), 2),
        "max_drawdown_%": round(100 * dd, 1),
        "trades": int(n_trades),
        "costs_paid": round(float(fees), 2),
        "years": round(years, 2),
    }


def result_stats(res: Result) -> dict:
    return stats(res.equity, res.periods_per_year, res.initial_capital, res.fees, len(res.trades), res.tax_rate)
