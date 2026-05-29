// 賭場遊戲共用的結果 Embed 組裝器。
//
// 目標：在熱鬧的賭場頻道裡，一眼就能看出「這是誰的遊戲、輸贏多少」。
// - Embed author 放玩家頭像＋顯示名稱
// - 內文附上 <@id> 提及與純數字 ID（方便辨識／管理時複製）
// - 下注／賠付／淨輸贏／餘額以欄位呈現
// - 既有的遊戲圖片用 setImage 放進 embed（attachment://<檔名>）

const { EmbedBuilder } = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const CASINO_COLORS = {
  win: 0x2ecc71,
  lose: 0xe74c3c,
  neutral: 0x5865f2,
  jackpot: 0xf1c40f,
};

// net 帶正負號的金額字串（淨輸贏）。
function signedAmount(net) {
  const sign = net > 0 ? "＋" : net < 0 ? "－" : "±";
  return `${sign}${Math.abs(net).toLocaleString()} ${MONEY_EMOJI}`;
}

function buildCasinoEmbed({
  game, // 遊戲標題，如 "🎴 HI-LO"
  user, // { id, displayName, avatarURL }
  outcome = "neutral", // win | lose | neutral | jackpot → 決定顏色
  headline, // 一行結果標題（可選）
  lines = [], // 額外狀態敘述（陣列，逐行）
  bet, // 下注金額
  payout, // 贏得金額（沒有 net 時顯示）
  net, // 淨輸贏（有就優先顯示，帶正負）
  balance, // 餘額
  imageName, // 放進 embed 的附件檔名
  footer, // 頁尾文字
} = {}) {
  const embed = new EmbedBuilder().setColor(
    CASINO_COLORS[outcome] || CASINO_COLORS.neutral
  );
  if (game) embed.setTitle(game);

  if (user) {
    embed.setAuthor({
      name: (user.displayName || "玩家").slice(0, 256),
      iconURL: user.avatarURL || undefined,
    });
  }

  const descParts = [];
  if (user?.id) descParts.push(`玩家：<@${user.id}>`);
  if (headline) descParts.push(headline);
  if (lines.length) descParts.push(lines.join("\n"));
  if (descParts.length) embed.setDescription(descParts.join("\n").slice(0, 4096));

  const fields = [];
  if (typeof bet === "number") {
    fields.push({
      name: "下注",
      value: `${bet.toLocaleString()} ${MONEY_EMOJI}`,
      inline: true,
    });
  }
  if (typeof net === "number") {
    fields.push({ name: "淨輸贏", value: signedAmount(net), inline: true });
  } else if (typeof payout === "number") {
    fields.push({
      name: "賠付",
      value: `＋${payout.toLocaleString()} ${MONEY_EMOJI}`,
      inline: true,
    });
  }
  if (typeof balance === "number") {
    fields.push({
      name: "餘額",
      value: `${balance.toLocaleString()} ${MONEY_EMOJI}`,
      inline: true,
    });
  }
  if (fields.length) embed.addFields(fields);

  if (imageName) embed.setImage(`attachment://${imageName}`);
  if (footer) embed.setFooter({ text: footer.slice(0, 2048) });

  return embed;
}

module.exports = { buildCasinoEmbed, CASINO_COLORS, signedAmount };
