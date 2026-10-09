import io
import zipfile
from datetime import date

import pandas as pd
import pytest

from lab.nse_store import NseStore, parse_bhavcopy, urls_for

LEGACY_HEADER = "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN,\n"
UDIFF_HEADER = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,"
                "StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,"
                "SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,"
                "Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n")


def legacy_file(d: date, rows) -> bytes:
    ts = d.strftime("%d-%b-%Y").upper()
    body = "".join(f"{s},{ser},{c},{c},{c},{c},{c},{p},1000,{1000 * c},{ts},10,INE000000000,\n" for s, ser, c, p in rows)
    return _zip(LEGACY_HEADER + body)


def udiff_file(d: date, rows) -> bytes:
    body = "".join(f"{d:%Y-%m-%d},{d:%Y-%m-%d},CM,NSE,STK,1,INE000000000,{s},{ser},,,,,{s} LTD,{c},{c},{c},{c},{c},"
                   f"{p},,{c},,,1000,{1000 * c},10,F1,1,,,,,\n" for s, ser, c, p in rows)
    return _zip(UDIFF_HEADER + body)


def _zip(text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("bhav.csv", text)
    return buf.getvalue()


# 2024-07-01 .. 2024-07-12: legacy format before 07-08, UDiFF after; 07-05 is a "holiday";
# RELIANCE does a 1:2 split on 07-03 (NSE publishes prev_close already halved).
TRADING_DAYS = [date(2024, 7, d) for d in (1, 2, 3, 4, 8, 9, 10, 11, 12)]
RAW_CLOSE = [100, 102, 52, 53, 54, 55, 56, 57, 58]


def fake_archive():
    files = {}
    prev = None
    for d, c in zip(TRADING_DAYS, RAW_CLOSE):
        p = (prev / 2 if d == date(2024, 7, 3) else prev) if prev else c
        rows = [("RELIANCE", "EQ", c, p), ("NIFTYBEES", "EQ", 250, 250), ("SOMEBOND", "GS", 99, 99)]
        files[urls_for(d)[0]] = (udiff_file if d >= date(2024, 7, 8) else legacy_file)(d, rows)
        prev = c
    return files


def test_parses_both_formats():
    a = parse_bhavcopy(legacy_file(date(2024, 7, 1), [("RELIANCE", "EQ", 100, 99), ("X", "GS", 1, 1)]))
    b = parse_bhavcopy(udiff_file(date(2024, 7, 8), [("RELIANCE", "EQ", 100, 99)]))
    for df in (a, b):
        assert list(df["symbol"]) == ["RELIANCE"]  # non-equity series dropped
        assert df["close"].iloc[0] == 100 and df["prev_close"].iloc[0] == 99
    assert a["date"].iloc[0] == "2024-07-01" and b["date"].iloc[0] == "2024-07-08"


def test_update_backfills_skips_holidays_and_adjusts_splits(tmp_path):
    files = fake_archive()
    calls = []

    def fetch(url):
        calls.append(url)
        return files.get(url)

    store = NseStore(tmp_path / "nse.sqlite")
    assert store.update("2024-07-01", "2024-07-12", fetch=fetch, pause=0, verbose=False) == 9
    assert dict(store.db.execute("SELECT date, status FROM days WHERE status='holiday'")) == {"2024-07-05": "holiday"}

    # incremental: nothing new to download
    calls.clear()
    assert store.update("2024-07-01", "2024-07-12", fetch=fetch, pause=0, verbose=False) == 0
    assert calls == []

    panel = store.panel(["RELIANCE", "NIFTYBEES"], start="2024-01-01")
    close = panel.close["RELIANCE"]
    assert list(close.round(2)) == [50, 51, 52, 53, 54, 55, 56, 57, 58]  # split removed from history
    assert panel.volume["RELIANCE"].iloc[0] == pytest.approx(2000)
    assert (panel.close["NIFTYBEES"] == 250).all()


def test_update_stops_after_repeated_network_errors(tmp_path):
    def broken(url):
        raise OSError("connection refused")

    store = NseStore(tmp_path / "nse.sqlite")
    with pytest.raises(SystemExit):
        store.update("2024-07-01", "2024-07-12", fetch=broken, pause=0, verbose=False)
    assert store.known_days() == set()  # failures are not mistaken for holidays


def test_a_changed_archive_address_is_not_mistaken_for_holidays(tmp_path):
    store = NseStore(tmp_path / "nse.sqlite")
    with pytest.raises(SystemExit, match="weekdays in a row"):
        store.update("2024-07-01", "2024-07-31", fetch=lambda url: None, pause=0, verbose=False)
    assert store.known_days() == set()


def test_unexpected_file_content_counts_as_failure(tmp_path):
    store = NseStore(tmp_path / "nse.sqlite")
    with pytest.raises(SystemExit, match="unexpected files"):
        store.update("2024-07-01", "2024-07-12", fetch=lambda url: b"<html>blocked</html>", pause=0, verbose=False)
    assert store.known_days() == set()
