const { hostedEvents: hostedEventsConfig } = require("../../config");

const DEFAULT_REFUND_FEE_RATE = 0.3;

function getRefundFeeRate() {
  const rate = hostedEventsConfig?.refundFeeRate;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return DEFAULT_REFUND_FEE_RATE;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}

function computeRefundFee(amount, rateOverride) {
  const rate =
    typeof rateOverride === "number" && Number.isFinite(rateOverride)
      ? Math.max(0, Math.min(1, rateOverride))
      : getRefundFeeRate();
  const safeAmount = Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
  if (safeAmount <= 0) return { fee: 0, net: 0, rate };
  const fee = Math.floor(safeAmount * rate);
  const net = safeAmount - fee;
  return { fee, net, rate };
}

module.exports = {
  DEFAULT_REFUND_FEE_RATE,
  getRefundFeeRate,
  computeRefundFee,
};
