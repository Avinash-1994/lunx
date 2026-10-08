"""Walk-forward validation: the only backtest number worth believing.

For each test year Y, parameters are chosen using ONLY data before Y, then traded
through Y. The stitched test-year results are what the strategy would have earned
had you run this exact process live. We also run every parameter combination over
the whole test period: if only a few of them make money, the "edge" is luck.
"""
from __future__ import annotations

import itertools

import numpy as np
import pandas as pd

from . import backtest
from .metrics import result_stats, stats
from .strategies import REGISTRY

GRIDS = {
    "momentum": {"lookback": [63, 126, 252], "top_n": [2, 3, 4], "regime_ma": [100, 200]},
    "smooth_momentum": {"lookback": [126, 252], "top_n": [2, 3, 4], "candidates": [6, 10], "regime_ma": [100, 200]},
    "meanrev": {"entry": [5, 10, 20], "max_positions": [1, 2, 3], "exit_ma": [3, 5]},
    "trend": {"ma": [50, 100, 150, 200], "band": [0.0, 0.03], "target_vol": [0.4, 0.8]},
    "onchain_trend": {"ma": [50, 100, 200], "hot": [0.85, 0.95], "cold": [0.0, 0.1], "flow_z": [None, 2.0]},
    "rotation": {"lookback": [14, 30, 60], "top_k": [1, 2, 3], "ma": [20, 50]},
    "ml": {"horizon": [5, 20], "threshold": [0.5, 0.55, 0.6]},
}


def expand(space: dict[str, list]) -> list[dict]:
    keys = list(space)
    return [dict(zip(keys, vals)) for vals in itertools.product(*(space[k] for k in keys))]


def walk_forward(panel, strategy: str, costs, capital: float, test_start: str, fixed: dict | None = None,
                 space: dict | None = None, min_trade_frac: float = 0.05, warmup_bars: int = 300,
                 benchmark: str | None = None, verbose: bool = True) -> dict:
    fn = REGISTRY[strategy]
    fixed = fixed or {}
    configs = expand(space or GRIDS[strategy])
    # Strategies are causal (tested), so weights computed once on the full panel are
    # identical to what each fold would have computed on its own truncated data.
    weights = [fn(panel, capital, **fixed, **cfg) for cfg in configs]
    dates = panel.dates
    train_start = dates[min(warmup_bars, len(dates) - 1)]
    years = sorted(set(dates[dates >= pd.Timestamp(test_start)].year))

    parts, chosen, cap, fees, n_trades = [], [], float(capital), 0.0, 0
    for y in years:
        y0, y1 = pd.Timestamp(f"{y}-01-01"), pd.Timestamp(f"{y}-12-31")
        scores = []
        for w in weights:
            r = backtest.run(panel, w, costs, capital, start=train_start, end=y0 - pd.Timedelta(days=1),
                             min_trade_frac=min_trade_frac)
            s = result_stats(r)["sharpe"]
            scores.append(s if np.isfinite(s) else -9)
        best = int(np.argmax(scores))
        r = backtest.run(panel, weights[best], costs, cap, start=y0, end=y1, min_trade_frac=min_trade_frac,
                         liquidate_at_end=y1 < dates[-1])
        parts.append(r.equity)
        fees += r.fees
        n_trades += len(r.trades)
        year_ret = r.equity.iloc[-1] / cap - 1
        cap = float(r.equity.iloc[-1])
        chosen.append({"year": y, "params": configs[best], "train_sharpe": scores[best],
                       "test_return_%": round(100 * year_ret, 1)})
        if verbose:
            print(f"  {y}: picked {configs[best]} (train sharpe {scores[best]:.2f}) -> {100 * year_ret:+.1f}%")

    oos = pd.concat(parts)
    oos_stats = stats(oos, panel.periods_per_year, capital, fees, n_trades, costs.tax_rate_on_gains)

    grid_rows = []
    for cfg, w in zip(configs, weights):
        st = result_stats(backtest.run(panel, w, costs, capital, start=test_start, min_trade_frac=min_trade_frac))
        grid_rows.append({**cfg, **{k: st[k] for k in ("CAGR_%", "sharpe", "max_drawdown_%", "trades")}})
    grid = pd.DataFrame(grid_rows)

    bench_stats = None
    if benchmark:
        bw = REGISTRY["buyhold"](panel, capital, symbol=benchmark)
        bench_stats = result_stats(backtest.run(panel, bw, costs, capital, start=test_start))

    return {"oos_equity": oos, "oos_stats": oos_stats, "chosen": chosen, "grid": grid, "benchmark": bench_stats}
