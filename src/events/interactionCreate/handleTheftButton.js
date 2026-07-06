// 盜賊系統按鈕：
//   theft_hunt_<wantedUserId>  任何人可點 → 追捕該通緝犯（公開結果）
//   theft_noto_<ownerId>       查看自己的惡名與戰績（owner 限定）
//   theft_bank_<ownerId>       存款捷徑提示（owner 限定）
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const theftService = require("../../features/theft/theftService");
const theftProfile = require("../../features/theft/theftProfile");
const { errorContainer, huntResultContainer, broadcast } = require("../../features/theft/theftView");
const theftBoard = require("../../features/theft/theftBoard");
const { COIN_EMOJI } = require("../../constants/coin");
const logger = require("../../utils/logger");
const { consume } = require("../../utils/rateLimiter");

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId || "";
    if (!id.startsWith("theft_")) return;
    if (!client.wantedListCollection) return;

    const rl = consume(interaction.user.id, "btn:theft", { windowMs: 1500, max: 1 });
    if (!rl.allowed) {
      return interaction
        .reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }

    // ── 追捕（公開）──
    if (id.startsWith("theft_hunt_")) {
      const wantedUserId = id.slice("theft_hunt_".length);
      // 追捕結果對玩家私人顯示；成功才公開推到通緝廣播頻道
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await theftService.huntWanted(client, {
        guildId: interaction.guildId,
        hunterId: interaction.user.id,
        hunterName: interaction.member?.displayName || interaction.user.username,
        wantedUserId,
        member: interaction.member,
      });
      if (!result.ok) {
        const cdEpoch = result.readyAt ? Math.floor(result.readyAt / 1000) : 0;
        const map = {
          self: ["🪞 不能追捕自己", "自首請用 /自首。", null],
          not_wanted: ["🕊️ 對方已不在逃", "這名通緝犯已被處理或自首了。", "刷新 /通緝榜 看看還有誰。"],
          daily_limit: [
            "🕵️ 今日追捕次數已用完",
            `你今天已追捕 ${result.todayCount}/${result.dailyLimit} 次。`,
            "明天（台灣時間 00:00）重置。",
          ],
          hunt_cooldown: [
            "🫥 他躲起來了",
            `這名通緝犯剛甩開一次追捕，正躲風頭。可再次追捕：<t:${cdEpoch}:R>`,
            "等他探頭出來，或先去 /通緝榜 抓別人。",
          ],
          already_failed: [
            "🙅 你已經追丟過他了",
            "你這次通緝期間已追捕他失敗，機會用掉了。",
            "讓其他人去抓，或等他下次再犯。",
          ],
          race: ["🌀 慢了一步", "這名通緝犯剛剛已被別人處理掉了。", "刷新 /通緝榜 看看還有誰。"],
        };
        const [t, b, h] = map[result.reason] || ["🔧 追捕失敗", "系統忙碌或未啟動。", "稍後再試。"];
        return interaction.editReply({
          components: [errorContainer(t, b, h)],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      const resultContainer = huntResultContainer(result, interaction.user.id, wantedUserId);
      // 抓到人 → 公開推到通緝廣播頻道；玩家本人這裡仍是私人結果
      if (result.success) {
        await broadcast(client, resultContainer);
      }
      theftBoard.refresh(client).catch(() => {});
      return interaction.editReply({
        components: [resultContainer],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── 報案後強制決鬥（owner 限定）──
    if (id.startsWith("theft_revenge_")) {
      const [victimId, culpritId] = id.slice("theft_revenge_".length).split("_");
      if (interaction.user.id !== victimId) {
        return interaction.reply({ content: "🚫 這不是你的按鈕！", flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await theftService.revengeDuel(client, {
        guildId: interaction.guildId,
        victimId,
        victimName: interaction.member?.displayName || interaction.user.username,
        culpritId,
        member: interaction.member,
      });
      if (!result.ok) {
        const map = {
          self: ["🪞 不能打自己", "選錯對象了。", null],
          already_done: ["🗡️ 你已經找他算過帳了", "每個兇手只能強制決鬥一次。", "去 /通緝榜 或找別人吧。"],
          no_case: ["🕊️ 查無此帳", "近期沒有他偷你的紀錄可討。", null],
        };
        const [t, b, h] = map[result.reason] || ["🔧 決鬥失敗", "系統忙碌或未啟動。", "稍後再試。"];
        return interaction.editReply({
          components: [errorContainer(t, b, h)],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      const container = result.win
        ? new ContainerBuilder()
            .setAccentColor(0xf1c40f)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `# 🗡️ 討回公道！\n你打贏了 <@${culpritId}>，` +
                  (result.recover > 0
                    ? `討回 **${result.recover.toLocaleString()}** ${COIN_EMOJI}！`
                    : "但他錢包空空，一毛也沒討到 😮‍💨") +
                  `\n\n攻擊力 ${result.victimAtk} vs ${result.culpritAtk}`
              )
            )
        : new ContainerBuilder()
            .setAccentColor(0x95a5a6)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `# 💔 討不回來\n你輸給了 <@${culpritId}>，這筆帳只能算了。\n\n攻擊力 ${result.victimAtk} vs ${result.culpritAtk}`
              )
            );
      return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    }

    // ── 查看惡名 / 存款捷徑（owner 限定）──
    const isNoto = id.startsWith("theft_noto_");
    const isBank = id.startsWith("theft_bank_");
    if (isNoto || isBank) {
      const ownerId = id.slice((isNoto ? "theft_noto_" : "theft_bank_").length);
      if (interaction.user.id !== ownerId) {
        return interaction.reply({
          content: "🚫 這不是你的按鈕！",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (isBank) {
        return interaction.reply({
          content: `💰 用 \`/存款 開戶\` 把贓款鎖進定存，就偷不走了！`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const prof = await theftProfile.getOrCreate(client, ownerId, interaction.guildId);
      const wanted = await theftService.activeWanted(client, ownerId, interaction.guildId);
      const container = new ContainerBuilder()
        .setAccentColor(0x8e44ad)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🥷 你的盜賊檔案\n` +
              `惡名：**${prof.notoriety_effective || 0}**\n` +
              `得手 ${prof.steal_success || 0} 次　失手 ${prof.steal_fail || 0} 次\n` +
              `追捕成功 ${prof.hunt_success || 0} 次　累積贓款 ${(prof.lifetime_stolen || 0).toLocaleString()} ${COIN_EMOJI}` +
              (wanted
                ? `\n\n🚨 你目前通緝中，賞金 **${wanted.bounty.toLocaleString()}** ${COIN_EMOJI}`
                : "")
          )
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 沒偷竊的日子惡名會自然下降。")
        );
      return interaction.reply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    logger.error(
      {
        source: "theft-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "盜賊按鈕處理失敗"
    );
    try {
      if (interaction.deferred) {
        await interaction.editReply("🔧 處理失敗，請呼叫舒舒！");
      } else {
        await interaction.reply({
          content: "🔧 處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
