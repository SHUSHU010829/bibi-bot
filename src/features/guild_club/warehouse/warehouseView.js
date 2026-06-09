const {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { guildWarehouse } = require("../../../config");
const { COIN_EMOJI } = require("../../../constants/coin");
const {
  itemDef,
  capacityFor,
  perTakeMaxFor,
  resolveSettings,
  calcFee,
  marketValue,
} = require("./warehouseSettings");

const COLOR_GOLD = 0xf1c40f;
const COLOR_SUCCESS = 0x2ecc71;
const COLOR_ERROR = 0xe74c3c;
const COLOR_INFO = 0x3498db;

const KIND_LABEL = { backpack: "礦石 / 作物", fish_bag: "魚類" };
const KIND_ORDER = ["backpack_mining", "backpack_farming", "fish_bag"];

const groupKey = (id, def) => {
  if (def.kind === "fish_bag") return "fish_bag";
  if (def.kind === "veggie_bag") return "backpack_farming";
  return "backpack_mining";
};
const GROUP_TITLE = {
  backpack_mining: "⛏️ 礦石",
  backpack_farming: "🌾 作物",
  fish_bag: "🎣 魚類",
};
const GROUP_SHORT = {
  backpack_mining: "礦石",
  backpack_farming: "作物",
  fish_bag: "魚類",
};
const GROUP_EMOJI = {
  backpack_mining: "⛏️",
  backpack_farming: "🌾",
  fish_bag: "🎣",
};

const VALID_VIEWS = new Set(["home", ...KIND_ORDER]);
const normalizeView = (v) => (VALID_VIEWS.has(v) ? v : "home");

const buildTabRow = ({ viewerId, view, groups }) => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gcw_tab_${viewerId}_home`)
      .setLabel("首頁")
      .setEmoji("📦")
      .setStyle(view === "home" ? ButtonStyle.Primary : ButtonStyle.Secondary)
  );
  for (const key of KIND_ORDER) {
    const list = groups[key] || [];
    const totalQty = list.reduce((s, it) => s + it.qty, 0);
    const btn = new ButtonBuilder()
      .setCustomId(`gcw_tab_${viewerId}_${key}`)
      .setLabel(`${GROUP_SHORT[key]} ${totalQty}`)
      .setEmoji(GROUP_EMOJI[key])
      .setStyle(view === key ? ButtonStyle.Primary : ButtonStyle.Secondary);
    if (totalQty === 0) btn.setDisabled(true);
    row.addComponents(btn);
  }
  return row;
};

const buildWarehouseContainer = ({
  viewerId,
  club,
  inventory,
  isManager,
  todayItemsTaken = [],
  todayTimesUsed = 0,
  netFlow7d = null,
  view = "home",
}) => {
  const settings = resolveSettings(club);
  const container = new ContainerBuilder().setAccentColor(COLOR_GOLD);
  view = normalizeView(view);

  const groups = { backpack_mining: [], backpack_farming: [], fish_bag: [] };
  for (const it of inventory) groups[groupKey(it.item_id, it.def)].push(it);

  const totalValue = inventory.reduce(
    (s, it) => s + marketValue(it.item_id, it.qty),
    0
  );
  const takenLine =
    todayItemsTaken.length > 0
      ? `你今日已領：${todayItemsTaken.map((i) => itemDef(i)?.name || i).join("・")}（${todayTimesUsed}/${settings.dailyMaxTimes}）`
      : `你今日尚未領取（0/${settings.dailyMaxTimes}）`;

  const headerTail = view === "home" ? "" : ` ・ ${GROUP_TITLE[view]}`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 📦 ${club.name} 倉庫${headerTail}\nLv.${club.level}｜總價值 ≈ ${totalValue.toLocaleString()} ${COIN_EMOJI}\n${takenLine}`
    )
  );

  if (typeof netFlow7d === "number" && netFlow7d < 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ⚠️ 近 7 天淨流出 ${Math.abs(netFlow7d).toLocaleString()} 幣，請會長留意倉庫資源走向。`
      )
    );
  }

  container.addActionRowComponents(buildTabRow({ viewerId, view, groups }));
  container.addSeparatorComponents(new SeparatorBuilder());

  if (view === "home") {
    const summaryLines = [];
    for (const key of KIND_ORDER) {
      const list = groups[key];
      if (!list || list.length === 0) continue;
      const nonZero = list.filter((it) => it.qty > 0);
      const totalQty = list.reduce((s, it) => s + it.qty, 0);
      const value = list.reduce((s, it) => s + marketValue(it.item_id, it.qty), 0);
      const takeable = nonZero.filter(
        (it) => it.available_qty > 0 && !todayItemsTaken.includes(it.item_id)
      ).length;
      const tail = takeable > 0 ? `　-# 可領 ${takeable} 種` : "";
      summaryLines.push(
        `**${GROUP_TITLE[key]}**　${nonZero.length} 種・共 ${totalQty}｜≈ ${value.toLocaleString()} ${COIN_EMOJI}${tail}`
      );
    }
    if (summaryLines.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 倉庫目前空空如也，先用 `/公會 存入` 捐一些物資吧。"
        )
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(summaryLines.join("\n"))
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 點上方分類按鈕進入該類別直接領取。"
        )
      );
    }

    const empties = inventory.filter((it) => it.qty === 0).map((it) => it.def.name);
    if (empties.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 尚無：${empties.join("・")}`)
      );
    }
  } else {
    const list = groups[view] || [];
    const visible = list.filter((it) => it.qty > 0);
    const emptiesInCat = list.filter((it) => it.qty === 0).map((it) => it.def.name);

    if (visible.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 此分類目前沒有可領取的物品。`
        )
      );
    } else {
      for (const it of visible) {
        const cap = capacityFor(it.item_id, club.level, club.warehouse_settings);
        const protTail =
          it.protected_qty > 0 && it.next_unlock_at
            ? `（${it.protected_qty} 保護中，<t:${Math.floor(it.next_unlock_at / 1000)}:R> 解鎖）`
            : "";
        const personalCap = perTakeMaxFor(it.item_id, club.warehouse_settings);
        const maxTake = Math.min(personalCap, it.available_qty);
        const takeable = maxTake > 0 && !todayItemsTaken.includes(it.item_id);

        const mainText = `${it.def.emoji} **${it.def.name}** ${it.qty} / ${cap}${protTail}`;
        if (takeable) {
          container.addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent(mainText))
              .setButtonAccessory(
                new ButtonBuilder()
                  .setCustomId(`gcw_takeopen_${viewerId}_${it.item_id}_${maxTake}`)
                  .setLabel(`領取（≤ ${maxTake}）`)
                  .setStyle(ButtonStyle.Success)
              )
          );
        } else {
          let tail = "";
          if (todayItemsTaken.includes(it.item_id)) tail = "　-# 今日已領";
          else if (it.available_qty === 0) tail = "　-# 可取 0（保護中）";
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(mainText + tail)
          );
        }
      }
    }

    if (emptiesInCat.length > 0) {
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 此類尚無：${emptiesInCat.join("・")}`)
      );
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  const footer = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gcw_help_${viewerId}`)
      .setLabel("怎麼存？")
      .setEmoji("❓")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`gcw_refresh_${viewerId}_${view}`)
      .setLabel("重新整理")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary)
  );
  if (isManager) {
    footer.addComponents(
      new ButtonBuilder()
        .setCustomId(`gcw_log_${viewerId}`)
        .setLabel("紀錄")
        .setEmoji("📜")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`gcw_settings_${viewerId}`)
        .setLabel("倉庫設定")
        .setEmoji("⚙️")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  container.addActionRowComponents(footer);

  return container;
};

