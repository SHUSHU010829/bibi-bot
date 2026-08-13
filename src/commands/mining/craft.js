require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, craft, dungeon, fishing } = require("../../config");
const craftService = require("../../features/mining/craftService");
const { materialLabel } = require("../../features/mining/craftMaterials");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const workshopView = require("../../features/workshop/workshopView");
const {
  buildChoices,
  filterChoices,
  resolveChoice,
  MAX_OPTIONS,
} = require("../../utils/choiceInput");
const { buildChoiceErrorContainer } = require("../../utils/choiceErrorContainer");

// 配方數已超過 Discord 靜態 choices 上限（25），改走 autocomplete。
//
// 沒打字時只回得了 25 筆，若照 config 原順序切，排在後面的整個類別會完全消失
// （拓荒錘、魔晶系列全都在第 26 筆之後，而拓荒錘是參加主線活動的必要前置）。
// 所以空字串時改成「各類別輪流取」，保證每個分類都露得到；有打字就照一般過濾。
function balancedSample(recipes, limit) {
  const byType = new Map();
  for (const r of recipes) {
    const t = r.result?.type || "?";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }
  const queues = [...byType.values()];
  const out = [];
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (!q.length) continue;
      out.push(q.shift());
      if (out.length >= limit) break;
    }
  }
  return out;
}

function recipeChoices(recipes = craft?.recipes || []) {
  return buildChoices(recipes, (r) => ({ name: r.name, value: r.id }));
}

function recipeMatches(query) {
  const q = (query || "").trim();
  if (!q) return recipeChoices(balancedSample(craft?.recipes || [], MAX_OPTIONS));
  return filterChoices(recipeChoices(), q).slice(0, MAX_OPTIONS);
}

// 裝備標籤：依類型取鎬子 / 武器 / 釣竿 / 盾定義。
function gearLabel(type, id) {
  if (type === "weapon") {
    const d = (dungeon?.weapons || {})[id] || {};
    return `${d.emoji || "👊"} ${d.name || id}`;
  }
  if (type === "rod") {
    const d = (fishing?.rods || {})[id] || {};
    return `${d.emoji || "🎣"} ${d.name || id}`;
  }
  if (type === "shield") {
    if (!id) return "🛡️ （未裝盾）";
    const d = (dungeon?.shields || {})[id] || {};
    return `${d.emoji || "🛡️"} ${d.name || id}`;
  }
  const d = (mining?.pickaxes || {})[id] || {};
  return `${d.emoji || "⛏️"} ${d.name || id}`;
}

