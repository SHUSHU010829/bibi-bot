const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const itemRegistry = require("../economy/itemRegistry");
const { getPrizeFeeRate, getPrizeFeeExemptParticipants } = require("../economy/refundFee");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

const COLOR_REVIEW = 0x5865f2;
const COLOR_FUNDING = 0xeb459e;
const COLOR_OK = 0x57f287;
const COLOR_WARN = 0x95a5a6;
const COLOR_BAD = 0xed4245;

function nameOf(guild, userId) {
  return plainifyUserMentions(guild, `<@${userId}>`);
}

function epoch(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function progressBar(raised, goal) {
  const pct = goal > 0 ? Math.min(raised / goal, 1) : 0;
  const filled = Math.round(pct * 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${Math.round(pct * 100)}%`;
}

// 募資目標是選填的，沒填就沒有分母可以畫進度條，只報已募得金額。
function goalLabel(goal) {
  return goal ? `${goal.toLocaleString()} credits` : "未設定（不設門檻，募多少算多少）";
}

function progressLines(f) {
  if (!f.goal) return `${f.raised.toLocaleString()} credits`;
  return `${f.raised.toLocaleString()} / ${f.goal.toLocaleString()} credits\n${progressBar(f.raised, f.goal)}`;
}

// 物品池一律轉中文；找不到定義（config 移除過的物品）就標示為已下架，不印英文 id。
function formatItemPool(itemPool = []) {
  if (!itemPool.length) return null;
  return itemPool
    .map((it) => `${itemRegistry.labelOf(it.value) || "❔ 已下架物品"} ×${it.qty.toLocaleString()}`)
    .join("・");
}

// 既有的防洗錢摩擦：參賽人數未達門檻時，每筆獎金會被抽成，得獎者實得會比帳面少。
function prizeFeeHint() {
  const pct = Math.round(getPrizeFeeRate() * 100);
  const exempt = getPrizeFeeExemptParticipants();
  return `結算發獎時，參賽未滿 ${exempt} 人每筆獎金抽 ${pct}%（達 ${exempt} 人免收）。防洗錢機制。`;
}

function retentionLine(doc) {
  const pct = doc.funding.hostRetentionPct || 0;
  if (pct <= 0) return "**主辦人抽成**：0%（募得的每一分都會發成獎金）";
  const amount = Math.floor((doc.funding.raised || 0) * (pct / 100));
  return `**主辦人保留**：${pct}%（目前約 ${amount.toLocaleString()} credits），其餘全數發成獎金`;
}

function buildNotice({ title, body, hint, kind = "ok" }) {
  const color =
    kind === "bad" ? COLOR_BAD : kind === "warn" ? COLOR_WARN : kind === "fund" ? COLOR_FUNDING : COLOR_OK;
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));
  if (body) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  }
  if (hint) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  }
  return container;
}

function buildReviewContainer(doc, guild) {
  const f = doc.funding;
  const capacity = doc.maxParticipants
    ? `最少 ${doc.minParticipants} 人・最多 ${doc.maxParticipants} 人`
    : `最少 ${doc.minParticipants} 人・無上限`;

  return new ContainerBuilder()
    .setAccentColor(COLOR_REVIEW)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📥 募資活動申請\n**${doc.name}**\n${doc.description || "（沒有描述）"}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**申請人**：${nameOf(guild, doc.hostId)}\n` +
          `**募資目標**：${goalLabel(f.goal)}\n` +
          `**募資天數**：${f.days} 天\n` +
          `**名次**：${doc.rankCount} 名\n` +
          `**報名人數**：${capacity}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(retentionLine(doc)))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 活動 ID：${doc.eventId} ・ 申請於 <t:${epoch(doc.createdAt)}:f>\n` +
          "-# 通過後才會開放募資；募得的 credits 與物品全鎖在活動錢包，只能在結算時發給參加者。\n" +
          `-# ${prizeFeeHint()}`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`fundreview_approve_${doc.eventId}`)
          .setLabel("通過，開始募資")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`fundreview_reject_${doc.eventId}`)
          .setLabel("駁回")
          .setEmoji("🚫")
          .setStyle(ButtonStyle.Danger),
      ),
    );
}

