"""Free, official NSE end-of-day data: the daily bhavcopy files, kept in a local SQLite store.

NSE publishes one file per trading day with the open/high/low/close/volume of every
listed security. No account, API key or payment is needed. `update()` downloads only
the days the store doesn't have yet, so after the first backfill a daily run takes
seconds, and your history never depends on a third-party service staying up.

Bhavcopy prices are raw (not adjusted for splits and bonuses). On an ex-date NSE
publishes an adjusted "previous close", so prev_close / yesterday's close reveals
every split/bonus factor; `panel()` back-adjusts history with it.
"""
from __future__ import annotations

import io
import sqlite3
import time
import urllib.error
import urllib.request
import zipfile
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from .data import Panel

UDIFF_URL = "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"
LEGACY_URLS = (
    "https://nsearchives.nseindia.com/content/historical/EQUITIES/{d:%Y}/{mon}/cm{d:%d}{mon}{d:%Y}bhav.csv.zip",
    "https://archives.nseindia.com/content/historical/EQUITIES/{d:%Y}/{mon}/cm{d:%d}{mon}{d:%Y}bhav.csv.zip",
)
UDIFF_FROM = date(2024, 7, 8)
MAX_HOLIDAY_RUN = 5  # longest plausible run of weekday exchange holidays  # NSE switched to the new (UDiFF) file format on this date
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0 Safari/537.36",
    "Accept": "*/*",
    "Referer": "https://www.nseindia.com/",
}
KEEP_SERIES = ("EQ", "BE", "BZ", "SM", "ST")  # equities and ETFs (NIFTYBEES trades as EQ)
COLUMNS = ["date", "symbol", "series", "open", "high", "low", "close", "prev_close", "volume", "value", "trades"]

_UDIFF_MAP = {"TradDt": "date", "TckrSymb": "symbol", "SctySrs": "series", "OpnPric": "open", "HghPric": "high",
              "LwPric": "low", "ClsPric": "close", "PrvsClsgPric": "prev_close", "TtlTradgVol": "volume",
              "TtlTrfVal": "value", "TtlNbOfTxsExctd": "trades"}
_LEGACY_MAP = {"TIMESTAMP": "date", "SYMBOL": "symbol", "SERIES": "series", "OPEN": "open", "HIGH": "high",
               "LOW": "low", "CLOSE": "close", "PREVCLOSE": "prev_close", "TOTTRDQTY": "volume",
               "TOTTRDVAL": "value", "TOTALTRADES": "trades"}


def urls_for(d: date) -> list[str]:
    mon = d.strftime("%b").upper()
    if d >= UDIFF_FROM:
        return [UDIFF_URL.format(d=d)]
    return [u.format(d=d, mon=mon) for u in LEGACY_URLS] + [UDIFF_URL.format(d=d)]


