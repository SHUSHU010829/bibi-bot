const { hostedEvents: hostedEventsConfig } = require("../../config");

const DEFAULT_REFUND_FEE_RATE = 0.3;
const DEFAULT_PRIZE_FEE_RATE = 0.1;
const DEFAULT_PRIZE_FEE_EXEMPT_PARTICIPANTS = 5;

function clampRate(rate, fallback) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return fallback;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}

function getRefundFeeRate() {
  return clampRate(hostedEventsConfig?.refundFeeRate, DEFAULT_REFUND_FEE_RATE);
}

function getPrizeFeeRate() {
  return clampRate(hostedEventsConfig?.prizeFeeRate, DEFAULT_PRIZE_FEE_RATE);
}

function getPrizeFeeExemptParticipants() {
  const n = hostedEventsConfig?.prizeFeeExemptParticipants;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PRIZE_FEE_EXEMPT_PARTICIPANTS;
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

// 活動獎金發放的防洗錢摩擦：達免收人數時免課，否則對每筆獎金課 prizeFeeRate。
// 阻擋「開活動→全額指定發給小帳」變相轉帳；真實社群活動（參賽達門檻）不受影響。
function computePrizeFee(amount, participantCount) {
  const exempt = getPrizeFeeExemptParticipants();
  if ((participantCount || 0) >= exempt) return { fee: 0, net: Math.max(0, Math.floor(amount || 0)), rate: 0, exempt: true };
  return { ...computeRefundFee(amount, getPrizeFeeRate()), exempt: false };
}

module.exports = {
  DEFAULT_REFUND_FEE_RATE,
  getRefundFeeRate,
  getPrizeFeeRate,
  getPrizeFeeExemptParticipants,
  computeRefundFee,
  computePrizeFee,
};
