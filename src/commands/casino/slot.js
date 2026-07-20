require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const parseBetAmount = require("../../utils/parseBetAmount");
const { spin } = require("../../features/casino/slot/slotMachine");
const {
  contribute: contributeJackpot,
  bustPool: bustJackpot,
  getPool: getJackpotPool,
  getCfg: getJackpotCfg,
} = require("../../features/casino/slot/jackpotPool");
const {
  checkAndAnnouncePoolMilestones: checkSlotPoolMilestones,
} = require("../../features/casino/slot/poolAnnouncer");
const generateSlotGif = require("../../utils/generateSlotGif");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");
const { buildCasinoEmbed } = require("../../features/casino/casinoEmbed");

function getSlotConfig() {
  return casino?.slot || {};
}

function describeMatch(matchType) {
  switch (matchType) {
    case "jackpot":
      return "🎉 JACKPOT！七七七！";
    case "triple":
      return "🎊 三連線！";
    case "double_cherry":
      return "🍒🍒 兩個櫻桃！";
    case "double":
      return "✨ 兩個一樣！";
    default:
      return "💸 沒中，下次再來！";
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("拉霸")
    .setDescription("拉霸試手氣！🎰")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注金額（梭哈打 all，也支援 1.5k、50%）")
        .setRequired(true)
    )
    .toJSON(),

  subcommandOnly: true,

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getSlotConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 拉霸暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 5;

      const rawBet = interaction.options.getString("下注");

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const jackpotCfg = getJackpotCfg();
      const jackpotEnabled = jackpotCfg?.enabled !== false;
      const seed = jackpotCfg?.seedAmount ?? 5000;
      const contributionRate = jackpotCfg?.contributionRate ?? 0.03;

      // Phase 1：餘額 + 彩池一次平行讀完（兩個 collection 互不相關）
      const [before, prePoolDoc] = await Promise.all([
        client.userCoinsCollection.findOne({ userId, guildId }),
        jackpotEnabled
          ? getJackpotPool(client, guildId).catch(() => null)
          : Promise.resolve(null),
      ]);
      const balance = before?.totalCoins || 0;
      const parsed = parseBetAmount(rawBet, balance);
      if (!parsed.ok) {
        return interaction.editReply(`下注格式錯誤：${parsed.reason}`);
      }
      const bet = parsed.amount;
      if (bet < minBet) {
        return interaction.editReply(
          `下注金額至少需 **${minBet.toLocaleString()}** credits。`
        );
      }
      if (balance < bet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`
        );
      }

      const roundId = crypto.randomUUID();
      const prePoolAmount = prePoolDoc?.amount ?? seed;
      const contribution = jackpotEnabled ? Math.floor(bet * contributionRate) : 0;

      // Phase 2：抽獎（純 CPU，不碰 DB）
      const result = spin({ bet });
      const isJackpot = jackpotEnabled && result.matchType === "jackpot";

      // Phase 3（僅 jackpot 路徑）：必須序列 bet → contribute → bust 才能拿到真實爆池金額
      let jackpotBust = 0;
      let jackpotPool;
      let jackpotBetResult = null;
      if (isJackpot) {
        jackpotBetResult = await grantCoins(client, {
          userId,
          guildId,
          username,
          avatarHash: interaction.user.avatar,
          amount: -bet,
          source: "bet",
          member,
          meta: { game: "slot", roundId },
        });
        if (!jackpotBetResult) {
          return interaction.editReply("🔧 下注失敗，請稍後再試。");
        }
        await contributeJackpot(client, guildId, bet).catch((e) =>
          console.log(`[SLOT] jackpot contribute failed: ${e}`.yellow)
        );
        jackpotBust = await bustJackpot(client, guildId).catch((e) => {
          console.log(`[SLOT] jackpot bust failed: ${e}`.red);
          return 0;
        });
        jackpotPool = seed;
      } else if (jackpotEnabled) {
        // 非 jackpot：contribute fire-and-forget，pool 用投影值
        contributeJackpot(client, guildId, bet).catch((e) =>
          console.log(`[SLOT] jackpot contribute failed: ${e}`.yellow)
        );
        jackpotPool = prePoolAmount + contribution;
      } else {
        jackpotPool = null;
      }

      const totalPayout = result.payout + jackpotBust;
      const balanceAfter = balance - bet + totalPayout;

      // Phase 4：所有剩下的工作一次平行
      // - 非 jackpot 路徑：bet + payout + GIF + saveLastBet 全部一起跑（critical path 變成 max 而非 sum）
      // - jackpot 路徑：bet 已經 serial 跑完，這裡只剩 payout + GIF + save
      // 安全性：pre-validation 已保證 balance >= bet；grantCoins 對 CASINO_SOURCES 不再做餘額檢查，
      // 所以非 jackpot 路徑把 bet 並行進來不會 race。
      const betPromise = isJackpot
        ? Promise.resolve(jackpotBetResult)
        : grantCoins(client, {
            userId,
            guildId,
            username,
            avatarHash: interaction.user.avatar,
            amount: -bet,
            source: "bet",
            member,
            meta: { game: "slot", roundId },
          });

      const payoutPromise =
        totalPayout > 0
          ? grantCoins(client, {
              userId,
              guildId,
              username,
              avatarHash: interaction.user.avatar,
              amount: totalPayout,
              source: "payout",
              member,
              meta: {
                game: "slot",
                matchType: result.matchType,
                matchKey: result.matchKey,
                multiplier: result.multiplier,
                basePayout: result.payout,
                jackpotBust,
                bet,
                roundId,
              },
            }).catch((e) => {
              console.log(`[SLOT] payout grantCoins failed: ${e}`.red);
              return null;
            })
          : Promise.resolve(null);

      const gifPromise = generateSlotGif({
        userId,
        username,
        grid: result.grid,
        lines: result.lines,
        matchType: result.matchType,
        matchedSymbol: result.matchedSymbol,
        bet,
        payout: totalPayout,
        multiplier: result.multiplier,
        balance: balanceAfter,
        jackpotPool,
        jackpotBust,
      }).catch((gifErr) => {
        console.log(
          `[WARN] slot gif render failed, falling back to text: ${gifErr.message}`.yellow
        );
        return null;
      });

      const savePromise = saveLastBet(client, {
        userId,
        guildId,
        game: "slot",
        payload: { options: { 下注: bet } },
      }).catch(() => null);

      const [betResult, , buf] = await Promise.all([
        betPromise,
        payoutPromise,
        gifPromise,
        savePromise,
      ]);
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      const attachment = buf
        ? new AttachmentBuilder(buf, { name: `slot-${roundId}.gif` })
        : null;

      const jackpotLine =
        result.matchType === "jackpot" && jackpotBust > 0
          ? `💥 **爆池！** 累積池 **+${jackpotBust.toLocaleString()}** credits`
          : "";

      const headline =
        result.matchType === "jackpot"
          ? `🎉 **JACKPOT！** ＋${totalPayout.toLocaleString()} credits！`
          : totalPayout > 0
          ? `${describeMatch(result.matchType)} ＋${totalPayout.toLocaleString()} credits`
          : `💸 沒中，下次再來！`;

      const bankruptLine =
        balanceAfter <= 0
          ? `🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！`
          : "";

      // 結果改用賭場共用 embed 呈現：作者放玩家頭像／名稱，圖片塞進 embed 內。
      const net = totalPayout - bet;
      const outcome =
        result.matchType === "jackpot"
          ? "jackpot"
          : net > 0
          ? "win"
          : net < 0
          ? "lose"
          : "neutral";

      // GIF 失敗時用文字 fallback 把 3x3 結果 + 目前 pool 補回來，
      // GIF 正常時這些資訊已經畫在圖上，不要重複塞文字。
      const reelsLine = attachment
        ? null
        : "🎰 轉出：\n" +
          result.grid
            .map((row) => row.map((s) => s.emoji).join(" ｜ "))
            .join("\n");
      const fallbackPoolLine =
        !attachment && jackpotEnabled && jackpotPool != null
          ? `${MONEY_EMOJI} 目前 Jackpot Pool：**${jackpotPool.toLocaleString()}**`
          : "";
      const extraLines = [reelsLine, jackpotLine, fallbackPoolLine, bankruptLine].filter(Boolean);

      const embed = buildCasinoEmbed({
        game: "🎰 拉霸",
        user: {
          id: interaction.user.id,
          displayName: interaction.member?.displayName || interaction.user.username,
          avatarURL: interaction.user.displayAvatarURL(),
        },
        outcome,
        headline,
        lines: extraLines,
        bet,
        net,
        balance: balanceAfter,
        imageName: attachment?.name,
      });

      await interaction.editReply({
        content: "",
        embeds: [embed],
        files: attachment ? [attachment] : [],
        components: [buildReplayRow("slot", userId, { name: username })],
      });

      // 爆池公告
      const announceChannelId = jackpotCfg?.announceChannelId;
      if (jackpotBust > 0 && announceChannelId) {
        try {
          const ch = await client.channels.fetch(announceChannelId).catch(() => null);
          if (ch?.isTextBased?.()) {
            ch.send(
              `💥💥💥 **拉霸 JACKPOT 爆池！** <@${userId}> 中了 **+${jackpotBust.toLocaleString()}** credits 累積彩池（七七七！）`
            ).catch(() => {});
          }
        } catch (_) { /* ignore */ }
      }

      // 彩池里程碑播報（沒爆池才檢查；爆池後 pool 已歸 seed）
      if (jackpotEnabled && jackpotBust === 0) {
        checkSlotPoolMilestones(client, guildId).catch((e) =>
          console.log(`[SLOT] milestone check failed: ${e}`.yellow)
        );
      }
    } catch (error) {
      console.log(`[ERROR] /拉霸:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 拉霸執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
