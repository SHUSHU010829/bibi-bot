// /紅包 — 在頻道發一包紅包，大家限時搶，未搶完自動退回發包人。
//
// 兩種類型：
//   normal — 一般紅包：發包人預先扣款，shares 預先算好，搶到實際金額。
//   prank  — 傻瓜紅包：發包人只付固定整人費，shares 全部是 0，所有搶到的人都拿到空包，
//            費用不退回（被服務器吃掉，避免免費刷屏）。對外顯示與一般紅包完全一樣，
//            等截止 / 全被騙完再揭曉「🤡 X 人上當」。

require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, casino } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");
const grantCoins = require("../../features/economy/grantCoins");
const { buildShares } = require("../../features/casino/redPacket/split");
const { buildOpenPayload } = require("../../features/casino/redPacket/render");
const { closeRedPacket } = require("../../features/casino/redPacket/service");

function getCfg() {
  return casino?.redPacket || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("紅包")
    .setDescription("🧧 發一包紅包讓大家搶！未搶完自動退回")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("金額")
        .setDescription("紅包總金額（傻瓜紅包顯示用，實際只扣整人費）")
        .setRequired(true)
        .setMinValue(1)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("包數")
        .setDescription("拆成幾包（至少 2 包，避免變成轉帳）")
        .setRequired(true)
        .setMinValue(2)
    )
    .addStringOption((opt) =>
      opt
        .setName("類型")
        .setDescription("一般 或 傻瓜紅包（🤡 看似有錢、其實是空的）")
        .setRequired(false)
        .addChoices(
          { name: "一般紅包", value: "normal" },
          { name: "🤡 傻瓜紅包（假的，沒錢）", value: "prank" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("手氣")
        .setDescription("拚手氣（隨機）或均分")
        .setRequired(false)
        .addChoices(
          { name: "拚手氣（隨機）", value: "lucky" },
          { name: "均分", value: "even" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("標題")
        .setDescription("紅包標題（會顯示在訊息上，最多 50 字）")
        .setRequired(false)
        .setMaxLength(50)
    )
    .toJSON(),

  // 紅包是同樂性質：開放在公會大廳(general)與賭場遊戲頻道(casino)，遊戲房討論串本就豁免。
  channelBuckets: ["general", "casino"],

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }
      if (!client.redPacketGamesCollection) {
        return interaction.editReply("🔧 紅包系統未啟動，請聯絡舒舒！");
      }

      const cfg = getCfg();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 紅包暫時關閉中！");
      }

      const minTotal = cfg.minTotal ?? 100;
      const minCount = cfg.minCount ?? 2;
      const maxCount = cfg.maxCount ?? 20;
      const normalWindowSec = cfg.grabWindowSeconds ?? 600;

      const prankCfg = cfg.prank || {};
      const prankEnabled = prankCfg.enabled !== false;
      const prankFee = prankCfg.fee ?? 100;
      const prankWindowSec = prankCfg.grabWindowSeconds ?? normalWindowSec;

      const displayTotal = interaction.options.getInteger("金額");
      const displayCount = interaction.options.getInteger("包數");
      const kind = interaction.options.getString("類型") || "normal";
      const mode = interaction.options.getString("手氣") || "lucky";
      const rawTitle = interaction.options.getString("標題");
      const title = rawTitle
        ? rawTitle
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 50)
        : null;

      if (kind === "prank" && !prankEnabled) {
        return interaction.editReply("🔧 傻瓜紅包暫時關閉中！");
      }

      if (displayCount < minCount) {
        return interaction.editReply(
          `🧧 至少要拆成 **${minCount}** 包（少於 ${minCount} 包就跟直接轉帳沒兩樣了 🙅）。`
        );
      }
      if (displayCount > maxCount) {
        return interaction.editReply(
          `🧧 最多拆成 **${maxCount}** 包（目前填 ${displayCount}）。`
        );
      }

      if (kind === "normal") {
        if (displayTotal < minTotal) {
          return interaction.editReply(
            `🧧 紅包至少要 **${minTotal.toLocaleString()}** ${MONEY_EMOJI}（目前填 ${displayTotal.toLocaleString()}）。`
          );
        }
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;

      const pending = await client.redPacketGamesCollection.findOne({
        guildId,
        hostUserId: userId,
        status: { $in: ["open", "closing"] },
      });
      if (pending) {
        const grabbed = pending.grabbers?.length || 0;
        const total = pending.displayCount ?? pending.totalCount;
        const expiresEpoch = Math.floor(new Date(pending.expiresAt).getTime() / 1000);
        return interaction.editReply(
          `🧧 你上一包紅包還沒被搶完（已搶 **${grabbed}** / ${total} 包）！\n` +
          `等它被搶光或 <t:${expiresEpoch}:R> 到期退回後，才能再發新的一包。`
        );
      }

      const actualPay = kind === "prank" ? prankFee : displayTotal;

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;
      if (balance < actualPay) {
        const need = kind === "prank"
          ? `傻瓜紅包整人費 **${actualPay.toLocaleString()}** ${MONEY_EMOJI}`
          : `這包要 **${actualPay.toLocaleString()}** ${MONEY_EMOJI}`;
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}**，發${need}。`
        );
      }

      const gameId = crypto.randomUUID();

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -actualPay,
        source: "bet",
        member: interaction.member,
        meta: { game: "redPacket", gameId, kind: kind === "prank" ? "prank_fee" : "fund" },
      });
      if (!betResult) {
        return interaction.editReply("🔧 扣款失敗，請稍後再試。");
      }

      const shares = kind === "prank"
        ? new Array(displayCount).fill(0)
        : buildShares(displayTotal, displayCount, mode);
      const windowSec = kind === "prank" ? prankWindowSec : normalWindowSec;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + windowSec * 1000);

      const state = {
        gameId,
        guildId,
        channelId: interaction.channelId,
        messageId: null,
        hostUserId: userId,
        hostUsername: username,
        kind,
        mode,
        title: title || null,
        totalAmount: actualPay,
        totalCount: displayCount,
        displayAmount: displayTotal,
        displayCount,
        prankFee: kind === "prank" ? prankFee : 0,
        shares,
        grabbers: [],
        status: "open",
        refunded: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt,
      };

      await client.redPacketGamesCollection.insertOne(state);

      const message = await interaction.channel.send(buildOpenPayload(state));
      await client.redPacketGamesCollection.updateOne(
        { gameId },
        { $set: { messageId: message.id, updatedAt: new Date() } }
      );

      const windowText = windowSec >= 60
        ? `${Math.round(windowSec / 60)} 分鐘`
        : `${windowSec} 秒`;
      const hostNotice = kind === "prank"
        ? `🤡 傻瓜紅包已發出！花費 **${prankFee.toLocaleString()}** ${MONEY_EMOJI} 整人費（不退回），` +
          `顯示金額 ${displayTotal.toLocaleString()} ${MONEY_EMOJI} / ${displayCount} 包都是假的。` +
          `${windowText}內看誰來上鉤～`
        : `🧧 紅包已發出！共 ${displayTotal.toLocaleString()} ${MONEY_EMOJI} / ${displayCount} 包，` +
          `${windowText}內沒搶完會退回給你。`;
      await interaction.editReply(hostNotice);

      const delayMs = expiresAt.getTime() - Date.now();
      if (delayMs > 0) {
        setTimeout(() => {
          closeRedPacket(client, gameId, { reason: "expired" }).catch((e) =>
            console.log(`[REDPACKET] auto-close failed: ${e}`.yellow)
          );
        }, delayMs).unref?.();
      }
    } catch (error) {
      console.log(`[ERROR] /紅包:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 發紅包失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
