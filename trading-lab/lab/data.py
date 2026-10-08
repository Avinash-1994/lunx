"""Market data: NSE (via Yahoo Finance), Binance public klines, local CSVs, synthetic.

Every loader returns a Panel: one DataFrame per field (open/high/low/close/volume),
indexed by date, one column per symbol.
"""
from __future__ import annotations

import io
import json
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

FIELDS = ("open", "high", "low", "close", "volume")


@dataclass
class Panel:
    open: pd.DataFrame
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    volume: pd.DataFrame
    periods_per_year: int = 252
    # optional per-symbol series beyond OHLCV, e.g. {"mvrv": DataFrame} from on-chain data
    extra: dict[str, pd.DataFrame] = field(default_factory=dict)

    @property
    def dates(self) -> pd.DatetimeIndex:
        return self.close.index

    @property
    def symbols(self) -> list[str]:
        return list(self.close.columns)

    def upto(self, date) -> "Panel":
        """Panel truncated at `date` (inclusive). Used to prove strategies don't peek ahead."""
        return Panel(*(getattr(self, f).loc[:date] for f in FIELDS), periods_per_year=self.periods_per_year,
                     extra={k: v.loc[:date] for k, v in self.extra.items()})

    def select(self, symbols: list[str]) -> "Panel":
        return Panel(*(getattr(self, f)[symbols] for f in FIELDS), periods_per_year=self.periods_per_year,
                     extra={k: v.reindex(columns=symbols) for k, v in self.extra.items()})

    @classmethod
    def from_frames(cls, frames: dict[str, pd.DataFrame], periods_per_year: int = 252) -> "Panel":
        """Build from {symbol: DataFrame with Open/High/Low/Close/Volume columns}."""
        fields = {}
        for f in FIELDS:
            cols = {}
            for sym, df in frames.items():
                lower = {c.lower(): c for c in df.columns}
                if f in lower:
                    cols[sym] = df[lower[f]]
            fields[f] = pd.DataFrame(cols).sort_index()
        idx = fields["close"].dropna(how="all").index
        return cls(*(fields[f].reindex(idx) for f in FIELDS), periods_per_year=periods_per_year)


def read_universe(path: str | Path) -> list[str]:
    lines = Path(path).read_text().splitlines()
    return [ln.split("#")[0].strip() for ln in lines if ln.split("#")[0].strip()]


# --------------------------------------------------------------------------- cache

def _cache_path(cache_dir: Path, source: str, symbol: str) -> Path:
    safe = symbol.replace("/", "_").replace("^", "IDX_").replace("&", "and")
    return cache_dir / source / f"{safe}.csv"


def _cached_fetch(path: Path, max_age_hours: float, fetch, label: str) -> pd.DataFrame | None:
    """Return fresh cached data, else download and store it.

    The cache doubles as a local history store: if the provider is down, renamed
    or blocked, the last good copy is used (with a warning) instead of failing.
    """
    def read():
        return pd.read_csv(path, index_col=0, parse_dates=True, low_memory=False)

    if path.exists() and (time.time() - path.stat().st_mtime) / 3600 <= max_age_hours:
        return read()
    try:
        df = fetch()
    except Exception as e:  # network errors, delisted tickers, API changes
        df, err = None, e
    else:
        err = None
    if df is not None and not df.empty:
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(path)
        return df
    if path.exists():
        print(f"  ! {label}: download failed ({err or 'no data'}); using stored copy from "
              f"{time.strftime('%Y-%m-%d', time.localtime(path.stat().st_mtime))}")
        return read()
    print(f"  ! {label}: no data ({err or 'renamed or delisted?'}) - skipped")
    return None


# --------------------------------------------------------------------------- NSE

