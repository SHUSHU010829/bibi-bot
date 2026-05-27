require("colors");
const { MessageFlags } = require("discord.js");
const { BADGES, BADGE_BY_ID } = require("../../leveling/badgeDefinitions");
const { getLevelProgress } = require("../../../utils/levelMath");
const { getTier } = require("../../../utils/levelTier");
const gameTitleService = require("../../gameTitles/gameTitleService");

const TIER_TITLE_VALUE = "__tier_default__";
const GAME_TITLE_PREFIX = "gt:";

async function autocomplete(client, interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "徽章") return interaction.respond([]);

    const doc = await client.userLevelsCollection?.findOne({
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    const owned = new Set(doc?.badges || []);

    const tier = getTier(getLevelProgress(doc?.totalXp || 0).level);
    const tierOption = {
      name: `${tier.emoji} 等級稱號 ・ ${tier.label}`,
      value: TIER_TITLE_VALUE,
    };

    const query = (focused.value || "").toLowerCase();
    const tierMatchesQuery =
      !query ||
      tier.label.toLowerCase().includes(query) ||
      tier.key.toLowerCase().includes(query) ||
      "等級".includes(query) ||
      "tier".includes(query);

    const badgeOpts = BADGES.filter((b) => owned.has(b.id))
      .filter(
        (b) =>
          !query ||
          b.name.toLowerCase().includes(query) ||
          b.id.toLowerCase().includes(query)
      )
      .map((b) => ({ name: `${b.emoji} ${b.name}`, value: b.id }));

    // 已解鎖的遊戲稱號（挖礦 / 賭場 / 股市…）也可當等級卡稱號展示
    const unlockedGameTitles = new Set(doc?.gameTitles || []);
    const gameTitleOpts = gameTitleService
      .order()
      .filter((id) => unlockedGameTitles.has(id))
      .map((id) => {
        const d = gameTitleService.def(id);
        return {
          name: `${gameTitleService.categoryLabel(d.category)} ・ ${d.emoji || ""} ${d.name || id}`.trim(),
          value: `${GAME_TITLE_PREFIX}${id}`,
          _q: `${d.name || ""}${id}${gameTitleService.categoryLabel(d.category)}`.toLowerCase(),
        };
      })
      .filter((o) => !query || o._q.includes(query))
      .map(({ name, value }) => ({ name, value }));

    const opts = (tierMatchesQuery ? [tierOption] : [])
      .concat(badgeOpts)
      .concat(gameTitleOpts)
      .slice(0, 25);

    await interaction.respond(opts);
  } catch (error) {
    console.log(`[ERROR] /level title autocomplete: ${error}`.red);
    try {
      await interaction.respond([]);
    } catch {}
  }
}

async function run(client, interaction) {
  const sub = interaction.options.getSubcommand();

  try {
    if (!client.userLevelsCollection) {
      return interaction.reply({
        content: "🔧 等級系統尚未啟動",
        flags: MessageFlags.Ephemeral,
      });
    }

    const badgeId = interaction.options.getString("徽章");

    if (badgeId === TIER_TITLE_VALUE) {
      const doc = await client.userLevelsCollection.findOne({
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      const tier = getTier(getLevelProgress(doc?.totalXp || 0).level);
      await client.userLevelsCollection.updateOne(
        { userId: interaction.user.id, guildId: interaction.guildId },
        { $set: { title: null, updatedAt: new Date() } },
        { upsert: true }
      );
      return interaction.reply({
        content: `✅ 稱號已設定為等級 tier **${tier.emoji} ${tier.label}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 遊戲稱號（挖礦 / 賭場…）
    if (typeof badgeId === "string" && badgeId.startsWith(GAME_TITLE_PREFIX)) {
      const titleId = badgeId.slice(GAME_TITLE_PREFIX.length);
      const def = gameTitleService.def(titleId);
      if (!def) {
        return interaction.reply({
          content: "❌ 找不到該稱號",
          flags: MessageFlags.Ephemeral,
        });
      }
      const result = await gameTitleService.setActive(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        titleId,
      });
      if (!result.ok) {
        return interaction.reply({
          content:
            result.reason === "locked"
              ? `❌ 你還沒解鎖 **${gameTitleService.label(titleId)}**`
              : "🔧 操作失敗，請稍後再試",
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content: `✅ 稱號已設定為 **${gameTitleService.label(titleId)}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const badge = BADGE_BY_ID.get(badgeId);
    if (!badge) {
      return interaction.reply({
        content: "❌ 找不到該徽章",
        flags: MessageFlags.Ephemeral,
      });
    }

    const doc = await client.userLevelsCollection.findOne({
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    if (!doc?.badges?.includes(badgeId)) {
      return interaction.reply({
        content: `❌ 你還沒解鎖 ${badge.emoji} **${badge.name}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await client.userLevelsCollection.updateOne(
      { _id: doc._id },
      {
        $set: {
          title: `${badge.emoji} ${badge.name}`,
          updatedAt: new Date(),
        },
      }
    );

    await interaction.reply({
      content: `✅ 稱號已設定為 **${badge.emoji} ${badge.name}**`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.log(`[ERROR] /level title ${sub}:\n${error}\n${error.stack}`.red);
    const reply = { content: "🔧 操作失敗，請呼叫舒舒！", flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
}

module.exports = { run, autocomplete };