function buildReviewDecidedContainer(doc, guild) {
  const approved = doc.status !== "REJECTED";
  const f = doc.funding;
  const lines = [
    `**申請人**：${nameOf(guild, doc.hostId)}`,
    `**募資目標**：${goalLabel(f.goal)}`,
  ];
  if (approved) {
    lines.push(`**審核**：${nameOf(guild, f.approvedBy)} 於 <t:${epoch(f.approvedAt)}:f> 通過`);
    lines.push(`**募資截止**：<t:${epoch(f.deadline)}:f>（<t:${epoch(f.deadline)}:R>）`);
  } else {
    lines.push(`**審核**：${nameOf(guild, f.rejectedBy)} 於 <t:${epoch(f.rejectedAt)}:f> 駁回`);
    lines.push(`**理由**：${f.rejectReason || "（未填）"}`);
  }

  return new ContainerBuilder()
    .setAccentColor(approved ? COLOR_OK : COLOR_BAD)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${approved ? "✅ 募資活動已通過" : "🚫 募資活動已駁回"}\n**${doc.name}**`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 活動 ID：${doc.eventId}`),
    );
}

function buildFundActionRows(doc, { open }) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fund_coin_${doc.eventId}`)
        .setLabel(open ? "募資 credits" : "募資已截止")
        .setEmoji("💰")
        .setStyle(open ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!open),
      new ButtonBuilder()
        .setCustomId(`fund_item_${doc.eventId}`)
        .setLabel("募資物品")
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!open),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fund_detail_${doc.eventId}`)
        .setLabel("募資明細")
        .setEmoji("📊")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`fund_manage_${doc.eventId}`)
        .setLabel("管理（限主辦人）")
        .setEmoji("⚙️")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
  return rows;
}

function buildFundraisingContainer(doc, guild, { open }) {
  const f = doc.funding;
  const capacity = doc.maxParticipants
    ? `最少 ${doc.minParticipants} 人・最多 ${doc.maxParticipants} 人`
    : `最少 ${doc.minParticipants} 人・無上限`;
  const itemLine = formatItemPool(f.itemPool);

  const container = new ContainerBuilder()
    .setAccentColor(open ? COLOR_FUNDING : COLOR_WARN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎁 ${doc.name}（募資中）\n${doc.description || "（沒有描述）"}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**主辦人**：${nameOf(guild, doc.hostId)}\n` +
          `**名次**：${doc.rankCount} 名\n` +
          `**報名人數**：${capacity}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${f.goal ? "募資進度" : "已募得"}**　${progressLines(f)}\n` +
          `**贊助人數**：${f.donorCount || 0} 人`,
      ),
    );

  if (itemLine) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**物品獎池**\n${itemLine.slice(0, 1500)}`),
    );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(retentionLine(doc)))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        (open
          ? `-# 募資截止：<t:${epoch(f.deadline)}:f>（<t:${epoch(f.deadline)}:R>）\n` +
            "-# 募到的 credits 與物品鎖在活動錢包，主辦人領不走，只能在結算時發給參加者；活動取消則原路退還贊助者。"
          : "-# 募資已截止，等待主辦人開始報名。取消活動時所有贊助會原路退還。") +
          `\n-# ${prizeFeeHint()}`,
      ),
    );

  for (const row of buildFundActionRows(doc, { open })) {
    container.addActionRowComponents(row);
  }
  return container;
}