def load_nse(symbols: list[str], start: str = "2012-01-01", cache_dir: str | Path = "data/cache",
             max_age_hours: float = 12) -> Panel:
    """Daily OHLCV for NSE symbols (e.g. 'RELIANCE', 'NIFTYBEES') from Yahoo Finance.

    Prices are split/dividend adjusted. Symbols that fail to download are skipped
    with a warning, so a stale universe file doesn't break the run.
    """
    try:
        import yfinance as yf
    except ImportError as e:  # pragma: no cover
        raise SystemExit("yfinance is required for NSE data: pip install yfinance") from e

    cache_dir = Path(cache_dir)
    frames = {}
    for sym in symbols:
        ticker = sym if sym.startswith("^") or sym.endswith(".NS") else f"{sym}.NS"
        def fetch(ticker=ticker):
            df = yf.download(ticker, start=start, auto_adjust=True, progress=False, multi_level_index=False)
            if df is not None and not df.empty:
                df.index = pd.to_datetime(df.index).tz_localize(None)
            return df

        df = _cached_fetch(_cache_path(cache_dir, "nse", sym), max_age_hours, fetch, sym)
        if df is not None:
            frames[sym] = df.loc[start:]
    if not frames:
        raise SystemExit("No NSE data loaded. Check network access to query1.finance.yahoo.com.")
    return Panel.from_frames(frames, periods_per_year=252)


# --------------------------------------------------------------------------- Binance

BINANCE_URL = "https://data-api.binance.vision/api/v3/klines"


def _binance_klines(symbol: str, start_ms: int, interval: str = "1d") -> list[list]:
    rows: list[list] = []
    while True:
        url = f"{BINANCE_URL}?symbol={symbol}&interval={interval}&startTime={start_ms}&limit=1000"
        with urllib.request.urlopen(url, timeout=30) as r:
            batch = json.loads(r.read())
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        start_ms = batch[-1][0] + 1
    return rows


def load_binance(symbols: list[str], start: str = "2018-01-01", cache_dir: str | Path = "data/cache",
                 max_age_hours: float = 12) -> Panel:
    """Daily OHLCV for Binance spot pairs (e.g. 'BTCUSDT') from the public market-data API.

    No API key needed. The last (still-forming) daily candle is dropped.
    """
    cache_dir = Path(cache_dir)
    frames = {}
    start_ms = int(pd.Timestamp(start).timestamp() * 1000)
    for sym in symbols:
        def fetch(sym=sym):
            rows = _binance_klines(sym, start_ms)
            if not rows:
                return None
            df = pd.DataFrame(rows, columns=["t", "Open", "High", "Low", "Close", "Volume", "ct",
                                             "qv", "n", "tb", "tq", "ig"])
            df = df[df["ct"] < time.time() * 1000]  # drop the unfinished candle
            df.index = pd.to_datetime(df["t"], unit="ms")
            return df[["Open", "High", "Low", "Close", "Volume"]].astype(float)

        df = _cached_fetch(_cache_path(cache_dir, "binance", sym), max_age_hours, fetch, sym)
        if df is not None:
            frames[sym] = df.loc[start:]
    if not frames:
        raise SystemExit("No Binance data loaded. Check network access to data-api.binance.vision.")
    return Panel.from_frames(frames, periods_per_year=365)


# --------------------------------------------------------------------------- CoinMetrics

COINMETRICS_URL = "https://raw.githubusercontent.com/coinmetrics/data/master/csv/{asset}.csv"
COINMETRICS_EXTRA = {"mvrv": "CapMVRVCur", "flow_in": "FlowInExNtv", "flow_out": "FlowOutExNtv",
                     "active_addr": "AdrActCnt", "spot_volume": "volume_reported_spot_usd_1d"}


