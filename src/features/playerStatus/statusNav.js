const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");

const PREFIX = "pStat_";
const SEC_PREFIX = "pStatSec_";

// 狀態面板的分類子頁：一頁全塞太難找，拆成三大類用下拉切換。
const SECTIONS = [
  {
    id: "overview",
    label: "總覽",
    desc: "體力與已套用的關鍵加成",
    emoji: "📊",
  },
  {
    id: "sources",
    label: "加成來源",
    desc: "金幣・身分組・公會・活動・世界事件",
    emoji: "🔗",
  },
  {
    id: "timed",
    label: "時效狀態",
    desc: "食物 buff・消耗道具・防身狀態",
    emoji: "⏳",
  },
];

function buildSectionRow(userId, current) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SEC_PREFIX}${userId}`)
    .setPlaceholder("切換狀態分類…")
    .addOptions(
      SECTIONS.map((sec) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(sec.label)
          .setValue(sec.id)
          .setDescription(sec.desc)
          .setEmoji(sec.emoji)
          .setDefault(sec.id === current),
      ),
    );
  return new ActionRowBuilder().addComponents(menu);
}

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
      .setLabel("狀態")
      .setEmoji("✨")
      .setStyle(current === "buff" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(current === "buff"),
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

module.exports = {
  PREFIX,
  SEC_PREFIX,
  SECTIONS,
  buildSectionRow,
  buildNavRow,
  appendNav,
};
