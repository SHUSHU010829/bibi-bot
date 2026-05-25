require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { DateTime } = require("luxon");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const parseBetAmount = require("../../utils/parseBetAmount");
const {
  startGame,
  MIN_AUTOCASHOUT,
  DEFAULT_HOUSE_EDGE,
} = require("../../features/casino/crash/engine");
const { buildPlayingPayload } = require("../../features/casino/crash/renderer");
const tickManager = require("../../features/casino/crash/tick");
const { saveLastBet } = require("../../features/casino/replay");

const WEEKDAY_LABEL = ["", "週一", "週二", "週三", "週四", "週五", "週六", "週日"];

function getCrashConfig() {
  return casino?.crash || {};
}

function formatRemaining(sec) {
  const s = Math.max(0, Math.ceil(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分`;
}

// 沒設 openingWindow → 全天開放。設了就只在 weekday + [startHour, endHour) 開。
// endHour 可填 24 表示「到當天結束」。
function checkOpeningWindow(window, now = DateTime.now()) {
  if (!window) return { open: true };
  const tz = window.timezone || "Asia/Taipei";
  const localNow = now.setZone(tz);
  const wd = window.weekday;
  const sh = window.startHour;
  const eh = window.endHour;
  const inDay = wd == null || localNow.weekday === wd;
  const hour = localNow.hour + localNow.minute / 60;
  const inHour =
    (sh == null || hour >= sh) && (eh == null || hour < eh);
  if (inDay && inHour) return { open: true };
  const dayLabel = wd != null ? WEEKDAY_LABEL[wd] || `weekday=${wd}` : "每天";
  const hourLabel =
    sh != null && eh != null
      ? `${String(sh).padStart(2, "0")}:00–${String(eh).padStart(2, "0")}:00`
      : sh != null
        ? `${String(sh).padStart(2, "0")}:00 之後`
        : eh != null
          ? `${String(eh).padStart(2, "0")}:00 之前`
          : "全天";
  return {
    open: false,
    message: `🕘 火箭只在 **${dayLabel} ${hourLabel}（${tz}）** 開放，現在還沒到時間。`,
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("火箭")
    .setDescription("🚀 押注火箭！倍率衝多高就賺多少，按收手鎖定派彩，慢一步就爆炸")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注金額（支援 100、1.5k、10%、all）")
        .setRequired(true),
    )
    .addNumberOption((opt) =>
      opt
        .setName("自動收手")
        .setDescription(`(選填) 達到此倍率自動收手，省去搶按鈕；最低 ${MIN_AUTOCASHOUT}`)
        .setMinValue(MIN_AUTOCASHOUT)
        .setRequired(false),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (
        !client.userCoinsCollection ||
        !client.coinTransactionsCollection ||
        !client.crashGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getCrashConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 火箭暫時關閉中！");
      }

      const window = checkOpeningWindow(cfg.openingWindow);
      if (!window.open) {
        return interaction.editReply(window.message);
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      // 同時只能有一局 playing
      const existing = await client.crashGamesCollection.findOne({
        userId,
        guildId,
        status: "playing",
      });
      if (existing) {
        return interaction.editReply(
          "🚀 你還有一支火箭在天上！等它落地（或爆炸）再開新局。",
        );
      }

      // 結算後冷卻：擋連發
      const cooldownSec = cfg.cooldownSeconds ?? 0;
      if (cooldownSec > 0) {
        const lastSettled = await client.crashGamesCollection.findOne(
          { userId, guildId, status: "settled" },
          { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
        );
        if (lastSettled?.updatedAt) {
          const lastAt = +lastSettled.updatedAt;
          const elapsedSec = (Date.now() - lastAt) / 1000;
          if (elapsedSec < cooldownSec) {
            const readyEpoch = Math.floor((lastAt + cooldownSec * 1000) / 1000);
            const remainSec = Math.ceil(cooldownSec - elapsedSec);
            return interaction.editReply(
              `⏳ 火箭剛落地，還在補燃料！還要 **${formatRemaining(remainSec)}**，下次可發射：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`,
            );
          }
        }
      }

      const minBet = cfg.minBet ?? 10;
      const maxBet = cfg.maxBet ?? 0;
      const houseEdge = cfg.houseEdge ?? DEFAULT_HOUSE_EDGE;

      const before = await client.userCoinsCollection.findOne({
        userId,
        guildId,
      });
      const balance = before?.totalCoins || 0;

      const rawBet = interaction.options.getString("下注");
      const parsed = parseBetAmount(rawBet, balance);
      if (!parsed.ok) {
        return interaction.editReply(`下注格式錯誤：${parsed.reason}`);
      }
      const bet = parsed.amount;

      if (bet < minBet) {
        return interaction.editReply(
          `下注金額至少需 **${minBet.toLocaleString()}** credits。`,
        );
      }
      if (maxBet > 0 && bet > maxBet) {
        return interaction.editReply(
          `下注金額上限 **${maxBet.toLocaleString()}** credits。`,
        );
      }
      if (balance < bet) {
        return interaction.editReply(
          `💰 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`,
        );
      }

      const autocashoutInput =
        interaction.options.getNumber("自動收手") ?? null;

      const gameId = crypto.randomUUID();

      // 扣下注
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "crash", gameId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      const balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      // 開局
      const initial = startGame({
        bet,
        autocashout: autocashoutInput,
        houseEdge,
      });
      const now = new Date();
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const doc = {
        ...initial,
        gameId,
        userId,
        guildId,
        username,
        channelId: interaction.channelId,
        // messageId 之後拿到再回填
        startedAt: new Date(initial.startedAt),
        bustAt: new Date(initial.bustAt),
        autocashoutAt:
          initial.autocashoutAt != null
            ? new Date(initial.autocashoutAt)
            : null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      await client.crashGamesCollection.insertOne(doc);

      // 紀錄上一注（下注為字串選項，自動收手可為 null），供「再來一局」
      await saveLastBet(client, {
        userId,
        guildId,
        game: "crash",
        payload: {
          options: { 下注: String(bet), 自動收手: autocashoutInput },
        },
      });

      // 第一次回應：playing payload
      const payload = buildPlayingPayload(
        { ...initial, gameId },
        { username, balance: balanceAfter },
      );
      const msg = await interaction.editReply(payload);

      // 回填 messageId，tick 才知道要 edit 哪則
      const messageId = msg?.id;
      if (messageId) {
        await client.crashGamesCollection.updateOne(
          { gameId },
          { $set: { messageId, updatedAt: new Date() } },
        );
      }

      // 撈剛才寫進去的 doc（包含 messageId）給 tick 用
      const liveDoc = await client.crashGamesCollection.findOne({ gameId });
      if (liveDoc && liveDoc.status === "playing") {
        tickManager.start(client, liveDoc);
      }
    } catch (error) {
      console.log(`[ERROR] /火箭:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 火箭執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
