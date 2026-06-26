// 賭場牌局被自動清理 / 退款後，主動 DM 通知玩家款項去向，
// 避免「被清房後以為錢不見了」的誤會。不丟例外、不阻塞結算流程。

require("colors");

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

function buildBody({ game, kind, amount = 0, detail }) {
  const name = GAME_NAMES[game] || game;
  const amt = Number(amount).toLocaleString();
  const d = detail ? `（${detail}）` : "";
  switch (kind) {
    case "cashout":
      return `🧹 你的 **${name}** 因閒置太久自動收手了${d}。\n已派彩 **${amt}** credits 入帳。`;
    case "win":
      return `🧹 你的 **${name}** 因閒置自動開獎${d}，恭喜中獎！\n已派彩 **${amt}** credits 入帳。`;
    case "lose":
      return `🧹 你的 **${name}** 因閒置自動開獎${d}，可惜這次沒中。`;
    case "bust":
      return `🧹 你的 **${name}** 因閒置自動結算${d}，可惜沒能及時收手，這局未派彩。`;
    case "refund":
    default:
      return `🧹 你的 **${name}** 因閒置太久自動結束了${d}。\n已全額退回 **${amt}** credits。`;
  }
}

// 單人牌局清理通知（refund / cashout / win / lose / bust）
async function notifyAbandon(client, userId, opts) {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    const noMoney = opts.kind === "bust" || opts.kind === "lose";
    const footer = noMoney
      ? "系統會自動清理閒置太久的牌局。"
      : "系統會自動清理閒置太久的牌局，款項一定回到你身上 👍";
    await user.send(`${buildBody(opts)}\n-# ${footer}`).catch(() => {});
  } catch (e) {
    console.log(`[CASINO] 清理 DM 失敗 ${userId}:${e.message}`.yellow);
  }
}

// 自訂訊息 DM（給群組遊戲退款等情境用）
async function notifyDm(client, userId, message) {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    await user.send(message).catch(() => {});
  } catch (e) {
    console.log(`[CASINO] DM 失敗 ${userId}:${e.message}`.yellow);
  }
}

module.exports = { notifyAbandon, notifyDm, GAME_NAMES };
