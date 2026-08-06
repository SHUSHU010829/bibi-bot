require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const worldEventService = require("../../features/world_event/worldEventService");
const worldEventView = require("../../features/world_event/worldEventView");
const { itemLabel, itemEmoji } = require("../../features/world_event/worldEventItems");
const worldEventScheduler = require("../../events/ready/worldEventScheduler");
const { buildChoices, respondChoices, resolveChoice } = require("../../utils/choiceInput");
const { buildChoiceErrorContainer } = require("../../utils/choiceErrorContainer");

// 主線活動沒有 trigger（一般世界事件靠挖到礦 / 釣到魚隨機觸發），
// 開跟關都得由管理員決定時機，所以另開這支指令。
function mainlineDefs() {
  return (worldEventService.allEventIds() || [])
    .map((id) => worldEventService.eventDef(id))
    .filter((d) => worldEventService.isMainline(d));
}

function mainlineChoices() {
  return buildChoices(mainlineDefs(), (d) => ({
    name: `${d.emoji || ""} ${d.label}`.trim(),
    value: d.id,
    search: `${d.id} ${d.label}`,
  }));
}

function reqLines(event) {
  return Object.entries(event.requirements_total || {})
    .map(([k, total]) => {
      const remain = (event.requirements_remaining || {})[k] || 0;
      const filled = total - remain;
      const ratio = total ? Math.max(0, Math.min(1, filled / total)) : 1;
      const on = Math.round(ratio * 12);
      const daily = (event.daily_limits || {})[k];
      return (
        `• ${itemEmoji(k)} ${itemLabel(k)}　${filled.toLocaleString()} / ${total.toLocaleString()}`
        + (daily ? `（每人每日上限 ${daily.toLocaleString()}）` : "")
        + `\n\`${"█".repeat(on)}${"░".repeat(12 - on)} ${Math.floor(ratio * 100)}%\``
      );
    })
    .join("\n");
}

const ok = (title, body, hint) => {
  const c = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return c;
};

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("worldevent-admin")
    .setDescription("[DEV] 主線世界活動開關與進度 🛤️")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("開啟")
        .setDescription("開始一個主線活動")
        .addStringOption((o) =>
          o.setName("活動").setDescription("要開啟的主線活動").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) => s.setName("進度").setDescription("查看進行中主線活動的進度與貢獻榜"))
    .addSubcommand((s) => s.setName("結束").setDescription("手動結束進行中的主線活動")),

  autocomplete: async (client, interaction) => {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "活動") return interaction.respond([]).catch(() => {});
      return respondChoices(interaction, mainlineChoices(), focused.value);
    } catch (error) {
      console.log(`[ERROR] /worldevent-admin autocomplete: ${error}`.red);
      return interaction.respond([]).catch(() => {});
    }
  },

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const activeMainline = (await worldEventService.getActiveEvents(client)).find(
        (e) => e.kind === "mainline",
      );

      if (sub === "開啟") {
        const picked = resolveChoice(interaction.options.getString("活動"), mainlineChoices());
        if (!picked.ok) {
          return interaction.editReply({
            components: [buildChoiceErrorContainer(picked, { what: "主線活動" })],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        const eventId = picked.value;
        const def = worldEventService.eventDef(eventId);
        const r = await worldEventService.tryOpenEvent(client, eventId);
        if (!r.opened) {
          const body =
            r.reason === "concurrent_full"
              ? `已經有一個主線活動進行中（**${activeMainline?.label || "?"}**），先結束它再開新的。`
              : r.reason === "disabled"
                ? "世界事件系統目前未啟用。"
                : "無法開啟，請再試一次。";
          return interaction.editReply({
            components: [worldEventView.buildSimpleError({ title: "❌ 開啟失敗", body })],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        // 立刻掃一次，讓開場公告不用等到下一分鐘
        worldEventScheduler.scanOnce(client).catch(() => {});
        const days = Math.round((new Date(r.event.ends_at) - new Date(r.event.started_at)) / 86400000);
        return interaction.editReply({
          components: [
            ok(
              `${def.emoji || "🛤️"} ${def.label} 已開啟`,
              `${reqLines(r.event)}\n\n募集期限：${days} 天（<t:${Math.floor(new Date(r.event.ends_at).getTime() / 1000)}:R>）`,
              "開場公告已送出；玩家需先打造拓荒錘才能投入資源",
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      if (!activeMainline) {
        return interaction.editReply({
          components: [
            worldEventView.buildSimpleError({
              title: "❌ 沒有進行中的主線活動",
              body: "先用 `/worldevent-admin 開啟` 開一個。",
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      if (sub === "結束") {
        const r = await worldEventService.forceEndEvent(client, activeMainline.event_db_id);
        return interaction.editReply({
          components: [
            r.ok
              ? ok(
                  `🏁 ${activeMainline.label} 已結束`,
                  reqLines(activeMainline),
                  "貢獻明細保留在 WorldEventContributions，之後仍可用來發稱號",
                )
              : worldEventView.buildSimpleError({
                  title: "❌ 結束失敗",
                  body: "這個活動已經不在進行中了。",
                }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      // 進度
      // 用正規化分數排，跟發稱號同一份依據（原始數量相加會讓逼幣完全主導）
      const ranking = (await worldEventService.contributionScores(client, activeMainline)).slice(0, 10);
      const rankText = ranking.length
        ? ranking
            .map((r, i) => {
              const detail = Object.entries(r.byItem)
                .map(([k, v]) => `${itemLabel(k)} ${v.toLocaleString()}`)
                .join("・");
              return `${i + 1}. <@${r._id}>　**${r.pct.toFixed(2)}%**\n　-# ${detail}`;
            })
            .join("\n")
        : "-# 還沒有人投入資源";
      return interaction.editReply({
        components: [
          ok(
            `${activeMainline.emoji || "🛤️"} ${activeMainline.label}`,
            `${reqLines(activeMainline)}\n\n**貢獻榜（各物資按自身目標正規化）**\n${rankText}`,
            `狀態：${activeMainline.state} ・ 截止 <t:${Math.floor(new Date(activeMainline.ends_at).getTime() / 1000)}:R>`,
          ),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /worldevent-admin: ${error}\n${error.stack}`.red);
      return interaction
        .editReply({
          content: "🔧 指令執行失敗，請看 log。",
        })
        .catch(() => {});
    }
  },
};
