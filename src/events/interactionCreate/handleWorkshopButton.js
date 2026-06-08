// 工坊按鈕 handler：分頁切換 + 配方合成（含二次確認）。
//
// customId：
//   wsTab_<userId>_<tab>           — 切分頁
//   wsCraft_<userId>_<recipeId>    — 點某配方的「合成」按鈕（confirm=false 嘗試）
//   wsConfirm_<userId>_<recipeId>  — 二次確認替換現有裝備
//   wsCancel_<userId>              — 二次確認取消

require("colors");
const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { mining, craft, dungeon, fishing } = require("../../config");
const craftService = require("../../features/mining/craftService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const workshopView = require("../../features/workshop/workshopView");

const { TAB_PREFIX, CRAFT_PREFIX, CONFIRM_PREFIX, CANCEL_PREFIX, TABS } = workshopView;

function isFishMaterial(mat) {
  return !!(fishing?.fish && fishing.fish[mat]);
}

function materialLabel(mat, qty) {
  if (mat === "legendary_fragment") return `✨ 傳說素材碎片 ×${qty}`;
  if (isFishMaterial(mat)) {
    const f = fishing.fish[mat];
    return `${f.emoji || "🐟"} ${f.name || mat} ×${qty}`;
  }
  const def = mining?.ores?.[mat] || {};
  return `${def.emoji || "⛏️"} ${def.name || mat} ×${qty}`;
}

function gearLabel(type, id) {
  if (type === "weapon") {
    const d = (dungeon?.weapons || {})[id] || {};
    return `${d.emoji || "👊"} ${d.name || id}`;
  }
  if (type === "rod") {
    const d = (fishing?.rods || {})[id] || {};
    return `${d.emoji || "🎣"} ${d.name || id}`;
  }
  const d = (mining?.pickaxes || {})[id] || {};
  return `${d.emoji || "⛏️"} ${d.name || id}`;
}

function parseOwnerAndPayload(customId, prefix) {
  const rest = customId.slice(prefix.length);
  const firstUnderscore = rest.indexOf("_");
  if (firstUnderscore < 0) return { ownerId: rest, payload: "" };
  return {
    ownerId: rest.slice(0, firstUnderscore),
    payload: rest.slice(firstUnderscore + 1),
  };
}

function buildConfirmContainer(userId, recipeId, recipeName, currentLabel, currentDurability, relation) {
  const relationHint =
    relation === "upgrade"
      ? "（升級，但舊裝備剩餘耐久不會保留）"
      : relation === "downgrade"
        ? "（降級替換，請再三確認）"
        : "（同級替換）";
  return new ContainerBuilder()
    .setAccentColor(0xf39c12)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⚠️ 確認替換？\n你目前的 **${currentLabel}** 還有 **${currentDurability}** 次耐久，` +
          `合成 **${recipeName}** 會直接覆蓋它${relationHint}。`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${CONFIRM_PREFIX}${userId}_${recipeId}`)
          .setLabel("確認替換並合成")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${CANCEL_PREFIX}${userId}`)
          .setLabel("取消")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

function buildSuccessContainer(result) {
  const matLines = Object.entries(result.recipe.materials).map(([mat, qty]) =>
    materialLabel(mat, qty),
  );
  const resultLabel = `${result.resultEmoji || ""} ${result.resultName}`.trim();
  const accent = result.type === "weapon" ? 0xe67e22 : result.type === "rod" ? 0x16a085 : 0x9b59b6;
  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔨 合成成功\n你打造出了 **${resultLabel}**！`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**消耗材料**\n${matLines.join("\n")}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**耐久**　${result.durability == null ? "永久" : `${result.durability} 次`}\n**累積合成**　${result.craftCountTotal} 件`,
      ),
    );
}

function buildInsufficientContainer(result) {
  const lines = result.missing.map(
    (m) => `${materialLabel(m.mat, m.need)}（你有 ${m.have}，還缺 ${m.need - m.have}）`,
  );
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ❌ 材料不足\n無法合成 **${result.recipe.name}**`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
}