def parse_bhavcopy(raw: bytes) -> pd.DataFrame:
    """Parse a bhavcopy (zipped or plain CSV, old or new format) into COLUMNS."""
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            raw = z.read(z.namelist()[0])
    df = pd.read_csv(io.BytesIO(raw), dtype=str)
    df.columns = [c.strip() for c in df.columns]
    mapping = _UDIFF_MAP if "TckrSymb" in df.columns else _LEGACY_MAP
    missing = set(mapping) - set(df.columns)
    if missing:
        raise ValueError(f"unrecognised bhavcopy format, missing columns {sorted(missing)}")
    df = df[list(mapping)].rename(columns=mapping)
    for c in ("symbol", "series"):
        df[c] = df[c].str.strip()
    df = df[df["series"].isin(KEEP_SERIES)].copy()
    df["date"] = pd.to_datetime(df["date"].str.strip(), format="mixed", dayfirst=False).dt.strftime("%Y-%m-%d")
    for c in COLUMNS[3:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[COLUMNS].reset_index(drop=True)


def _http_get(url: str) -> bytes | None:
    """Bytes of the file, or None if NSE has no file for that day (holiday)."""
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


class NseStore:
    def __init__(self, path: str | Path = "data/nse_eod.sqlite"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS bhav (date TEXT, symbol TEXT, series TEXT, open REAL, high REAL, low REAL,
                close REAL, prev_close REAL, volume REAL, value REAL, trades REAL,
                PRIMARY KEY (date, symbol, series));
            CREATE INDEX IF NOT EXISTS bhav_symbol ON bhav(symbol, date);
            CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, status TEXT);
        """)

    def known_days(self) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT date FROM days")}

    def last_trading_day(self) -> str | None:
        return self.db.execute("SELECT max(date) FROM days WHERE status='ok'").fetchone()[0]

    def add_day(self, d: date, rows: pd.DataFrame) -> None:
        self.db.executemany(f"INSERT OR REPLACE INTO bhav VALUES ({','.join('?' * len(COLUMNS))})",
                            rows[COLUMNS].itertuples(index=False, name=None))
        self.db.execute("INSERT OR REPLACE INTO days VALUES (?, 'ok')", (d.isoformat(),))
        self.db.commit()

    def update(self, start: str = "2018-01-01", end: str | None = None, fetch=_http_get, pause: float = 0.35,
               verbose: bool = True) -> int:
        """Download every missing weekday in [start, end]. Returns the number of new trading days.

        Weekdays with no file (exchange holidays) are remembered so they aren't retried,
        except for the last few days, whose files may simply not be published yet.
        NSE is never shut for more than a few weekdays in a row, so a longer gap means
        the archive address changed: we stop rather than record fake holidays.
        """
        d = pd.Timestamp(start).date()
        last = pd.Timestamp(end).date() if end else date.today()
        known = self.known_days()
        recent = date.today() - timedelta(days=4)
        added = failures = 0
        no_file: list[date] = []  # consecutive weekdays without a file, not yet recorded as holidays

        def record_holidays():
            for h in no_file:
                if h < recent:
                    self.db.execute("INSERT OR REPLACE INTO days VALUES (?, 'holiday')", (h.isoformat(),))
            self.db.commit()
            no_file.clear()

        while d <= last:
            if d.weekday() < 5 and d.isoformat() not in known:
                try:
                    raw = None
                    for url in urls_for(d):
                        raw = fetch(url)
                        if raw:
                            break
                    rows = parse_bhavcopy(raw) if raw else None
                    failures = 0
                except Exception as e:
                    rows = None
                    failures += 1
                    if verbose:
                        print(f"  ! {d}: {e}")
                    if failures >= 3:
                        record_holidays()
                        raise SystemExit("NSE archives unreachable or returning unexpected files (3 failures in "
                                         "a row). Check your internet connection, or try again later - NSE "
                                         "sometimes blocks bursts.") from e
                else:
                    if rows is not None:
                        record_holidays()
                        self.add_day(d, rows)
                        added += 1
                        if verbose and added % 50 == 0:
                            print(f"  ... {d} ({added} trading days added)")
                    else:
                        no_file.append(d)
                        if len(no_file) > MAX_HOLIDAY_RUN:
                            raise SystemExit(f"No NSE file for {len(no_file)} weekdays in a row ({no_file[0]} to "
                                             f"{no_file[-1]}). NSE may have changed its archive addresses; "
                                             "nothing was recorded for these days, so a later run will retry them.")
                if pause:
                    time.sleep(pause)
            d += timedelta(days=1)
        record_holidays()
        if verbose:
            print(f"NSE store: {added} new trading days, data up to {self.last_trading_day()}")
        return added

    def panel(self, symbols: list[str], start: str = "2015-01-01") -> Panel:
        q = f"SELECT * FROM bhav WHERE symbol IN ({','.join('?' * len(symbols))}) AND date >= ?"
        raw = pd.read_sql_query(q, self.db, params=[*symbols, start])
        if raw.empty:
            raise SystemExit("NSE store has no data for these symbols. Run: python run.py update-data")
        rank = {s: i for i, s in enumerate(KEEP_SERIES)}
        raw["rank"] = raw["series"].map(rank)
        raw = raw.sort_values(["symbol", "date", "rank"]).drop_duplicates(["symbol", "date"])
        raw["date"] = pd.to_datetime(raw["date"])
        frames = {sym: adjust_for_corporate_actions(g.set_index("date")) for sym, g in raw.groupby("symbol")}
        missing = sorted(set(symbols) - set(frames))
        if missing:
            print(f"  ! not in NSE store (renamed/delisted/not yet listed?): {', '.join(missing)}")
        return Panel.from_frames(frames, periods_per_year=252)


def adjust_for_corporate_actions(g: pd.DataFrame, tolerance: float = 0.005) -> pd.DataFrame:
    """Back-adjust one symbol's raw prices for splits/bonuses using NSE's adjusted prev_close."""
    g = g.sort_index()
    ratio = g["prev_close"] / g["close"].shift(1)
    factor = ratio.where((ratio - 1).abs() > tolerance, 1.0).fillna(1.0)
    # price on day s is scaled by the product of all factors AFTER s
    after = factor[::-1].cumprod()[::-1].shift(-1).fillna(1.0)
    out = pd.DataFrame(index=g.index)
    for c in ("open", "high", "low", "close"):
        out[c.capitalize()] = g[c] * after
    out["Volume"] = g["volume"] / after.replace(0, np.nan)
    return out
