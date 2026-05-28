require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { BADGES, BADGE_BY_ID } = require("../../features/leveling/badgeDefinitions");
const { getLevelProgress } = require("../../utils/levelMath");
const { getTier } = require("../../utils/levelTier");
const gameTitleService = require("../../features/gameTitles/gameTitleService");

// /稱號 = 等級卡上的稱號與展示徽章管理（合併原 /level title + /level displaybadges）
//   - 設定：選一個已解鎖徽章 / 等級 tier / 遊戲稱號當稱號
//   - 展示徽章：自選最多 5 個徽章顯示在等級卡下方
//   - 重置展示：回到預設（依解鎖順序顯示前 5 個）

const TIER_TITLE_VALUE = "__tier_default__";
const GAME_TITLE_PREFIX = "gt:";
const SLOT_NAMES = ["徽章1", "徽章2", "徽章3", "徽章4", "徽章5"];

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("稱號")
    .setDescription("管理你等級卡上的稱號與展示徽章 ✨")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("設定")
        .setDescription("從已解鎖徽章、等級 tier 或遊戲稱號中選一個當稱號")
        .addStringOption((opt) =>
          opt
            .setName("徽章")
            .setDescription("選擇徽章 / 等級稱號 / 遊戲稱號")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) => {
      sub
        .setName("展示徽章")
        .setDescription("依序選最多 5 個已解鎖徽章，顯示在等級卡下方");
      SLOT_NAMES.forEach((slot, idx) => {
        sub.addStringOption((opt) =>
          opt
            .setName(slot)
            .setDescription(
              idx === 0
                ? "第 1 格徽章（必填）"
                : `第 ${idx + 1} 格徽章（可留空）`
            )
            .setRequired(idx === 0)
            .setAutocomplete(true)
        );
      });
      return sub;
    })
    .addSubcommand((sub) =>
      sub
        .setName("重置展示")
        .setDescription("回到預設（依解鎖順序顯示前 5 個徽章）")
    ),

  autocomplete: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    const focused = interaction.options.getFocused(true);

    try {
      if (sub === "設定" && focused.name === "徽章") {
        return autocompleteTitle(client, interaction, focused);
      }
      if (sub === "展示徽章" && SLOT_NAMES.includes(focused.name)) {
        return autocompleteDisplayBadges(client, interaction, focused);
      }
      return interaction.respond([]).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /稱號 autocomplete: ${error}`.red);
      return interaction.respond([]).catch(() => {});
    }
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    try {
      if (!client.userLevelsCollection) {
        return interaction.reply({
          content: "🔧 等級系統尚未啟動",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "設定") return runSetTitle(client, interaction);
      if (sub === "展示徽章") return runSetDisplayBadges(client, interaction);
      if (sub === "重置展示") return runResetDisplayBadges(client, interaction);
    } catch (error) {
      console.log(`[ERROR] /稱號 ${sub}:\n${error}\n${error.stack}`.red);
      const reply = {
        content: "🔧 操作失敗，請呼叫舒舒！",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};

// ───────── 設定稱號（合併原 /level title 設定）─────────

async function autocompleteTitle(client, interaction, focused) {
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
}

async function runSetTitle(client, interaction) {
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
}

// ───────── 展示徽章（合併原 /level displaybadges 設定 / 重置）─────────

async function autocompleteDisplayBadges(client, interaction, focused) {
  const doc = await client.userLevelsCollection?.findOne({
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  const owned = new Set(doc?.badges || []);

  const alreadyPicked = new Set(
    SLOT_NAMES.filter((n) => n !== focused.name)
      .map((n) => interaction.options.getString(n))
      .filter(Boolean)
  );

  const query = (focused.value || "").toLowerCase();
  const opts = BADGES.filter((b) => owned.has(b.id))
    .filter((b) => !alreadyPicked.has(b.id))
    .filter(
      (b) =>
        !query ||
        b.name.toLowerCase().includes(query) ||
        b.id.toLowerCase().includes(query)
    )
    .slice(0, 25)
    .map((b) => ({ name: `${b.emoji} ${b.name}`, value: b.id }));

  await interaction.respond(opts);
}

async function runSetDisplayBadges(client, interaction) {
  const picks = SLOT_NAMES.map((n) => interaction.options.getString(n)).filter(
    Boolean
  );

  const seen = new Set();
  for (const id of picks) {
    if (seen.has(id)) {
      const b = BADGE_BY_ID.get(id);
      return interaction.reply({
        content: `❌ 重複選到 ${b ? `${b.emoji} **${b.name}**` : `\`${id}\``}，請每格選不同徽章`,
        flags: MessageFlags.Ephemeral,
      });
    }
    seen.add(id);
  }

  const doc = await client.userLevelsCollection.findOne({
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  const owned = new Set(doc?.badges || []);

  for (const id of picks) {
    const b = BADGE_BY_ID.get(id);
    if (!b) {
      return interaction.reply({
        content: `❌ 找不到徽章 \`${id}\``,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!owned.has(id)) {
      return interaction.reply({
        content: `❌ 你還沒解鎖 ${b.emoji} **${b.name}**`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  await client.userLevelsCollection.updateOne(
    { userId: interaction.user.id, guildId: interaction.guildId },
    { $set: { displayBadges: picks, updatedAt: new Date() } },
    { upsert: true }
  );

  const summary = picks
    .map((id) => {
      const b = BADGE_BY_ID.get(id);
      return `${b.emoji} ${b.name}`;
    })
    .join(" ・ ");

  await interaction.reply({
    content: `✅ 已更新展示徽章：${summary}`,
    flags: MessageFlags.Ephemeral,
  });
}

async function runResetDisplayBadges(client, interaction) {
  await client.userLevelsCollection.updateOne(
    { userId: interaction.user.id, guildId: interaction.guildId },
    { $unset: { displayBadges: "" }, $set: { updatedAt: new Date() } }
  );
  return interaction.reply({
    content: "✅ 已回到預設，等級卡會依解鎖順序顯示前 5 個徽章",
    flags: MessageFlags.Ephemeral,
  });
}