async function postCraftSideEffects(client, interaction) {
  gameTitleService
    .check(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
    }, ["mining"])
    .catch(() => {});

  applyQuestHooks(
    client,
    {
      interaction,
      user: interaction.user,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      username: interaction.user.username,
    },
    [{ questId: "weekly_craft" }],
  ).catch(() => {});
}

async function refreshWorkshop(client, interaction, tab) {
  const view = await workshopView.buildView(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    displayName:
      interaction.member?.displayName ||
      interaction.user.displayName ||
      interaction.user.username,
    tab,
  });
  await interaction.editReply(view);
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;

  // 分頁切換
  if (customId.startsWith(TAB_PREFIX)) {
    const { ownerId, payload: tab } = parseOwnerAndPayload(customId, TAB_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "❌ 這不是你的工坊！",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!TABS.includes(tab)) return;
    await interaction.deferUpdate();
    try {
      await refreshWorkshop(client, interaction, tab);
    } catch (err) {
      console.log(`[ERROR] wsTab handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }

  // 合成（第一次點，confirm=false）：成功 → followUp 顯示結果 + refresh 主訊息；
  // confirm_needed → followUp 顯示確認框；insufficient → followUp 顯示缺料。
  if (customId.startsWith(CRAFT_PREFIX)) {
    const { ownerId, payload: recipeId } = parseOwnerAndPayload(customId, CRAFT_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "❌ 這不是你的工坊！",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!craft?.recipes?.some((r) => r.id === recipeId)) return;
    await interaction.deferUpdate();
    try {
      const result = await craftService.craftItem(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        recipeId,
        confirm: false,
      });
      if (!result.ok && result.reason === "insufficient") {
        await interaction.followUp({
          components: [buildInsufficientContainer(result)],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      if (!result.ok && result.reason === "confirm_needed") {
        await interaction.followUp({
          components: [
            buildConfirmContainer(
              interaction.user.id,
              recipeId,
              result.recipe.name,
              gearLabel(result.type, result.current.id),
              result.current.durability,
              result.relation,
            ),
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      if (!result.ok) {
        await interaction.followUp({
          content: "🔧 合成失敗，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.followUp({
        components: [buildSuccessContainer(result)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      await refreshWorkshop(client, interaction, "craft").catch(() => {});
      postCraftSideEffects(client, interaction);
    } catch (err) {
      console.log(`[ERROR] wsCraft handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }

  // 二次確認：以 update() 直接覆蓋確認 followUp 的內容
  if (customId.startsWith(CONFIRM_PREFIX)) {
    const { ownerId, payload: recipeId } = parseOwnerAndPayload(customId, CONFIRM_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "❌ 這不是你的合成確認！",
        flags: MessageFlags.Ephemeral,
      });
    }
    try {
      const result = await craftService.craftItem(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        recipeId,
        confirm: true,
      });
      if (!result.ok && result.reason === "insufficient") {
        await interaction.update({
          components: [buildInsufficientContainer(result)],
          flags: MessageFlags.IsComponentsV2,
        });
        return;
      }
      if (!result.ok) {
        await interaction.update({
          content: "🔧 合成失敗，請稍後再試。",
          components: [],
        });
        return;
      }
      await interaction.update({
        components: [buildSuccessContainer(result)],
        flags: MessageFlags.IsComponentsV2,
      });
      postCraftSideEffects(client, interaction);
    } catch (err) {
      console.log(`[ERROR] wsConfirm handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }

  // 取消：用 update() 把確認框改成「已取消」
  if (customId.startsWith(CANCEL_PREFIX)) {
    const { ownerId } = parseOwnerAndPayload(customId, CANCEL_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "❌ 這不是你的取消！",
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.update({
      content: "🚫 已取消合成。",
      components: [],
    });
  }
};
