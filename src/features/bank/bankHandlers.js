require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");

const { coinSystem, bank } = require("../../config");
const creditService = require("./creditService");
const goldService = require("./goldService");
const loanService = require("./loanService");
const depositService = require("./depositService");
const { COLOR, fmt, creditCard, progressBar } = require("./bankView");

const TABS = [
  { key: "overview", label: "總覽", emoji: "🏦" },
  { key: "credit", label: "信用分", emoji: "📊" },
  { key: "deposit", label: "定期存款", emoji: "📜" },
  { key: "gold", label: "黃金存摺", emoji: "🪙" },
  { key: "loan", label: "貸款", emoji: "💳" },
];

function ctxOf(interaction) {
  return {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    username: interaction.member?.displayName || interaction.user.username,
    displayName: interaction.member?.displayName || interaction.user.username,
    avatarHash: interaction.user.avatar,
    member: interaction.member,
  };
}

function navRow(userId, active) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`bank_${userId}_nav`)
    .setPlaceholder("前往銀行其他功能…")
    .addOptions(
      TABS.map((t) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(t.label)
          .setValue(t.key)
          .setEmoji(t.emoji)
          .setDefault(t.key === active),
      ),
    );
  return new ActionRowBuilder().addComponents(select);
}

const U = () => bank?.gold?.unitLabel || "克";

// 開啟 Modal 的按鈕（customId：bank_<uid>_open_<key>）
function openBtn(userId, key, label, style, emoji) {
  const b = new ButtonBuilder()
    .setCustomId(`bank_${userId}_open_${key}`)
    .setLabel(label)
    .setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

// ── 各分頁 Container ─────────────────────────────────────────────────────────
async function buildOverview(client, ctx) {
  const { userId, guildId, displayName } = ctx;
  const [limits, wallet, goldPrices, goldVault, activeDeposits, loans] =
    await Promise.all([
      creditService.getLimits(client, userId, guildId, ctx.member),
      client.userCoinsCollection.findOne({ userId, guildId }),
      bank?.gold?.enabled ? goldService.getPrices() : null,
      bank?.gold?.enabled ? goldService.getVaultStatus(client, userId, guildId, ctx.member) : null,
      client.coinDepositsCollection
        ? client.coinDepositsCollection.countDocuments({ userId, guildId, status: "active" })
        : 0,
      bank?.loan?.enabled && client.loansCollection
        ? loanService.listActive(client, userId, guildId)
        : [],
    ]);

  const balance = wallet?.totalCoins || 0;
  const goldHolding = goldVault?.units || 0;
  const goldValue = goldPrices ? goldHolding * goldPrices.sell : 0;
  const loanOutstanding = (loans || []).reduce((s, l) => s + (l.dueAmount - (l.paid || 0)), 0);
  const now = Date.now();
  const overdueLoans = (loans || []).filter(
    (l) => l.status === "defaulted" || (l.status === "active" && new Date(l.dueAt).getTime() < now),
  );
  const overdue = overdueLoans.length > 0;
  const frozen = overdue && bank?.loan?.freezeWithdrawOnOverdue;

  const nextLine = limits.next
    ? `\n-# 距 ${limits.next.emoji} ${limits.next.name} 還差 **${limits.next.min - limits.score}** 分`
    : "";

  const container = new ContainerBuilder()
    .setAccentColor(overdue ? COLOR.red : COLOR.gold)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🏦 ${displayName} 的銀行`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `💰 錢包餘額　**${fmt(balance)}**\n` +
          `${limits.tier.emoji} 信用評等　**${limits.tier.name}**（信用分 ${limits.score}）${nextLine}`,
      ),
    );

  if (overdue) {
    const total = overdueLoans.reduce((s, l) => s + (l.dueAmount - (l.paid || 0)), 0);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⚠️ **你有逾期貸款待還 ${fmt(total)}**${frozen ? "，黃金定存領回已凍結" : ""}\n-# 逾期每日加罰並扣信用分，請盡快用下方「還清貸款」還款`,
      ),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  const lines = [];
  if (bank?.gold?.enabled) {
    const cap = goldVault.limited
      ? `　（金庫 ${fmt(goldVault.used)}／${fmt(goldVault.capacity)} ${U()}）`
      : "";
    lines.push(
      `🪙 黃金金庫　**${fmt(goldHolding)}** ${U()}　≈ ${fmt(goldValue)} 幣${cap}　-# 賣出價 ${fmt(goldPrices.sell)}/${U()}`,
    );
  }
  lines.push(`📜 定期存款　**${activeDeposits}** 筆進行中`);
  if (bank?.loan?.enabled) {
    lines.push(loanOutstanding > 0 ? `💳 貸款待還　**${fmt(loanOutstanding)}**` : `💳 貸款　無`);
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 下方選單切換功能　·　各頁用按鈕操作"),
    );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bank_${userId}_xferstart`)
      .setLabel("轉帳給玩家")
      .setEmoji("💸")
      .setStyle(ButtonStyle.Primary),
  );
  if (loanOutstanding > 0 && loans[0]) {
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_${userId}_loanrepay_${loans[0].loanId}`)
        .setLabel(`還清貸款（${fmt(loanOutstanding)}）`)
        .setEmoji("💳")
        .setStyle(overdue ? ButtonStyle.Danger : ButtonStyle.Secondary),
    );
  }
  container.addActionRowComponents(actionRow);
  return container;
}