const buildDepositSuccessContainer = ({
  userId,
  club,
  itemDefArg,
  deposited,
  newTotal,
  capacity,
  availableAt,
  marketValueAmount,
  contributionAdded,
}) => {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ <@${userId}> 向「${club.name}」倉庫存入 ${itemDefArg.emoji} ${itemDefArg.name} ×${deposited}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `倉庫 ${itemDefArg.name}：${newTotal} / ${capacity}\n市價 ${marketValueAmount.toLocaleString()} ${COIN_EMOJI}｜公會貢獻 +${contributionAdded}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 保護至 <t:${Math.floor(availableAt.getTime() / 1000)}:R>，期間全員都不能領取。`
      )
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gcw_refresh_${userId}`)
      .setLabel("查看倉庫")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Secondary)
  );
  container.addActionRowComponents(row);
  return container;
};

const buildWithdrawSuccessContainer = ({
  userId,
  club,
  itemDefArg,
  withdrawn,
  fee,
  newTotal,
  dailyRemaining,
  dailyMax,
}) => {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ <@${userId}> 從「${club.name}」倉庫領取 ${itemDefArg.emoji} ${itemDefArg.name} ×${withdrawn}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `手續費 -${fee} ${COIN_EMOJI}（已入金庫）\n倉庫剩餘：${newTotal}\n今日額度：${dailyMax - dailyRemaining}/${dailyMax}`
      )
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gcw_refresh_${userId}`)
      .setLabel("查看倉庫")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Secondary)
  );
  container.addActionRowComponents(row);
  return container;
};

