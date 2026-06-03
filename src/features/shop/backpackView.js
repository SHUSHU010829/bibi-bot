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
const { mining, shop, fishing, farming } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("../mining/miningProfile");
const { getActiveFoodBuffs } = require("../fishing/cookService");
const { COIN_EMOJI, MONEY_EMOJI } = require("../../constants/coin");
const {
  DONOR_THEME_ITEM_ID,
  CARDNO_OPEN_ID,
} = require("../donation/customCardNumber");
const { roleBuffSummary } = require("../buff/buffResolver");
const { getPickaxeRepairCost } = require("../mining/mineService");
const orePriceEngine = require("../market/orePriceEngine");

function trendLabel(price, base) {
  if (!base) return "";
  const pct = Math.round((price / base - 1) * 100);
  return pct > 0 ? ` ▲+${pct}%` : pct < 0 ? ` ▼${pct}%` : " ▬";
}

// CD 縮短券「使用」按鈕 customId 格式：mining_use_cd_ticket_<ownerId>
// 由 events/interactionCreate/handleMiningTicket.js 處理。
const USE_TICKET_PREFIX = "mining_use_cd_ticket_";

function parseUseTicketId(customId) {
  if (!customId || !customId.startsWith(USE_TICKET_PREFIX)) return null;
  const ownerId = customId.slice(USE_TICKET_PREFIX.length);
  return ownerId ? { ownerId } : null;
}

// 劣質磨鎬石「使用」按鈕：mining_use_whetstone_inferior_<ownerId>
// 確認按鈕：mining_use_whetstone_inferior_confirm_<ownerId>
// 注意：_inferior_ 是 _whetstone_ 的超集，handler 內先比長的 prefix。
const USE_WHETSTONE_INFERIOR_PREFIX = "mining_use_whetstone_inferior_";
const USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX = "mining_use_whetstone_inferior_confirm_";

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
// 把四種可裝備道具併進同一個選單，避免每種一排撞到 Discord 動作列上限（導致自訂稱號選單被吃掉）。
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
// 選項 value 編碼成 `<type>:<inventoryId>`，由 handler 依型別決定要直接裝備或開稱號彈窗。
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
  { value: "all",  label: "🎒 全部" },
  { value: "ore",  label: "⛏️ 礦石" },
  { value: "mine", label: "🪓 挖礦道具" },
  { value: "fish", label: "🎣 釣魚" },
  { value: "farm", label: "🌾 農場" },
  { value: "shop", label: "🛍️ 商店道具" },
];

