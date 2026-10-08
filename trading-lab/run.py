#!/usr/bin/env python3
"""Trading lab command line.

  python run.py backtest    --source coinmetrics --strategy trend --set ma=100
  python run.py walkforward --source coinmetrics --strategy onchain_trend --test-start 2020-01-01
  python run.py signals     --source binance --strategy trend --set ma=100 --since 2026-10-01
  python run.py update-data --from 2018-01-01      # free official NSE bhavcopy -> data/nse_eod.sqlite
  python run.py report      --source nse-official  # walk-forward every strategy, one summary table

`signals` is paper trading: it replays the strategy from --since to the latest
bar and prints current holdings plus the orders to place at the next open.
Nothing is ever sent to a broker or exchange.
"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path

import pandas as pd

from lab import backtest, data
from lab.nse_store import NseStore
from lab.costs import CryptoSpotCosts, NseDeliveryCosts
from lab.metrics import result_stats
from lab.strategies import REGISTRY
from lab.validate import walk_forward

HERE = Path(__file__).parent
CRYPTO_SOURCES = {"coinmetrics", "binance", "synthetic-crypto"}

NSE_STORE = HERE / "data" / "nse_eod.sqlite"
DEFAULT_UNIVERSE = {
    "nse": HERE / "universes" / "nifty50_plus_former.txt",
    "nse-official": HERE / "universes" / "nifty50_plus_former.txt",
    "csv": None,
    "coinmetrics": HERE / "universes" / "crypto_coinmetrics.txt",
    "binance": HERE / "universes" / "crypto_binance.txt",
}
DEFAULT_BENCH = {"nse": "NIFTYBEES", "nse-official": "NIFTYBEES", "csv": "NIFTYBEES", "synthetic": "BENCH",
                 "coinmetrics": "btc", "binance": "BTCUSDT", "synthetic-crypto": "BENCH"}


def parse_sets(items: list[str]) -> dict:
    out = {}
    for item in items or []:
        k, v = item.split("=", 1)
        try:
            out[k] = ast.literal_eval(v)
        except (ValueError, SyntaxError):
            out[k] = v
    return out


def load(args) -> data.Panel:
    uni = args.universe or DEFAULT_UNIVERSE.get(args.source)
    symbols = data.read_universe(uni) if uni else None
    cache = HERE / "data" / "cache"
    if args.source == "nse":
        bench = DEFAULT_BENCH["nse"]
        return data.load_nse(sorted(set(symbols + [bench])), start=args.data_start, cache_dir=cache)
    if args.source == "nse-official":
        bench = DEFAULT_BENCH["nse-official"]
        return NseStore(NSE_STORE).panel(sorted(set(symbols + [bench])), start=args.data_start)
    if args.source == "binance":
        return data.load_binance(symbols, start=args.data_start, cache_dir=cache)
    if args.source == "coinmetrics":
        return data.load_coinmetrics(symbols, start=args.data_start, cache_dir=cache)
    if args.source == "csv":
        return data.load_csv_dir(args.data_dir, symbols)
    if args.source == "synthetic":
        return data.synthetic_panel(n_symbols=40, n_days=2500, seed=args.seed, trend_strength=args.synthetic_trend)
    if args.source == "synthetic-crypto":
        return data.synthetic_panel(n_symbols=6, n_days=2500, seed=args.seed, trend_strength=args.synthetic_trend,
                                    start_price=(1, 50000), periods_per_year=365)
    raise SystemExit(f"unknown source {args.source}")


def strategy_params(args, panel) -> dict:
    params = parse_sets(args.set)
    crypto = args.source in CRYPTO_SOURCES
    if not crypto and args.strategy in ("momentum", "smooth_momentum", "meanrev", "ml"):
        params.setdefault("benchmark", DEFAULT_BENCH[args.source])
    if not crypto and args.strategy == "ml":
        params.setdefault("top_n", 3)
        params.setdefault("regime_ma", 200)
    if crypto and args.strategy in ("trend", "onchain_trend", "rotation", "ml") and "assets" not in params:
        bench = DEFAULT_BENCH[args.source]
        params["assets"] = [s for s in panel.symbols if s != "BENCH"] if args.strategy == "rotation" \
            else [s for s in panel.symbols if s in (bench, "eth", "ETHUSDT")] or [panel.symbols[0]]
    if args.source == "synthetic-crypto" and args.strategy == "rotation":
        params.setdefault("regime_asset", "BENCH")
    if args.strategy == "buyhold":
        params.setdefault("symbol", DEFAULT_BENCH[args.source])
    return params


def costs_for(args):
    return CryptoSpotCosts() if args.source in CRYPTO_SOURCES else NseDeliveryCosts()


def print_stats(title: str, st: dict) -> None:
    print(f"\n{title}")
    for k, v in st.items():
        print(f"  {k:<22} {v}")


def cmd_backtest(args) -> None:
    panel = load(args)
    params = strategy_params(args, panel)
    w = REGISTRY[args.strategy](panel, args.capital, **params)
    res = backtest.run(panel, w, costs_for(args), args.capital, start=args.start, min_trade_frac=args.min_trade)
    print_stats(f"{args.strategy} {params}", result_stats(res))
    bench = DEFAULT_BENCH[args.source]
    if bench in panel.symbols:
        bw = REGISTRY["buyhold"](panel, args.capital, symbol=bench)
        print_stats(f"benchmark: buy & hold {bench}",
                    result_stats(backtest.run(panel, bw, costs_for(args), args.capital, start=args.start)))
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    res.equity.to_csv(out / f"{args.strategy}_equity.csv")
    res.trades.to_csv(out / f"{args.strategy}_trades.csv", index=False)
    print(f"\nEquity curve and trades written to {out}/")


def cmd_walkforward(args) -> None:
    panel = load(args)
    params = strategy_params(args, panel)
    print(f"Walk-forward {args.strategy}, fixed params {params}")
    wf = walk_forward(panel, args.strategy, costs_for(args), args.capital, args.test_start, fixed=params,
                      min_trade_frac=args.min_trade, benchmark=DEFAULT_BENCH[args.source]
                      if DEFAULT_BENCH[args.source] in panel.symbols else None)
    print_stats("OUT-OF-SAMPLE (walk-forward, params re-chosen each year on past data only)", wf["oos_stats"])
    if wf["benchmark"]:
        print_stats(f"benchmark: buy & hold {DEFAULT_BENCH[args.source]} (same period)", wf["benchmark"])
    g = wf["grid"]
    print(f"\nRobustness: {len(g)} parameter sets run over the whole test period")
    print(f"  median CAGR {g['CAGR_%'].median():.1f}%, {100 * (g['CAGR_%'] > 0).mean():.0f}% of sets profitable")
    print(g.sort_values("sharpe", ascending=False).head(8).to_string(index=False))
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    wf["oos_equity"].to_csv(out / f"wf_{args.strategy}_equity.csv")
    g.to_csv(out / f"wf_{args.strategy}_grid.csv", index=False)
    (out / f"wf_{args.strategy}_summary.json").write_text(json.dumps(
        {"oos": wf["oos_stats"], "benchmark": wf["benchmark"], "chosen": wf["chosen"]}, indent=2, default=str))


def cmd_signals(args) -> None:
    panel = load(args)
    params = strategy_params(args, panel)
    w = REGISTRY[args.strategy](panel, args.capital, **params)
    res = backtest.run(panel, w, costs_for(args), args.capital, start=args.since, min_trade_frac=args.min_trade)
    last = panel.dates[-1]
    print(f"Paper portfolio since {args.since}, data up to {last.date()}")
    print_stats("performance", result_stats(res))
    print("\nholdings:")
    px = panel.close.ffill().iloc[-1]
    for s, q in res.holdings.items():
        print(f"  {s:<12} qty {q:<12g} ~value {q * px[s]:,.2f}")
    print(f"  cash         {res.cash:,.2f}")
    if res.pending_orders:
        print("\nORDERS FOR NEXT SESSION (place manually; prices are last close, use limit orders):")
        for o in res.pending_orders:
            print(f"  {o['side']:<4} {o['symbol']:<12} qty {o['qty']:g} @ ~{o['approx_price']:,.2f}")
    else:
        print("\nNo orders: the strategy does not trade at the next session.")


REPORT_STRATEGIES = {
    "nse": ["momentum", "smooth_momentum", "meanrev", "ml"],
    "crypto": ["trend", "onchain_trend", "ml", "rotation"],
}


def cmd_report(args) -> None:
    """Walk-forward every strategy for this market and print one comparison table."""
    panel = load(args)
    crypto = args.source in CRYPTO_SOURCES
    names = REPORT_STRATEGIES["crypto" if crypto else "nse"]
    if crypto and "mvrv" not in panel.extra:
        names = [n for n in names if n != "onchain_trend"]
    bench = DEFAULT_BENCH[args.source]
    rows, bench_stats = [], None
    for name in names:
        args.strategy = name
        print(f"\n=== {name}")
        wf = walk_forward(panel, name, costs_for(args), args.capital, args.test_start,
                          fixed=strategy_params(args, panel), min_trade_frac=args.min_trade,
                          benchmark=bench if bench in panel.symbols else None)
        st, g = wf["oos_stats"], wf["grid"]
        rows.append({"strategy": name, "CAGR_%": st["CAGR_%"], "max_dd_%": st["max_drawdown_%"],
                     "sharpe": st["sharpe"], "end_equity": st["end_equity"], "trades": st["trades"],
                     "costs": st["costs_paid"], "grid_median_CAGR_%": g["CAGR_%"].median(),
                     "grid_%_profitable": round(100 * (g["CAGR_%"] > 0).mean())})
        bench_stats = wf["benchmark"] or bench_stats
    if bench_stats:
        rows.append({"strategy": f"buy&hold {bench}", "CAGR_%": bench_stats["CAGR_%"],
                     "max_dd_%": bench_stats["max_drawdown_%"], "sharpe": bench_stats["sharpe"],
                     "end_equity": bench_stats["end_equity"], "trades": bench_stats["trades"],
                     "costs": bench_stats["costs_paid"]})
    table = pd.DataFrame(rows)
    print(f"\nREPORT: {args.source}, out-of-sample from {args.test_start}, start capital {args.capital:,.0f}, "
          f"after costs, before tax")
    print(table.to_string(index=False))
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    table.to_csv(out / f"report_{args.source}.csv", index=False)


def cmd_update_data(args) -> None:
    NseStore(NSE_STORE).update(start=args.from_date, end=args.to_date)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("update-data", help="download/refresh free official NSE end-of-day data")
    up.add_argument("--from", dest="from_date", default="2018-01-01")
    up.add_argument("--to", dest="to_date")
    for name in ("backtest", "walkforward", "signals", "report"):
        p = sub.add_parser(name)
        p.add_argument("--source", default="coinmetrics",
                       choices=["nse", "nse-official", "binance", "coinmetrics", "csv", "synthetic",
                                "synthetic-crypto"])
        p.add_argument("--strategy", default="trend", choices=sorted(REGISTRY))
        p.add_argument("--set", nargs="*", help="strategy params, e.g. --set ma=100 top_n=3")
        p.add_argument("--capital", type=float, default=10_000)
        p.add_argument("--universe", help="text file with one symbol per line")
        p.add_argument("--data-dir", help="for --source csv")
        p.add_argument("--data-start", default="2015-01-01")
        p.add_argument("--min-trade", type=float, default=0.05,
                       help="skip resizing trades smaller than this fraction of equity")
        p.add_argument("--seed", type=int, default=0)
        p.add_argument("--synthetic-trend", type=float, default=0.0)
    sub.choices["backtest"].add_argument("--start")
    sub.choices["walkforward"].add_argument("--test-start", default="2020-01-01")
    sub.choices["report"].add_argument("--test-start", default="2020-01-01")
    sub.choices["signals"].add_argument("--since", required=True)
    args = ap.parse_args()
    {"backtest": cmd_backtest, "walkforward": cmd_walkforward, "signals": cmd_signals, "report": cmd_report,
     "update-data": cmd_update_data}[args.cmd](args)


if __name__ == "__main__":
    pd.set_option("display.width", 160)
    main()
