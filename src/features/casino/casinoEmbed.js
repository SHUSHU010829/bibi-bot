// 賭場遊戲共用的結果 Embed 組裝器。
//
// 目標：在熱鬧的賭場頻道裡，一眼就能看出「這是誰的遊戲、輸贏多少」。
// - Embed author 放玩家頭像＋顯示名稱
// - 內文附上 <@id> 提及與純數字 ID（方便辨識／管理時複製）
// - 下注／賠付／淨輸贏／餘額以欄位呈現
// - 既有的遊戲圖片用 setImage 放進 embed（attachment://<檔名>）

const {
  EmbedBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require("discord.js");
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

  // 玩家名稱已由 embed 標頭（author）呈現，內文不再重複標註
  const descParts = [];
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

// Components V2 版的結果呈現：把標題、玩家、結果圖（GIF）、戰績與重玩按鈕
// 全部收進一個 ContainerBuilder，讓賭場結果訊息有一致的卡片外觀。
// 用法與 buildCasinoEmbed 幾乎相同，差別在回傳 ContainerBuilder，
// 送出時需帶 flags: MessageFlags.IsComponentsV2。
function buildCasinoContainer({
  game, // 遊戲標題，如 "🎡 倍率轉盤"
  user, // { id, displayName }
  outcome = "neutral", // win | lose | neutral | jackpot → 決定 accent 顏色
  headline, // 一行結果標題（可選）
  lines = [], // 額外狀態敘述（陣列，逐行）
  bet, // 下注金額
  payout, // 贏得金額（沒有 net 時顯示）
  net, // 淨輸贏（有就優先顯示，帶正負）
  balance, // 餘額
  imageName, // 放進 media gallery 的附件檔名
  actionRow, // 收進容器底部的 ActionRowBuilder（如重玩按鈕）
} = {}) {
  const container = new ContainerBuilder().setAccentColor(
    CASINO_COLORS[outcome] || CASINO_COLORS.neutral
  );

  const titleParts = [];
  if (game) titleParts.push(`## ${game}`);
  if (user?.id) titleParts.push(`-# <@${user.id}>`);
  if (titleParts.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(titleParts.join("\n"))
    );
  }

  const body = [];
  if (headline) body.push(headline);
  if (lines.length) body.push(lines.join("\n"));
  if (body.length) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(body.join("\n").slice(0, 4096))
    );
  }

  if (imageName) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${imageName}`)
      )
    );
  }

  const stats = [];
  if (typeof bet === "number") {
    stats.push(`下注 **${bet.toLocaleString()} ${MONEY_EMOJI}**`);
  }
  if (typeof net === "number") {
    stats.push(`淨輸贏 **${signedAmount(net)}**`);
  } else if (typeof payout === "number") {
    stats.push(`賠付 **＋${payout.toLocaleString()} ${MONEY_EMOJI}**`);
  }
  if (typeof balance === "number") {
    stats.push(`餘額 **${balance.toLocaleString()} ${MONEY_EMOJI}**`);
  }
  if (stats.length) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(stats.join("　｜　"))
    );
  }

  if (actionRow) {
    container.addActionRowComponents(actionRow);
  }

  return container;
}

module.exports = {
  buildCasinoEmbed,
  buildCasinoContainer,
  CASINO_COLORS,
  signedAmount,
};
