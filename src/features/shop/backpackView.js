const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { mining, shop, fishing, farming, dungeon, craft } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
  fishBagCapacity,
  fishBagUsed,
  veggieBagCapacity,
  veggieBagUsed,
} = require("../mining/miningProfile");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");
const {
  DONOR_THEME_ITEM_ID,
  CARDNO_OPEN_ID,
} = require("../donation/customCardNumber");
const { getPickaxeRepairCost, applyRepairDiscount } = require("../mining/mineService");
const buildingService = require("../guild_club/buildingService");
const dungeonService = require("../mining/dungeonService");
const orePriceEngine = require("../market/orePriceEngine");
const eventEngine = require("../event/eventEngine");

// 魚袋顯示用的魚定義表：基礎魚 + 魚袋內持有、但不在基礎圖鑑的限定活動魚
// （resolveFishDef 含已結束活動，讓限定魚活動後仍顯示得出名稱、賣得掉）。
function bagFishDefs(bag) {
  const defs = { ...(fishing?.fish || {}) };
  for (const key of Object.keys(bag || {})) {
    if (!defs[key] && (bag[key] || 0) > 0) {
      const d = eventEngine.resolveFishDef(key);
      if (d) defs[key] = d;
    }
  }
  return defs;
}
const { getSellableItem, SELL_MODAL_OPEN_PREFIX } = require("./sellableItems");
const foodBag = require("../fishing/foodBag");
const foodBagView = require("../fishing/foodBagView");

function trendLabel(price, base) {
  if (!base) return "";
  const pct = Math.round((price / base - 1) * 100);
  return pct > 0 ? ` ▲+${pct}%` : pct < 0 ? ` ▼${pct}%` : " ▬";
}

// 容量百分比 + 號誌燈（依使用率上色）。
function capacityBar(used, cap) {
  const ratio = cap > 0 ? Math.min(1, used / cap) : 0;
  const pct = Math.round(ratio * 100);
  let mark = "🟢";
  if (pct >= 90) mark = "🔴";
  else if (pct >= 70) mark = "🟡";
  return { pct, mark };
}

// 單一袋子的容量顯示：用量 / 上限（百分比）+ 號誌；有 % 就不再畫進度條。
function bagLine(emoji, name, used, cap) {
  const { pct, mark } = capacityBar(used, cap);
  return `${emoji} **${name}**　${used} / ${cap}（${pct}%）${mark}`;
}

// 食物倉庫最快到期時間（ms epoch），用於背包總覽提示；無新鮮食物回 null。
function soonestFoodExpiry(profile, now = Date.now()) {
  const fresh = foodBag.listFresh(profile, now);
  if (fresh.length === 0) return null;
  const cfg = fishing?.foodStorage || {};
  let soonest = Infinity;
  for (const it of fresh) {
    const m = it.useCoal ? cfg.coalMultiplier || 1.5 : 1;
    const expireAt = (it.cookedAt || 0) + (cfg.zeroAtMs || 0) * m;
    if (expireAt < soonest) soonest = expireAt;
  }
  return Number.isFinite(soonest) ? soonest : null;
}

// 劣質磨石「使用」按鈕：mining_use_whetstone_inferior_<ownerId>（修鎬）
// 確認按鈕：mining_use_whetstone_inferior_confirm_<ownerId>
// Phase H+ 加入：磨武器 / 磨盾
//   mining_use_whetstone_weapon_<ownerId> / _confirm_<ownerId>
//   mining_use_whetstone_shield_<ownerId> / _confirm_<ownerId>
const USE_WHETSTONE_INFERIOR_PREFIX = "mining_use_whetstone_inferior_";
const USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX = "mining_use_whetstone_inferior_confirm_";
const USE_WHETSTONE_WEAPON_PREFIX = "mining_use_whetstone_weapon_";
const USE_WHETSTONE_WEAPON_CONFIRM_PREFIX = "mining_use_whetstone_weapon_confirm_";
const USE_WHETSTONE_SHIELD_PREFIX = "mining_use_whetstone_shield_";
const USE_WHETSTONE_SHIELD_CONFIRM_PREFIX = "mining_use_whetstone_shield_confirm_";

function parseUseWhetstoneWeaponId(customId) {
  if (!customId) return null;
  if (customId.startsWith(USE_WHETSTONE_WEAPON_CONFIRM_PREFIX)) {
    const ownerId = customId.slice(USE_WHETSTONE_WEAPON_CONFIRM_PREFIX.length);
    return ownerId ? { ownerId, confirm: true } : null;
  }
  if (customId.startsWith(USE_WHETSTONE_WEAPON_PREFIX)) {
    const ownerId = customId.slice(USE_WHETSTONE_WEAPON_PREFIX.length);
    return ownerId ? { ownerId, confirm: false } : null;
  }
  return null;
}

function parseUseWhetstoneShieldId(customId) {
  if (!customId) return null;
  if (customId.startsWith(USE_WHETSTONE_SHIELD_CONFIRM_PREFIX)) {
    const ownerId = customId.slice(USE_WHETSTONE_SHIELD_CONFIRM_PREFIX.length);
    return ownerId ? { ownerId, confirm: true } : null;
  }
  if (customId.startsWith(USE_WHETSTONE_SHIELD_PREFIX)) {
    const ownerId = customId.slice(USE_WHETSTONE_SHIELD_PREFIX.length);
    return ownerId ? { ownerId, confirm: false } : null;
  }
  return null;
}

// 體力藥水「使用」按鈕：mining_use_stamina_potion_<ownerId>
const USE_STAMINA_POTION_PREFIX = "mining_use_stamina_potion_";

const USE_TREASURE_MAP_PREFIX = "use_treasure_map_";

function parseUseTreasureMapId(customId) {
  if (!customId || !customId.startsWith(USE_TREASURE_MAP_PREFIX)) return null;
  return customId.slice(USE_TREASURE_MAP_PREFIX.length);
}

// 連續通行證「啟用」按鈕：batch_activate_pass_<ownerId>
const ACTIVATE_BATCH_PASS_PREFIX = "batch_activate_pass_";

function parseActivateBatchPassId(customId) {
  if (!customId || !customId.startsWith(ACTIVATE_BATCH_PASS_PREFIX)) return null;
  return customId.slice(ACTIVATE_BATCH_PASS_PREFIX.length);
}

// customId 格式：mining_use_stamina_potion_<tier>_<ownerId>（<tier> ∈ small/medium/large）
// 舊格式 mining_use_stamina_potion_<ownerId>（無 tier）仍相容 → tier=null（用持有中最大的）。
function parseUseStaminaPotionId(customId) {
  if (!customId || !customId.startsWith(USE_STAMINA_POTION_PREFIX)) return null;
  const rest = customId.slice(USE_STAMINA_POTION_PREFIX.length);
  if (!rest) return null;
  const parts = rest.split("_");
  if (["small", "medium", "large"].includes(parts[0])) {
    const tier = parts[0];
    const ownerId = parts.slice(1).join("_");
    return ownerId ? { ownerId, tier } : null;
  }
  return { ownerId: rest, tier: null };
}

