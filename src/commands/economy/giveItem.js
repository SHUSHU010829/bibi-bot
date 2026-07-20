require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  InteractionContextType,
} = require("discord.js");

const { craft, coinSystem } = require("../../config");
const itemCatalog = require("../../features/barter/itemCatalog");
const inventory = require("../../features/barter/inventoryAdapter");
const { getOrCreate } = require("../../features/mining/miningProfile");

// 可發放的消耗品：profile 上的整數欄位 → 中文顯示名。
const CONSUMABLES = [
  { field: "cd_ticket_count", name: "🎫 CD 縮短券" },
  { field: "luck_potion_uses", name: "🍀 幸運藥水" },
  { field: "whetstone_inferior_count", name: "🪨 劣質磨石" },
  { field: "fishing_net_uses", name: "🕸️ 撈網" },
  { field: "advanced_trap_uses", name: "🪤 進階陷阱" },
  { field: "treasure_maps", name: "🗺️ 藏寶圖" },
  { field: "stamina_potion_count", name: "🥤 體力藥水（小）" },
  { field: "stamina_potion_medium_count", name: "🥤 體力藥水（中）" },
  { field: "stamina_potion_large_count", name: "🥤 體力藥水（大）" },
  { field: "hp_potion_small", name: "❤️ 生命藥水（小）" },
  { field: "hp_potion_medium", name: "❤️ 生命藥水（中）" },
  { field: "hp_potion_large", name: "❤️ 生命藥水（大）" },
];

// 碎片：profile 根層的複數欄位 → 名稱取自 craft.materials（單數 key）。
const FRAGMENTS = [
  { field: "legendary_fragments", mat: "legendary_fragment" },
  { field: "broken_net_fragments", mat: "broken_net_fragment" },
  { field: "broken_trap_fragments", mat: "broken_trap_fragment" },
  { field: "treasure_map_fragments", mat: "treasure_map_fragment" },
];

// 組出「可發放物品」總表：ore/crop/fish（bag:）＋ 消耗品/維修工具/碎片（inc:<欄位>）。
function buildRegistry() {
  const items = [];
  for (const c of itemCatalog.listAllChoices()) {
    items.push({ value: `bag:${c.value}`, name: c.name });
  }
  for (const it of CONSUMABLES) {
    items.push({ value: `inc:${it.field}`, name: it.name });
  }
  for (const [tier, def] of Object.entries(craft?.repairTools || {})) {
    items.push({ value: `inc:repair_tools.${tier}`, name: `${def.emoji || "🔧"} ${def.name}` });
  }
  for (const f of FRAGMENTS) {
    const def = (craft?.materials || {})[f.mat] || {};
    items.push({ value: `inc:${f.field}`, name: `${def.emoji || "🧩"} ${def.name || f.mat}` });
  }
  return items;
}

function resolveItem(value) {
  const entry = buildRegistry().find((r) => r.value === value);
  if (!entry) return null;
  if (value.startsWith("bag:")) {
    const parsed = itemCatalog.parseChoice(value.slice("bag:".length));
    if (!parsed) return null;
    return { kind: "bag", type: parsed.type, key: parsed.key, label: entry.name };
  }
  if (value.startsWith("inc:")) {
    return { kind: "inc", field: value.slice("inc:".length), label: entry.name };
  }
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("give-item")
    .setDescription("[ADMIN] Grant items to a member（礦石／魚／作物／道具／碎片）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Member receiving the items").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("item")
        .setDescription("要給的物品（從自動完成清單選擇）")
        .setAutocomplete(true)
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("qty")
        .setDescription("數量")
        .setMinValue(1)
        .setRequired(true),
    )
    .toJSON(),

  userPermissions: [PermissionFlagsBits.Administrator],

  autocomplete: async (client, interaction) => {
    const focused = (interaction.options.getFocused() || "").toString().toLowerCase();
    const reg = buildRegistry();
    const filtered = focused
      ? reg.filter(
          (r) => r.name.toLowerCase().includes(focused) || r.value.toLowerCase().includes(focused),
        )
      : reg;
    await interaction
      .respond(
        filtered.slice(0, 25).map((r) => ({
          name: r.name.slice(0, 100),
          value: r.value.slice(0, 100),
        })),
      )
      .catch(() => {});
  },

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.miningProfilesCollection) {
        return interaction.editReply("🔧 物品系統尚未啟動！");
      }

      const targetUser = interaction.options.getUser("user");
      const itemValue = interaction.options.getString("item");
      const qty = interaction.options.getInteger("qty");

      if (!qty || qty <= 0) {
        return interaction.editReply("數量必須是正整數。");
      }

      const item = resolveItem(itemValue);
      if (!item) {
        return interaction.editReply("❌ 找不到這個物品，請從自動完成清單選擇。");
      }

      // 確保玩家 profile 存在且已 normalize（避免 upsert 出殘缺文件）
      await getOrCreate(client, targetUser.id, interaction.guildId);

      if (item.kind === "bag") {
        await inventory.add(client, targetUser.id, interaction.guildId, item.type, item.key, qty);
      } else {
        await client.miningProfilesCollection.updateOne(
          { userId: targetUser.id, guildId: interaction.guildId },
          { $inc: { [item.field]: qty }, $set: { updatedAt: new Date() } },
        );
      }

      await interaction.editReply(
        `✅ 已給 ${targetUser} **${item.label} ×${qty.toLocaleString()}**`,
      );

      // Audit log：沿用 admin 發錢的稽核頻道
      const auditChannelId = coinSystem?.adminGrant?.auditLogChannelId;
      if (auditChannelId) {
        try {
          const auditChannel = await client.channels.fetch(auditChannelId).catch(() => null);
          if (auditChannel?.isTextBased?.()) {
            const container = new ContainerBuilder()
              .setAccentColor(0x57f287)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent("# 🛡️ Admin 物品發放紀錄"),
              )
              .addSeparatorComponents(new SeparatorBuilder())
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**操作者**\n<@${interaction.user.id}>`),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**對象**\n<@${targetUser.id}>`),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `**物品**\n${item.label} ×${qty.toLocaleString()}`,
                ),
              )
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# <t:${Math.floor(Date.now() / 1000)}:f>`),
              );
            await auditChannel
              .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
              .catch(() => {});
          }
        } catch (e) {
          console.log(`[ERROR] give-item audit log: ${e}`.red);
        }
      }
    } catch (error) {
      console.log(`[ERROR] /give-item:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 給物品失敗，看 console").catch(() => {});
    }
  },
};
