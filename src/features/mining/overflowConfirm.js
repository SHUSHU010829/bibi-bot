const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { mining } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");

// 「背包滿了，繼續會把溢出礦自動折成金幣」的二次確認 UI。
// 由各個發放礦石的指令在偵測到溢出風險時呼叫，按下確認後由對應 handler 重跑流程。
function buildOverflowConfirmView({
  title,
  body,
  used,
  cap,
  confirmCustomId,
  cancelCustomId,
  confirmLabel,
}) {
  const lines = [
    `# 🎒 ${title}`,
    body,
    "",
    `**背包狀態**\n${used}/${cap}（已滿）`,
    "",
    `-# 繼續會把放不下的礦石依系統收購價自動折算成 ${COIN_EMOJI} 入帳。想保留實體礦石，請先 \`/賣礦\` 或 \`/合成\` 騰出空間。`,
  ];

  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n"))
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(confirmCustomId)
          .setLabel(confirmLabel || "繼續（溢出折金幣）")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(cancelCustomId)
          .setLabel("取消")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  return container;
}

// 把溢出的礦石折成金幣（依系統收購價）。回傳 { delivered, overflowQty, overflowCoins }
// 呼叫端負責真正 $inc backpack 和 grantCoins；本函式只做「分配計算」。
function splitForOverflow({ qty, space }) {
  const delivered = Math.max(0, Math.min(space, qty));
  const overflowQty = Math.max(0, qty - delivered);
  return { delivered, overflowQty };
}

function priceOf(oreKey) {
  return mining?.ores?.[oreKey]?.price || 0;
}

function overflowLineText(ore, overflowQty, overflowCoins) {
  const oreDef = mining?.ores?.[ore] || {};
  return (
    `🎒 背包放不下 **${oreDef.emoji || "⛏️"} ${oreDef.name || ore} ×${overflowQty}**，` +
    `已自動折成 **+${overflowCoins.toLocaleString()}** ${COIN_EMOJI} 入帳。`
  );
}

module.exports = {
  buildOverflowConfirmView,
  splitForOverflow,
  priceOf,
  overflowLineText,
};