function parseUseWhetstoneInferiorId(customId) {
  if (!customId) return null;
  if (customId.startsWith(USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX)) {
    const ownerId = customId.slice(USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX.length);
    return ownerId ? { ownerId, confirm: true } : null;
  }
  if (customId.startsWith(USE_WHETSTONE_INFERIOR_PREFIX)) {
    const ownerId = customId.slice(USE_WHETSTONE_INFERIOR_PREFIX.length);
    return ownerId ? { ownerId, confirm: false } : null;
  }
  return null;
}

// 材料修復預覽按鈕：mining_repair_material_<ownerId>
// 確認按鈕：mining_repair_material_confirm_<ownerId>
const REPAIR_MATERIAL_PREFIX = "mining_repair_material_";
const REPAIR_MATERIAL_CONFIRM_PREFIX = "mining_repair_material_confirm_";

function parseRepairMaterialId(customId) {
  // 先比長的（confirm 是 preview 的超集）
  if (!customId) return null;
  if (customId.startsWith(REPAIR_MATERIAL_CONFIRM_PREFIX)) {
    const ownerId = customId.slice(REPAIR_MATERIAL_CONFIRM_PREFIX.length);
    return ownerId ? { ownerId, confirm: true } : null;
  }
  if (customId.startsWith(REPAIR_MATERIAL_PREFIX)) {
    const ownerId = customId.slice(REPAIR_MATERIAL_PREFIX.length);
    return ownerId ? { ownerId, confirm: false } : null;
  }
  return null;
}

// 武器材料修復：mining_repair_weapon_<ownerId> / _confirm_
const REPAIR_WEAPON_PREFIX = "mining_repair_weapon_";
const REPAIR_WEAPON_CONFIRM_PREFIX = "mining_repair_weapon_confirm_";

function parseRepairWeaponId(customId) {
  if (!customId) return null;
  if (customId.startsWith(REPAIR_WEAPON_CONFIRM_PREFIX)) {
    const ownerId = customId.slice(REPAIR_WEAPON_CONFIRM_PREFIX.length);
    return ownerId ? { ownerId, confirm: true } : null;
  }
  if (customId.startsWith(REPAIR_WEAPON_PREFIX)) {
    const ownerId = customId.slice(REPAIR_WEAPON_PREFIX.length);
    return ownerId ? { ownerId, confirm: false } : null;
  }
  return null;
}

// 釣竿材料修復：mining_repair_rod_<ownerId> / _confirm_
const REPAIR_ROD_PREFIX = "mining_repair_rod_";
const REPAIR_ROD_CONFIRM_PREFIX = "mining_repair_rod_confirm_";

function parseRepairRodId(customId) {
  if (!customId) return null;
  if (customId.startsWith(REPAIR_ROD_CONFIRM_PREFIX)) {
    const ownerId = customId.slice(REPAIR_ROD_CONFIRM_PREFIX.length);
    return ownerId ? { ownerId, confirm: true } : null;
  }
  if (customId.startsWith(REPAIR_ROD_PREFIX)) {
    const ownerId = customId.slice(REPAIR_ROD_PREFIX.length);
    return ownerId ? { ownerId, confirm: false } : null;
  }
  return null;
}

// 盾牌材料修復：mining_repair_shield_<ownerId> / _confirm_
const REPAIR_SHIELD_PREFIX = "mining_repair_shield_";
const REPAIR_SHIELD_CONFIRM_PREFIX = "mining_repair_shield_confirm_";

function parseRepairShieldId(customId) {
  if (!customId) return null;
  if (customId.startsWith(REPAIR_SHIELD_CONFIRM_PREFIX)) {
    const ownerId = customId.slice(REPAIR_SHIELD_CONFIRM_PREFIX.length);
    return ownerId ? { ownerId, confirm: true } : null;
  }
  if (customId.startsWith(REPAIR_SHIELD_PREFIX)) {
    const ownerId = customId.slice(REPAIR_SHIELD_PREFIX.length);
    return ownerId ? { ownerId, confirm: false } : null;
  }
  return null;
}

const TYPE_LABEL = {
  role_color: "🎨 顏色身份組",
  role_color_custom: "🎨 自訂顏色身份組",
  wallet_theme: "🎴 卡面風格",
  card_accent: "🌈 等級卡顏色",
  custom_title: "🪪 自訂稱號",
  casino_token: "🎲 賭場道具",
};

const EQUIPPABLE_TYPES = ["role_color", "role_color_custom", "wallet_theme", "card_accent", "custom_title"];

// 統一的「裝備／設定道具」下拉選單 customId（見 events/interactionCreate/handleShopInteraction.js）。
const UNIFIED_EQUIP_ID = "shop_equip_unified";

function fmtExpiry(expiresAt) {
  if (!expiresAt) return "永久";
  const ts = Math.floor(new Date(expiresAt).getTime() / 1000);
  return `<t:${ts}:R>`;
}

