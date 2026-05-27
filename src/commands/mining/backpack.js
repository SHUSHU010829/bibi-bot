require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { mining } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("../../features/mining/miningProfile");
const { COIN_EMOJI } = require("../../constants/coin");

// CD 縮短券「使用」按鈕 customId 格式：mining_use_cd_ticket_<ownerId>
// 由 events/interactionCreate/handleMiningTicket.js 處理。
const USE_TICKET_PREFIX = "mining_use_cd_ticket_";

function parseUseTicketId(customId) {
  if (!customId || !customId.startsWith(USE_TICKET_PREFIX)) return null;
  const ownerId = customId.slice(USE_TICKET_PREFIX.length);
  return ownerId ? { ownerId } : null;
}

// 組出 /背包 的 Components V2 卡片，指令與按鈕互動共用，確保顯示一致。
// 回傳 { components, flags }，需以 IsComponentsV2 旗標送出（不能再帶 embeds / content）。
async function buildBackpackPayload(client, { userId, guildId, username }) {
  const profile = await getOrCreate(client, userId, guildId);
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);

  const oreLines = [];
  let totalValue = 0;
  for (const [key, def] of Object.entries(mining.ores)) {
    const qty = profile.backpack?.[key] || 0;
    const value = qty * (def.price || 0);
    totalValue += value;
    oreLines.push(
      `${def.emoji || "⛏️"} **${def.name}** ×${qty}` +
        (qty > 0 ? ` ・ ${value.toLocaleString()} ${COIN_EMOJI}` : "")
    );
  }

  const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
  const durabilityText =
    profile.pickaxe === "wood" || profile.pickaxe_durability == null
      ? "永久"
      : `耐久 ${profile.pickaxe_durability} 次`;

  const now = Date.now();
  const inCooldown = (profile.mine_cooldown_at || 0) > now;
  const cdText = inCooldown
    ? `<t:${Math.floor(profile.mine_cooldown_at / 1000)}:R>`
    : "✅ 現在可挖礦";

  const luckUses = profile.luck_potion_uses || 0;
  const ticketCount = profile.cd_ticket_count || 0;
  const fragments = profile.legendary_fragments || 0;
  const reductionMin = Math.round((mining?.cdTicketReductionMs || 0) / 60000);

  const container = new ContainerBuilder().setAccentColor(0xd2a679);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 🎒 ${username} 的背包`)
  );
  container.addSeparatorComponents(new SeparatorBuilder());

  // 礦石區
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ⛏️ 礦石\n${oreLines.join("\n")}`)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `📦 **背包容量**：${used} / ${cap}\n` +
        `💰 **全部賣出可得**：${totalValue.toLocaleString()} ${COIN_EMOJI}\n` +
        `⛏️ **目前鎬子**：${pdef.emoji || "⛏️"} ${pdef.name}（${durabilityText}）\n` +
        `⏳ **挖礦狀態**：${cdText}`
    )
  );
  container.addSeparatorComponents(new SeparatorBuilder());

  // 道具區（依用途區分：被動 / 可使用 / 素材）
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("### 🎁 道具")
  );

  // 幸運藥水：挖礦時自動生效，無需手動使用
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `🍀 **幸運藥水** ×${luckUses}\n-# 挖礦時自動生效，提升 luck`
    )
  );

  // CD 縮短券：冷卻中可主動使用 → 右側「使用」按鈕（非冷卻 / 沒券時停用）
  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🎫 **CD 縮短券** ×${ticketCount}\n-# 冷卻中使用，立即 -${reductionMin} 分（不足直接歸零）`
        )
      )
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(`${USE_TICKET_PREFIX}${userId}`)
          .setLabel("使用")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!(ticketCount > 0 && inCooldown))
      )
  );

  // 傳說素材碎片：收藏素材，目前無主動用途
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `✨ **傳說素材碎片** ×${fragments}\n-# 未來合成傳說裝備用，好好收著`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# 用 /賣礦 換金幣，或 /合成 打造更好的鎬子")
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("背包")
    .setDescription("查看你的背包：礦石、道具與挖礦狀態 🎒")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    try {
      if (!mining?.enabled || !client.miningProfilesCollection) {
        return interaction.reply({
          content: "🔧 挖礦系統尚未啟動！",
          flags: MessageFlags.Ephemeral,
        });
      }

      const payload = await buildBackpackPayload(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
      });

      await interaction.reply(payload);
    } catch (error) {
      console.log(`[ERROR] /背包:\n${error}\n${error.stack}`.red);
      const errMsg = { content: "🔧 查看背包失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errMsg).catch(() => {});
      } else {
        await interaction.reply(errMsg).catch(() => {});
      }
    }
  },

  buildBackpackPayload,
  parseUseTicketId,
  USE_TICKET_PREFIX,
};
