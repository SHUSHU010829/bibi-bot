require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const titleManager = require("../../features/mining/titleManager");

function titleChoices() {
  const defs = mining?.titles?.defs || {};
  const order = titleManager.titleOrder();
  return order
    .filter((id) => defs[id])
    .map((id) => ({ name: `${defs[id].emoji || ""} ${defs[id].name || id}`.trim(), value: id }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("稱號")
    .setDescription("查看與切換你的挖礦稱號 🏅")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName("清單").setDescription("查看所有稱號與你的解鎖進度")
    )
    .addSubcommand((s) =>
      s
        .setName("設定")
        .setDescription("切換目前展示的稱號")
        .addStringOption((o) =>
          o
            .setName("稱號")
            .setDescription("要展示的稱號（需先解鎖）")
            .setRequired(true)
            .addChoices(...titleChoices())
        )
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !client.miningProfilesCollection) {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }

      const sub = interaction.options.getSubcommand();
      if (sub === "清單") return await handleList(client, interaction);
      if (sub === "設定") return await handleSet(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /稱號:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 稱號操作失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};

async function handleList(client, interaction) {
  const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
  const unlocked = new Set(profile.unlocked_titles || []);
  const active = profile.active_title || "novice_miner";
  const defs = mining?.titles?.defs || {};
  const order = titleManager.titleOrder();

  const lines = order
    .filter((id) => defs[id])
    .map((id) => {
      const d = defs[id];
      const label = `${d.emoji || ""} ${d.name || id}`.trim();
      let mark = "🔒";
      if (id === active) mark = "⭐";
      else if (unlocked.has(id)) mark = "✅";
      const cond = unlocked.has(id) ? "" : `（${d.desc || ""}）`;
      return `${mark} **${label}**${cond}`;
    });

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏅 ${interaction.user.username} 的稱號`)
    .setDescription(lines.join("\n"))
    .setFooter({
      text: "⭐ 展示中 ・ ✅ 已解鎖 ・ 🔒 未解鎖｜用 /稱號 設定 來切換展示",
    });

  await interaction.editReply({ embeds: [embed] });
}

async function handleSet(client, interaction) {
  const titleId = interaction.options.getString("稱號");

  const result = await titleManager.setActiveTitle(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    titleId,
  });

  if (!result.ok) {
    if (result.reason === "no_title") {
      return interaction.editReply("❌ 找不到這個稱號。");
    }
    if (result.reason === "locked") {
      return interaction.editReply(
        `🔒 你還沒解鎖 **${titleManager.titleLabel(titleId)}**！\n條件：${result.def?.desc || "—"}`
      );
    }
    return interaction.editReply("🔧 切換稱號失敗，請稍後再試。");
  }

  await interaction.editReply(
    `✅ 已將展示稱號切換為 **${titleManager.titleLabel(titleId)}**！`
  );
}
