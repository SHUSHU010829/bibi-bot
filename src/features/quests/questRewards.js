// 任務獎勵：金幣（quest.reward）＋可選道具（quest.rewardItems: { <key>: qty }）的共用工具。
// 發放、顯示文字、按鈕標籤全部走這裡，避免各處各自組字串而漏掉道具或印出英文 key。

const { COIN_EMOJI } = require("../../constants/coin");

// 任務可發的道具獎勵：key → 中文標籤 + 寫入 miningProfiles 的欄位。
// 新增道具獎勵種類時補這裡（並同步 bibi-website botDefs.ts 的 QUEST_ITEM_REWARDS）。
const ITEM_REWARD_DEFS = {
  cd_ticket: { emoji: "🎫", name: "CD 縮短券", field: "cd_ticket_count" },
};

const itemRewardLabel = (key) => {
  const def = ITEM_REWARD_DEFS[key];
  return def ? `${def.emoji} ${def.name}` : key;
};

const itemEntries = (rewardItems) =>
  Object.entries(rewardItems || {}).filter(
    ([key, qty]) => ITEM_REWARD_DEFS[key] && qty > 0,
  );

const hasItemRewards = (rewardItems) => itemEntries(rewardItems).length > 0;

// 把任務道具獎勵發到 miningProfiles（目前只有 cd_ticket_count）。回傳實發清單。
const grantQuestItems = async (client, userId, guildId, rewardItems) => {
  const entries = itemEntries(rewardItems);
  if (entries.length === 0) return [];
  const inc = {};
  for (const [key, qty] of entries) {
    const { field } = ITEM_REWARD_DEFS[key];
    inc[field] = (inc[field] || 0) + qty;
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );
  return entries.map(([key, qty]) => ({ key, qty }));
};

// 顯示用：金幣 + 道具組成含 emoji 的字串（給 Container / Embed）。
const rewardText = ({ reward = 0, rewardItems } = {}) => {
  const parts = [];
  if (reward > 0) parts.push(`**${reward.toLocaleString()}** ${COIN_EMOJI}`);
  for (const [key, qty] of itemEntries(rewardItems)) {
    parts.push(`**${itemRewardLabel(key)} ×${qty}**`);
  }
  return parts.length ? parts.join(" + ") : `**0** ${COIN_EMOJI}`;
};

// 按鈕標籤用：label 內顯示不了自訂金幣 emoji，金幣走 "+N"，道具走 "🎫×N"。
const claimButtonLabel = ({ reward = 0, rewardItems } = {}) => {
  const parts = [];
  if (reward > 0) parts.push(`+${reward.toLocaleString()}`);
  for (const [key, qty] of itemEntries(rewardItems)) {
    parts.push(`${ITEM_REWARD_DEFS[key].emoji}×${qty}`);
  }
  return `領取 (${parts.length ? parts.join(" ") : "+0"})`;
};

module.exports = {
  ITEM_REWARD_DEFS,
  itemRewardLabel,
  hasItemRewards,
  grantQuestItems,
  rewardText,
  claimButtonLabel,
};
