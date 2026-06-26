require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { startGame } = require("../../features/casino/scratch/engine");
const { renderMessage } = require("../../features/casino/scratch/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getScratchConfig() {
  return casino?.scratch || {};
}

// 把 config 的 themes 正規化成「款式」清單；沒設定 themes 時退回舊的頂層 config（款式 classic）。
function getThemes(cfg = getScratchConfig()) {
  if (Array.isArray(cfg.themes) && cfg.themes.length > 0) return cfg.themes;
  return [
    {
      key: "classic",
      name: null,
      emoji: null,
      minBet: cfg.minBet,
      maxBet: cfg.maxBet,
      luckyCount: cfg.luckyCount,
      numberMax: cfg.numberMax,
      prizes: cfg.prizes,
      decoyPrizes: cfg.decoyPrizes,
    },
  ];
}

// 依款式 key 解析；找不到就回第一個（預設款）。
function resolveTheme(cfg, key) {
  const themes = getThemes(cfg);
  return themes.find((t) => t.key === key) || themes[0];
}

function buildScratchBuilder() {
  const cfg = getScratchConfig();
  const themes = getThemes(cfg);
  const minBetFloor = Math.min(
    ...themes.map((t) => t.minBet ?? cfg.minBet ?? 10)
  );
  const builder = new SlashCommandBuilder()
    .setName("刮刮樂")
    .setDescription("買一張刮刮卡，湊滿三個相同符號就中獎 🎫")
    .setContexts(InteractionContextType.Guild);

  // 有多種款式才開放「款式」選項
  if (themes.length > 1) {
    builder.addStringOption((opt) => {
      opt
        .setName("款式")
        .setDescription("選擇刮刮卡款式（不同入手價與大獎）")
        .setRequired(false);
      themes.forEach((t) =>
        opt.addChoices({
          name: `${t.emoji ? `${t.emoji} ` : ""}${t.name || "經典"}（最低 ${(t.minBet ?? cfg.minBet ?? 10).toLocaleString()}）`,
          value: t.key,
        })
      );
      return opt;
    });
  }

  builder
    .addIntegerOption((opt) =>
      opt
        .setName("下注")
        .setDescription("買卡金額（勾選梭哈時可省略）")
        .setRequired(false)
        .setMinValue(minBetFloor)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("梭哈")
        .setDescription("一次押上目前全部餘額")
        .setRequired(false)
    );
  return builder;
}

module.exports = {
  data: buildScratchBuilder().toJSON(),

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
        !client.scratchGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getScratchConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 刮刮樂暫時關閉中！");
      }

      const theme = resolveTheme(cfg, interaction.options.getString("款式"));
      const minBet = theme.minBet ?? cfg.minBet ?? 10;
      const maxBet = theme.maxBet ?? cfg.maxBet ?? 0;
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const prizes = theme.prizes ?? cfg.prizes;
      const decoys = theme.decoyPrizes ?? cfg.decoyPrizes;
      const luckyCount = theme.luckyCount ?? cfg.luckyCount ?? 3;
      const numberMax = theme.numberMax ?? cfg.numberMax ?? 99;

      if (!Array.isArray(prizes) || prizes.length === 0) {
        return interaction.editReply("🔧 刮刮樂獎項尚未設定，請聯絡舒舒！");
      }

      const betInput = interaction.options.getInteger("下注");
      const allIn = interaction.options.getBoolean("梭哈") === true;
      if (!allIn && (!Number.isInteger(betInput) || betInput < minBet)) {
        return interaction.editReply(
          `買卡金額至少需 ${minBet.toLocaleString()} credits（或勾選梭哈）。`
        );
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const existing = await client.scratchGamesCollection.findOne({
        userId,
        guildId,
        status: "playing",
      });
      if (existing) {
        return interaction.editReply(
          "🎫 你手上還有一張沒刮完！先把上一張刮完再買新的。"
        );
      }

      const before = await client.userCoinsCollection.findOne({
        userId,
        guildId,
      });
      const balance = before?.totalCoins || 0;
      const bet = allIn ? balance : betInput;

      if (allIn && balance < minBet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足以梭哈！目前 **${balance.toLocaleString()}** credits，至少需 ${minBet.toLocaleString()}。`
        );
      }
      if (maxBet > 0 && bet > maxBet) {
        return interaction.editReply(
          `買卡金額上限 **${maxBet.toLocaleString()}** credits。`
        );
      }
      if (balance < bet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`
        );
      }

      const gameId = crypto.randomUUID();

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "scratch", gameId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 買卡失敗，請稍後再試。");
      }
      const balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const initial = startGame({
        bet,
        prizes,
        luckyCount,
        numberMax,
        decoys,
      });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        themeKey: theme.key,
        themeName: theme.name || null,
        themeEmoji: theme.emoji || null,
        bet: initial.bet,
        status: initial.status,
        luckyNumbers: initial.luckyNumbers,
        cells: initial.cells,
        winIndices: initial.winIndices,
        matchCount: initial.matchCount,
        revealed: initial.revealed,
        multiplier: initial.multiplier,
        result: initial.result,
        payout: initial.payout,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      await client.scratchGamesCollection.insertOne(doc);

      await saveLastBet(client, {
        userId,
        guildId,
        game: "scratch",
        payload: { options: { 下注: bet, 梭哈: false, 款式: theme.key } },
      });

      const payload = await renderMessage(doc, {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /刮刮樂:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 刮刮樂執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
