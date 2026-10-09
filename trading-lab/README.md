# trading-lab

A research and paper-trading tool for small accounts (designed around **Rs 10,000**),
covering NSE equity delivery and crypto spot.

It does three things:

1. **Backtests** strategies with realistic Indian costs: STT, stamp duty, exchange and SEBI fees, GST,
   and the flat DP charge on every sell. Orders fill at the next open, NSE trades use whole shares, and
   there is no leverage.
2. **Walk-forward validates** them. For each year, parameters are chosen using only earlier data and
   then traded through that year. This is the closest a backtest gets to "what would really have happened".
3. **Paper trades** (`signals`): it prints current holdings and the exact orders to place at the next
   open. It never sends orders anywhere, and it needs no API keys.

> **No strategy here is guaranteed to make money.** Every number below is historical. Crypto in
> particular had an exceptional 2019–2021, and 2026 so far has been negative for every strategy tested.

## Results on real crypto data (2019-01 → 2026-05, Rs 10,000 start)

Out-of-sample walk-forward results, after exchange fees and slippage and **before tax**
(India: 30% flat tax on crypto gains plus 1% TDS on sells).

| Strategy | CAGR | Worst drawdown | Sharpe | Rs 10k became |
|---|---|---|---|---|
| `trend` (BTC+ETH, volatility-targeted) | 32.4% | −39.9% | 1.06 | Rs 79.5k |
| `onchain_trend` (trend + MVRV valuation) | 44.6% | −44.8% | 1.17 | Rs 152.9k |
| `ml` (gradient-boosting model, retrained monthly) | 23.0% | −69.6% | 0.70 | Rs 46.4k |
| `rotation` (top coins weekly) | 98.3%* | −57.0% | 1.44 | *see warning* |
| Buy & hold BTC (benchmark) | 50.7% | −76.7% | 0.98 | Rs 207.5k |

**What this means:**
- None of the strategies beat simply holding BTC on total return. What the trend strategies do is
  **cut the worst crash roughly in half** (−40% instead of −77%). That is their real value: you are far
  more likely to stick with a strategy that drops 40% than one that drops 77%.
- **The on-chain idea is genuine but modest.** Ranking each coin's MVRV (market value / realized value)
  against its own past, exiting when it is euphoric and buying half a position when it is cheap,
  improved risk-adjusted returns over plain trend in 75% of like-for-like comparisons. The
  exchange-inflow signal added nothing reliable.
- **Machine learning did worse than the simple rules.** A gradient-boosting model trained only on past
  data (11 price features plus MVRV) made 23%/yr with a −70% drawdown and 727 trades. It found nothing
  the 100-day trend rule doesn't already capture, and it paid more in fees.
- \* **`rotation` is not trustworthy.** It made +499% in 2021 alone, about +1%/yr in 2022–23 and about
  +30%/yr since 2024, with 50–70% drawdowns. Its coin list is also today's survivors (coins that
  collapsed, like LUNA, FTT and EOS, aren't in the free data), which inflates it.
- 2026 to date: `trend` −5.8%, `onchain_trend` −12.9%.

### NSE equities: not yet tested on real data

The NSE strategies (`momentum`, `smooth_momentum`, `meanrev`, `ml`) have been tested for correctness on
synthetic data only, because the build environment could not reach NSE or Yahoo. Run the walk-forward
yourself (below) before trusting any of them. The one strong lesson from the cost model already holds:
**at Rs 10,000, the flat ~Rs 15 DP charge per sell is about 0.6% of a Rs 2,500 position.** High-turnover
strategies like `meanrev` are therefore almost impossible to make profitable at this size. Low-turnover
monthly momentum with 2–4 stocks is the realistic option.

`smooth_momentum` is the less common idea for NSE: among the strongest stocks it prefers those that rose
through many small steady gains rather than a few jumps ("frog in the pan", Da, Gurun and Warachka, 2014).
Retail tools rarely implement it, and it costs no extra data.

## Quick start (on your own computer)

```bash
cd trading-lab
pip install -r requirements.txt
python -m pytest -q tests                      # 31 tests, incl. "no strategy peeks at future data"

# NSE: build your own official price database (free, no account; first run ~20-30 min)
python run.py update-data --from 2018-01-01    # later runs only fetch new days
python run.py report --source nse-official --test-start 2020-01-01   # every strategy, one table

# crypto, real data, free
python run.py report --source coinmetrics --test-start 2019-01-01

# one strategy in detail (yearly picks + parameter grid)
python run.py walkforward --source nse-official --strategy smooth_momentum --test-start 2020-01-01

# paper trading: what to hold now, and orders for the next session
python run.py signals --source binance --strategy trend --set ma=100 --since 2026-10-01
python run.py signals --source nse-official --strategy momentum --set top_n=3 lookback=126 --since 2026-10-01
```

Results (equity curves, trades, parameter grids) are written to `results/`.

## Daily paper trading

