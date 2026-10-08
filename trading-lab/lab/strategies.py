"""Strategies.

Each strategy is a function (panel, capital, **params) -> weights DataFrame:
rows are decision dates (decided at that day's close), columns are symbols,
values are target fractions of equity. Every indicator is computed causally
(rolling/expanding windows over past data only); tests/test_no_lookahead.py
proves this by recomputing on truncated data.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data import Panel


# --------------------------------------------------------------------------- helpers

def sma(df, n: int):
    return df.rolling(n, min_periods=n).mean()


def simple_returns(df):
    return df / df.shift(1) - 1


def rsi(close: pd.DataFrame, n: int) -> pd.DataFrame:
    delta = close.diff()
    up = delta.clip(lower=0).rolling(n, min_periods=n).mean()
    dn = (-delta.clip(upper=0)).rolling(n, min_periods=n).mean()
    out = 100 - 100 / (1 + up / dn)
    return out.where(dn > 0, 100.0).where(up.notna())


def period_starts(dates: pd.DatetimeIndex, freq: str) -> pd.DatetimeIndex:
    """First bar of each quarter ('Q'), month ('M') or ISO week ('W'); every bar for 'D'.

    Uses only the previous bar's date, so it never needs to know the future
    (unlike "last trading day of the month").
    """
    if freq == "D":
        return dates
    if freq == "M":
        key = dates.year * 12 + dates.month
    elif freq == "Q":
        key = dates.year * 4 + (dates.month - 1) // 3
    elif freq == "W":
        iso = dates.isocalendar()
        key = (iso["year"] * 100 + iso["week"]).to_numpy()
    else:
        raise ValueError(freq)
    key = np.asarray(key)
    change = np.r_[False, key[1:] != key[:-1]]
    return dates[change]


def hysteresis(enter: pd.DataFrame, exit_: pd.DataFrame) -> pd.DataFrame:
    """1 after an enter signal until an exit signal, else 0 (causal state machine)."""
    state = pd.DataFrame(np.where(enter, 1.0, np.where(exit_, 0.0, np.nan)), index=enter.index, columns=enter.columns)
    return state.ffill().fillna(0.0)


def _tradable(panel: Panel, benchmark: str | None) -> list[str]:
    return [s for s in panel.symbols if s != benchmark]


def _frame(rows: dict, columns: list[str]) -> pd.DataFrame:
    """{date: {symbol: weight}} -> weights frame. Empty dicts become all-zero rows
    ("go to cash"), which DataFrame.from_dict would silently drop."""
    out = pd.DataFrame(0.0, index=pd.DatetimeIndex(list(rows)), columns=columns)
    for d, ws in rows.items():
        for sym, wt in ws.items():
            out.at[d, sym] = wt
    return out.sort_index()


# --------------------------------------------------------------------------- benchmark

def buyhold(panel: Panel, capital: float, symbol: str | None = None) -> pd.DataFrame:
    """Hold one symbol (default: first column), or equal-weight everything if symbol='ALL'."""
    syms = panel.symbols if symbol == "ALL" else [symbol or panel.symbols[0]]
    first = panel.close[syms].first_valid_index()
    return pd.DataFrame({s: [1.0 / len(syms)] for s in syms}, index=[first])


# --------------------------------------------------------------------------- NSE equity

def momentum(panel: Panel, capital: float, lookback: int = 126, skip: int = 5, top_n: int = 3,
             regime_ma: int = 200, benchmark: str | None = "NIFTYBEES", buffer: float = 2.0,
             rebalance: str = "M", smooth: bool = False, candidates: int = 10) -> pd.DataFrame:
    """Cross-sectional momentum: hold the top_n strongest stocks, rebalanced monthly.

    - skip: ignore the most recent days (short-term reversal noise)
    - regime filter: go to cash when the benchmark is below its regime_ma-day average
    - buffer: keep a holding while it stays within top_n*buffer ranks (cuts turnover/fees)
    - affordability: skip stocks whose single share costs more than one slot of capital
    - smooth=True ("frog in the pan", Da-Gurun-Warachka 2014): among the `candidates`
      strongest, prefer stocks that went up through many small steady gains rather than a
      few jumps. Investors under-react to gradual news, so smooth winners tend to persist.
    """
    syms = _tradable(panel, benchmark)
    c = panel.close[syms]
    mom = c.shift(skip) / c.shift(lookback) - 1
    if smooth:
        r = simple_returns(c)
        win = lookback - skip
        pos = (r > 0).astype(float).where(r.notna()).rolling(win, min_periods=win).mean().shift(skip)
        neg = (r < 0).astype(float).where(r.notna()).rolling(win, min_periods=win).mean().shift(skip)
        info_discreteness = np.sign(mom) * (neg - pos)  # lower = smoother path
    if benchmark and regime_ma and benchmark in panel.symbols:
        b = panel.close[benchmark]
        regime_ok = (b > sma(b, regime_ma)).fillna(False)
    else:
        regime_ok = pd.Series(True, index=panel.dates)

    slot = capital / top_n
    rows, held = {}, []
    for d in period_starts(panel.dates, rebalance):
        if not regime_ok.loc[d]:
            held = []
            rows[d] = {}
            continue
        m, px = mom.loc[d], c.loc[d]
        ok = m.notna() & px.notna() & (px <= 0.95 * slot) & (m > 0)
        ranked = m[ok].sort_values(ascending=False)
        if smooth:
            cand = ranked.index[:candidates]
            order = list(info_discreteness.loc[d, cand].dropna().sort_values().index)
            keep_zone = order
        else:
            order = list(ranked.index)
            keep_zone = order[: int(top_n * buffer)]
        keep = [s for s in held if s in keep_zone][:top_n]
        held = keep + [s for s in order if s not in keep][: top_n - len(keep)]
        rows[d] = {s: 1.0 / top_n for s in held}
    return _frame(rows, syms)


def smooth_momentum(panel: Panel, capital: float, **params) -> pd.DataFrame:
    return momentum(panel, capital, smooth=True, **params)


def meanrev(panel: Panel, capital: float, rsi_len: int = 2, entry: float = 10, trend_ma: int = 200,
            exit_ma: int = 5, max_hold: int = 10, max_positions: int = 2,
            benchmark: str | None = "NIFTYBEES") -> pd.DataFrame:
    """Short-term pullback buying: in an uptrend (close > trend_ma), buy when RSI(2) is
    deeply oversold; sell when price closes back above its exit_ma average or after max_hold days.
    High turnover, so at small capital the flat per-sell DP charge is the main enemy.
    """
    syms = _tradable(panel, benchmark)
    c = panel.close[syms]
    C, R, T, X = (a.to_numpy() for a in (c, rsi(c, rsi_len), sma(c, trend_ma), sma(c, exit_ma)))
    slot = capital / max_positions
    held: dict[int, int] = {}
    rows = {}
    for i, d in enumerate(panel.dates):
        changed = False
        for k in list(held):
            if not np.isfinite(C[i, k]) or C[i, k] > X[i, k] or i - held[k] >= max_hold:
                del held[k]
                changed = True
        free = max_positions - len(held)
        if free > 0:
            ok = np.isfinite(R[i]) & (R[i] < entry) & (C[i] > T[i]) & (C[i] <= 0.95 * slot)
            for k in np.nonzero(ok)[0][np.argsort(R[i][ok])]:
                if free == 0:
                    break
                if k not in held:
                    held[k] = i
                    free -= 1
                    changed = True
        if changed:
            rows[d] = {syms[k]: 1.0 / max_positions for k in held}
    return _frame(rows, syms)


# --------------------------------------------------------------------------- crypto

def trend(panel: Panel, capital: float, assets: list[str] | None = None, ma: int = 100, band: float = 0.02,
          vol_len: int = 30, target_vol: float = 0.6) -> pd.DataFrame:
    """Time-series trend following with volatility targeting.

    Long an asset after it closes `band` above its ma-day average, flat after it closes
    `band` below (the band stops whipsawing around the line). Position size shrinks when
    the asset is more volatile than target_vol (annualised), so a calm BTC uptrend gets a
    full slot and a wild altcoin gets less.
    """
    assets = assets or panel.symbols
    c = panel.close[assets]
    m = sma(c, ma)
    on = hysteresis(c > m * (1 + band), c < m * (1 - band))
    rv = simple_returns(c).rolling(vol_len, min_periods=vol_len).std() * np.sqrt(panel.periods_per_year)
    size = (target_vol / rv).clip(upper=1.0)
    w = (on * size / len(assets)).where(m.notna() & rv.notna(), 0.0).fillna(0.0)
    return w


def onchain_trend(panel: Panel, capital: float, assets: list[str] | None = None, ma: int = 100,
                  band: float = 0.02, vol_len: int = 30, target_vol: float = 0.6, hot: float = 0.9,
                  cold: float = 0.1, flow_z: float | None = None, flow_len: int = 7) -> pd.DataFrame:
    """Trend following plus on-chain valuation and exchange-flow filters.

    - MVRV (market cap / realized cap) ranked against its OWN history up to that day
      (expanding percentile, so no hindsight about what "high" means):
        * above `hot`: the market is euphoric relative to holders' cost basis -> exit
        * below `cold`: price is near/below what holders paid -> buy even without a trend
    - flow_z (optional, BTC/ETH only): if coins flowing INTO exchanges over flow_len days
      are this many std-devs above normal, holders are getting ready to sell -> stand aside.
    """
    assets = assets or panel.symbols
    base = trend(panel, capital, assets, ma, band, vol_len, target_vol)
    mvrv = panel.extra.get("mvrv")
    if mvrv is None:
        raise ValueError("onchain_trend needs MVRV data (use the coinmetrics source)")
    mv = mvrv[assets]
    pct = mv.expanding(min_periods=365).rank(pct=True)
    hot_mask = (pct > hot).fillna(False)
    cold_mask = (pct < cold).fillna(False)
    full = 1.0 / len(assets)
    w = base.where(~hot_mask, 0.0)
    w = w.where(~cold_mask, np.maximum(w, full * 0.5))  # accumulate half a slot when cheap
    if flow_z is not None and "flow_in" in panel.extra and "flow_out" in panel.extra:
        net = (panel.extra["flow_in"] - panel.extra["flow_out"]).reindex(columns=assets)
        roll = net.rolling(flow_len, min_periods=flow_len).sum()
        z = (roll - roll.rolling(365, min_periods=180).mean()) / roll.rolling(365, min_periods=180).std()
        w = w.where(~(z > flow_z).fillna(False), 0.0)
    return w.fillna(0.0)


def rotation(panel: Panel, capital: float, assets: list[str] | None = None, lookback: int = 30, top_k: int = 2,
             ma: int = 50, regime_asset: str = "btc", regime_ma: int = 100, rebalance: str = "W") -> pd.DataFrame:
    """Weekly crypto rotation: hold the top_k strongest coins that are above their ma,
    only while BTC itself is above its regime_ma (altcoins crash hardest in BTC downtrends).
    """
    assets = assets or panel.symbols
    c = panel.close[assets]
    mom = c / c.shift(lookback) - 1
    above = c > sma(c, ma)
    b = panel.close[regime_asset]
    regime_ok = (b > sma(b, regime_ma)).fillna(False)
    rows = {}
    for d in period_starts(panel.dates, rebalance):
        if not regime_ok.loc[d]:
            rows[d] = {}
            continue
        m = mom.loc[d][above.loc[d] & mom.loc[d].notna() & (mom.loc[d] > 0)]
        rows[d] = {s: 1.0 / top_k for s in m.sort_values(ascending=False).index[:top_k]}
    return _frame(rows, assets)


def ml(panel: Panel, capital: float, **params) -> pd.DataFrame:
    from .ml import ml as _ml  # imported lazily: needs scikit-learn
    return _ml(panel, capital, **params)


REGISTRY = {
    "ml": ml,
    "buyhold": buyhold,
    "momentum": momentum,
    "smooth_momentum": smooth_momentum,
    "meanrev": meanrev,
    "trend": trend,
    "onchain_trend": onchain_trend,
    "rotation": rotation,
}
