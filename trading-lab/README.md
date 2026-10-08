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
- \* **`rotation` is not trustworthy.** It made +499% in 2021 alone, about +1%/yr in 2022–23 and about
  +30%/yr since 2024, with 50–70% drawdowns. Its coin list is also today's survivors (coins that
  collapsed, like LUNA, FTT and EOS, aren't in the free data), which inflates it.
- 2026 to date: `trend` −5.8%, `onchain_trend` −12.9%.

### NSE equities: not yet tested on real data

The NSE strategies (`momentum`, `smooth_momentum`, `meanrev`) have been tested for correctness on
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
python -m pytest -q tests                      # 16 tests, incl. "no strategy peeks at future data"

# crypto, real data, free
python run.py walkforward --source coinmetrics --strategy onchain_trend --test-start 2019-01-01

# NSE, real data via Yahoo Finance (free)
python run.py walkforward --source nse --strategy smooth_momentum --test-start 2019-01-01
python run.py walkforward --source nse --strategy momentum --test-start 2019-01-01

# paper trading: what to hold now, and orders for the next session
python run.py signals --source binance --strategy trend --set ma=100 --since 2026-10-01
python run.py signals --source nse --strategy momentum --set top_n=3 lookback=126 --since 2026-10-01
```

Results (equity curves, trades, parameter grids) are written to `results/`.

## Data: the permanent setup

| Use | Source | Cost | Status |
|---|---|---|---|
| Crypto live signals | Binance public market-data API (`--source binance`) | free, no key | built |
| Crypto research + on-chain | CoinMetrics community data on GitHub (`--source coinmetrics`) | free | built; lags by weeks to months, so research only |
| NSE quick start | Yahoo Finance via `yfinance` (`--source nse`) | free, unofficial | built |
| NSE official end-of-day | NSE daily bhavcopy files → local store | free, official | next step (`--source csv` reads files today) |
| NSE live and orders | A broker API (e.g. Angel One SmartAPI or Upstox; check current terms) | usually free for API access | next step, once you pick a broker |

Every download is stored under `data/cache/`. If a provider is down, renamed or blocked, the tool uses
the stored copy and prints a warning instead of failing. Any source that produces daily OHLCV can plug in
through `lab/data.py`.

## Safety rules (please keep them)

- **Paper trade first** for at least 4–8 weeks with `signals`, and compare against what the backtest expected.
- **Place orders manually** at first. Monthly momentum is 3–6 orders a month. Broker API fees and SEBI's
  retail-algo rules (static IP, broker-registered algos) aren't worth it at Rs 10,000.
- When you add exchange or broker keys later: put them in `.env` (git-ignored), never share them in chat,
  **disable withdrawals**, and whitelist your IP.
- Decide your maximum loss in advance (for example −25%) and stop the strategy if it hits it.

## Layout

```
lab/costs.py       NSE delivery and crypto cost models (verify rates with your broker)
lab/data.py        data loaders + local store with fallback
lab/strategies.py  momentum, smooth_momentum, meanrev, trend, onchain_trend, rotation, buyhold
lab/backtest.py    next-open fills, whole shares, cash limits, pending orders
lab/validate.py    yearly walk-forward + parameter-robustness grid
run.py             CLI: backtest | walkforward | signals
tests/             correctness tests, incl. a no-lookahead check for every strategy
```
