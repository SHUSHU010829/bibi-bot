// 賭場牌局被自動清理 / 退款後，主動 DM 通知玩家款項去向。
// 用 Embed 呈現，乾淨好看；不丟例外、不阻塞結算流程。

require("colors");
const { EmbedBuilder } = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const GAME_NAMES = {
  mines: "踩地雷",
  blackjack: "二十一點",
  hilo: "猜大小",
  tower: "爬塔",
  dragonGate: "射龍門",
  keno: "尋寶",
  roulette: "輪盤",
  crash: "火箭",
  scratch: "刮刮樂",
  casinoHoldem: "德州撲克",
  redPacket: "紅包",
  russianRoulette: "俄羅斯輪盤",
};

const COLORS = {
  refund: 0x2ecc71,
  cashout: 0x2ecc71,
  win: 0xf1c40f,
  lose: 0x95a5a6,
  bust: 0xe74c3c,
};

function buildAbandonEmbed({ game, kind, amount = 0, detail }) {
  const name = GAME_NAMES[game] || game;
  const d = detail ? `（${detail}）` : "";
  const amt = `**${Number(amount).toLocaleString()}** ${MONEY_EMOJI}`;

  let title;
  let desc;
  switch (kind) {
    case "cashout":
      title = "🧹 自動收手";
      desc = `你的 **${name}** 閒置太久自動收手${d}\n已派彩 ${amt} 入帳`;
      break;
    case "win":
      title = "🎉 自動開獎・中獎";
      desc = `你的 **${name}** 閒置自動開獎${d}，恭喜中獎！\n已派彩 ${amt} 入帳`;
      break;
    case "lose":
      title = "🧹 自動開獎";
      desc = `你的 **${name}** 閒置自動開獎${d}\n可惜這次沒中，再接再厲！`;
      break;
    case "bust":
      title = "🧹 自動結算";
      desc = `你的 **${name}** 閒置自動結算${d}\n可惜沒能及時收手，這局未派彩`;
      break;
    case "refund":
    default:
      title = "🧹 自動退款";
      desc = `你的 **${name}** 閒置太久自動結束${d}\n已全額退回 ${amt}`;
      break;
  }
  return new EmbedBuilder()
    .setColor(COLORS[kind] || COLORS.refund)
    .setTitle(title)
    .setDescription(desc);
}

// 單人牌局清理通知（refund / cashout / win / lose / bust）
async function notifyAbandon(client, userId, opts) {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    await user.send({ embeds: [buildAbandonEmbed(opts)] }).catch(() => {});
  } catch (e) {
    console.log(`[CASINO] 清理 DM 失敗 ${userId}:${e.message}`.yellow);
  }
}

// 自訂 Embed DM（群組遊戲退款等情境）
async function notifyEmbed(client, userId, { title, description, color = COLORS.refund } = {}) {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    const embed = new EmbedBuilder().setColor(color);
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    await user.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.log(`[CASINO] DM 失敗 ${userId}:${e.message}`.yellow);
  }
}

module.exports = { notifyAbandon, notifyEmbed, GAME_NAMES, COLORS };
