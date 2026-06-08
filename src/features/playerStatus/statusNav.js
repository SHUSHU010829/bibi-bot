const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SeparatorBuilder,
} = require("discord.js");

const PREFIX = "pStat_";

function buildNavRow(userId, current) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${userId}_backpack`)
      .setLabel("背包")
      .setEmoji("🎒")
      .setStyle(current === "backpack" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(current === "backpack"),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${userId}_buff`)
      .setLabel("加成")
      .setEmoji("✨")
      .setStyle(current === "buff" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(current === "buff"),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${userId}_food`)
      .setLabel("魚袋")
      .setEmoji("🥡")
      .setStyle(current === "food" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(current === "food"),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}${userId}_refresh_${current}`)
      .setLabel("刷新")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Success),
  );
}

function appendNav(view, userId, current) {
  if (!view || !Array.isArray(view.components)) return view;
  const container = view.components[0];
  if (!container || typeof container.addSeparatorComponents !== "function") return view;
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addActionRowComponents(buildNavRow(userId, current));
  return view;
}

module.exports = { PREFIX, buildNavRow, appendNav };
