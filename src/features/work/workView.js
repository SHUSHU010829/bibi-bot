const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { work } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");

const PICK_PREFIX = "workpick_";

function workTypes() {
  return Array.isArray(work?.workTypes) ? work.workTypes : [];
}

// 依 key 取事件層級的顏色 / 標題（normal / good / jackpot / bad）。
function tierMeta(tier) {
  const tiers = work?.eventTiers || {};
  return tiers[tier] || tiers.normal || { color: 0x3498db, title: "💼 打工完成" };
}

// 上工前的「選工作類型」訊息：每種類型一行說明 + 一排按鈕。
function buildChoiceMessage(ownerId, { claimsToday, maxClaims } = {}) {
  const types = workTypes();

  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# 💼 今天想怎麼打工？\n" +
          "選一種上工方式吧！運氣好可能收到小費、獎金甚至大紅包，運氣差也可能白忙一場…"
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        types.map((t) => `${t.emoji} **${t.name}**\n-# ${t.desc}`).join("\n\n")
      )
    );

  const styleByKey = { steady: ButtonStyle.Primary, risky: ButtonStyle.Danger };
  const row = new ActionRowBuilder().addComponents(
    ...types.map((t) =>
      new ButtonBuilder()
        .setCustomId(`${PICK_PREFIX}${ownerId}_${t.key}`)
        .setLabel(t.name)
        .setEmoji(t.emoji)
        .setStyle(styleByKey[t.key] || ButtonStyle.Secondary)
    )
  );
  container.addActionRowComponents(row);

  if (maxClaims != null) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 今日次數 ${claimsToday ?? 0}/${maxClaims}`)
    );
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// 打工結果訊息：標題 / 顏色依事件層級變化，帶事件敘述。
function buildResultMessage(result, { notifyEnabled } = {}) {
  const readyEpoch = Math.floor(result.newCooldownAt / 1000);
  const tier = tierMeta(result.event?.tier);

  const bonusNotes =
    (result.foodWorkBonus > 0 ? ` （食物加成 +${Math.round(result.foodWorkBonus * 100)}%）` : "") +
    (result.guildWorkBonus > 0 ? ` （公會加成 +${Math.round(result.guildWorkBonus * 100)}%）` : "");

  const eventLine = result.eventText ? `\n${result.eventText}` : "";
  const multLine =
    result.eventMult != null && result.eventMult !== 1
      ? `\n-# 打工事件倍率 ×${result.eventMult}（基礎 ${result.baseAmount.toLocaleString()} 幣）`
      : "";

  const xpLine = result.xpGained > 0 ? `\n⭐ 經驗值 **+${result.xpGained}**` : "";

  const levelLine = result.level != null
    ? `Lv.${result.level} **${result.levelName}**`
    : "—";
  const progressLine = result.toNext != null
    ? `-# 距下一級（${result.nextLevelName}）還需 ${result.toNext} 次`
    : result.level != null
      ? "-# 已達最高等級 🎉"
      : "";

  const container = new ContainerBuilder()
    .setAccentColor(tier.color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${tier.title}\n你${result.job}。${eventLine}\n` +
          `結算：**+${result.amount.toLocaleString()}** ${COIN_EMOJI}${bonusNotes}${multLine}${xpLine}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**打工等級**\n${levelLine}\n${progressLine}`)
    );

  if (result.foodBuffLines?.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🍽️ 食物加成**\n${result.foodBuffLines.join("\n")}`)
    );
  }

  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**目前餘額**\n${result.balance.toLocaleString()} ${COIN_EMOJI}`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**今日次數**\n${result.claimsToday}/${result.maxClaims}`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**下次可打工**\n<t:${readyEpoch}:R>`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 想要更高報酬？試試 /挖礦 吧！")
    );

  if (!notifyEnabled) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 🔔 想冷卻結束時收到提醒？用 `/通知設定` 開啟打工到點通知。"
      )
    );
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildDisabledMessage() {
  const container = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🔧 打工系統尚未啟動\n-# 稍後再試，或呼叫舒舒開啟。")
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildCooldownMessage(readyAt) {
  const readyEpoch = Math.floor(readyAt / 1000);
  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# 💼 你還在休息！\n" +
          `下次可打工：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）\n` +
          "-# 冷卻中先去 /挖礦 或 /釣魚 賺一波吧。"
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildDailyLimitMessage({ claimsToday, maxClaims, resetEpoch }) {
  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# 💼 今天的打工次數用完了\n" +
          `已打工 ${claimsToday}/${maxClaims} 次，達每日上限。\n` +
          `明天再來：<t:${resetEpoch}:R>\n` +
          "-# 想繼續賺？去 /挖礦、/釣魚 或 /賭場 試試手氣。"
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

module.exports = {
  PICK_PREFIX,
  buildChoiceMessage,
  buildResultMessage,
  buildDisabledMessage,
  buildCooldownMessage,
  buildDailyLimitMessage,
};
