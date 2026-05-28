require("colors");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { DateTime } = require("luxon");

const { levelSystem, coinSystem, questSystem } = require("../../config");
const grantXp = require("../../features/leveling/grantXp");
const grantCoins = require("../../features/economy/grantCoins");
const generateCheckinCard = require("../../utils/generateCheckinCard");
const questService = require("../../features/quests/questService");
const notifyQuestClaim = require("../../features/quests/notifyQuestClaim");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("每日簽到")
    .setDescription("每日簽到領 XP 🗓️")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("簽到")
        .setDescription("今日簽到領 XP / 逼幣 🗓️")
        .addBooleanOption((opt) =>
          opt
            .setName("押倍")
            .setDescription(
              "把今天的金幣翻倍，但隔天沒簽到 streak 直接歸零（不能用補簽卡）"
            )
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("補簽卡").setDescription("查看你的補簽卡庫存與規則 🛡️")
    ),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === "補簽卡") return runFreezeCard(client, interaction);
    return runCheckin(client, interaction);
  },
};

async function runFreezeCard(client, interaction) {
  try {
    if (!client.userLevelsCollection) {
      return interaction.reply({
        content: "🔧 等級系統尚未啟動",
        flags: MessageFlags.Ephemeral,
      });
    }

    const cfg = levelSystem.daily;
    const max = cfg.maxStreakFreezeStock ?? 3;
    const every = cfg.streakFreezeUnlockEvery ?? 30;

    const doc = await client.userLevelsCollection.findOne({
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    const stock = doc?.streakFreezes || 0;
    const streak = doc?.streak || 0;
    const nextMilestone = every > 0 ? Math.ceil((streak + 1) / every) * every : null;
    const remainToNext = nextMilestone != null ? nextMilestone - streak : null;

    const lines = [
      `## 🛡️ 補簽卡`,
      `目前庫存：**${stock} / ${max}**`,
      `當前連勝：**${streak}** 天`,
    ];
    if (every > 0) {
      lines.push(
        `每連續 **${every}** 天簽到 +1 張（庫存上限 ${max}）`
      );
      if (remainToNext != null) {
        if (stock >= max) {
          lines.push(`-# 庫存已滿，下次里程碑不會再 +1`);
        } else {
          lines.push(`-# 距離下次保護卡：再連續簽到 **${remainToNext}** 天`);
        }
      }
    }
    lines.push("");
    lines.push(
      `規則：當你「漏簽 1 天」時自動消耗 1 張，連勝不歸零繼續累積。漏 2 天以上仍會歸零。`
    );

    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.log(`[ERROR] /每日簽到 補簽卡:\n${error}\n${error.stack}`.red);
    const reply = {
      content: "🔧 載入失敗，請呼叫舒舒！",
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
}

async function runCheckin(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!client.userLevelsCollection || !client.dailyCheckinCollection) {
        return interaction.editReply("🔧 等級系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = levelSystem.daily;
      const tz = cfg.resetTimezone || "Asia/Taipei";
      const today = DateTime.now().setZone(tz).toISODate();
      const yesterday = DateTime.now().setZone(tz).minus({ days: 1 }).toISODate();
      const dayBefore = DateTime.now().setZone(tz).minus({ days: 2 }).toISODate();

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const already = await client.dailyCheckinCollection.findOne({
        userId,
        guildId,
        date: today,
      });
      if (already) {
        const nextResetTs = Math.floor(
          DateTime.now()
            .setZone(tz)
            .plus({ days: 1 })
            .startOf("day")
            .toSeconds()
        );
        return interaction.editReply(
          `今天已經簽到過了！\n目前連續：**${already.streak}** 天\n下次可簽到：<t:${nextResetTs}:R>（<t:${nextResetTs}:t>）`
        );
      }

      const userDoc = await client.userLevelsCollection.findOne({
        userId,
        guildId,
      });

      const doubleOrNothing = interaction.options.getBoolean("押倍") === true;

      // 連勝計算
      const prevStreak = userDoc?.streak || 0;
      const prevFreezes = userDoc?.streakFreezes || 0;
      const maxStock = cfg.maxStreakFreezeStock ?? 3;
      const unlockEvery = cfg.streakFreezeUnlockEvery ?? 30;
      // 昨天有沒有押倍？（押倍 = 隔天沒簽就一律歸零，不准用補簽卡）
      const prevPledged = userDoc?.lastDailyPledge === true;

      let streak = 1;
      let freezesAfter = prevFreezes;
      let consumedFreeze = false;
      let pledgeForfeited = false;

      if (userDoc?.lastDailyAt === yesterday) {
        streak = prevStreak + 1;
      } else if (
        userDoc?.lastDailyAt === dayBefore &&
        prevFreezes > 0 &&
        prevStreak > 0 &&
        !prevPledged
      ) {
        // 用一張保護卡，streak 不歸零
        streak = prevStreak + 1;
        freezesAfter = prevFreezes - 1;
        consumedFreeze = true;
      } else if (
        userDoc?.lastDailyAt === dayBefore &&
        prevPledged
      ) {
        // 昨天押倍 + 今天才簽（中間漏一天）→ 押倍違約，streak 歸 1
        streak = 1;
        pledgeForfeited = true;
      }

      // 達到 30/60/90... 連勝里程碑且庫存未滿 → +1 保護卡
      let unlockedFreeze = false;
      if (
        unlockEvery > 0 &&
        streak >= unlockEvery &&
        streak % unlockEvery === 0 &&
        freezesAfter < maxStock
      ) {
        freezesAfter += 1;
        unlockedFreeze = true;
      }

      let xp = cfg.baseXp;
      const bonusDays = Math.min(streak, cfg.streakBonusCapDays || 30);
      xp += bonusDays * (cfg.streakBonusPerDay || 0);
      let multiplier = 1;
      if (streak >= 30) multiplier = cfg.streak30Multiplier || 2.0;
      else if (streak >= 7) multiplier = cfg.streak7Multiplier || 1.5;
      xp = Math.floor(xp * multiplier);

      try {
        await client.dailyCheckinCollection.insertOne({
          userId,
          guildId,
          date: today,
          streak,
          usedFreeze: consumedFreeze,
          reward: { xp, bonus: multiplier > 1 },
          createdAt: new Date(),
        });
      } catch (err) {
        if (err?.code === 11000) {
          return interaction.editReply("今天已經簽到過了！明天再來吧 🌙");
        }
        throw err;
      }

      await client.userLevelsCollection.updateOne(
        { userId, guildId },
        {
          $set: {
            lastDailyAt: today,
            lastDailyPledge: doubleOrNothing,
            streak,
            streakFreezes: freezesAfter,
            longestStreak: Math.max(streak, userDoc?.longestStreak || 0),
            updatedAt: new Date(),
          },
          $inc: { totalCheckins: 1 },
          $setOnInsert: {
            userId,
            guildId,
            badges: [],
            title: null,
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );

      // 週週出席任務：簽到成功 +1
      let weeklyAttendanceClaimed = null;
      if (questSystem?.enabled && client.questProgressCollection) {
        const res = await questService
          .incrementProgress(client, userId, guildId, "weekly_attendance", 1, {
            member: interaction.member,
            username: interaction.user.username,
          })
          .catch((e) => {
            console.log(`[ERROR] quest weekly_attendance: ${e}`.red);
            return null;
          });
        weeklyAttendanceClaimed = res?.autoClaimed || null;
      }

      const grantResult = await grantXp(client, {
        userId,
        guildId,
        username: interaction.user.username,
        avatarHash: interaction.user.avatar,
        amount: xp,
        source: "daily",
        counterField: "xpFromDaily",
        member: interaction.member,
        channel: interaction.channel,
      });

      // 每日金幣（與 XP 同步發，使用相同 streak / 倍率邏輯）
      let coinResult = null;
      let pledgeBonusMult = 1;
      if (coinSystem?.enabled && client.userCoinsCollection) {
        const cCfg = coinSystem.daily || {};
        const baseC = cCfg.baseCoins ?? 30;
        const bonusDaysC = Math.min(streak, cCfg.streakBonusCapDays || 10);
        let coinAmt = baseC + bonusDaysC * (cCfg.streakBonusPerDay || 0);
        let coinMult = 1;
        if (streak >= 30) coinMult = cCfg.streak30Multiplier || 3.0;
        else if (streak >= 7) coinMult = cCfg.streak7Multiplier || 2.0;
        coinAmt = Math.floor(coinAmt * coinMult);
        if (doubleOrNothing) {
          coinAmt = coinAmt * 2;
          pledgeBonusMult = 2;
        }

        coinResult = await grantCoins(client, {
          userId,
          guildId,
          username: interaction.user.username,
          avatarHash: interaction.user.avatar,
          amount: coinAmt,
          source: "daily",
          member: interaction.member,
          meta: { streak, streakMultiplier: coinMult, doubleOrNothing },
        });
      }

      const calendarStart = DateTime.now()
        .setZone(tz)
        .minus({ days: 29 })
        .toISODate();
      const recentCheckins = await client.dailyCheckinCollection
        .find({ userId, guildId, date: { $gte: calendarStart } })
        .toArray();
      const checkinDates = new Set(recentCheckins.map((c) => c.date));

      const buf = await generateCheckinCard({
        username: interaction.member?.displayName || interaction.user.username,
        avatarUrl: interaction.user.displayAvatarURL({
          extension: "png",
          size: 256,
        }),
        streak,
        totalCheckins: (userDoc?.totalCheckins || 0) + 1,
        xpEarned: xp,
        multiplier,
        afterLevel: grantResult?.after,
        checkinDates,
        today,
        timezone: tz,
      });

      const fileName = `checkin-${today}.png`;
      const attachment = new AttachmentBuilder(buf, { name: fileName });

      const container = new ContainerBuilder()
        .setAccentColor(0xc9302c)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🗓️ 簽到成功！\n獲得 **+${xp} XP**${
              coinResult?.granted ? ` ・ **+${coinResult.granted} ${MONEY_EMOJI}**` : ""
            }${
              multiplier > 1 ? ` ・ 連勝加成 x${multiplier}` : ""
            } ・ 連續 **${streak}** 天`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder()
              .setURL(`attachment://${fileName}`)
              .setDescription(`簽到・${today}`)
          )
        );

      const noteLines = [];
      if (pledgeForfeited) {
        noteLines.push(
          `💀 你昨天**押倍**了卻沒簽到！streak 直接歸零（押倍違約規則）。`
        );
      }
      if (consumedFreeze) {
        noteLines.push(
          `🛡️ 你昨天忘了簽到，但消耗 1 張補簽卡，連勝沒歸零！剩餘庫存：${freezesAfter}`
        );
      }
      if (unlockedFreeze) {
        noteLines.push(
          `🎁 達成 ${streak} 天連勝里程碑，獲得 1 張補簽卡！目前庫存：${freezesAfter}/${maxStock}`
        );
      }
      if (doubleOrNothing) {
        noteLines.push(
          `🎲 **押倍生效！** 今日金幣已翻倍（×${pledgeBonusMult}）。但**明天沒簽到 streak 歸零**，且**不能用補簽卡**。慎之！`
        );
      }
      if (noteLines.length > 0) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(noteLines.join("\n"))
          );
      }

      const newBadges = grantResult?.newBadges || [];
      if (newBadges.length > 0) {
        const lines = newBadges
          .map((b) => `${b.emoji} **${b.name}** — ${b.description}`)
          .join("\n");
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `🎉 解鎖新徽章：\n${lines}`
            )
          );
      }

      const eventNames = grantResult?.eventNames || [];
      const eventLine =
        eventNames.length > 0
          ? `\n-# ⚡ XP 倍率事件：${eventNames.join("、")}（x${grantResult.eventMultiplier}）`
          : "";
      const twitchLine =
        grantResult?.twitchSubMultiplier > 1
          ? `\n-# 💜 ${grantResult.twitchSubName} 加成：x${grantResult.twitchSubMultiplier}`
          : "";
      const boostLine =
        grantResult?.boostBonusMultiplier > 1
          ? `\n-# 🚀 ${grantResult.boostBonusName}：x${grantResult.boostBonusMultiplier}`
          : "";

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 連續 7 天 +50% ・ 連續 30 天 x2 ・ 🛡️ 庫存 ${freezesAfter}/${maxStock}${eventLine}${twitchLine}${boostLine}`
        )
      );

      await interaction.editReply({
        components: [container],
        files: [attachment],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });

      if (weeklyAttendanceClaimed) {
        await notifyQuestClaim(
          client,
          { interaction, user: interaction.user, userId },
          weeklyAttendanceClaimed
        );
      }
    } catch (error) {
      console.log(`[ERROR] /每日簽到 簽到:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 簽到失敗，請呼叫舒舒！")
        .catch(() => {});
    }
}