async function buildTransfer(client, ctx) {
  return new ContainerBuilder()
    .setAccentColor(COLOR.blue)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 💸 轉帳給玩家\n-# 選擇收款人後會跳出視窗輸入金額與備註"),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`bank_${ctx.userId}_xferuser`)
          .setPlaceholder("選擇收款人…")
          .setMinValues(1)
          .setMaxValues(1),
      ),
    );
}

async function buildCredit(client, ctx) {
  const [limits, capacity] = await Promise.all([
    creditService.getLimits(client, ctx.userId, ctx.guildId, ctx.member),
    bank?.gold?.enabled ? goldService.getCapacity(client, ctx.userId, ctx.guildId, ctx.member) : null,
  ]);
  return creditCard(limits, ctx.displayName, {
    vaultCapacity: Number.isFinite(capacity) ? capacity : null,
    unitLabel: U(),
  });
}

async function buildDeposit(client, ctx) {
  const { userId, guildId } = ctx;
  const [docs, limit] = await Promise.all([
    depositService.list(client, userId, guildId),
    depositService.maxActive(client, userId, guildId, ctx.member),
  ]);

  const rateStr = (coinSystem?.deposit?.terms || [])
    .map((t) => `${t.days}天+${(t.rate * 100).toFixed(0)}%`)
    .join("・");
  const container = new ContainerBuilder()
    .setAccentColor(COLOR.blue)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📜 定期存款\n-# 同時最多 **${limit}** 筆　·　${rateStr}`,
      ),
    );

  const actionRow = new ActionRowBuilder().addComponents(
    openBtn(userId, "depopen", "開戶", ButtonStyle.Success, "➕"),
    openBtn(userId, "depclaimid", "提款", ButtonStyle.Primary, "📤"),
  );

  if (!docs.length) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("目前沒有任何定期存款。"))
      .addActionRowComponents(actionRow);
    return container;
  }

  const now = Date.now();
  const totalPrincipal = docs.reduce((s, d) => s + d.principal, 0);
  const totalAtMaturity = docs.reduce((s, d) => s + d.principal + d.interest, 0);

  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(docs.length / pageSize));
  const page = Math.min(Math.max(0, ctx.page || 0), totalPages - 1);
  const pageDocs = docs.slice(page * pageSize, page * pageSize + pageSize);

  const matured = [];
  for (const d of pageDocs) {
    const maturesUnix = Math.floor(new Date(d.maturesAt).getTime() / 1000);
    const isMatured = new Date(d.maturesAt).getTime() <= now;
    if (isMatured) matured.push(d);
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `\`${d.depositId}\` ・ ${isMatured ? "✅ 已到期" : "⏳ 鎖定中"}\n` +
            `本金 ${fmt(d.principal)} ・ ${d.days} 天 ・ 到期領 **${fmt(d.principal + d.interest)}** ・ <t:${maturesUnix}:R>`,
        ),
      );
  }

  // 本頁到期存款直接給領回按鈕（UX #1：緊貼列表；最多 5 顆一排）
  if (matured.length) {
    const row = new ActionRowBuilder();
    matured.slice(0, 5).forEach((d) =>
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_${userId}_depclaim_${d.depositId}`)
          .setLabel(`領回 ${fmt(d.principal + d.interest)}`)
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
      ),
    );
    container.addActionRowComponents(row);
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 第 ${page + 1} / ${totalPages} 頁（共 ${docs.length} 筆）　·　總本金 **${fmt(totalPrincipal)}**　到期總額 **${fmt(totalAtMaturity)}**`,
    ),
  );

  if (totalPages > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_${userId}_deppage_${page - 1}`)
          .setLabel("上一頁")
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 0),
        new ButtonBuilder()
          .setCustomId(`bank_${userId}_deppage_${page + 1}`)
          .setLabel("下一頁")
          .setEmoji("▶️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= totalPages - 1),
      ),
    );
  }
  container.addActionRowComponents(actionRow);
  return container;
}

// 金庫區塊：持有量 + 估值 + 容量，若有成本資料再附上「平均成本」與「現在賣出的損益」（像股市）。
function vaultText(holding, value, position, prices, vault) {
  let text = `**你的金庫**\n持有 **${fmt(holding)}** ${U()}　≈ **${fmt(value)}** 幣（以賣出價估）`;
  if (vault.limited) {
    const bar = progressBar(vault.used, 0, vault.capacity);
    const lock = vault.locked > 0 ? `（含定存鎖倉 ${fmt(vault.locked)}）` : "";
    const state = vault.over
      ? "⚠️ 已超出上限，賣出前無法再存入"
      : vault.free <= 0
        ? "🈵 已滿"
        : `還可存 **${fmt(vault.free)}** ${U()}`;
    text += `\n容量 \`${bar}\` **${fmt(vault.used)} / ${fmt(vault.capacity)}** ${U()}${lock}　${state}`;
  }
  if (holding > 0 && position.costBasis > 0) {
    const pnl = Math.round(value - position.costBasis);
    const pnlPct = position.costBasis > 0 ? (pnl / position.costBasis) * 100 : 0;
    const arrow = pnl > 0 ? "📈" : pnl < 0 ? "📉" : "➖";
    const sign = pnl > 0 ? "+" : pnl < 0 ? "−" : "";
    const pctSign = pnl > 0 ? "+" : pnl < 0 ? "" : "";
    text +=
      `\n平均成本 **${fmt(position.avgCost)}** 幣/${U()}` +
      `\n${arrow} 現在賣出損益 **${sign}${fmt(Math.abs(pnl))}** 幣（${pctSign}${pnlPct.toFixed(1)}%）` +
      `\n-# 損益＝現在全部賣出（賣出價 ${fmt(prices.sell)}/${U()}）− 買進 / 精煉的平均成本`;
  }
  return text;
}

