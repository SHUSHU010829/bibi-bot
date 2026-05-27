require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const gameTitleService = require("../../features/gameTitles/gameTitleService");

function titleChoices() {
  const choices = gameTitleService
    .order()
    .map((id) => {
      const d = gameTitleService.def(id);
      return d ? { name: `${d.emoji || ""} ${d.name || id}`.trim(), value: id } : null;
    })
    .filter(Boolean)
    .slice(0, 24);
  // 第一個放「清除」讓玩家退回顯示等級稱號
  return [{ name: "（清除，顯示等級稱號）", value: "__clear__" }, ...choices];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("稱號")
    .setDescription("查看與切換你的遊戲稱號（與等級卡共用展示）🏅")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName("清單").setDescription("查看所有遊戲稱號與解鎖進度")
    )
    .addSubcommand((s) =>
      s
        .setName("設定")
        .setDescription("切換錢包卡上展示的稱號")
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
      if (!client.userLevelsCollection) {
        return interaction.editReply("🔧 稱號系統尚未啟動！");
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
  const doc = await gameTitleService.getDoc(
    client,
    interaction.user.id,
    interaction.guildId
  );
  const unlocked = new Set(doc?.gameTitles || []);
  const activeText = doc?.title || null;

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🏅 ${interaction.user.username} 的遊戲稱號`)
    .setFooter({
      text: "⭐ 展示中 ・ ✅ 已解鎖 ・ 🔒 未解鎖｜用 /稱號 設定 切換展示（也可在 /level title 設定）",
    });

  const cats = {};
  for (const id of gameTitleService.order()) {
    const d = gameTitleService.def(id);
    if (!d) continue;
    (cats[d.category] ||= []).push(id);
  }

  for (const [cat, ids] of Object.entries(cats)) {
    const lines = ids.map((id) => {
      const d = gameTitleService.def(id);
      const label = `${d.emoji || ""} ${d.name || id}`.trim();
      let mark = "🔒";
      if (activeText && activeText === label) mark = "⭐";
      else if (unlocked.has(id)) mark = "✅";
      const cond = unlocked.has(id) ? "" : `（${d.desc || ""}）`;
      return `${mark} **${label}**${cond}`;
    });
    embed.addFields({
      name: gameTitleService.categoryLabel(cat),
      value: lines.join("\n"),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleSet(client, interaction) {
  const titleId = interaction.options.getString("稱號");

  const result = await gameTitleService.setActive(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    titleId,
  });

  if (!result.ok) {
    if (result.reason === "no_title") {
      return interaction.editReply("❌ 找不到這個稱號。");
    }
    if (result.reason === "locked") {
      return interaction.editReply(
        `🔒 你還沒解鎖 **${gameTitleService.label(titleId)}**！\n條件：${gameTitleService.def(titleId)?.desc || "—"}`
      );
    }
    return interaction.editReply("🔧 切換稱號失敗，請稍後再試。");
  }

  if (result.cleared) {
    return interaction.editReply("✅ 已清除展示稱號，錢包卡將顯示你的等級稱號。");
  }
  await interaction.editReply(
    `✅ 已將展示稱號切換為 **${gameTitleService.label(titleId)}**！會顯示在錢包卡與升等公告。`
  );
}
