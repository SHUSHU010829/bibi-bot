// src/features/casino/roulette/numbers.js

const RED_NUMS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const BLACK_NUMS = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);

const WHEEL_ORDER = [
  0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,
  24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26,
];

const COL1 = new Set([1,4,7,10,13,16,19,22,25,28,31,34]);
const COL2 = new Set([2,5,8,11,14,17,20,23,26,29,32,35]);
const COL3 = new Set([3,6,9,12,15,18,21,24,27,30,33,36]);

const BET_TYPES = {
  // 1:1
  outside_red:   { label: '紅色',   payout: 1, numbers: [...RED_NUMS] },
  outside_black: { label: '黑色',   payout: 1, numbers: [...BLACK_NUMS] },
  outside_odd:   { label: '奇數',   payout: 1, numbers: [1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,33,35] },
  outside_even:  { label: '偶數',   payout: 1, numbers: [2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36] },
  outside_low:   { label: '1–18',  payout: 1, numbers: Array.from({length:18}, (_,i) => i+1) },
  outside_high:  { label: '19–36', payout: 1, numbers: Array.from({length:18}, (_,i) => i+19) },
  // 2:1
  outside_dozen1: { label: '第一打', payout: 2, numbers: Array.from({length:12}, (_,i) => i+1) },
  outside_dozen2: { label: '第二打', payout: 2, numbers: Array.from({length:12}, (_,i) => i+13) },
  outside_dozen3: { label: '第三打', payout: 2, numbers: Array.from({length:12}, (_,i) => i+25) },
  outside_col1:   { label: '第一列', payout: 2, numbers: [...COL1] },
  outside_col2:   { label: '第二列', payout: 2, numbers: [...COL2] },
  outside_col3:   { label: '第三列', payout: 2, numbers: [...COL3] },
};

module.exports = {
  RED_NUMS, BLACK_NUMS, WHEEL_ORDER,
  BET_TYPES,
};
