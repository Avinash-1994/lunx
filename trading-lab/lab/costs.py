"""Transaction cost models.

With ~Rs 10,000 of capital, costs decide whether a strategy is viable at all,
so they are modelled explicitly rather than as a single "fee %".

All rates are approximate public figures; verify them against your broker's
charges page before trusting a backtest.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class NseDeliveryCosts:
    """NSE equity delivery (CNC) charges, modelled on a discount broker.

    The DP charge is a flat fee per scrip on every sell day. On a Rs 2,500
    position it alone is ~0.6%, which is why few positions and low turnover
    matter so much at small capital.
    """

    brokerage_rate: float = 0.0          # most discount brokers: free delivery
    brokerage_max: float = 20.0          # per order cap, if brokerage_rate > 0
    stt_rate: float = 0.001              # 0.1% on buy and on sell
    exchange_rate: float = 0.0000297     # NSE transaction charge
    sebi_rate: float = 0.000001          # Rs 10 per crore
    stamp_rate_buy: float = 0.00015      # 0.015% on buy side only
    gst_rate: float = 0.18               # on brokerage + exchange + SEBI fees
    dp_charge_per_sell: float = 15.34    # flat, per scrip per sell day (incl. GST)
    slippage: float = 0.0005             # 0.05% assumed bid-ask/impact per side
    fractional: bool = False             # whole shares only
    tax_rate_on_gains: float = 0.20      # STCG on listed equity (approx.)

    def fee(self, side: str, notional: float) -> float:
        """Charges in rupees for one order of `notional` value (excludes slippage)."""
        if notional <= 0:
            return 0.0
        brokerage = min(notional * self.brokerage_rate, self.brokerage_max)
        exchange = notional * self.exchange_rate
        sebi = notional * self.sebi_rate
        gst = (brokerage + exchange + sebi) * self.gst_rate
        stt = notional * self.stt_rate
        total = brokerage + exchange + sebi + gst + stt
        if side == "buy":
            total += notional * self.stamp_rate_buy
        else:
            total += self.dp_charge_per_sell
        return total


@dataclass(frozen=True)
class CryptoSpotCosts:
    """Crypto spot exchange fees (Binance-like taker fee)."""

    fee_rate: float = 0.001              # 0.1% per side
    slippage: float = 0.0005
    fractional: bool = True
    tax_rate_on_gains: float = 0.30      # India: flat 30% on crypto gains, no loss set-off

    def fee(self, side: str, notional: float) -> float:
        if notional <= 0:
            return 0.0
        return notional * self.fee_rate


@dataclass(frozen=True)
class ZeroCosts:
    """For tests: no fees, no slippage."""

    slippage: float = 0.0
    fractional: bool = True
    tax_rate_on_gains: float = 0.0

    def fee(self, side: str, notional: float) -> float:
        return 0.0
