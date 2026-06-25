// 賭場「🔁 再來一局」按鈕統一處理器。
//
// 按鈕 customId = rb_<game>_<ownerId>（見 features/casino/replay.js）。
// 大多數遊戲：把上一注參數合成 interaction.options，直接交回原 slash 指令的 run() 重跑
// （run() 會自己 deferReply，產生一則全新的對局訊息）。
// 輪盤特例：bet 是用按鈕逐格累加的，重玩時直接重建一張「已預填同樣押注」的下注面板，
//          玩家只要再按一次「開轉」即可。

const { MessageFlags } = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const crypto = require("crypto");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { parseReplayId, getLastBet } = require("../../features/casino/replay");

// game → 原 slash 指令模組路徑（懶載入，避免載入順序問題）
const GAME_COMMAND_PATHS = {
  slot: "../../commands/casino/slot",
  sicbo: "../../commands/casino/sicbo",
  blackjack: "../../commands/casino/blackjack",
  hilo: "../../commands/casino/hilo",
  crash: "../../commands/casino/crash",
  keno: "../../commands/casino/keno",
  dragonGate: "../../commands/casino/dragonGate",
  lottery: "../../commands/casino/lottery",
  tower: "../../commands/casino/tower",
  mines: "../../commands/casino/mines",
  plinko: "../../commands/casino/plinko",
};

// 把存起來的選項 map 包成一個假的 interaction.options。
// 各指令都用對應型別的 getter 讀自己的選項，所以這裡不需區分型別，缺值一律回 null。
function makeOptions(map = {}) {
  const get = (name) => {
    const v = map[name];
    return v === undefined ? null : v;
  };
  return {
    getInteger: get,
    getString: get,
    getBoolean: get,
    getNumber: get,
    getUser: () => null,
    getMember: () => null,
    getChannel: () => null,
    getRole: () => null,
    getAttachment: () => null,
    getMentionable: () => null,
    getSubcommand: () => map.__subcommand ?? null,
    getSubcommandGroup: () => null,
  };
}

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const parsed = parseReplayId(interaction.customId);
    if (!parsed) return;
    const { game, ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:casinoReplay", {
      windowMs: 2000,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`
      );
      return;
    }

    // 只有本人能用自己的「再來一局」
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的「再來一局」按鈕，請用指令自己開一局～"
      );
      return;
    }

    const lastBet = await getLastBet(client, {
      userId: ownerId,
      guildId: interaction.guildId,
      game,
    });
    if (!lastBet?.payload) {
      await replyEphemeral(
        interaction,
        "找不到可重玩的下注紀錄，先玩一局再用這顆按鈕吧！"
      );
      return;
    }

    if (game === "roulette") {
      await replayRoulette(client, interaction, lastBet.payload);
      trackSuccess("casino-replay");
      return;
    }

    const cmdPath = GAME_COMMAND_PATHS[game];
    if (!cmdPath) {
      await replyEphemeral(interaction, "這個遊戲暫不支援再來一局。");
      return;
    }
    const cmd = require(cmdPath);
    if (typeof cmd?.run !== "function") return;

    // 合成 options 後交回原指令重跑（run() 會自己 deferReply 並產生新訊息）
    interaction.options = makeOptions(lastBet.payload.options || {});
    await cmd.run(client, interaction);
    trackSuccess("casino-replay");
  } catch (err) {
    logger.error(
      {
        source: "casino-replay",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "賭場再來一局處理失敗"
    );
    trackError("casino-replay", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 再來一局失敗，請呼叫舒舒！");
  }
};

// 輪盤重玩：重建一張預填同樣押注的下注面板。
async function replayRoulette(client, interaction, payload) {
  const { casino } = require("../../config");
  const grantCoins = require("../../features/economy/grantCoins");
  const { totalWagered } = require("../../features/casino/roulette/engine");
  const {
    buildBettingRows,
    buildStatusContent,
  } = require("../../commands/casino/roulette");

  await interaction.deferReply();

  const cfg = casino?.roulette || {};
  if (cfg.enabled === false) {
    return interaction.editReply("🔧 輪盤暫時關閉中！");
  }
  if (!client.rouletteGamesCollection) {
    return interaction.editReply("🔧 輪盤系統未啟動，請聯絡舒舒！");
  }

  const totalBudget = payload.totalBudget;
  const bets = Array.isArray(payload.bets) ? payload.bets : [];
  if (!totalBudget || bets.length === 0) {
    return interaction.editReply("找不到可重玩的輪盤下注。");
  }

  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const username =
    interaction.member?.displayName || interaction.user.username;

  const existing = await client.rouletteGamesCollection.findOne({
    userId,
    guildId,
    status: "betting",
  });
  if (existing) {
    return interaction.editReply("🎰 你還有一局在進行中！");
  }

  const userDoc = await client.userCoinsCollection.findOne({
    userId,
    guildId,
  });
  const balance = userDoc?.totalCoins || 0;
  if (balance < totalBudget) {
    return interaction.editReply(
      `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，需要 **${totalBudget.toLocaleString()}**。`
    );
  }

  const betResult = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash: interaction.user.avatar,
    amount: -totalBudget,
    source: "bet",
    member: interaction.member,
    meta: { game: "roulette", replay: true },
  });
  if (!betResult) {
    return interaction.editReply("🔧 扣款失敗，請稍後再試。");
  }

  const gameId = crypto.randomUUID();
  const now = new Date();
  const timeoutSec = cfg.bettingTimeoutSeconds ?? 90;
  const game = {
    gameId,
    userId,
    guildId,
    username,
    status: "betting",
    totalBudget,
    bets: bets.map((b) => ({
      type: b.type,
      amount: b.amount,
      numbers: b.numbers,
    })),
    result: null,
    totalPayout: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + timeoutSec * 1000),
  };
  await client.rouletteGamesCollection.insertOne(game);

  const remaining = totalBudget - totalWagered(game.bets);
  await interaction.editReply({
    content: buildStatusContent(game),
    components: buildBettingRows(gameId, remaining),
  });
}
