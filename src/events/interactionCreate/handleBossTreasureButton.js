// BOSS 亂入寶箱按鈕
//
// 開寶箱：boss_chest_<bossId>_<treasureId>（公用，先搶先贏，無 owner 鎖）
// 賭局：boss_gtake_ / boss_groll_ <bossId>_<treasureId>_<userId>（owner 鎖，只有戰利品擁有者能操作）
require("colors");
const { MessageFlags } = require("discord.js");
const bossTreasure = require("../../features/boss/bossTreasure");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const id = interaction.customId;
  const isOpen = id.startsWith(bossTreasure.PREFIX);
  const isTake = id.startsWith(bossTreasure.TAKE_PREFIX);
  const isRoll = id.startsWith(bossTreasure.ROLL_PREFIX);
  if (!isOpen && !isTake && !isRoll) return;
  try {
    if (isTake) {
      await bossTreasure.resolveGamble(client, interaction, "take");
    } else if (isRoll) {
      await bossTreasure.resolveGamble(client, interaction, "roll");
    } else {
      await bossTreasure.claim(client, interaction);
    }
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
