"""Machine-learning strategy, trained strictly on the past.

Every month (quarter, for stocks) the model is retrained on all samples whose outcome was already known
on that day (a sample from day s with an h-day horizon only becomes usable on day
s+h). It then predicts until the next retrain. This mimics running it live; a model
fitted once on the full history would look far better and mean nothing.

Two modes:
  timing  (top_n=None): per asset, hold it while P(price higher in h days) is high (crypto)
  ranking (top_n=k):    monthly, hold the k stocks most likely to beat the median (NSE)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data import Panel
from .strategies import _frame, _tradable, period_starts, rsi, simple_returns, sma


def _features(panel: Panel, syms: list[str]) -> dict[str, pd.DataFrame]:
    c = panel.close[syms]
    r1 = simple_returns(c)
    f = {
        "r5": c / c.shift(5) - 1,
        "r20": c / c.shift(20) - 1,
        "r60": c / c.shift(60) - 1,
        "r120": c / c.shift(120) - 1,
        "d20": c / sma(c, 20) - 1,
        "d50": c / sma(c, 50) - 1,
        "d200": c / sma(c, 200) - 1,
        "vol20": r1.rolling(20, min_periods=20).std(),
        "rsi14": rsi(c, 14) / 100,
    }
    mkt = f["r20"].mean(axis=1)
    f["mkt_r20"] = pd.DataFrame({s: mkt for s in syms})
    f["rel_r20"] = f["r20"].sub(mkt, axis=0)
    if "mvrv" in panel.extra:
        f["mvrv_pct"] = panel.extra["mvrv"].reindex(columns=syms).expanding(min_periods=365).rank(pct=True)
    return f


def _model(kind: str):
    if kind == "logit":
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        return make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=500))
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(max_iter=150, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=100,
                                          l2_regularization=1.0, early_stopping=False, random_state=0)


def ml(panel: Panel, capital: float, assets: list[str] | None = None, horizon: int = 10, threshold: float = 0.55,
       exit_band: float = 0.05, top_n: int | None = None, benchmark: str | None = None, regime_ma: int = 0,
       min_train: int = 1000, model: str = "gb", target_vol: float = 0.6, vol_len: int = 30,
       retrain: str | None = None) -> pd.DataFrame:
    syms = assets or _tradable(panel, benchmark)
    c = panel.close[syms]
    feats = _features(panel, syms)
    names = sorted(feats)
    X = np.stack([feats[n].to_numpy(dtype=float) for n in names], axis=-1)  # (T, N, F)
    fwd = (c.shift(-horizon) / c - 1).to_numpy(dtype=float)  # outcome; only used once it is in the past
    if top_n:
        y = (fwd > np.nanmedian(fwd, axis=1, keepdims=True)).astype(float)
    else:
        y = (fwd > 0).astype(float)
    y[np.isnan(fwd)] = np.nan
    valid = np.isfinite(X).all(axis=-1) & np.isfinite(y)

    T, N = len(panel.dates), len(syms)
    prob = np.full((T, N), np.nan)
    # stock universes are big, so retrain quarterly there; crypto retrains monthly
    retrain = [panel.dates.get_loc(d) for d in period_starts(panel.dates, retrain or ("Q" if top_n else "M"))]
    for j, t in enumerate(retrain):
        known = valid[: max(t - horizon + 1, 0)]  # samples whose outcome was known by day t
        if known.sum() < min_train:
            continue
        rows = np.nonzero(known)
        clf = _model(model).fit(X[: t - horizon + 1][rows], y[: t - horizon + 1][rows])
        stop = retrain[j + 1] if j + 1 < len(retrain) else T
        block = X[t:stop]
        ok = np.isfinite(block).all(axis=-1)
        p = np.full(ok.shape, np.nan)
        if ok.any():
            p[ok] = clf.predict_proba(block[ok])[:, 1]
        prob[t:stop] = p

    if benchmark and regime_ma and benchmark in panel.symbols:
        b = panel.close[benchmark]
        regime_ok = (b > sma(b, regime_ma)).fillna(False).to_numpy()
    else:
        regime_ok = np.ones(T, dtype=bool)

    if top_n:  # monthly ranking (equities)
        slot = capital / top_n
        rows = {}
        C = c.to_numpy(dtype=float)
        for d in period_starts(panel.dates, "M"):
            t = panel.dates.get_loc(d)
            if not regime_ok[t] or np.isnan(prob[t]).all():
                rows[d] = {}
                continue
            ok = np.isfinite(prob[t]) & np.isfinite(C[t]) & (C[t] <= 0.95 * slot) & (prob[t] > threshold)
            best = np.nonzero(ok)[0][np.argsort(-prob[t][ok])][:top_n]
            rows[d] = {syms[k]: 1.0 / top_n for k in best}
        return _frame(rows, syms)

    # daily timing (crypto): enter above threshold, exit below threshold - exit_band
    state = np.zeros((T, N))
    on = np.zeros(N)
    for t in range(T):
        p = prob[t]
        on = np.where(p > threshold, 1.0, np.where(p < threshold - exit_band, 0.0, on))
        on = np.where(np.isnan(p) | ~regime_ok[t], 0.0, on)
        state[t] = on
    rv = simple_returns(c).rolling(vol_len, min_periods=vol_len).std() * np.sqrt(panel.periods_per_year)
    size = (target_vol / rv).clip(upper=1.0).fillna(0.0).to_numpy()
    return pd.DataFrame(state * size / N, index=panel.dates, columns=syms)