module.exports = {
  channelBuckets: ["general", "mining", "fishing"],
  data: new SlashCommandBuilder()
    .setName("合成")
    .setDescription("用礦石與魚合成更好的鎬子、武器或釣竿 🔨")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("裝備")
        .setDescription("要合成的鎬子或武器；不填則打開工坊「合成」分頁，用按鈕直接合成")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addBooleanOption((o) =>
      o
        .setName("確認")
        .setDescription("確認替換目前仍可用的裝備")
        .setRequired(false)
    ),

  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused(true);
    try {
      if (focused.name !== "裝備") return interaction.respond([]).catch(() => {});
      return interaction.respond(recipeMatches(focused.value)).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /合成 autocomplete: ${error}`.red);
      return interaction.respond([]).catch(() => {});
    }
  },

  run: async (client, interaction) => {
    const recipeId = interaction.options.getString("裝備");

    // 不指定配方 → 直接開工坊（合成分頁，ephemeral）
    if (!recipeId) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (!mining?.enabled || !client.miningProfilesCollection) {
          return interaction.editReply("🔧 合成系統尚未啟動！");
        }
        const view = await workshopView.buildView(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          displayName:
            interaction.member?.displayName ||
            interaction.user.displayName ||
            interaction.user.username,
          tab: "craft",
        });
        return interaction.editReply(view);
      } catch (error) {
        console.log(`[ERROR] /合成 開工坊:\n${error}\n${error.stack}`.red);
        return interaction.editReply("🔧 開工坊失敗，請呼叫舒舒！").catch(() => {});
      }
    }

    // 指定配方 → 維持原本的公開合成流程（直接執行）
    await interaction.deferReply();

    try {
      const picked = resolveChoice(recipeId, recipeChoices());
      if (!picked.ok) {
        return interaction.editReply({
          components: [
            buildChoiceErrorContainer(picked, {
              what: "配方",
              hint: "-# 不填「裝備」直接送出可以打開工坊，用按鈕挑配方最快。",
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const confirm = interaction.options.getBoolean("確認") || false;

      const result = await craftService.craftItem(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        recipeId: picked.value,
        confirm,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 合成系統尚未啟動！");
        }
        if (result.reason === "no_recipe") {
          return interaction.editReply("❌ 找不到這個配方。");
        }
        if (result.reason === "insufficient") {
          const lines = result.missing.map(
            (m) =>
              `${materialLabel(m.mat, m.need)}（你有 ${m.have}，還缺 ${m.need - m.have}）`
          );
          return interaction.editReply(
            `❌ 材料不足，無法合成 **${result.recipe.name}**：\n${lines.join("\n")}`
          );
        }
        if (result.reason === "confirm_needed") {
          const curLabel = gearLabel(result.type, result.current.id);
          const relationHint =
            result.relation === "upgrade"
              ? "（雖然是升級，但舊裝備剩餘耐久不會保留也無法折抵）"
              : result.relation === "downgrade"
                ? "（這是降級替換，請再三確認）"
                : "（這是同級替換）";
          const upgradeHint = result.upgradeRecipe
            ? `\n\n🔮 **想升級的話這個配方不對**：**${result.recipe.name}** 只會重打一把同階的 ${curLabel}（耐久補滿），階級不會變。\n` +
              `要升級請改用 **${result.upgradeRecipe.name}**。`
            : "";
          return interaction.editReply(
            `⚠️ 你目前的 **${curLabel}** 還有 ${result.current.durability} 次耐久，` +
              `合成 **${result.recipe.name}** 會直接替換掉它${relationHint}。\n` +
              `確定要換，請再執行一次並把 \`確認\` 設為 \`true\`。${upgradeHint}`
          );
        }
        return interaction.editReply("🔧 合成失敗，請稍後再試。");
      }

      const matLines = Object.entries(result.recipe.materials).map(([mat, qty]) =>
        materialLabel(mat, qty)
      );
      const resultLabel = `${result.resultEmoji || ""} ${result.resultName}`.trim();
      const isWeapon = result.type === "weapon";
      const isRod = result.type === "rod";
      const isShield = result.type === "shield";
      const isAppraisalTrigger = result.type === "stone_appraisal_trigger";
      const tail = isWeapon
        ? "-# 帶著武器去 /地下城 打怪吧！用 /裝備 查看裝備"
        : isRod
          ? "-# 帶著新釣竿去 /釣魚 吧！用 /裝備 查看裝備"
          : isShield
            ? "-# 帶著盾去 /地下城 地下城面板挑樓層！盾在戰鬥中觸發格擋才扣耐久"
            : isAppraisalTrigger
              ? "-# 10 分鐘內按下方「立刻賭石」開出，過期就失效"
              : "-# 用 /裝備 查看裝備，/挖礦 開挖！";
      const accent = isWeapon ? 0xe67e22 : isRod ? 0x16a085 : isShield ? 0x95a5a6 : 0x9b59b6;

      const container = new ContainerBuilder()
        .setAccentColor(accent)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🔨 合成成功\n你打造出了 **${resultLabel}**！`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**消耗材料**\n${matLines.join("\n")}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**耐久**\n${result.durability == null ? "永久" : `${result.durability} 次`}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**累積合成**\n${result.craftCountTotal} 件`,
          ),
        )
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(tail));

      if (isAppraisalTrigger && result.appraiseTs) {
        const fee = (mining?.stoneAppraisal?.feePerStone || 0) * (result.appraiseQty || 1);
        container.addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`mining_appraise_${interaction.user.id}_${result.appraiseTs}`)
              .setLabel(`🔍 立刻賭石（${result.appraiseQty || 1} 顆・${fee.toLocaleString()} 幣）`)
              .setStyle(ButtonStyle.Primary),
          ),
        );
      }

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      gameTitleService
        .check(
          client,
          {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            member: interaction.member,
          },
          ["mining"]
        )
        .catch(() => {});

      // 合成任務進度（非阻塞）
      await applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        [{ questId: "weekly_craft" }]
      );
    } catch (error) {
      console.log(`[ERROR] /合成:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 合成失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