async function buildGold(client, ctx) {
  const { userId, guildId } = ctx;
  const [prices, position, terms, block, mineProfile, vault] = await Promise.all([
    goldService.getPrices(),
    goldService.getPosition(client, userId, guildId),
    goldService.listTerms(client, userId, guildId),
    loanService.repaymentBlock(client, userId, guildId),
    client.miningProfilesCollection
      ? client.miningProfilesCollection.findOne({ userId, guildId }).catch(() => null)
      : null,
    goldService.getVaultStatus(client, userId, guildId, ctx.member),
  ]);
  const holding = position.units;
  const value = holding * prices.sell;
  const r = goldService.refineRecipe();

  const base = bank?.gold?.basePrice || prices.spot;
  const pct = Math.round((prices.spot / base - 1) * 100);
  const trend = pct > 0 ? `▲ +${pct}%` : pct < 0 ? `▼ ${pct}%` : "▬ ±0%";

  const container = new ContainerBuilder()
    .setAccentColor(COLOR.gold)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🪙 黃金存摺（純金）\n-# 現貨價 **${fmt(prices.spot)}** 幣/${U()}　${trend}（每日浮動貴金屬）`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**銀行報價**\n🟢 買進 **${fmt(prices.buy)}** 幣/${U()}　　🔴 賣出 **${fmt(prices.sell)}** 幣/${U()}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(vaultText(holding, value, position, prices, vault)),
    );

  if (vault.limited) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 金庫有容量上限（隨信用評等擴充），純金不能無限囤；放不下的財富只能留在錢包，每週照課財富稅",
      ),
    );
  }

  if (block) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🔒 **黃金定存領回凍結中**：有逾期貸款未清（待還 ${fmt(block.outstanding)}），請先到貸款頁還款`,
      ),
    );
  }

  if (r.enabled) {
    const haveOre = mineProfile?.backpack?.[r.oreKey] || 0;
    const haveCoal = mineProfile?.backpack?.[r.coalKey] || 0;
    const refinable = Math.min(
      Math.floor(haveOre / r.orePerUnit),
      r.coalPerUnit > 0 ? Math.floor(haveCoal / r.coalPerUnit) : Infinity,
      vault.free,
    );
    const stockLine =
      haveOre > 0 || haveCoal > 0
        ? `\n-# 你的原料：黃金礦 ${fmt(haveOre)}${r.coalPerUnit > 0 ? ` / 煤炭 ${fmt(haveCoal)}` : ""} → 可精煉約 **${fmt(refinable)}** ${U()}`
        : "";
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 精煉：${fmt(r.orePerUnit)} 黃金礦${r.coalPerUnit > 0 ? ` ＋ ${fmt(r.coalPerUnit)} 煤炭` : ""} → 1 ${U()}${stockLine}`,
      ),
    );
  }

  const full = vault.free <= 0;
  const goldRow = new ActionRowBuilder().addComponents(
    openBtn(userId, "goldbuy", full ? "買進（金庫已滿）" : "買進", ButtonStyle.Success, "🟢").setDisabled(full),
    openBtn(userId, "goldsell", "賣出", ButtonStyle.Danger, "🔴"),
    openBtn(userId, "goldrefine", "精煉", ButtonStyle.Primary, "🔥").setDisabled(full),
    openBtn(userId, "goldterm", "定存", ButtonStyle.Secondary, "🔒"),
  );
  if (holding > 0) {
    goldRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`bank_${userId}_goldsellall`)
        .setLabel("賣出全部")
        .setEmoji("💰")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  container.addActionRowComponents(goldRow);

  if (terms.length) {
    const now = Date.now();
    const matured = [];
    const lines = terms.map((d) => {
      const maturesUnix = Math.floor(new Date(d.maturesAt).getTime() / 1000);
      const isMatured = new Date(d.maturesAt).getTime() <= now;
      if (isMatured) matured.push(d);
      return `\`${d.depositId}\` ${isMatured ? "✅ 已到期" : "⏳ 鎖定中"}　${fmt(d.units)}${U()} → **${fmt(d.units + d.interestUnits)}**${U()}　<t:${maturesUnix}:R>`;
    });
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**黃金定存（${terms.length} 筆）**\n${lines.join("\n")}`),
      );
    if (matured.length) {
      const row = new ActionRowBuilder();
      matured.slice(0, 5).forEach((d) =>
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`bank_${userId}_goldclaim_${d.depositId}`)
            .setLabel(`領回 ${fmt(d.units + d.interestUnits)}${U()}`)
            .setEmoji(block ? "🔒" : "✅")
            .setStyle(ButtonStyle.Success)
            .setDisabled(!!block),
        ),
      );
      container.addActionRowComponents(row);
    }
  }
  return container;
}

async function buildLoan(client, ctx) {
  const { userId, guildId } = ctx;
  const [loans, limits] = await Promise.all([
    loanService.listActive(client, userId, guildId),
    creditService.getLimits(client, userId, guildId, ctx.member),
  ]);

  const now0 = Date.now();
  const overdue = loans.some(
    (l) => l.status === "defaulted" || (l.status === "active" && new Date(l.dueAt).getTime() < now0),
  );

  const container = new ContainerBuilder()
    .setAccentColor(overdue ? COLOR.red : COLOR.purple)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💳 貸款\n-# 你的信用額度 **${limits.loanCap > 0 ? fmt(limits.loanCap) : "尚未開放（需提升信用分）"}**`,
      ),
    );

  if (overdue) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🔒 有逾期貸款：每日加罰並扣信用分，還清後即解除黃金定存的領回凍結\n-# 準時（或現在）還清可累積信用分`,
      ),
    );
  }

  const actionRow = new ActionRowBuilder().addComponents(
    openBtn(userId, "loantake", "借款", ButtonStyle.Success, "💵"),
    openBtn(userId, "loanrepay", "還款", ButtonStyle.Primary, "💳"),
  );

  if (!loans.length) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("目前沒有任何貸款。"))
      .addActionRowComponents(actionRow);
    return container;
  }

  const now = new Date();
  for (const l of loans) {
    const dueUnix = Math.floor(new Date(l.dueAt).getTime() / 1000);
    const outstanding = l.dueAmount - (l.paid || 0);
    const tag = l.status === "defaulted" ? "🔴 已違約" : new Date(l.dueAt) < now ? "⚠️ 逾期中" : "⏳ 進行中";
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `\`${l.loanId}\` ・ ${tag}\n待還 **${fmt(outstanding)}**（本金 ${fmt(l.principal)}＋息 ${fmt(l.interest)}）・ 到期 <t:${dueUnix}:R>`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`bank_${userId}_loanrepay_${l.loanId}`)
            .setLabel(`一鍵還清（${fmt(outstanding)}）`)
            .setEmoji("💳")
            .setStyle(ButtonStyle.Success),
        ),
      );
  }
  container.addActionRowComponents(actionRow);
  return container;
}

const BUILDERS = {
  overview: buildOverview,
  transfer: buildTransfer,
  credit: buildCredit,
  deposit: buildDeposit,
  gold: buildGold,
  loan: buildLoan,
};

async function renderTab(client, ctx, tab, note) {
  const fn = BUILDERS[tab] || buildOverview;
  const container = await fn(client, ctx);
  if (note) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(note));
  }
  container.addActionRowComponents(navRow(ctx.userId, BUILDERS[tab] ? tab : "overview"));
  return container;
}

function payload(container) {
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

module.exports = { TABS, ctxOf, navRow, renderTab, payload };
