require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require("discord.js");
const eventExchangeService = require("./eventExchangeService");
const eventEngine = require("./eventEngine");

const EXCHANGE_BTN_PREFIX = "evt_exch_";
const FISH_SELECT_PREFIX = "evtxfish_";
const ALL_FISH = "all";
const MAX_ITEMS = 8; // 元件上限保護：每項 3 元件 + 下拉與標題約 9，8 項約 33 < 40

function rewardLabel(reward) {
  switch (reward?.type) {
    case "coins":
      return `🪙 ${Number(reward.qty || 0).toLocaleString()} 幣`;
    case "cdTicket":
      return `🎫 CD 縮短券 ×${reward.qty}`;
    case "batchPass":
      return `🎟️ 連續通行證 ×${reward.qty}`;
    case "title":
      return `🏅 稱號「${eventExchangeService.titleName(reward.titleId)}」`;
    case "ore": {
      const def = eventEngine.resolveOreDef(reward.oreKey) || {};
      return `${def.emoji || "⛏️"} ${def.name || reward.oreKey} ×${reward.qty}`;
    }
    case "backpackItem": {
      const def = eventExchangeService.backpackItemDef(reward.itemKey);
      return `${def.emoji} ${def.name} ×${reward.qty}`;
    }
    default:
      return "獎勵";
  }
}

function itemLine(x) {
  const fishDef = x.costFishDef || {};
  const fishName = `${fishDef.emoji || "🐟"} ${fishDef.name || x.cost.fish}`;
  const limitText =
    x.limit > 0 ? `每人上限 ${x.limit}・已兌換 ${x.used}` : "無兌換次數限制";
  const ownedText =
    x.owned >= x.cost.qty
      ? `你有 ${x.owned}`
      : `你有 ${x.owned}・還差 ${x.cost.qty - x.owned}`;
  return (
    `### ${x.emoji || "🎁"} ${x.name}\n` +
    (x.desc ? `-# ${x.desc}\n` : "") +
    `花費：**${fishName} ×${x.cost.qty}**（${ownedText}）\n` +
    `-# ${limitText}`
  );
}

function itemButton(ownerId, x) {
  const btn = new ButtonBuilder().setCustomId(`${EXCHANGE_BTN_PREFIX}${ownerId}_${x.id}`);
  if (x.soldOut) {
    return btn.setLabel("已達上限").setStyle(ButtonStyle.Secondary).setDisabled(true);
  }
  return btn
    .setLabel(x.affordable ? "兌換" : `需要 ×${x.cost.qty}`)
    .setEmoji(x.affordable ? "✅" : "🎣")
    .setStyle(x.affordable ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(!x.affordable);
}

// 從兌換項目中抓出「不同的成本魚種」，供下拉選單切換顯示。
function fishSpecies(items) {
  const seen = new Map();
  for (const x of items) {
    const key = x.cost.fish;
    if (!seen.has(key)) {
      const def = x.costFishDef || {};
      seen.set(key, { key, name: def.name || key, emoji: def.emoji || "🐟" });
    }
  }
  return [...seen.values()];
}

function fishSelectRow(ownerId, species, selectedFish) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${FISH_SELECT_PREFIX}${ownerId}`)
    .setPlaceholder("依魚種篩選兌換項目");
  menu.addOptions(
    new StringSelectMenuOptionBuilder()
      .setLabel("全部魚種")
      .setEmoji("🎣")
      .setValue(ALL_FISH)
      .setDefault(selectedFish === ALL_FISH),
    ...species.map((s) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(s.name)
        .setEmoji(s.emoji)
        .setValue(s.key)
        .setDefault(selectedFish === s.key),
    ),
  );
  return new ActionRowBuilder().addComponents(menu);
}

// 組兌換所面板。banner：兌換成功後置頂的一行提示（可省略）。
// selectedFish：目前選中的魚種（"all" 或魚 key），決定顯示哪些兌換項目。
function buildExchangeView({ ownerId, active, items, banner = null, selectedFish = ALL_FISH }) {
  const container = new ContainerBuilder().setAccentColor(active ? 0xf1c40f : 0x95a5a6);

  if (banner) {
    container
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(banner))
      .addSeparatorComponents(new SeparatorBuilder());
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("## 🎣 限定魚兌換所"),
  );

  if (!active || items.length === 0) {
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("目前沒有進行中的限定兌換活動。"),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 活動開跑時，用 `/釣魚` 撈到的限定魚就能來這裡換 CD 券、通行證、月光露水、金幣與限定稱號。",
        ),
      );
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
  }

  const species = fishSpecies(items);
  // 選中的魚種已不在清單（活動換檔）時退回「全部」，避免顯示空清單。
  const activeFish =
    selectedFish !== ALL_FISH && species.some((s) => s.key === selectedFish)
      ? selectedFish
      : ALL_FISH;
  const filtered =
    activeFish === ALL_FISH ? items : items.filter((x) => x.cost.fish === activeFish);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# 用活動限定魚兌換限定獎勵，換完不補！"),
  );

  // 兩種以上魚種才給下拉選單（單一魚種切了也沒差）。
  if (species.length >= 2) {
    container.addActionRowComponents(fishSelectRow(ownerId, species, activeFish));
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  const shown = filtered.slice(0, MAX_ITEMS);
  for (const x of shown) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(itemLine(x)))
        .setButtonAccessory(itemButton(ownerId, x)),
    );
  }
  if (filtered.length > shown.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 還有 ${filtered.length - shown.length} 項未顯示，用上方下拉選單依魚種篩選查看。`,
      ),
    );
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function parseExchangeButtonId(customId) {
  if (!customId.startsWith(EXCHANGE_BTN_PREFIX)) return null;
  const rest = customId.slice(EXCHANGE_BTN_PREFIX.length);
  const idx = rest.indexOf("_");
  if (idx < 0) return null;
  return { ownerId: rest.slice(0, idx), exchangeId: rest.slice(idx + 1) };
}

function parseFishSelectId(customId) {
  if (!customId.startsWith(FISH_SELECT_PREFIX)) return null;
  const ownerId = customId.slice(FISH_SELECT_PREFIX.length);
  if (!ownerId) return null;
  return { ownerId };
}

module.exports = {
  buildExchangeView,
  parseExchangeButtonId,
  parseFishSelectId,
  rewardLabel,
  EXCHANGE_BTN_PREFIX,
  FISH_SELECT_PREFIX,
  ALL_FISH,
};
