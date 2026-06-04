const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
  if (["carrot", "corn", "strawberry", "black_rose"].includes(id))
    return "backpack_farming";
  return "backpack_mining";
};
const GROUP_TITLE = {
  backpack_mining: "⛏️ 礦石",
  backpack_farming: "🌾 作物",
  fish_bag: "🎣 魚類",
};

const buildWarehouseContainer = ({
  viewerId,
  club,
  inventory,
  isManager,
  todayItemsTaken = [],
  todayTimesUsed = 0,
}) => {
  const settings = resolveSettings(club);
  const container = new ContainerBuilder().setAccentColor(COLOR_GOLD);

  const totalValue = inventory.reduce(
    (s, it) => s + marketValue(it.item_id, it.qty),
    0
  );
  const takenLine =
    todayItemsTaken.length > 0
      ? `你今日已領：${todayItemsTaken.map((i) => itemDef(i)?.name || i).join("・")}（${todayTimesUsed}/${settings.dailyMaxTimes}）`
      : `你今日尚未取礦（0/${settings.dailyMaxTimes}）`;

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 📦 ${club.name} 倉庫\nLv.${club.level}｜總價值 ≈ ${totalValue.toLocaleString()} ${COIN_EMOJI}\n${takenLine}`
    )
  );

  const groups = { backpack_mining: [], backpack_farming: [], fish_bag: [] };
  for (const it of inventory) groups[groupKey(it.item_id, it.def)].push(it);

  const empties = [];

  for (const key of KIND_ORDER) {
    const list = groups[key];
    if (!list || list.length === 0) continue;
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${GROUP_TITLE[key]}**`)
    );
    for (const it of list) {
      if (it.qty === 0) {
        empties.push(it.def.name);
        continue;
      }
      const cap = capacityFor(it.item_id, club.level, club.warehouse_settings);
      const protTail =
        it.protected_qty > 0 && it.next_unlock_at
          ? `（${it.protected_qty} 保護中，<t:${Math.floor(it.next_unlock_at / 1000)}:R> 解鎖）`
          : "";
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `${it.def.emoji} **${it.def.name}** ${it.qty} / ${cap}${protTail}`
        )
      );
      const personalCap = perTakeMaxFor(it.item_id, club.warehouse_settings);
      const maxTake = Math.min(personalCap, it.available_qty);
      if (maxTake > 0 && !todayItemsTaken.includes(it.item_id)) {
        const fee1 = calcFee(it.item_id, 1, club);
        const feeMax = calcFee(it.item_id, maxTake, club);
        const row = new ActionRowBuilder();
        if (personalCap >= 1) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`gcw_take_${viewerId}_${it.item_id}_1`)
              .setLabel(`領 1（-${fee1}）`)
              .setStyle(ButtonStyle.Primary)
          );
        }
        if (personalCap >= 5 && maxTake >= 5) {
          const fee5 = calcFee(it.item_id, 5, club);
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`gcw_take_${viewerId}_${it.item_id}_5`)
              .setLabel(`領 5（-${fee5}）`)
              .setStyle(ButtonStyle.Primary)
          );
        }
        if (maxTake > 1) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`gcw_take_${viewerId}_${it.item_id}_${maxTake}`)
              .setLabel(`領 ${maxTake}（-${feeMax}）`)
              .setStyle(ButtonStyle.Success)
          );
        }
        container.addActionRowComponents(row);
      } else if (todayItemsTaken.includes(it.item_id)) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# 今天已領過此項，明日再來`)
        );
      } else if (it.available_qty === 0) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# 可取量為 0（保護中或暫無）`)
        );
      }
    }
  }

  if (empties.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 尚無：${empties.join("・")}`)
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  const footer = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gcw_help_${viewerId}`)
      .setLabel("怎麼存？")
      .setEmoji("❓")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`gcw_refresh_${viewerId}`)
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
        `# ✅ <@${userId}> 向公會倉庫存入 ${itemDefArg.emoji} ${itemDefArg.name} ×${deposited}`
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
        `# ✅ <@${userId}> 從公會倉庫領取 ${itemDefArg.emoji} ${itemDefArg.name} ×${withdrawn}`
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
    else {
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
    const lines = recent.map((e) => {
      const ts = Math.floor(new Date(e.created_at).getTime() / 1000);
      const def = itemDef(e.item_id);
      const name = def ? `${def.emoji} ${def.name}` : e.item_id;
      const verb = e.action === "deposit" ? "📥 存" : "📤 取";
      const tail =
        e.action === "withdraw" ? `（-${(e.fee || 0).toLocaleString()} 幣手續費）` : "";
      return `<t:${ts}:R>　${verb} <@${e.user_id}>　${name} ×${e.qty}${tail}`;
    });
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n"))
    );
  }
  return container;
};

module.exports = {
  buildWarehouseContainer,
  buildDepositSuccessContainer,
  buildWithdrawSuccessContainer,
  buildErrorContainer,
  buildLogContainer,
};