1. Copy `portfolio.example.json` to `portfolio.json`. Keep the strategies you want, and set their
   parameters from your `report` / `walkforward` results.
2. Run this once a day after market close (6 pm IST or later, when NSE has published the day's file):
   ```bash
   python run.py daily
   ```
   It refreshes NSE data, replays every strategy from its `since` date, prints holdings and the orders
   for the next session, and appends a line to `results/paper_journal.csv`.
3. Schedule it with cron (Linux/Mac: `0 19 * * 1-5 cd /path/to/trading-lab && python run.py daily`) or
   Windows Task Scheduler.

If the data is too old (more than 2 days for crypto, 4 days for NSE), the tool prints **STALE DATA** and
gives no orders. This matters for `onchain_trend`: its MVRV data is only current when the CoinMetrics
Community API is reachable. The free GitHub files were about 4.5 months behind when this was written.

## Zerodha (optional, after paper trading)

Uses the free Kite Connect Personal API for orders, holdings and cash. Prices still come from the free
data store, because the free plan has no market data.

1. At https://developers.kite.trade create a Personal app, then put the keys in `trading-lab/.env`
   (git-ignored):
   ```
   KITE_API_KEY=...
   KITE_API_SECRET=...
   ```
2. `pip install kiteconnect`, then once each day: `python run.py zerodha-login`
3. `python run.py zerodha --name nse-smooth-momentum` shows the strategy's target vs. your real holdings
   and the orders needed (dry run). Add `--place` to send them; you must type `YES` to confirm.

How it stays safe:
- It only touches the symbols the strategy trades. Your other holdings are never sold.
- It places LIMIT delivery (CNC) orders only, 1% from the last close, with a per-order value cap.
  Outside market hours they go as after-market orders.
- Unfilled orders expire. The next run compares real holdings with the target and re-issues what's missing.
- SEBI's retail-algo rules may require API orders to come from a static IP registered with Zerodha.
  If orders are rejected for that reason, the tool says so.

## Data: the permanent setup

| Use | Source | Cost | Status |
|---|---|---|---|
| Crypto live signals | Binance public market-data API (`--source binance`) | free, no key | built |
| Crypto on-chain (MVRV) | CoinMetrics Community API, falling back to its GitHub files (`--source coinmetrics`) | free, no key | built; the API is daily, the GitHub files can lag months |
| NSE official end-of-day | NSE daily bhavcopy files → `data/nse_eod.sqlite` (`update-data`, `--source nse-official`) | free, official | built |
| NSE alternative | Yahoo Finance via `yfinance` (`--source nse`) | free, unofficial | built |
| NSE orders (optional) | Zerodha Kite Connect Personal API (`zerodha-login`, `zerodha`) | free | built |

Bhavcopy prices are raw, so the store back-adjusts splits and bonuses using the adjusted "previous close"
that NSE publishes on each ex-date. Dividends are not adjusted, which slightly understates returns.
Renamed symbols (e.g. ZOMATO → ETERNAL) keep their history under the old name.

### Where an API key is needed

| Task | API key needed? |
|---|---|
| All price data (NSE and crypto) | **No.** Everything above is free and keyless. |
| Paper trading / `signals` | **No.** |
| Order placement on Zerodha | Yes: Kite Connect Personal (free), kept in `.env`. Optional. |
| Automatic order placement on Binance | Yes: Binance API key with trading only, withdrawals off. Optional, later. |

Every download is stored under `data/cache/`. If a provider is down, renamed or blocked, the tool uses
the stored copy and prints a warning instead of failing. Any source that produces daily OHLCV can plug in
through `lab/data.py`.

## Safety rules (please keep them)

- **Paper trade first** for at least 4–8 weeks with `signals`, and compare against what the backtest expected.
- **Place orders manually** at first. Monthly momentum is only 3–6 orders a month. Use `zerodha --place`
  only after paper results match the backtest.
- When you add exchange or broker keys later: put them in `.env` (git-ignored), never share them in chat,
  **disable withdrawals**, and whitelist your IP.
- Decide your maximum loss in advance (for example −25%) and stop the strategy if it hits it.

## Layout

```
lab/costs.py       NSE delivery and crypto cost models (verify rates with your broker)
lab/data.py        data loaders + local store with fallback
lab/nse_store.py   official NSE bhavcopy downloader, SQLite store, split/bonus adjustment
lab/strategies.py  momentum, smooth_momentum, meanrev, trend, onchain_trend, rotation, buyhold
lab/ml.py          gradient-boosting / logistic model, retrained on past data only
lab/backtest.py    next-open fills, whole shares, cash limits, pending orders
lab/validate.py    yearly walk-forward + parameter-robustness grid
lab/zerodha.py     Kite Connect: login, holdings/cash, order planning, guarded LIMIT order placement
portfolio.example.json   strategies to paper trade daily (copy to portfolio.json)
run.py             CLI: update-data | report | backtest | walkforward | signals | daily | zerodha-login | zerodha
tests/             correctness tests, incl. a no-lookahead check for every strategy
```