def load_coinmetrics(assets: list[str], start: str = "2017-01-01", cache_dir: str | Path = "data/cache",
                     max_age_hours: float = 24) -> Panel:
    """Free daily crypto prices + on-chain metrics from CoinMetrics' community data on GitHub.

    Close-only (UTC end of day). Crypto trades 24/7, so the next day's open is taken
    as today's close. Extras (MVRV, exchange flows, active addresses) go in panel.extra.
    """
    cache_dir = Path(cache_dir)
    closes, extras = {}, {k: {} for k in COINMETRICS_EXTRA}
    for asset in assets:
        def fetch(asset=asset):
            with urllib.request.urlopen(COINMETRICS_URL.format(asset=asset), timeout=60) as r:
                return pd.read_csv(io.BytesIO(r.read()), index_col=0, parse_dates=True, low_memory=False)

        df = _cached_fetch(_cache_path(cache_dir, "coinmetrics", asset), max_age_hours, fetch, asset)
        if df is None:
            continue
        px = df.get("PriceUSD")
        if px is None or px.notna().sum() < 365:
            print(f"  ! {asset}: under a year of free price history - skipped")
            continue
        closes[asset] = px.where(px > 0)
        for k, col in COINMETRICS_EXTRA.items():
            if col in df:
                extras[k][asset] = pd.to_numeric(df[col], errors="coerce")
    if not closes:
        raise SystemExit("No CoinMetrics data loaded. Check access to raw.githubusercontent.com.")
    close = pd.DataFrame(closes).sort_index().loc[start:]
    close = close[close.notna().any(axis=1)]
    open_ = close.shift(1)
    vol = pd.DataFrame(extras["spot_volume"]).reindex(index=close.index, columns=close.columns)
    extra = {k: pd.DataFrame(v).reindex(index=close.index, columns=close.columns)
             for k, v in extras.items() if v and k != "spot_volume"}
    return Panel(open_, close.copy(), close.copy(), close, vol, periods_per_year=365, extra=extra)


# --------------------------------------------------------------------------- local CSVs

def load_csv_dir(directory: str | Path, symbols: list[str] | None = None, periods_per_year: int = 252) -> Panel:
    """Load <SYMBOL>.csv files with Date,Open,High,Low,Close,Volume columns."""
    directory = Path(directory)
    frames = {}
    for path in sorted(directory.glob("*.csv")):
        sym = path.stem
        if symbols and sym not in symbols:
            continue
        frames[sym] = pd.read_csv(path, index_col=0, parse_dates=True)
    if not frames:
        raise SystemExit(f"No CSV files found in {directory}")
    return Panel.from_frames(frames, periods_per_year=periods_per_year)


# --------------------------------------------------------------------------- synthetic

def synthetic_panel(n_symbols: int = 40, n_days: int = 2000, seed: int = 0, trend_strength: float = 0.0,
                    regime_days: int = 120, start_price: tuple[float, float] = (100, 3000),
                    benchmark: str | None = "BENCH", periods_per_year: int = 252) -> Panel:
    """Random-walk prices for testing.

    trend_strength=0 gives pure noise: no strategy should make money on it after
    costs, which is the backtester's main sanity check. trend_strength>0 gives each
    symbol a hidden drift that persists for `regime_days`, so momentum *should* work.
    """
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2015-01-01", periods=n_days)
    vol = rng.uniform(0.012, 0.025, n_symbols)
    drift = np.zeros((n_days, n_symbols))
    if trend_strength > 0:
        for s in range(0, n_days, regime_days):
            drift[s:s + regime_days] = rng.normal(0, trend_strength, n_symbols)
    rets = drift + rng.normal(0, 1, (n_days, n_symbols)) * vol
    close = rng.uniform(*start_price, n_symbols) * np.exp(np.cumsum(rets, axis=0))
    gap = rng.normal(0, 0.003, (n_days, n_symbols))
    open_ = np.vstack([close[0], close[:-1]]) * np.exp(gap)
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.004, (n_days, n_symbols))))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.004, (n_days, n_symbols))))
    syms = [f"S{i:02d}" for i in range(n_symbols)]
    mk = lambda a: pd.DataFrame(a, index=dates, columns=syms)  # noqa: E731
    vol_df = mk(rng.uniform(1e5, 1e6, (n_days, n_symbols)))
    panel = Panel(mk(open_), mk(high), mk(low), mk(close), vol_df, periods_per_year=periods_per_year)
    if benchmark:
        # equal-weight index of all symbols, priced ~250 like NIFTYBEES
        idx = 250 * (panel.close / panel.close.iloc[0]).mean(axis=1)
        idx_open = 250 * (panel.open / panel.close.iloc[0]).mean(axis=1)
        for f, s in (("open", idx_open), ("high", np.maximum(idx, idx_open)), ("low", np.minimum(idx, idx_open)),
                     ("close", idx), ("volume", pd.Series(1e6, index=dates))):
            getattr(panel, f)[benchmark] = s
    return panel