function buildDetailContainer(doc, donors, guild) {
  const f = doc.funding;
  const lines = donors.slice(0, 20).map((d) => {
    const parts = [];
    if (d.coins > 0) parts.push(`${d.coins.toLocaleString()} credits`);
    for (const it of d.items) {
      parts.push(`${itemRegistry.labelOf(it.value) || "❔ 已下架物品"} ×${it.qty.toLocaleString()}`);
    }
    return `・${nameOf(guild, d.userId)} — ${parts.join("、")}`;
  });

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_FUNDING)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 📊 ${doc.name}｜募資明細`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**已募得**：${progressLines(f)}`,
      ),
    );

  const itemLine = formatItemPool(f.itemPool);
  if (itemLine) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**物品獎池**\n${itemLine.slice(0, 1500)}`),
    );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**贊助者（${donors.length} 人）**\n${lines.join("\n").slice(0, 3000) || "（尚無人贊助）"}`,
      ),
    );

  if (donors.length > 20) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 只顯示前 20 位，其餘 ${donors.length - 20} 位未列出。`),
    );
  }
  return container;
}

function buildFundManagePanel(doc, { open, canStart, startBlockReason }) {
  const f = doc.funding;
  const retention = Math.floor(f.raised * ((f.hostRetentionPct || 0) / 100));
  const prizePool = f.raised - retention;
  const itemLine = formatItemPool(f.itemPool);

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_FUNDING)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ⚙️ ${doc.name}｜募資管理`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**已募得**：${f.raised.toLocaleString()} credits（${f.donorCount || 0} 位贊助者）\n` +
          `**你可保留**：${retention.toLocaleString()} credits（${f.hostRetentionPct || 0}%）\n` +
          `**必須發成獎金**：${prizePool.toLocaleString()} credits${itemLine ? `\n**物品獎池**：${itemLine}` : ""}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        (open
          ? `-# 募資截止 <t:${epoch(f.deadline)}:R>，也可以現在就結束募資開始報名。`
          : "-# 募資已截止。") + `\n-# ${prizeFeeHint()}`,
      ),
    );

  if (!canStart && startBlockReason) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ⚠️ ${startBlockReason}`),
    );
  }

  return container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fund_start_${doc.eventId}`)
        .setLabel("結束募資，開始報名")
        .setEmoji("🚀")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canStart),
      new ButtonBuilder()
        .setCustomId(`fund_cancel_${doc.eventId}`)
        .setLabel("取消活動並全額退還")
        .setEmoji("🚫")
        .setStyle(ButtonStyle.Danger),
    ),
  );
}

function buildCancelConfirmContainer(doc) {
  const f = doc.funding;
  const itemLine = formatItemPool(f.itemPool);
  return new ContainerBuilder()
    .setAccentColor(COLOR_BAD)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🚫 確定要取消「${doc.name}」？`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `將退還 **${f.raised.toLocaleString()}** credits 給 ${f.donorCount || 0} 位贊助者` +
          (itemLine ? `\n以及物品：${itemLine}` : ""),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 退款原路退回，主辦人拿不到任何一分；此操作無法復原。"),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`fund_cancelconfirm_${doc.eventId}`)
          .setLabel("確定取消並退還")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`fund_manage_${doc.eventId}`)
          .setLabel("再想想")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

function buildCoinModal(doc, balance, minDonation) {
  return new ModalBuilder()
    .setCustomId(`fund_coinmodal_${doc.eventId}`)
    .setTitle(`贊助「${doc.name}」`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("amount")
          .setLabel(`金額（最低 ${minDonation}）`.slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10)
          .setPlaceholder(`你目前有 ${balance.toLocaleString()} credits`),
      ),
    );
}

function buildOwnedItemSelect(doc, owned) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`fund_itemsel_${doc.eventId}`)
      .setPlaceholder("選擇要贊助的物品")
      .addOptions(
        owned.slice(0, 25).map((it) => ({
          label: `${it.name}（持有 ${it.qty.toLocaleString()}）`.slice(0, 100),
          value: it.value,
        })),
      )
      .setMinValues(1)
      .setMaxValues(1),
  );
}

function buildItemQtyModal(doc, item, owned) {
  return new ModalBuilder()
    .setCustomId(`fund_itemqty_${doc.eventId}_${item.value}`)
    .setTitle(`贊助 ${item.label}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("qty")
          .setLabel(`數量（持有 ${owned}）`.slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(5)
          .setPlaceholder("輸入正整數"),
      ),
    );
}

function buildRejectModal(eventId) {
  return new ModalBuilder()
    .setCustomId(`fundreject_modal_${eventId}`)
    .setTitle("駁回募資活動")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("駁回理由（會回覆給申請人）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(300),
      ),
    );
}

module.exports = {
  buildNotice,
  buildReviewContainer,
  buildReviewDecidedContainer,
  buildFundraisingContainer,
  buildFundActionRows,
  buildDetailContainer,
  buildFundManagePanel,
  buildCancelConfirmContainer,
  buildCoinModal,
  buildOwnedItemSelect,
  buildItemQtyModal,
  buildRejectModal,
  formatItemPool,
  progressBar,
  progressLines,
};