const buildErrorContainer = ({ title, body, hint }) => {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR_ERROR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint)
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return c;
};

const buildLogContainer = ({ club, entries, isVice }) => {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_INFO)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 📜 ${club.name} 倉庫紀錄（近 30 天）`)
    );

  const leaderId = club.leader_id;
  const totals = { in: 0, out: 0, leaderNet: 0, leaderFeeBack: 0 };
  for (const e of entries) {
    if (e.action === "deposit") totals.in += e.market_value || 0;
    else if (e.action === "withdraw") {
      totals.out += e.market_value || 0;
      if (e.user_id === leaderId) {
        totals.leaderNet += (e.market_value || 0) - (e.fee || 0);
        totals.leaderFeeBack += e.fee || 0;
      }
    }
  }
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 近 30 天會長淨領取價值：${totals.leaderNet.toLocaleString()} 幣（含手續費回流 ${totals.leaderFeeBack.toLocaleString()} 幣）\n-# 總流入：${totals.in.toLocaleString()}　總流出：${totals.out.toLocaleString()}`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  const recent = entries.slice(0, 20);
  if (recent.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 尚無紀錄。`)
    );
  } else {
    const VERB = {
      deposit: "📥 存",
      withdraw: "📤 取",
      consign_listed: "🏷️ 寄售",
      consign_sold: "💰 售出",
      consign_returned: "↩️ 退回",
    };
    const lines = recent.map((e) => {
      const ts = Math.floor(new Date(e.created_at).getTime() / 1000);
      const def = itemDef(e.item_id);
      const name = def ? `${def.emoji} ${def.name}` : e.item_id;
      const verb = VERB[e.action] || "・";
      let tail = "";
      if (e.action === "withdraw")
        tail = `（-${(e.fee || 0).toLocaleString()} 幣手續費）`;
      else if (e.action === "consign_listed")
        tail = `（${(e.price || 0).toLocaleString()} 幣標價）`;
      else if (e.action === "consign_sold")
        tail = `（+${(e.price || 0).toLocaleString()} 幣入金庫）`;
      return `<t:${ts}:R>　${verb} <@${e.user_id}>　${name} ×${e.qty}${tail}`;
    });
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n"))
    );
  }
  return container;
};

const TAKE_MODAL_PREFIX = "gcw_takedo_";

const buildTakeModal = ({ userId, club, itemId, maxTake }) => {
  const def = itemDef(itemId);
  const oneFee = calcFee(itemId, 1, club);
  const maxFee = calcFee(itemId, maxTake, club);
  const modal = new ModalBuilder()
    .setCustomId(`${TAKE_MODAL_PREFIX}${userId}_${itemId}`)
    .setTitle(`領取 ${def?.name || itemId}`.slice(0, 45));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("qty")
        .setLabel(`數量（1～${maxTake}）`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4)
        .setPlaceholder(
          maxTake === 1
            ? `1 顆扣 ${oneFee} 幣手續費`
            : `1 顆 -${oneFee}、領滿 ${maxTake} 顆 -${maxFee} 幣`
        )
        .setValue(String(maxTake))
    )
  );
  return modal;
};

const SETTINGS_MODAL_PREFIX = "gcw_settings_modal_";

const buildSettingsModal = ({ userId, club }) => {
  const w = guildWarehouse?.withdraw || {};
  const cur = club?.warehouse_settings || {};
  const settings = resolveSettings(club);
  const modal = new ModalBuilder()
    .setCustomId(`${SETTINGS_MODAL_PREFIX}${userId}`)
    .setTitle(`「${club.name}」倉庫設定`.slice(0, 45));

  const mk = (id, label, placeholder, value) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder(placeholder)
        .setValue(value ?? "")
    );

  modal.addComponents(
    mk(
      "dailyMaxTimes",
      `每日次數（${w.dailyMaxTimesRange[0]}–${w.dailyMaxTimesRange[1]}，留空＝預設）`,
      `預設 ${w.dailyMaxTimesDefault}，目前 ${settings.dailyMaxTimes}`,
      cur.dailyMaxTimes != null ? String(cur.dailyMaxTimes) : ""
    ),
    mk(
      "feeRate",
      `手續費率（${w.feeRateRange[0] * 100}%–${w.feeRateRange[1] * 100}%）`,
      `預設 ${w.feeRateDefault * 100}%，目前 ${(settings.feeRate * 100).toFixed(1)}%`,
      cur.feeRate != null ? String(cur.feeRate) : ""
    ),
    mk(
      "tenureHours",
      `入會時間門檻 / 小時（${w.tenureHoursRange[0]}–${w.tenureHoursRange[1]}）`,
      `預設 ${w.tenureHoursDefault}h，目前 ${settings.tenureHours}h`,
      cur.tenureHours != null ? String(cur.tenureHours) : ""
    ),
    mk(
      "minContribution",
      `最低貢獻門檻（${w.minContributionRange[0]}–${w.minContributionRange[1]}）`,
      `預設 ${w.minContributionDefault}，目前 ${settings.minContribution}`,
      cur.minContribution != null ? String(cur.minContribution) : ""
    )
  );
  return modal;
};

const formatSettingValue = (key, value) => {
  if (value == null) return "預設";
  if (key === "feeRate") return `${(value * 100).toFixed(1)}%`;
  if (key === "tenureHours") return `${value} 小時`;
  return String(value);
};

const SETTING_LABEL = {
  dailyMaxTimes: "每日次數",
  feeRate: "手續費率",
  tenureHours: "入會時間門檻",
  minContribution: "最低貢獻",
};

const buildSettingsUpdatedContainer = ({ club, applied, userId }) => {
  const lines = Object.entries(applied).map(
    ([k, v]) => `・${SETTING_LABEL[k] || k}：${formatSettingValue(k, v)}`
  );
  return new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⚙️ 「${club.name}」倉庫設定已更新`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n"))
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 由 <@${userId}> 更新。輸入空白即恢復預設。`
      )
    );
};

const buildConsignSuccessContainer = ({ userId, club, itemDefArg, listing }) => {
  const expiresEpoch = Math.floor(new Date(listing.expires_at).getTime() / 1000);
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ 已上架到市集：${itemDefArg.emoji} ${itemDefArg.name} ×${listing.qty}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🏰 ${club.name}　編號 **#${listing.listing_id}**\n` +
          `售價 **${listing.price.toLocaleString()}** ${COIN_EMOJI}（成交後全額進公會金庫）\n` +
          `截止 <t:${expiresEpoch}:R>，過期未售出物資自動退回倉庫`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 由 <@${userId}> 上架。需要下架請到 /市集 我的攤位。`
      )
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("market_view_browse")
      .setLabel("查看市集")
      .setEmoji("🏪")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("market_view_mystall")
      .setLabel("我的攤位")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Secondary)
  );
  container.addActionRowComponents(row);
  return container;
};

const buildLargeDepositAnnouncement = ({ userId, club, itemDefArg, deposited, marketValueAmount }) =>
  new ContainerBuilder()
    .setAccentColor(COLOR_GOLD)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎁 大額捐贈！<@${userId}> 存入 ${itemDefArg.emoji} ${itemDefArg.name} ×${deposited}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `「${club.name}」倉庫獲得市價 ${marketValueAmount.toLocaleString()} ${COIN_EMOJI} 的物資`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 1 小時後解鎖供會員取用。`)
    );

const buildWarehouseSummaryBlock = ({ totalValue, netFlow7d, lastActivityAt }) => {
  const lines = [
    `**📦 倉庫**　總價值 ≈ ${totalValue.toLocaleString()} ${COIN_EMOJI}`,
  ];
  if (lastActivityAt) {
    lines.push(`-# 最近活動：<t:${Math.floor(new Date(lastActivityAt).getTime() / 1000)}:R>`);
  }
  if (netFlow7d != null) {
    const sign = netFlow7d >= 0 ? "+" : "";
    lines.push(`-# 近 7 天淨流入：${sign}${netFlow7d.toLocaleString()} 幣`);
  }
  return new TextDisplayBuilder().setContent(lines.join("\n"));
};

module.exports = {
  buildWarehouseContainer,
  buildDepositSuccessContainer,
  buildWithdrawSuccessContainer,
  buildErrorContainer,
  buildLogContainer,
  buildSettingsModal,
  buildSettingsUpdatedContainer,
  buildLargeDepositAnnouncement,
  buildWarehouseSummaryBlock,
  buildTakeModal,
  buildConsignSuccessContainer,
  SETTINGS_MODAL_PREFIX,
  TAKE_MODAL_PREFIX,
  SETTING_LABEL,
};