function isUsable(it) {
  if (it.expired) return false;
  if (it.expiresAt && new Date(it.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function fmtExpiryPlain(expiresAt) {
  if (!expiresAt) return "永久";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "已過期";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `剩 ${days} 天`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `剩 ${hours} 小時`;
  const mins = Math.max(1, Math.floor(ms / 60000));
  return `剩 ${mins} 分鐘`;
}

// 純文字的型別標籤（去掉 emoji 前綴），用於選項描述。
function typeLabelText(type) {
  return (TYPE_LABEL[type] || type).replace(/^[^\s]+\s/, "");
}

// 單一「裝備／設定道具」選單：跨四種可裝備型別合併成同一個下拉。
function buildUnifiedEquipMenu(grouped) {
  const options = [];
  for (const type of EQUIPPABLE_TYPES) {
    const list = (grouped.get(type) || []).filter(isUsable);
    for (const it of list) {
      const emoji = (TYPE_LABEL[type] || "").split(" ")[0] || "";
      const detail =
        type === "custom_title"
          ? "點選設定／修改文字"
          : `${it.equipped ? "目前裝備中・" : ""}${fmtExpiryPlain(it.expiresAt)}`;
      options.push({
        label: `${it.equipped ? "✅ " : ""}${emoji ? `${emoji} ` : ""}${it.name}`.slice(0, 100),
        description: `${typeLabelText(type)}・${detail}`.slice(0, 100),
        value: `${type}:${it._id}`,
      });
      if (options.length >= 25) break;
    }
    if (options.length >= 25) break;
  }
  if (options.length === 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(UNIFIED_EQUIP_ID)
    .setPlaceholder("🎁 選擇要裝備／設定的道具…")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

// 背包分類常數
const BACKPACK_CATEGORIES = [
  { value: "all",     label: "🎒 全部" },
  { value: "ore",     label: "⛏️ 礦石" },
  { value: "mine",    label: "🪓 挖礦道具" },
  { value: "explore", label: "🗺️ 探險道具" },
  { value: "pass",    label: "🎟️ 通行證" },
  { value: "fish",    label: "🎣 釣魚" },
  { value: "farm",    label: "🌾 農場" },
  { value: "food",    label: "🍱 食物" },
  { value: "dungeon", label: "⚔️ 地下城" },
  { value: "shop",    label: "🛍️ 商店道具" },
];

// 「全部」總覽 = 乾淨儀表板：金幣 + 三袋容量條 + 各區一行摘要。
// 詳情與操作按鈕都收進各分類頁，避免這頁變成一面牆。
async function buildDashboard(client, container, { userId, guildId, member, totalCoins, profile }) {
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `💰 **金幣**：${totalCoins.toLocaleString()} ${MONEY_EMOJI}`
    )
  );

  // ── 三袋容量（一次擴充三袋共用同一加成）──
  if (profile) {
    const capLines = ["### 📦 背包容量"];
    const nearFull = [];
    if (mining?.enabled) {
      const used = backpackUsed(profile);
      const cap = backpackCapacity(profile, mining);
      capLines.push(bagLine("⛏️", "礦石袋", used, cap));
      if (cap > 0 && used / cap >= 0.9) nearFull.push("礦石袋");
    }
    if (fishing?.enabled) {
      const used = fishBagUsed(profile);
      const cap = fishBagCapacity(profile, fishing);
      capLines.push(bagLine("🎣", "魚袋", used, cap));
      if (cap > 0 && used / cap >= 0.9) nearFull.push("魚袋");
    }
    if (farming?.enabled) {
      const used = veggieBagUsed(profile);
      const cap = veggieBagCapacity(profile, farming);
      capLines.push(bagLine("🥬", "菜籃", used, cap));
      if (cap > 0 && used / cap >= 0.9) nearFull.push("菜籃");
    }
    if (nearFull.length > 0) {
      capLines.push(
        `-# 🔴 ${nearFull.join("、")} 快滿了！記得 \`/賣出\` 換金幣，或到 \`/商店\` 買背包擴充（一次擴三袋）`
      );
    }
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(capLines.join("\n"))
    );
  }

  // ── 各區一行摘要 ──
  const sum = ["### 📋 總覽"];

  if (mining?.enabled && profile) {
    const oreMarket = await orePriceEngine.getDailyPrices(client).catch(() => ({ prices: {} }));
    const priceMap = oreMarket?.prices || {};
    let value = 0;
    let kinds = 0;
    for (const [key, def] of Object.entries(mining.ores)) {
      const qty = profile.backpack?.[key] || 0;
      if (qty <= 0) continue;
      kinds++;
      const unit = typeof priceMap[key] === "number" ? priceMap[key] : def.price || 0;
      value += qty * unit;
    }
    sum.push(
      kinds > 0
        ? `⛏️ **礦石**：${kinds} 種・值 ${value.toLocaleString()} ${COIN_EMOJI}`
        : `⛏️ **礦石**：空`
    );
  }

  if (fishing?.enabled && profile) {
    const fishMarket = await orePriceEngine.getDailyFishPrices(client).catch(() => ({ prices: {} }));
    const priceMap = fishMarket?.prices || {};
    const bag = profile.fish_bag || {};
    let value = 0;
    let kinds = 0;
    for (const [key, def] of Object.entries(bagFishDefs(bag))) {
      const qty = bag[key] || 0;
      if (qty <= 0) continue;
      kinds++;
      const unit = typeof priceMap[key] === "number" ? priceMap[key] : def.price || 0;
      value += qty * unit;
    }
    sum.push(
      kinds > 0
        ? `🎣 **釣魚**：${kinds} 種・魚袋值 ${value.toLocaleString()} ${COIN_EMOJI}`
        : `🎣 **釣魚**：魚袋空`
    );
  }

  if (farming?.enabled && profile) {
    const cropMarket = await orePriceEngine.getDailyCropPrices(client).catch(() => ({ prices: {} }));
    const bag = profile.veggie_bag || {};
    let value = 0;
    let kinds = 0;
    for (const [key] of Object.entries(farming.crops || {})) {
      const qty = bag[key] || 0;
      if (qty <= 0) continue;
      kinds++;
      const dyn = cropMarket.prices?.[key];
      const unit = typeof dyn === "number" ? dyn : orePriceEngine.cropBasePrice(key);
      value += qty * unit;
    }
    const plotCount = Math.max(1, Math.min(profile.farm_plot_count || 2, farming.maxPlots || 8));
    sum.push(
      kinds > 0
        ? `🌾 **農場**：地塊 ${plotCount}/${farming.maxPlots || 8}・菜籃值 ${value.toLocaleString()} ${COIN_EMOJI}`
        : `🌾 **農場**：地塊 ${plotCount}/${farming.maxPlots || 8}・菜籃空`
    );
  }

  if (fishing?.enabled && profile) {
    const fresh = foodBag.listFresh(profile);
    if (fresh.length > 0) {
      const expiry = soonestFoodExpiry(profile);
      const expTxt = expiry ? `・最快 <t:${Math.floor(expiry / 1000)}:R> 到期` : "";
      sum.push(`🍱 **食物**：${fresh.length} 份${expTxt}`);
    } else {
      sum.push(`🍱 **食物**：空`);
    }
  }

  if (dungeon?.enabled && profile) {
    const status = await dungeonService
      .getDungeonStatus(client, { userId, guildId, member })
      .catch(() => null);
    if (status) {
      sum.push(
        `⚔️ **地下城**：HP ${status.hp}/${status.hpMax}・體力 ${status.stamina}/${status.staminaMax}`
      );
    }
  }

  if (mining?.enabled && profile) {
    const treasureMaps = profile.treasure_maps || 0;
    const mapFrags = profile.treasure_map_fragments || 0;
    sum.push(
      treasureMaps > 0 || mapFrags > 0
        ? `🗺️ **探險道具**：藏寶圖 ×${treasureMaps}・碎片 ${mapFrags}/6`
        : `🗺️ **探險道具**：無`
    );

    const passActive = (profile.batch_pass_expires_at || 0) > Date.now();
    const passCount = profile.batch_pass_count || 0;
    sum.push(
      passActive
        ? `🎟️ **通行證**：生效中・持有 ×${passCount}`
        : passCount > 0
          ? `🎟️ **通行證**：×${passCount}`
          : `🎟️ **通行證**：無`
    );
  }

  if (shop?.enabled && client.userInventoryCollection) {
    const count = await client.userInventoryCollection
      .countDocuments({ userId, guildId, expired: { $ne: true } })
      .catch(() => 0);
    sum.push(count > 0 ? `🛍️ **商店道具**：${count} 項` : `🛍️ **商店道具**：無`);
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(sum.join("\n"))
  );
}

// 統一背包：礦石 / 挖礦道具 / 釣魚 / 農場 / 食物 / 地下城 / 商店。
// 「全部」是乾淨儀表板（buildDashboard），其餘分類各自展開詳情與操作按鈕。
// 加成（身分組 / 食物 buff / 商店 buff）已移至 /狀態 指令，本頁不再重複顯示。
async function buildBackpackView(client, { userId, guildId, member, displayName, category = "all" }) {
  const container = new ContainerBuilder().setAccentColor(0x9b59b6);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 🎒 ${displayName} 的背包`)
  );

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`backpack_cat_${userId}`)
        .setPlaceholder("🔍 篩選分類…")
        .addOptions(
          BACKPACK_CATEGORIES.map((c) => ({
            label: c.label,
            value: c.value,
            default: c.value === category,
          }))
        )
    )
  );

  // ── 金幣 + 共用 profile（三袋容量、挖礦/釣魚/農場道具都掛在這）──
  let totalCoins = 0;
  if (client.userCoinsCollection) {
    const coinDoc = await client.userCoinsCollection.findOne(
      { userId, guildId },
      { projection: { totalCoins: 1 } }
    );
    totalCoins = coinDoc?.totalCoins || 0;
  }

  let miningProfile = null;
  if (
    client.miningProfilesCollection &&
    (mining?.enabled || fishing?.enabled || farming?.enabled)
  ) {
    miningProfile = await getOrCreate(client, userId, guildId);
  }

  const equipRows = [];

  // ════════════════ 全部：乾淨儀表板 ════════════════
  if (category === "all") {
    await buildDashboard(client, container, {
      userId,
      guildId,
      member,
      totalCoins,
      profile: miningProfile,
    });

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 上方下拉切換分類看詳情與操作｜想看加成 / Buff 請用 `/狀態`｜`/賣出` 換金幣・`/烹飪` 製作 buff・`/商店` 逛逛"
      )
    );
    return {
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    };
  }

  // ════════════════ 分類詳情：頂部金幣 + 該分類容量 ════════════════
  container.addSeparatorComponents(new SeparatorBuilder());
  {
    const headLines = [`💰 **金幣**：${totalCoins.toLocaleString()} ${MONEY_EMOJI}`];
    if (miningProfile) {
      if ((category === "ore" || category === "mine") && mining?.enabled) {
        headLines.push(
          bagLine("⛏️", "礦石袋", backpackUsed(miningProfile), backpackCapacity(miningProfile, mining))
        );
      } else if (category === "fish" && fishing?.enabled) {
        headLines.push(
          bagLine("🎣", "魚袋", fishBagUsed(miningProfile), fishBagCapacity(miningProfile, fishing))
        );
      } else if (category === "farm" && farming?.enabled) {
        headLines.push(
          bagLine("🥬", "菜籃", veggieBagUsed(miningProfile), veggieBagCapacity(miningProfile, farming))
        );
      }
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headLines.join("\n"))
    );
  }

  // ── 挖礦區（礦石 / 挖礦道具）──
  if ((category === "ore" || category === "mine") && miningProfile) {
    const profile = miningProfile;

    const oreMarket = await orePriceEngine.getDailyPrices(client).catch(() => ({ prices: {} }));
    const orePriceMap = oreMarket?.prices || {};
    const oreLines = [];
    let totalValue = 0;
    for (const [key, def] of Object.entries(mining.ores)) {
      const qty = profile.backpack?.[key] || 0;
      if (qty <= 0) continue;
      const base = def.price || 0;
      const unit = typeof orePriceMap[key] === "number" ? orePriceMap[key] : base;
      const value = qty * unit;
      totalValue += value;
      oreLines.push(
        `${def.emoji || "⛏️"} **${def.name}** ×${qty} ・ ${value.toLocaleString()} ${COIN_EMOJI}（@${unit.toLocaleString()}${trendLabel(unit, base)}）`
      );
    }

    const guildBuildingBuffs = await buildingService
      .getMemberBuildingBuffs(client, userId, guildId)
      .catch(() => ({}));
    const repairDiscountPct = guildBuildingBuffs.equipment_repair_discount_pct || 0;
    const equipMaxPct = guildBuildingBuffs.equipment_max_durability_pct || 0;
    const effMaxOf = (v) => buildingService.effectiveMaxDurability(v, equipMaxPct);

    const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
    const durabilityText =
      profile.pickaxe === "wood" || profile.pickaxe_durability == null
        ? "永久"
        : typeof profile.pickaxe_max_durability === "number"
          ? `耐久 ${profile.pickaxe_durability} / ${effMaxOf(profile.pickaxe_max_durability)}`
          : `耐久 ${profile.pickaxe_durability}`;

    const now = Date.now();
    const inCooldown = (profile.mine_cooldown_at || 0) > now;
    const cdText = inCooldown
      ? `<t:${Math.floor(profile.mine_cooldown_at / 1000)}:R> 可挖`
      : "✅ 現在可挖礦";

    const luckUses = profile.luck_potion_uses || 0;
    const ticketCount = profile.cd_ticket_count || 0;
    const inferiorCount = profile.whetstone_inferior_count || 0;
    const netUses = profile.fishing_net_uses || 0;
    const repairTools = profile.repair_tools || {};
    const reductionMin = Math.round((mining?.cdTicketReductionMs || 0) / 60000);

    const repairCost = applyRepairDiscount(
      getPickaxeRepairCost(profile),
      repairDiscountPct
    );
    const canRepair =
      repairCost !== null &&
      profile.pickaxe !== "wood" &&
      typeof profile.pickaxe_durability === "number" &&
      typeof profile.pickaxe_max_durability === "number" &&
      profile.pickaxe_durability < effMaxOf(profile.pickaxe_max_durability);

    const formatCost = (cost) => {
      if (!cost) return "";
      return Object.entries(cost)
        .map(([mat, qty]) => {
          const oreDef = mining.ores?.[mat];
          const have = profile.backpack?.[mat] || 0;
          const mark = have >= qty ? "✅" : "❌";
          const name = oreDef ? `${oreDef.emoji} ${oreDef.name}` : mat;
          return `${name}×${qty}（有 ${have}）${mark}`;
        })
        .join("、");
    };

    // ── 礦石 ──
    if (category === "ore") {
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          oreLines.length > 0
            ? `### ⛏️ 礦石（值 ${totalValue.toLocaleString()} ${COIN_EMOJI}）\n${oreLines.join("\n")}\n-# 依今日行情計價，每日 00:00 變動・用 \`/賣出\` 換金幣`
            : "### ⛏️ 礦石\n-# 背包裡還沒有礦石，快去 `/挖礦` 吧！"
        )
      );
    }

    // ── 挖礦道具 ──
    if (category === "mine") {
      container.addSeparatorComponents(new SeparatorBuilder());
      const oreInvLines = [];
      for (const [key, def] of Object.entries(mining.ores)) {
        const qty = profile.backpack?.[key] || 0;
        if (qty <= 0) continue;
        oreInvLines.push(`${def.emoji || "⛏️"} ${def.name}×${qty}`);
      }
      const oreInvLine = oreInvLines.length > 0
        ? `\n🪙 礦石庫存：${oreInvLines.join("・")}`
        : `\n🪙 礦石庫存：（空）`;
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🪓 挖礦狀態\n` +
            `⛏️ 目前鎬子：${pdef.emoji || "⛏️"} ${pdef.name}（${durabilityText}）\n` +
            `⏳ 挖礦冷卻：${cdText}` +
            oreInvLine
        )
      );

      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🎁 挖礦道具\n` +
            `🍀 **幸運藥水** ×${luckUses}\n-# 挖礦自動生效，提升幸運`
        )
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🎫 **CD 縮短券** ×${ticketCount}\n-# 立即 -${reductionMin} 分・在 \`/挖礦\` 或 \`/釣魚\` 冷卻訊息上按使用`
        )
      );
      // 連續通行證已獨立成「🎟️ 通行證」分類；探險道具（藏寶圖等）獨立成「🗺️ 探險道具」分類，避免本頁元件爆量
      // 體力藥水已移到「⚔️ 地下城」分類顯示，這裡不再重複
      {
        const pickaxeMax = profile.pickaxe_max_durability;
        const weaponMax = profile.weapon_max_durability;
        const shieldMax = profile.shield_max_durability;
        // 磨石 -10 的門檻看「原始上限」(weaponMax)；顯示則看「有效上限」(含鐵匠鋪加成)。
        const weaponEffMax = buildingService.effectiveMaxDurability(weaponMax, equipMaxPct);
        const canPickaxe = inferiorCount > 0 && profile.pickaxe !== "wood" && typeof pickaxeMax === "number" && pickaxeMax >= 20;
        const canWeapon = inferiorCount > 0 && profile.weapon !== "fist" && typeof weaponMax === "number" && weaponMax >= 20;
        const canShield = inferiorCount > 0 && !!profile.shield && typeof shieldMax === "number" && shieldMax >= 20;

        const hintLines = [`🪨 **劣質磨石** ×${inferiorCount}`];
        hintLines.push("-# 通用修復 — 補滿耐久，該裝備最大耐久 -10（max < 20 時無法使用）");
        const slots = [];
        if (profile.pickaxe !== "wood") slots.push(`鎬 max ${pickaxeMax ?? "—"}`);
        if (profile.weapon !== "fist") slots.push(`武 max ${weaponEffMax ?? "—"}`);
        if (profile.shield) slots.push(`盾 max ${shieldMax ?? "—"}`);
        if (slots.length) hintLines.push(`-# 目前：${slots.join(" ・ ")}`);

        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(hintLines.join("\n")),
        );
        const sellable = getSellableItem("mining_whetstone_inferior");
        container.addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`${USE_WHETSTONE_INFERIOR_PREFIX}${userId}`)
              .setLabel("🛠️ 修鎬")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(!canPickaxe),
            new ButtonBuilder()
              .setCustomId(`${USE_WHETSTONE_WEAPON_PREFIX}${userId}`)
              .setLabel("⚔️ 修武器")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(!canWeapon),
            new ButtonBuilder()
              .setCustomId(`${USE_WHETSTONE_SHIELD_PREFIX}${userId}`)
              .setLabel("🛡️ 修盾")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(!canShield),
            new ButtonBuilder()
              .setCustomId(`${SELL_MODAL_OPEN_PREFIX}${userId}_item_mining_whetstone_inferior`)
              .setLabel("🪙 賣出")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(!sellable || inferiorCount <= 0),
          ),
        );
      }
      {
        const repairLabel = canRepair && repairCost
          ? `🛠️ **材料修復**\n-# 消耗：${formatCost(repairCost)}，補滿鎬子耐久`
          : `🛠️ **材料修復**\n-# ${
              profile.pickaxe === "wood"
                ? "需要非木鎬才能修復"
                : !canRepair && typeof profile.pickaxe_durability === "number" &&
                  typeof profile.pickaxe_max_durability === "number" &&
                  profile.pickaxe_durability >= effMaxOf(profile.pickaxe_max_durability)
                ? "耐久已滿，不需要修復"
                : "裝備鎬子後可使用"
            }`;
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(repairLabel)
            )
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`${REPAIR_MATERIAL_PREFIX}${userId}`)
                .setLabel("修復")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!canRepair)
            )
        );
      }

      // 維修工具（消耗品，到 /工坊 對鎬子使用）
      const repairToolDefs = craft?.repairTools || {};
      const ownedRepairTools = Object.entries(repairToolDefs).filter(
        ([tier]) => (repairTools[tier] || 0) > 0
      );
      if (ownedRepairTools.length > 0) {
        const rtLine = ownedRepairTools
          .map(([tier, def]) => `${def.emoji || "🔧"} ${def.name}×${repairTools[tier]}`)
          .join("・");
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `🛠️ **維修工具**：${rtLine}\n-# 到 \`/工坊\` 對鎬子使用，依階級補耐久`
          )
        );
      }

      // 撈網 buff（仍與挖礦/釣魚相關保留在此）；高級陷阱保護已移到農場區塊
      if (netUses > 0) {
        container.addSeparatorComponents(new SeparatorBuilder());
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### ✨ 自動生效 buff\n🕸️ **撈網生效中**：剩 ${netUses} 次（+10% 釣魚成功率）`,
          ),
        );
      }
    }
  }

  // ── 探險道具 / 合成材料區（藏寶圖、各式碎片、傳說素材）──
  if (category === "explore" && miningProfile) {
    const profile = miningProfile;
    const treasureMaps = profile.treasure_maps || 0;
    const mapFrags = profile.treasure_map_fragments || 0;
    const stoneShards = profile.backpack?.stone_shard || 0;
    const netFrags = profile.broken_net_fragments || 0;
    const trapFrags = profile.broken_trap_fragments || 0;
    const fragments = profile.legendary_fragments || 0;

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🗺️ 探險道具 / 合成材料`),
    );

    if (treasureMaps > 0) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `🗺️ **藏寶圖** ×${treasureMaps}\n-# 撕開觸發隨機事件：藏寶箱 / 體力藥水 / 寶箱怪 / 惡作劇紙條`,
            ),
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`${USE_TREASURE_MAP_PREFIX}${userId}`)
              .setLabel("使用 1 張")
              .setEmoji("🗺️")
              .setStyle(ButtonStyle.Primary),
          ),
      );
    }

    const explorerLines = [];
    const explorerZero = [];
    if (mapFrags > 0) explorerLines.push(`📜 **藏寶圖碎片** ×${mapFrags} / 6\n-# 集滿到工坊合成藏寶圖`);
    else explorerZero.push("📜 藏寶圖碎片");
    if (stoneShards > 0) explorerLines.push(`<:crack_stone:1516055109199597708> **碎石** ×${stoneShards}\n-# 5 個合成劣質賭石、10 個合成優質賭石`);
    else explorerZero.push("<:crack_stone:1516055109199597708> 碎石");
    if (netFrags > 0) explorerLines.push(`🪡 **損壞的漁網碎片** ×${netFrags}\n-# 5 個合成 1 張撈網（+10% 釣魚成功率 / 3 次）`);
    else explorerZero.push("🪡 漁網碎片");
    if (trapFrags > 0) explorerLines.push(`🪛 **損壞的陷阱碎片** ×${trapFrags}\n-# 5 個合成 1 張高級陷阱（被動抵擋 4 次 raid）`);
    else explorerZero.push("🪛 陷阱碎片");
    if (fragments > 0) explorerLines.push(`✨ **傳說素材碎片** ×${fragments}\n-# 合成傳說裝備材料`);
    else explorerZero.push("✨ 傳說素材碎片");

    for (const line of explorerLines) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
    }
    const bottomZeroBits = [];
    if (treasureMaps === 0) bottomZeroBits.push("🗺️ 藏寶圖");
    bottomZeroBits.push(...explorerZero);
    if (bottomZeroBits.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 尚無：${bottomZeroBits.join("・")}`),
      );
    }
  }

  // ── 通行證區（連續通行證）──
  if (category === "pass" && miningProfile) {
    const profile = miningProfile;
    const now = Date.now();
    const passCount = profile.batch_pass_count || 0;
    const passActive = (profile.batch_pass_expires_at || 0) > now;

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 🎟️ 通行證`),
    );

    if (passCount > 0 || passActive) {
      const passText = passActive
        ? `🎟️ **連續通行證** ×${passCount}\n-# ✅ 生效中：<t:${Math.floor(profile.batch_pass_expires_at / 1000)}:R> 到期・可無視等級連續挖礦與釣魚`
        : `🎟️ **連續通行證** ×${passCount}\n-# 啟用後 1 小時內無視等級連續挖礦與釣魚（仍照冷卻扣 CD 縮短券）`;
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(passText))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`${ACTIVATE_BATCH_PASS_PREFIX}${userId}`)
              .setLabel(passActive ? "生效中" : "啟用")
              .setEmoji("🎟️")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(passActive || passCount < 1),
          ),
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 目前沒有連續通行證。啟用後 1 小時內無視等級連續挖礦與釣魚，適合連續操作衝進度（仍照冷卻扣 CD 縮短券）。",
        ),
      );
    }
  }

  // ── 釣魚區 ──
  if (category === "fish" && fishing?.enabled && client.miningProfilesCollection) {
    const fishProfile = miningProfile || await getOrCreate(client, userId, guildId);
    const fishBagData = fishProfile.fish_bag || {};
    const fishCdAt = fishProfile.fish_cooldown_at || 0;
    const now = Date.now();
    const fishCdText = fishCdAt > now
      ? `<t:${Math.floor(fishCdAt / 1000)}:R> 可釣`
      : "✅ 現在可釣魚";

    const rodKey = fishProfile.fishing_rod || "bamboo";
    const rodDef = (fishing.rods || {})[rodKey] || (fishing.rods || {}).bamboo || {};
    const rodDuraText =
      rodKey === "bamboo" || fishProfile.rod_durability == null
        ? "永久"
        : typeof fishProfile.rod_max_durability === "number"
          ? `耐久 ${fishProfile.rod_durability} / ${fishProfile.rod_max_durability}`
          : `耐久 ${fishProfile.rod_durability}`;
    const rodLine = `🪝 釣竿：**${rodDef.emoji || "🎣"} ${rodDef.name || "竹釣竿"}**（${rodDuraText}）`;

    container.addSeparatorComponents(new SeparatorBuilder());

    const fishMarket = await orePriceEngine.getDailyFishPrices(client).catch(() => ({ prices: {} }));
    const fishPriceMap = fishMarket?.prices || {};
    const fishBagDefs = bagFishDefs(fishBagData);
    const hasFish = Object.entries(fishBagDefs).some(([k]) => (fishBagData[k] || 0) > 0);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🎣 釣魚\n${rodLine}\n⏳ 釣魚冷卻：${fishCdText}`
      )
    );

    if (hasFish) {
      for (const [key, def] of Object.entries(fishBagDefs)) {
        const qty = fishBagData[key] || 0;
        if (qty <= 0) continue;
        const base = def.price || 0;
        const unit = typeof fishPriceMap[key] === "number" ? fishPriceMap[key] : base;
        const matchedRecipe = Object.entries(fishing.recipes || {}).find(
          ([, r]) => r.materials?.[key] !== undefined
        );
        const recipeHint = matchedRecipe ? `・可烹飪成 ${matchedRecipe[1].emoji} ${matchedRecipe[1].name}` : "";
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `${def.emoji} **${def.name}**（${def.rarity}）×${qty}・@${unit.toLocaleString()}${trendLabel(unit, base)}${recipeHint}`
              )
            )
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`${SELL_MODAL_OPEN_PREFIX}${userId}_fish_${key}`)
                .setLabel("🪙 賣出")
                .setStyle(ButtonStyle.Secondary)
            )
        );
      }
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 魚袋空空，快去 `/釣魚` 吧！")
      );
    }

    const emptyFish = Object.entries(fishing.fish || {})
      .filter(([k]) => (fishBagData[k] || 0) === 0)
      .map(([, def]) => def.name)
      .join("・");
    if (emptyFish) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 尚無：${emptyFish}`)
      );
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 依今日行情計價，每日 00:00 變動")
    );
  }

  // ── 農場區 ──
  if (category === "farm" && farming?.enabled && client.miningProfilesCollection) {
    const farmProfile = miningProfile || await getOrCreate(client, userId, guildId);
    const veggieBag = farmProfile.veggie_bag || {};
    const seedBag = farmProfile.seed_bag || {};
    const bp = farmProfile.backpack || {};
    const plotCount = Math.max(1, Math.min(farmProfile.farm_plot_count || 2, farming.maxPlots || 8));
    const cropMarket = await orePriceEngine.getDailyCropPrices(client).catch(() => ({ prices: {} }));
    const cropPriceOf = (key) => {
      const dynamic = cropMarket.prices?.[key];
      if (typeof dynamic === "number") return dynamic;
      return orePriceEngine.cropBasePrice(key);
    };

    container.addSeparatorComponents(new SeparatorBuilder());

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🌾 農場\n地塊：**${plotCount} / ${farming.maxPlots || 8}** 格・累計收成 ${farmProfile.farm_harvest_total || 0} 次`,
      ),
    );
    const veggieEntries = Object.entries(farming.crops || {})
      .filter(([k]) => (veggieBag[k] || 0) > 0);
    if (veggieEntries.length > 0) {
      for (const [key, def] of veggieEntries) {
        const qty = veggieBag[key] || 0;
        const price = cropPriceOf(key);
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `${def.emoji} **${def.name}** ×${qty}・單價 ${price} ${COIN_EMOJI}`,
              ),
            )
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`${SELL_MODAL_OPEN_PREFIX}${userId}_veggie_${key}`)
                .setLabel("🪙 賣出")
                .setStyle(ButtonStyle.Secondary),
            ),
        );
      }
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 菜籃空空，去 `/農場` 種點蔬菜吧！"),
      );
    }

    const seedEntries = Object.entries(seedBag).filter(([, v]) => v > 0);
    if (seedEntries.length > 0) {
      const seedLines = seedEntries.map(([k, v]) => {
        const cropKey = k.replace(/^seed_/, "");
        const cropDef = farming.crops?.[cropKey] || {};
        return `${cropDef.emoji || "🌱"} ${cropDef.name || k} 種子 ×${v}`;
      }).join("・");
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**🌱 種子**　${seedLines}`),
      );
    }

    const fertItems = [
      { key: "compost", emoji: "🍂", name: "廚餘堆肥" },
      { key: "monster_slime", emoji: "💧", name: "怪物黏液" },
      { key: "moonlight_dew", emoji: "🌟", name: "月光露水" },
    ];
    const fertLines = fertItems
      .filter((f) => (bp[f.key] || 0) > 0)
      .map((f) => `${f.emoji} ${f.name} ×${bp[f.key]}`);
    if (fertLines.length > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**💧 肥料**　${fertLines.join("・")}\n-# 到 /農場 點「施肥」加速作物成長`,
        ),
      );
    }
    if (farmProfile.rare_bait > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**🎏 稀有魚餌** ×${farmProfile.rare_bait}\n-# 黑玫瑰收成額外掉落物・下次 \`/釣魚\` 上鉤時自動吃 1 個，大幅提高稀有魚機率`,
        ),
      );
    }
    // 高級陷阱保護中（自動抵擋農場 raid，與農場 raid 系統強相關，放這裡）
    const farmTrapUses = trapTiers.totalTrapUses(farmProfile);
    if (farmTrapUses > 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🪤 **農場陷阱保護中**：剩 ${farmTrapUses} 次\n`
            + `-# ${trapTiers.describeHoldings(farmProfile).join("・")}\n`
            + `-# 自動抵擋農場怪物入侵`,
        ),
      );
    }
  }

  // ── 食物區 ──
  if (category === "food" && fishing?.enabled && client.miningProfilesCollection) {
    const foodProfile = miningProfile || await getOrCreate(client, userId, guildId);
    const fresh = foodBag.listFresh(foodProfile);
    const groups = foodBag.groupByRecipe(fresh);
    const recipes = fishing?.recipes || {};

    container.addSeparatorComponents(new SeparatorBuilder());

    if (groups.size === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "### 🍱 食物倉庫\n-# 倉庫是空的，用 `/烹飪 <食物>` 做幾份囤起來吧！"
        )
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`### 🍱 食物倉庫（${fresh.length} 份）`)
      );

      // 按平均新鮮度由低到高排（最該先吃的在上面）
      const entries = [...groups.entries()].map(([rid, arr]) => {
        const avg = arr.reduce((s, it) => s + it.freshness, 0) / arr.length;
        return { recipeId: rid, items: arr, avg };
      });
      entries.sort((a, b) => a.avg - b.avg);

      for (const { recipeId, items } of entries) {
        const recipe = recipes[recipeId];
        if (!recipe) continue;
        const oldest = items[0];
        const newest = items[items.length - 1];
        const oldestPct = Math.round(oldest.freshness * 100);
        const newestPct = Math.round(newest.freshness * 100);
        const buffDef = oldest.useCoal && (recipe.coalFuel || 0) > 0 && recipe.coalBuff
          ? recipe.coalBuff
          : recipe.buff;
        const effectFull = buffDef?.label || foodBagView.buffShortDesc(buffDef?.type, buffDef?.value);
        const rangeText = items.length === 1
          ? foodBagView.freshnessTag(oldest.freshness)
          : `最舊 ${oldestPct}% ～ 最新 ${newestPct}%`;
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${recipe.emoji} **${recipe.name}** ×${items.length}${oldest.useCoal ? " 🔥" : ""}・${rangeText}\n-# 效果：${effectFull}`
          )
        );
      }

      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${foodBagView.OPEN_PREFIX}${userId}`)
            .setLabel("🥡 打開食物倉庫 / 食用")
            .setStyle(ButtonStyle.Success)
        )
      );
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 新鮮度隨時間衰減（普通 7 天歸零、煤炭烤製 ×${fishing.foodStorage?.coalMultiplier || 1.5}）・歸零自動轉廚餘堆肥`
        )
      );
    }
  }

  // ── 地下城區 ──
  if (category === "dungeon" && dungeon?.enabled && client.miningProfilesCollection) {
    const status = await dungeonService.getDungeonStatus(client, {
      userId, guildId, member,
    }).catch(() => null);

    if (status) {
      container.addSeparatorComponents(new SeparatorBuilder());

      const wdef = (dungeon?.weapons || {})[status.weapon] || {};
      const sdef = status.shield ? (dungeon?.shields || {})[status.shield] || {} : null;
      const headLines = [`### ⚔️ 地下城`];
      headLines.push(`❤️ HP：**${status.hp}/${status.hpMax}**　🔋 體力：**${status.stamina}/${status.staminaMax}**`);
      const weaponLine = status.weapon === "fist"
        ? "👊 赤手空拳（先 /合成 一把劍）"
        : `${wdef.emoji || "🗡️"} ${wdef.name || status.weapon}（耐久 ${status.weaponDurability ?? "—"}/${status.weaponMaxDurability ?? "—"}）`;
      const shieldLine = sdef
        ? `${sdef.emoji || "🛡️"} ${sdef.name}（耐久 ${status.shieldDurability ?? "—"}/${status.shieldMaxDurability ?? "—"}・格擋 ${Math.round((sdef.blockRate || 0) * 100)}%）`
        : "—（未裝盾）";
      headLines.push(`⚔️ 武器：${weaponLine}`);
      headLines.push(`🛡️ 盾：${shieldLine}`);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(headLines.join("\n")),
      );

      // 體力藥水（小 / 中 / 大）：各級一個「使用」按鈕，緊貼該級數量。
      const STAMINA_TIERS = [
        { tier: "small",  emoji: "🥤", label: "小", type: "mining_stamina_potion" },
        { tier: "medium", emoji: "🧴", label: "中", type: "mining_stamina_potion_medium" },
        { tier: "large",  emoji: "🍶", label: "大", type: "mining_stamina_potion_large" },
      ];
      for (const t of STAMINA_TIERS) {
        const meta = dungeonService.STAMINA_POTION_TIERS?.[t.tier] || {};
        const count = status.profile?.[meta.field] || 0;
        const restore = (shop?.items || []).find((it) => it.type === t.type)?.payload?.restore || 0;
        const restoreText = restore >= 9999 ? "補滿體力" : `恢復 ${restore} 點體力`;
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `${t.emoji} **體力藥水（${t.label}）** ×${count}\n-# 立即${restoreText}（不超過上限）`,
              ),
            )
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`${USE_STAMINA_POTION_PREFIX}${t.tier}_${userId}`)
                .setLabel("使用")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(count <= 0),
            ),
        );
      }

      // 生命藥水庫存
      const potionLines = [];
      potionLines.push(`### 💊 生命藥水`);
      potionLines.push(`💊 小（+20 HP）×${status.potions.small}・💊 中（+50 HP）×${status.potions.medium}・💊 大（補滿）×${status.potions.large}`);
      const autoLabel = status.autoPotion === false
        ? "⛔ 自動藥水關閉"
        : `✅ 自動藥水開啟（${
            { smallest: "最小可用", largest: "最大可用", small: "只用小瓶", medium: "只用中瓶", large: "只用大瓶" }[status.autoPotionTier] || "最小可用"
          }）`;
      potionLines.push(`-# ${autoLabel}・到 /地下城 面板「💊 補血」可手動使用，或點「⚙️ 設定」改偏好`);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(potionLines.join("\n")),
      );

      // 樓層解鎖進度
      const floorLines = ["### 🏚️ 樓層解鎖進度"];
      for (const ts of status.themes) {
        const t = ts.theme;
        if (!t) continue;
        if (ts.unlocked) {
          const maxFloor = status.profile?.floor_unlocks?.[t.id]?.max_floor || 0;
          floorLines.push(`${t.emoji || ""} ${t.name}：最高 ${maxFloor}F 可挑戰`);
        } else {
          floorLines.push(`🔒 ${t.emoji || ""} ${t.name}：未解鎖`);
        }
      }
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(floorLines.join("\n")),
      );
    }
  }

  // ── 商店區 ──
  if (category === "shop" && shop?.enabled && client.userInventoryCollection) {
    const items = await client.userInventoryCollection
      .find({ userId, guildId, expired: { $ne: true } })
      .sort({ acquiredAt: -1 })
      .limit(50)
      .toArray();

    const grouped = new Map();
    for (const it of items) {
      if (!grouped.has(it.type)) grouped.set(it.type, []);
      grouped.get(it.type).push(it);
    }

    container.addSeparatorComponents(new SeparatorBuilder());
    if (items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("### 🛍️ 商店道具\n-# 還沒有任何道具，到 `/商店` 逛逛吧！")
      );
    } else {
      const sections = [];
      for (const [type, list] of grouped.entries()) {
        const text = list
          .map((it) => {
            const equipped = it.equipped ? " ✅" : "";
            const qty = it.qty ? ` ×${it.qty}` : "";
            const exp = it.expiresAt ? ` — 到期：${fmtExpiry(it.expiresAt)}` : "";
            return `・${it.name}${qty}${equipped}${exp}`;
          })
          .join("\n");
        sections.push(`**${TYPE_LABEL[type] || type}**\n${text}`);
      }
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🛍️ 商店道具\n${sections.join("\n\n")}`.slice(0, 4000)
        )
      );
    }

    const unifiedMenu = buildUnifiedEquipMenu(grouped);
    if (unifiedMenu) equipRows.push(unifiedMenu);

    const ownsDonorCard = (grouped.get("wallet_theme") || []).some(
      (it) => it.itemId === DONOR_THEME_ITEM_ID && isUsable(it)
    );
    if (ownsDonorCard) {
      equipRows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(CARDNO_OPEN_ID)
            .setLabel("💳 設定卡號")
            .setStyle(ButtonStyle.Secondary)
        )
      );
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 上方下拉可切換分類｜想看加成 / Buff 請用 `/狀態`｜`/賣出` 換金幣・`/烹飪` 製作 buff・`/商店` 逛逛"
    )
  );

  for (const row of equipRows) container.addActionRowComponents(row);

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

module.exports = {
  buildBackpackView,
  BACKPACK_CATEGORIES,
  USE_WHETSTONE_INFERIOR_PREFIX,
  USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX,
  parseUseWhetstoneInferiorId,
  USE_WHETSTONE_WEAPON_PREFIX,
  USE_WHETSTONE_WEAPON_CONFIRM_PREFIX,
  parseUseWhetstoneWeaponId,
  USE_WHETSTONE_SHIELD_PREFIX,
  USE_WHETSTONE_SHIELD_CONFIRM_PREFIX,
  parseUseWhetstoneShieldId,
  REPAIR_MATERIAL_PREFIX,
  REPAIR_MATERIAL_CONFIRM_PREFIX,
  parseRepairMaterialId,
  REPAIR_WEAPON_PREFIX,
  REPAIR_WEAPON_CONFIRM_PREFIX,
  parseRepairWeaponId,
  REPAIR_ROD_PREFIX,
  REPAIR_ROD_CONFIRM_PREFIX,
  parseRepairRodId,
  REPAIR_SHIELD_PREFIX,
  REPAIR_SHIELD_CONFIRM_PREFIX,
  parseRepairShieldId,
  USE_STAMINA_POTION_PREFIX,
  USE_TREASURE_MAP_PREFIX,
  parseUseTreasureMapId,
  ACTIVATE_BATCH_PASS_PREFIX,
  parseActivateBatchPassId,
  parseUseStaminaPotionId,
  UNIFIED_EQUIP_ID,
};
