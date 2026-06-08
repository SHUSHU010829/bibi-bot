// 背包 / 加成 / 魚袋 分頁切換 + 刷新。
// customId：pStat_<userId>_<tab> 或 pStat_<userId>_refresh_<currentTab>

require("colors");
const { MessageFlags } = require("discord.js");

const { buildBackpackView } = require("../../features/shop/backpackView");
const { buildStatusView } = require("../../features/buff/buffView");
const foodBag = require("../../features/fishing/foodBag");
const foodBagView = require("../../features/fishing/foodBagView");
const { getOrCreate: getMiningProfile } = require("../../features/mining/miningProfile");
const { appendNav, PREFIX } = require("../../features/playerStatus/statusNav");

const refreshBucket = new Map();
const REFRESH_COOLDOWN_MS = 3000;

async function buildTab(client, interaction, tab) {
  const ctx = {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    displayName:
      interaction.member?.displayName ||
      interaction.user.displayName ||
      interaction.user.username,
  };

  if (tab === "backpack") {
    return buildBackpackView(client, ctx);
  }
  if (tab === "buff") {
    return buildStatusView(client, ctx);
  }
  if (tab === "food") {
    const profilePre = await getMiningProfile(client, ctx.userId, ctx.guildId);
    const sweepInfo = await foodBag.sweepSpoiled(client, ctx.userId, ctx.guildId, profilePre);
    const profile = sweepInfo.removed > 0
      ? await getMiningProfile(client, ctx.userId, ctx.guildId)
      : profilePre;
    return foodBagView.buildBagView({ userId: ctx.userId, profile, sweepInfo });
  }
  return null;
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;
  if (!customId.startsWith(PREFIX)) return;

  const rest = customId.slice(PREFIX.length);
  const firstUnderscore = rest.indexOf("_");
  if (firstUnderscore < 0) return;
  const ownerId = rest.slice(0, firstUnderscore);
  const payload = rest.slice(firstUnderscore + 1);

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的狀態面板！",
      flags: MessageFlags.Ephemeral,
    });
  }

  let tab;
  if (payload.startsWith("refresh_")) {
    tab = payload.slice("refresh_".length);
    const now = Date.now();
    const last = refreshBucket.get(ownerId) || 0;
    if (now - last < REFRESH_COOLDOWN_MS) {
      return interaction.reply({
        content: `🔄 太快了，等 ${Math.ceil((REFRESH_COOLDOWN_MS - (now - last)) / 1000)} 秒再刷新`,
        flags: MessageFlags.Ephemeral,
      });
    }
    refreshBucket.set(ownerId, now);
  } else {
    tab = payload;
  }

  if (!["backpack", "buff", "food"].includes(tab)) return;

  await interaction.deferUpdate();

  try {
    const view = await buildTab(client, interaction, tab);
    if (!view) {
      return interaction.followUp({
        content: "🔧 切換失敗，請稍後再試。",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
    appendNav(view, interaction.user.id, tab);
    await interaction.editReply(view);
  } catch (err) {
    console.log(`[ERROR] pStat handler (tab=${tab}):\n${err}\n${err.stack}`.red);
    await interaction.followUp({
      content: "🔧 切換失敗，請稍後再試。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
};
