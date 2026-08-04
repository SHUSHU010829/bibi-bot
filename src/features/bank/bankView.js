const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const COLOR = {
  red: 0xe74c3c,
  gold: 0xf1c40f,
  green: 0x2ecc71,
  blue: 0x3498db,
  purple: 0x9b59b6,
};

function fmt(n) {
  return Math.round(n || 0).toLocaleString();
}

// 統一錯誤呈現（UX #2）：標題 + 具體差距 + 解決提示。
function errorContainer({ title, detail, hint }) {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR.red)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`));
  if (detail) {
    c.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(
      new TextDisplayBuilder().setContent(detail),
    );
  }
  if (hint) {
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  }
  return c;
}

const BAR = "█";
const EMPTY = "░";

function progressBar(cur, floor, ceil, width = 12) {
  if (ceil == null || ceil <= floor) return BAR.repeat(width);
  const ratio = Math.max(0, Math.min(1, (cur - floor) / (ceil - floor)));
  const filled = Math.round(ratio * width);
  return BAR.repeat(filled) + EMPTY.repeat(width - filled);
}

// 信用分卡片：等級、分數、下一級進度、當前額度。
function creditCard(limits, displayName, extra = {}) {
  const { score, tier, next } = limits;
  const c = new ContainerBuilder()
    .setAccentColor(COLOR.gold)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${tier.emoji} ${tier.name}　信用分 ${score}\n-# ${displayName} 的信用評等`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (next) {
    const bar = progressBar(score, tier.min, next.min);
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `\`${bar}\`　距 **${next.emoji} ${next.name}** 還差 **${next.min - score}** 分`,
      ),
    );
  } else {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("🏆 已達最高信用評等！"),
    );
  }

  const vaultLine =
    extra.vaultCapacity != null
      ? `\n🪙 黃金金庫容量　**${fmt(extra.vaultCapacity)}** ${extra.unitLabel || "克"}`
      : "";

  c.addSeparatorComponents(new SeparatorBuilder()).addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**目前銀行權益**\n` +
        `💸 轉帳單筆上限　**${fmt(tier.transferMax)}**\n` +
        `📅 每日轉帳額度　**${fmt(tier.dailyCap)}**\n` +
        `🔁 每日轉帳次數　**${tier.dailyCount}** 次\n` +
        `🏦 定存加開額度　**+${tier.depositSlotBonus || 0}** 筆\n` +
        `💰 貸款額度　**${tier.loanCap > 0 ? fmt(tier.loanCap) : "尚未開放"}**` +
        vaultLine,
    ),
  );

  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 完成轉帳、定存到期、準時還款可累積信用分；被判定洗幣或貸款違約會扣分",
    ),
  );
  return c;
}

// 提前解約二次確認（UX #2）：會扣違約金＋信用分的動作，先讓玩家確認。
function earlyWithdrawConfirm({ ownerId, depositId, principal, penaltyAmount, payout, creditPenalty }) {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR.red)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("# ⚠️ 確認提前解約？"))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `存單 \`${depositId}\` **尚未到期**，現在解約將扣：\n` +
          `💸 違約金 **${fmt(penaltyAmount)}**（本金 ${fmt(principal)} → 實領 **${fmt(payout)}**）` +
          (creditPenalty > 0 ? `\n📊 信用分 **−${creditPenalty}**` : ""),
      ),
    );

  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      creditPenalty > 0
        ? "-# 信用分影響轉帳額度、貸款額度與定存開戶數，扣分後需要時間才能累積回來。等到期領回可拿回本金＋利息。"
        : "-# 等到期領回可拿回本金＋利息，不會被扣違約金。",
    ),
  );

  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_${ownerId}_depclaimconfirm_${depositId}`)
        .setLabel("確認提前解約")
        .setEmoji("⚠️")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`bank_${ownerId}_depclaimcancel`)
        .setLabel("取消")
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return c;
}

module.exports = { COLOR, fmt, errorContainer, progressBar, creditCard, earlyWithdrawConfirm };
