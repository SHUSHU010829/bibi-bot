// BOSS 亂入寶箱按鈕（公用，先搶先贏，無 owner 鎖）
//
// customId：boss_chest_<bossId>_<treasureId>
// 勝者由 bossTreasure.claim 的原子更新決定，手慢者收到 ephemeral 提示。
require("colors");
const { MessageFlags } = require("discord.js");
const bossTreasure = require("../../features/boss/bossTreasure");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith(bossTreasure.PREFIX)) return;
  try {
    await bossTreasure.claim(client, interaction);
  } catch (e) {
    console.log(`[BOSS] 寶箱按鈕處理失敗：${e.stack || e.message}`.red);
    const payload = { content: "❌ 開寶箱時出了點狀況，請稍後再試。", flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
};