// 統一背包：礦石 / 挖礦道具 / 釣魚 / 商店（購買道具 / 生效 buff / 裝備選單）合在同一張卡片。
// category: "all" | "ore" | "mine" | "fish" | "shop"（預設 "all"）
// 回傳 { components, flags }，以 IsComponentsV2 + Ephemeral 私訊送出。
async function buildBackpackView(client, { userId, guildId, member, displayName, category = "all" }) {
  const container = new ContainerBuilder().setAccentColor(0x9b59b6);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## 🎒 ${displayName} 的背包`)
  );

  // 分類篩選下拉選單
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

  // 錢包餘額 + 生效中 buff（同一份文件，一次查回）
  let totalCoins = 0;
  let coinDoc = null;
  if (client.userCoinsCollection) {
    coinDoc = await client.userCoinsCollection.findOne(
      { userId, guildId },
      { projection: { totalCoins: 1, activeBuffs: 1 } }
    );
    totalCoins = coinDoc?.totalCoins || 0;
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `💰 目前金幣：**${totalCoins.toLocaleString()}** ${MONEY_EMOJI}`
    )
  );

  // ── 身分組加成（依 Twitch 訂閱 / 伺服器加成 / 贊助 等身分組彙整）──
  if (member) {
    const roleGroups = await roleBuffSummary(client, userId, guildId, member).catch(
      () => []
    );
    if (roleGroups.length > 0) {
      const roleText = roleGroups
        .map((g) => `${g.header}\n${g.lines.map((l) => `　${l}`).join("\n")}`)
        .join("\n");
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🎖️ 身分組加成\n${roleText}\n-# 這些加成來自你目前持有的身分組，失去身分組即失效`
        )
      );
    }
  }

  // ── 挖礦區 ──
  if ((category === "all" || category === "ore" || category === "mine") && mining?.enabled && client.miningProfilesCollection) {
    const profile = await getOrCreate(client, userId, guildId);
    const cap = backpackCapacity(profile, mining);
    const used = backpackUsed(profile);

    // 礦石：只列出有庫存的，數量為 0 的隱藏；依今日行情計價
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

    const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
    const durabilityText =
      profile.pickaxe === "wood" || profile.pickaxe_durability == null
        ? "永久"
        : typeof profile.pickaxe_max_durability === "number"
          ? `耐久 ${profile.pickaxe_durability} / ${profile.pickaxe_max_durability}`
          : `耐久 ${profile.pickaxe_durability}`;

    const now = Date.now();
    const inCooldown = (profile.mine_cooldown_at || 0) > now;
    const cdText = inCooldown
      ? `<t:${Math.floor(profile.mine_cooldown_at / 1000)}:R> 可挖`
      : "✅ 現在可挖礦";

    const luckUses = profile.luck_potion_uses || 0;
    const ticketCount = profile.cd_ticket_count || 0;
    const inferiorCount = profile.whetstone_inferior_count || 0;
    const fragments = profile.legendary_fragments || 0;
    const reductionMin = Math.round((mining?.cdTicketReductionMs || 0) / 60000);

    // 材料修復：計算所需材料（讓 UI 提示用）
    const repairCost = getPickaxeRepairCost(profile);
    const canRepair =
      repairCost !== null &&
      profile.pickaxe !== "wood" &&
      typeof profile.pickaxe_durability === "number" &&
      typeof profile.pickaxe_max_durability === "number" &&
      profile.pickaxe_durability < profile.pickaxe_max_durability;

    // 材料修復所需文字（iron×5、stone×20 …），帶 have/need 標記讓使用者一眼看出夠不夠
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
    if (category === "all" || category === "ore") {
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          oreLines.length > 0
            ? `### ⛏️ 礦石\n${oreLines.join("\n")}\n-# 💰 全部賣出可得 ${totalValue.toLocaleString()} ${COIN_EMOJI}・依今日行情計價，每日 00:00 變動`
            : "### ⛏️ 礦石\n-# 背包裡還沒有礦石，快去 /挖礦 吧！"
        )
      );
    }

    // ── 挖礦狀態 ──
    if (category === "all" || category === "mine") {
      container.addSeparatorComponents(new SeparatorBuilder());
      // 在「挖礦道具」分類同時顯示礦石庫存，方便對照修復所需材料
      const oreInvLine =
        category === "mine"
          ? (() => {
              const lines = [];
              for (const [key, def] of Object.entries(mining.ores)) {
                const qty = profile.backpack?.[key] || 0;
                if (qty <= 0) continue;
                lines.push(`${def.emoji || "⛏️"} ${def.name}×${qty}`);
              }
              return lines.length > 0
                ? `\n🪙 礦石庫存：${lines.join("・")}`
                : `\n🪙 礦石庫存：（空）`;
            })()
          : "";
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🪓 挖礦狀態\n` +
            `⛏️ 目前鎬子：${pdef.emoji || "⛏️"} ${pdef.name}（${durabilityText}）\n` +
            `📦 背包容量：${used} / ${cap}\n` +
            `⏳ 挖礦冷卻：${cdText}` +
            oreInvLine
        )
      );
    }

    // ── 挖礦道具 ──
    // 「全部」分類只顯示純文字摘要（避免超過 Discord Components V2 40 個元件上限），
    // 切到「🪓 挖礦道具」分類才看到互動 Section + 按鈕。
    if (category === "all") {
      const repairHint = canRepair && repairCost
        ? `\n🛠️ 修復鎬子需要：${formatCost(repairCost)}`
        : "";
      container.addSeparatorComponents(new SeparatorBuilder());
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🎁 挖礦道具\n` +
            `🍀 幸運藥水 ×${luckUses}　🎫 CD 縮短券 ×${ticketCount}　🪨 劣質磨鎬石 ×${inferiorCount}　✨ 傳說素材碎片 ×${fragments}` +
            repairHint +
            `\n-# 切到上方「🪓 挖礦道具」分類可使用道具／修復鎬子`
        )
      );
    } else if (category === "mine") {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🎁 挖礦道具\n` +
          `🍀 **幸運藥水** ×${luckUses}\n-# 挖礦自動生效，提升幸運`
      )
    );
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `🎫 **CD 縮短券** ×${ticketCount}\n-# 冷卻中使用，立即 -${reductionMin} 分`
          )
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${USE_TICKET_PREFIX}${userId}`)
            .setLabel("使用")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!(ticketCount > 0 && inCooldown))
        )
    );
    // 劣質磨鎬石
    {
      const maxDur = profile.pickaxe_max_durability;
      const inferiorCanUse =
        inferiorCount > 0 &&
        profile.pickaxe !== "wood" &&
        typeof maxDur === "number" &&
        maxDur >= 20;
      const inferiorHint = inferiorCount > 0 && typeof maxDur === "number" && maxDur < 20
        ? "\n-# ⚠️ 鎬子最大耐久不足 20，無法使用"
        : `\n-# 補滿耐久，最大耐久 -10（目前上限 ${typeof maxDur === "number" ? maxDur : "—"}）`;
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `🪨 **劣質磨鎬石** ×${inferiorCount}${inferiorHint}`
            )
          )
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`${USE_WHETSTONE_INFERIOR_PREFIX}${userId}`)
              .setLabel("使用")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(!inferiorCanUse)
          )
      );
    }
    // 材料修復
    {
      const repairLabel = canRepair && repairCost
        ? `🛠️ **材料修復**\n-# 消耗：${formatCost(repairCost)}，補滿鎬子耐久`
        : `🛠️ **材料修復**\n-# ${
            profile.pickaxe === "wood"
              ? "需要非木鎬才能修復"
              : !canRepair && typeof profile.pickaxe_durability === "number" &&
                typeof profile.pickaxe_max_durability === "number" &&
                profile.pickaxe_durability >= profile.pickaxe_max_durability
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
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `✨ **傳說素材碎片** ×${fragments}\n-# 合成傳說裝備材料`
      )
    );
    } // end category === "mine"
  }

  // ── 釣魚區 ──
  if ((category === "all" || category === "fish") && fishing?.enabled && client.miningProfilesCollection) {
    const fishProfile = await getOrCreate(client, userId, guildId);
    const fishBag = fishProfile.fish_bag || {};
    const fishCdAt = fishProfile.fish_cooldown_at || 0;
    const now = Date.now();
    const fishCdText = fishCdAt > now
      ? `<t:${Math.floor(fishCdAt / 1000)}:R> 可釣`
      : "✅ 現在可釣魚";

    const foodBuffs = getActiveFoodBuffs(fishProfile);
    const buffLines = foodBuffs.map((b) => {
      const recipe = Object.values(fishing.recipes || {}).find(
        (r) => r.buff?.type === b.type || r.coalBuff?.type === b.type
      );
      const emoji = recipe?.emoji || "🍽️";
      const name = recipe?.name || b.type;
      let desc = b.type === "work_income"  ? `打工 +${Math.round(b.value * 100)}%`
               : b.type === "dungeon_atk"  ? `地城 ATK +${b.value}`
               : b.type === "mine_luck"    ? `幸運 +${Math.round(b.value * 100)}%`
               : b.type === "all_boost"    ? `全屬性 +${Math.round(b.value * 100)}%`
               : b.type === "fish_fortune" ? `釣魚 +${Math.round(b.value * 100)}%`
               : b.type;
      const expire = b.uses_left != null
        ? `（剩 ${b.uses_left} 次）`
        : b.expires_at ? `（<t:${Math.floor(b.expires_at / 1000)}:R>）` : "";
      return `・${emoji} **${name}**：${desc}${expire}`;
    });

    // 目前釣竿 + 耐久
    const rodKey = fishProfile.fishing_rod || "bamboo";
    const rodDef = (fishing.rods || {})[rodKey] || (fishing.rods || {}).bamboo || {};
    const rodDuraText =
      rodKey === "bamboo" || fishProfile.rod_durability == null
        ? "永久"
        : typeof fishProfile.rod_max_durability === "number"
          ? `耐久 ${fishProfile.rod_durability} / ${fishProfile.rod_max_durability}`
          : `耐久 ${fishProfile.rod_durability}`;
    const rodLine = `🪝 目前釣竿：**${rodDef.emoji || "🎣"} ${rodDef.name || "竹釣竿"}**（${rodDuraText}）`;

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🎣 釣魚\n⏳ 釣魚冷卻：${fishCdText}\n${rodLine}` +
        (buffLines.length > 0 ? `\n**食物 Buff**\n${buffLines.join("\n")}` : "\n-# 目前無食物 buff・用 /烹飪 製作")
      )
    );

    // 每種有魚的魚種：在「釣魚」分類顯示數量 + 賣全部按鈕；
    // 在「全部」分類只用純文字摘要，避免超過 Discord Components V2 40 個元件上限。
    const fishMarket = await orePriceEngine.getDailyFishPrices(client).catch(() => ({ prices: {} }));
    const fishPriceMap = fishMarket?.prices || {};
    const hasFish = Object.entries(fishing.fish || {}).some(([k]) => (fishBag[k] || 0) > 0);
    if (category === "fish") {
      if (hasFish) {
        for (const [key, def] of Object.entries(fishing.fish || {})) {
          const qty = fishBag[key] || 0;
          if (qty <= 0) continue;
          const base = def.price || 0;
          const unit = typeof fishPriceMap[key] === "number" ? fishPriceMap[key] : base;
          const total = qty * unit;
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
                  .setCustomId(`fish_sell_${userId}_${key}`)
                  .setLabel(`賣全部 +${total.toLocaleString()}`)
                  .setStyle(ButtonStyle.Secondary)
              )
          );
        }
      } else {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 魚袋空空，快去 /釣魚 吧！")
        );
      }

      // 0 條的魚種低調收到底部
      const emptyFish = Object.entries(fishing.fish || {})
        .filter(([k]) => (fishBag[k] || 0) === 0)
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
    } else {
      // category === "all"：純文字摘要
      if (hasFish) {
        let bagTotalValue = 0;
        const fishLines = [];
        for (const [key, def] of Object.entries(fishing.fish || {})) {
          const qty = fishBag[key] || 0;
          if (qty <= 0) continue;
          const base = def.price || 0;
          const unit = typeof fishPriceMap[key] === "number" ? fishPriceMap[key] : base;
          const total = qty * unit;
          bagTotalValue += total;
          fishLines.push(`${def.emoji} **${def.name}** ×${qty} ・ ${total.toLocaleString()} ${COIN_EMOJI}（@${unit.toLocaleString()}${trendLabel(unit, base)}）`);
        }
        const emptyFish = Object.entries(fishing.fish || {})
          .filter(([k]) => (fishBag[k] || 0) === 0)
          .map(([, def]) => def.name)
          .join("・");
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**魚袋**\n${fishLines.join("\n")}\n-# 💰 全部賣出可得 ${bagTotalValue.toLocaleString()} ${COIN_EMOJI}・依今日行情計價・切到「🎣 釣魚」分類可一鍵賣出${emptyFish ? `\n-# 尚無：${emptyFish}` : ""}`
          )
        );
      } else {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 魚袋空空，快去 /釣魚 吧！")
        );
      }
    }
  }

  // ── 農場區 ──
  if ((category === "all" || category === "farm") && farming?.enabled && client.miningProfilesCollection) {
    const farmProfile = await getOrCreate(client, userId, guildId);
    const veggieBag = farmProfile.veggie_bag || {};
    const seedBag = farmProfile.seed_bag || {};
    const bp = farmProfile.backpack || {};
    const plotCount = Math.max(1, Math.min(farmProfile.farm_plot_count || 2, farming.maxPlots || 8));

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### 🌾 農場\n地塊：**${plotCount} / ${farming.maxPlots || 8}** 格・累計收成 ${farmProfile.farm_harvest_total || 0} 次`,
      ),
    );

    if (category === "farm") {
      // 蔬菜（含賣全部按鈕）
      const veggieEntries = Object.entries(farming.crops || {})
        .filter(([k]) => (veggieBag[k] || 0) > 0);
      if (veggieEntries.length > 0) {
        for (const [key, def] of veggieEntries) {
          const qty = veggieBag[key] || 0;
          const price = (farming.sellPrices || {})[key] || 0;
          const total = qty * price;
          container.addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `${def.emoji} **${def.name}** ×${qty}・單價 ${price} ${COIN_EMOJI}`,
                ),
              )
              .setButtonAccessory(
                new ButtonBuilder()
                  .setCustomId(`farm_sell_${userId}_${key}`)
                  .setLabel(`賣全部 +${total.toLocaleString()}`)
                  .setStyle(ButtonStyle.Secondary),
              ),
          );
        }
      } else {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 菜籃空空，去 /農場 種點蔬菜吧！"),
        );
      }

      // 種子
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

      // 肥料道具（compost / slime / moonlight_dew）
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
            `**💧 肥料**　${fertLines.join("・")}\n-# 用 \`/施肥\` 加速作物成長`,
          ),
        );
      }
      if (farmProfile.rare_bait > 0) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🎏 稀有魚餌** ×${farmProfile.rare_bait}\n-# 黑玫瑰收成額外掉落物`,
          ),
        );
      }
    } else {
      // 全部分類：摘要顯示
      const summary = [];
      let bagValue = 0;
      for (const [key, def] of Object.entries(farming.crops || {})) {
        const qty = veggieBag[key] || 0;
        if (qty <= 0) continue;
        const price = (farming.sellPrices || {})[key] || 0;
        bagValue += qty * price;
        summary.push(`${def.emoji} **${def.name}** ×${qty}`);
      }
      const fertSummary = [];
      if (bp.compost > 0) fertSummary.push(`🍂 堆肥 ×${bp.compost}`);
      if (bp.monster_slime > 0) fertSummary.push(`💧 黏液 ×${bp.monster_slime}`);
      if (bp.moonlight_dew > 0) fertSummary.push(`🌟 露水 ×${bp.moonlight_dew}`);
      const seedSummary = Object.entries(seedBag)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => {
          const cropKey = k.replace(/^seed_/, "");
          const def = farming.crops?.[cropKey] || {};
          return `${def.emoji || "🌱"} ${def.name || cropKey}種子 ×${v}`;
        });

      const parts = [];
      if (summary.length > 0) {
        parts.push(`**菜籃**：${summary.join("・")}\n-# 💰 全部賣出可得 ${bagValue.toLocaleString()} ${COIN_EMOJI}`);
      }
      if (fertSummary.length > 0) parts.push(`**肥料**：${fertSummary.join("・")}`);
      if (seedSummary.length > 0) parts.push(`**種子**：${seedSummary.join("・")}`);
      if (parts.length === 0) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 農場尚未開張，去 /農場 看看吧！"),
        );
      } else {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(parts.join("\n") + `\n-# 切到「🌾 農場」分類可一鍵賣蔬菜`),
        );
      }
    }
  }

  // ── 商店區 ──
  const equipRows = [];
  if ((category === "all" || category === "shop") && shop?.enabled && client.userInventoryCollection) {
    const items = await client.userInventoryCollection
      .find({ userId, guildId, expired: { $ne: true } })
      .sort({ acquiredAt: -1 })
      .limit(50)
      .toArray();

    const now = Date.now();
    const activeBuffs = (coinDoc?.activeBuffs || []).filter((b) => {
      const exp = b?.expiresAt ? new Date(b.expiresAt).getTime() : 0;
      return exp > now;
    });

    container.addSeparatorComponents(new SeparatorBuilder());

    const buffText =
      activeBuffs.length > 0
        ? activeBuffs
            .map(
              (b) =>
                `・${b.type === "xp_boost" ? "📈 XP" : `${MONEY_EMOJI} 金幣`} ×${b.multiplier}（${fmtExpiry(b.expiresAt)}）`
            )
            .join("\n")
        : "（沒有）";
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ✨ 生效中的 buff\n${buffText}\n-# 此處僅顯示商店購買的 XP／金幣 buff，贊助等挖礦幸運加成請於 \`/挖礦\` 結果或 \`/狀態\` 查看`
      )
    );

    const grouped = new Map();
    for (const it of items) {
      if (!grouped.has(it.type)) grouped.set(it.type, []);
      grouped.get(it.type).push(it);
    }

    container.addSeparatorComponents(new SeparatorBuilder());

    if (items.length === 0) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("### 🛍️ 商店道具\n-# 還沒有任何道具，到 /商店 逛逛吧！")
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

    // 四種可裝備道具併成單一下拉，徹底避免動作列爆量導致選單被截掉。
    // 只在「🛍️ 商店道具」分類顯示，避免「全部」分類元件總數超過 40。
    if (category === "shop") {
      const unifiedMenu = buildUnifiedEquipMenu(grouped);
      if (unifiedMenu) equipRows.push(unifiedMenu);

      // 贊助限定卡面持有者：提供「設定卡號」按鈕（自訂浮雕卡號）
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
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 上方下拉可切換分類｜/賣出 換金幣、/釣魚 去釣魚、/烹飪 製作 buff、/商店 逛逛"
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
  USE_TICKET_PREFIX,
  parseUseTicketId,
  USE_WHETSTONE_INFERIOR_PREFIX,
  USE_WHETSTONE_INFERIOR_CONFIRM_PREFIX,
  parseUseWhetstoneInferiorId,
  REPAIR_MATERIAL_PREFIX,
  REPAIR_MATERIAL_CONFIRM_PREFIX,
  parseRepairMaterialId,
  UNIFIED_EQUIP_ID,
};
