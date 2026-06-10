require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { DateTime } = require("luxon");

const { coinSystem, casino } = require("../../config");
const parseBetAmount = require("../../utils/parseBetAmount");
const {
  MIN_AUTOCASHOUT,
  clampAutocashout,
} = require("../../features/casino/crash/engine");
const { buildConfirmPayload } = require("../../features/casino/crash/renderer");

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

// 沒設 openingWindow → 全天開放。設了就只在 weekdays（或單一 weekday）+ [startHour, endHour) 開。
// weekdays 可填多天（例：週末 [6, 7]）；省略 startHour/endHour 表示該日全天。endHour 可填 24 表示「到當天結束」。
function checkOpeningWindow(window, now = DateTime.now()) {
  if (!window) return { open: true };
  const tz = window.timezone || "Asia/Taipei";
  const localNow = now.setZone(tz);
  const allowedDays = Array.isArray(window.weekdays)
    ? window.weekdays
    : window.weekday != null
      ? [window.weekday]
      : null;
  const sh = window.startHour;
  const eh = window.endHour;
  const inDay = allowedDays == null || allowedDays.includes(localNow.weekday);
  const hour = localNow.hour + localNow.minute / 60;
  const inHour =
    (sh == null || hour >= sh) && (eh == null || hour < eh);
  if (inDay && inHour) return { open: true };
  const dayLabel =
    allowedDays != null
      ? allowedDays.map((d) => WEEKDAY_LABEL[d] || `weekday=${d}`).join("、")
      : "每天";
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

  subcommandOnly: true,

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
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`,
        );
      }

      const autocashoutInput =
        interaction.options.getNumber("自動收手") ?? null;
      const autocashout =
        autocashoutInput != null ? clampAutocashout(autocashoutInput) : null;

      // 不在這裡扣款 / 開局：先讓玩家確認注意事項，按下「確認發射」才真正開始。
      const payload = buildConfirmPayload({
        bet,
        autocashout,
        balance,
        username,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /火箭:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 火箭執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
