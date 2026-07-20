require("colors");
const crypto = require("crypto");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { marketplace, bank } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const itemAccess = require("./itemAccess");
const marketplaceService = require("./marketplaceService");
const marketSaleMonitor = require("../economy/marketSaleMonitor");
const {
  BUY_PREFIX,
  FULFILL_PREFIX,
  BULK_SELL_PREFIX,
  BULKSELL_BUY_PREFIX,
  SWAP_SELL_PREFIX,
  VIEW_MYSTALL_ID,
  VIEW_BROWSE_ID,
  buildLiveListingCard,
} = require("./marketplaceView");

// 有成交進度、公開卡需即時更新的單型
const LIVE_KINDS = new Set(["bulk", "bulk_sell", "swap"]);

// 「物品換金錢」的上架二次確認：先預覽行情中位數與洗幣風險 → 確認才真正建立掛單。
// pending 存在記憶體（確認在數分鐘內完成，重啟就重下指令即可），可直接保留 member 物件。

const CONFIRM_PREFIX = "mktlist_confirm_";
const EDIT_PREFIX = "mktlist_edit_";
const CANCEL_PREFIX = "mktlist_cancel_";
const EDIT_MODAL_PREFIX = "mktlist_editmodal_";

const TTL_MS = 10 * 60 * 1000;
const PENDING = new Map();

function stash(data) {
  const token = crypto.randomBytes(6).toString("hex");
  const now = Date.now();
  for (const [k, v] of PENDING) {
    if (now - v._createdAt > TTL_MS) PENDING.delete(k);
  }
  const entry = { ...data, _token: token, _createdAt: now };
  PENDING.set(token, entry);
  return entry;
}

function getPending(token) {
  const p = PENDING.get(token);
  if (!p) return null;
  if (Date.now() - p._createdAt > TTL_MS) {
    PENDING.delete(token);
    return null;
  }
  return p;
}

function drop(token) {
  PENDING.delete(token);
}

const KIND_TITLE = {
  sell: "🧾 確認上架賣單",
  auction: "🧾 確認上架競標",
  bulk: "🧾 確認開收購單",
  bulk_sell: "🧾 確認開賣單",
  want: "🧾 確認上架徵求",
};

function classify(ratio, overpayRatio) {
  if (ratio == null) return "—";
  if (ratio < 0.6) return "🔻 偏低，可能賣太便宜";
  if (ratio <= 1.4) return "✅ 接近行情";
  if (ratio < overpayRatio) return "🔺 偏高";
  return "⛔ 遠高於行情";
}

function priceSummaryLine(p) {
  const label = itemAccess.itemLabel(p.itemType, p.itemKey, p.qty);
  const unit = Math.round(p.unitPrice);
  let line =
    `${label}\n` +
    `${p.priceLabel}：**${p.totalPrice.toLocaleString()}** ${COIN_EMOJI}`;
  if (p.buyoutPrice) line += `　一口價 **${p.buyoutPrice.toLocaleString()}**`;
  line += `　（單價約 **${unit.toLocaleString()}**／個）`;
  return line;
}

// 物物交換上架預覽：估兩邊價值（優先近期成交中位，樣本不足退回基礎價），
// 價值嚴重不對等時警示（洗幣風險）。
async function buildSwapPreview(client, pending) {
  const p = pending.params;
  const a = await marketSaleMonitor.assessSwapValue(client, {
    guildId: pending.guildId,
    giveType: p.giveType, giveKey: p.giveKey, giveQty: p.giveQty,
    wantType: p.wantType, wantKey: p.wantKey, wantQty: p.wantQty,
  });
  const flagWarn = a.wouldFlag;
  const giveLabel = itemAccess.itemLabel(p.giveType, p.giveKey, p.giveQty);
  const wantLabel = itemAccess.itemLabel(p.wantType, p.wantKey, p.wantQty);
  const basisLabel = a.usingMedian ? `近 ${a.medianDays} 天成交中位` : "系統基礎價";

  const container = new ContainerBuilder()
    .setAccentColor(flagWarn ? 0xe74c3c : 0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🧾 確認上架物物交換\n` +
          (pending.title ? `📌 ${pending.title}\n` : "") +
          `付出 ${giveLabel}\n換得 ${wantLabel}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `📊 **價值對照（${basisLabel}）**\n` +
        `付出估值 **${Math.round(a.giveValue).toLocaleString()}**　換得估值 **${Math.round(a.wantValue).toLocaleString()}**` +
        (a.ratio ? `\n兩邊價值相差約 **${a.ratio.toFixed(1)} 倍**` : "") +
        (a.usingMedian ? "" : `\n-# 成交樣本不足，改用系統基礎價對照`),
    ),
  );

  if (flagWarn) {
    const flagPenalty = Math.abs((bank?.credit?.scoring || {}).suspicious_flag || 0);
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🚨 **價值不對等警示**\n` +
            `兩邊估值相差約 **${a.ratio.toFixed(1)} 倍**（差 ${Math.round(a.diff).toLocaleString()}），成交後可能被判定為變相轉帳（洗幣），**雙方信用分恐各被扣 ${flagPenalty} 分**。`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 若確為正常交換可續行；若數量填錯，請按「取消」重下指令。",
        ),
      );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 確認無誤就按「確認上架」；數量要改請按「取消」重下指令。"),
    );
  }

  const { ownerId, _token } = pending;
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONFIRM_PREFIX}${ownerId}_${_token}`)
        .setLabel("確認上架")
        .setEmoji("✅")
        .setStyle(flagWarn ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${CANCEL_PREFIX}${ownerId}_${_token}`)
        .setLabel("取消")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { container, wouldFlag: flagWarn };
}

// 預覽 Container（含中位數提示與洗幣警示）。回傳 { container, wouldFlag }。
async function buildPreview(client, pending) {
  if (pending.kind === "swap") return buildSwapPreview(client, pending);

  const assess = await marketSaleMonitor.assessListingPrice(client, {
    guildId: pending.guildId,
    itemType: pending.itemType,
    itemKey: pending.itemKey,
    unitPrice: pending.unitPrice,
    qty: pending.qty,
  });

  // 洗幣警示只在「成交時真的會跑反洗幣偵測」的單型才成立（賣單/競標/收購）；
  // 徵求付金幣的成交目前不經 recordAndCheck，不宣稱會扣分，只保留行情提示。
  const flagWarn = assess.wouldFlag && pending.kind !== "want";

  const container = new ContainerBuilder()
    .setAccentColor(flagWarn ? 0xe74c3c : 0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${KIND_TITLE[pending.kind] || "🧾 確認上架"}\n` +
          (pending.title ? `📌 ${pending.title}\n` : "") +
          priceSummaryLine(pending),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (assess.usingMedian) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `📊 **近期行情**\n` +
          `近 ${assess.medianDays} 天成交中位 **${Math.round(assess.median).toLocaleString()}**／個（${assess.samples} 筆樣本）\n` +
          `你的單價 **${Math.round(pending.unitPrice).toLocaleString()}**／個 → ${classify(assess.ratio, assess.overpayRatio)}`,
      ),
    );
  } else {
    const base = itemAccess.basePrice(pending.itemType, pending.itemKey);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `📊 **近期行情**\n` +
          `成交樣本不足（${assess.samples} 筆），暫無市場中位可參考。\n` +
          `-# 系統基礎價約 **${Math.round(base).toLocaleString()}**／個，僅供對照`,
      ),
    );
  }

  if (flagWarn) {
    const flagPenalty = Math.abs((bank?.credit?.scoring || {}).suspicious_flag || 0);
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🚨 **洗幣風險警示**\n` +
            `此單價約為行情的 **${assess.ratio.toFixed(1)} 倍**（溢價約 ${assess.overpay.toLocaleString()} ${COIN_EMOJI}）。\n` +
            `成交後系統可能判定為變相轉帳（洗幣），**買賣雙方信用分恐各被扣 ${flagPenalty} 分**。`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 若確為正常高價交易可續行；若價格填錯，請按「改價格數量」修正後再上架。",
        ),
      );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 確認無誤就按「確認上架」；想調整可按「改價格數量」。"),
    );
  }

  const { ownerId, _token } = pending;
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONFIRM_PREFIX}${ownerId}_${_token}`)
        .setLabel("確認上架")
        .setEmoji("✅")
        .setStyle(flagWarn ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${EDIT_PREFIX}${ownerId}_${_token}`)
        .setLabel("改價格數量")
        .setEmoji("✏️")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${CANCEL_PREFIX}${ownerId}_${_token}`)
        .setLabel("取消")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { container, wouldFlag: assess.wouldFlag };
}

function simpleContainer(color, text) {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}

// ── 改價格 / 數量 Modal ───────────────────────────────────────────────────────
function priceFieldSpec(kind) {
  if (kind === "bulk" || kind === "bulk_sell") return { id: "price", label: "單價（每個金幣）" };
  if (kind === "auction") return { id: "price", label: "起標價（總價）" };
  if (kind === "want") return { id: "price", label: "金幣總額" };
  return { id: "price", label: "總價（一口價）" };
}

function buildEditModal(pending) {
  const { ownerId, _token, kind } = pending;
  const modal = new ModalBuilder()
    .setCustomId(`${EDIT_MODAL_PREFIX}${ownerId}_${_token}`)
    .setTitle("修改價格 / 數量");
  const pf = priceFieldSpec(kind);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("price")
        .setLabel(pf.label)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(kind === "bulk" || kind === "bulk_sell" ? pending.unitPrice : pending.totalPrice)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("qty")
        .setLabel("數量")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(pending.qty)),
    ),
  );
  if (kind === "auction") {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("buyout")
          .setLabel("一口價（選填，留空＝不設）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(pending.buyoutPrice ? String(pending.buyoutPrice) : ""),
      ),
    );
  }
  return modal;
}

function toInt(v) {
  const n = parseInt(String(v ?? "").replace(/[, ]/g, ""), 10);
  return Number.isFinite(n) ? n : NaN;
}

// 依 Modal 內容更新 pending（就地改，同一個 Map entry）。回傳 { ok } 或 { ok:false, note }。
// 注意：bulk 的 price 欄位是「單價」，其餘單型是「總價/起標價/金幣總額」。
function applyEdit(pending, fields) {
  const price = toInt(fields.price);
  const qty = toInt(fields.qty);
  if (!(price >= 1)) return { ok: false, note: "⚠️ 請輸入有效的價格" };
  if (!(qty >= 1)) return { ok: false, note: "⚠️ 請輸入有效的數量" };

  const p = pending.params;
  pending.qty = qty;

  if (pending.kind === "bulk" || pending.kind === "bulk_sell") {
    pending.unitPrice = price;
    pending.totalPrice = price * qty;
    p.qty = qty;
    p.unitPrice = price;
    return { ok: true };
  }

  if (pending.kind === "auction") {
    let buyout = null;
    const raw = String(fields.buyout || "").trim();
    if (raw) {
      buyout = toInt(fields.buyout);
      if (!(buyout >= 1)) return { ok: false, note: "⚠️ 一口價請輸入有效數字或留空" };
      if (buyout < price) return { ok: false, note: "⚠️ 一口價不能低於起標價" };
    }
    pending.totalPrice = price;
    pending.unitPrice = price / qty;
    pending.buyoutPrice = buyout;
    p.qty = qty;
    p.startPrice = price;
    p.buyoutPrice = buyout;
    return { ok: true };
  }

  pending.totalPrice = price;
  pending.unitPrice = price / qty;
  if (pending.kind === "sell") {
    p.qty = qty;
    p.price = price;
  } else if (pending.kind === "want") {
    p.wantQty = qty;
    p.coinAmount = price;
  }
  return { ok: true };
}

// ── 確認後真正建立掛單 ────────────────────────────────────────────────────────
async function callCreate(client, pending) {
  const p = pending.params;
  if (pending.kind === "sell") {
    if (p.subtype === "fish") return marketplaceService.createFishSellListing(client, p);
    if (p.subtype === "veggie") return marketplaceService.createVeggieSellListing(client, p);
    return marketplaceService.createSellListing(client, p);
  }
  if (pending.kind === "auction") return marketplaceService.createAuctionListing(client, p);
  if (pending.kind === "bulk") return marketplaceService.createBulkListing(client, p);
  if (pending.kind === "bulk_sell") return marketplaceService.createBulkSellListing(client, p);
  if (pending.kind === "swap") return marketplaceService.createSwapListing(client, p);
  if (pending.kind === "want") return marketplaceService.createWantListing(client, p);
  return { ok: false, reason: "disabled" };
}

function fmtErr(pending, result) {
  const r = result.reason;
  switch (r) {
    case "no_ore":
    case "no_fish":
    case "no_veggie":
    case "no_item":
    case "no_want_item":
    case "no_pay_item":
      return "❌ 找不到這種物品。";
    case "low_price":
      return `❌ 這批的最低售價為 **${result.minPrice.toLocaleString()}** ${COIN_EMOJI}（系統價的 80%）。請按「改價格數量」提高總價。`;
    case "low_unit_price":
      return `❌ 收購單價不得低於系統售價 **${result.minUnit.toLocaleString()}** ${COIN_EMOJI}／個。`;
    case "low_start":
      return `❌ 起標價至少要 **${result.minStart.toLocaleString()}** ${COIN_EMOJI}（基礎價的 80%）。`;
    case "low_buyout":
      return `❌ 一口價不能低於起標價 **${result.startPrice.toLocaleString()}** ${COIN_EMOJI}。`;
    case "qty_too_large":
      return `❌ 單筆收購數量上限為 **${result.maxQty.toLocaleString()}** 個。`;
    case "too_many":
      return `📦 你同時最多只能掛 **${result.max}** 件掛單。`;
    case "bulk_limit":
      return `📋 你同時只能開 **${result.maxBulk}** 張收購單，先下架舊的再開新的。`;
    case "insufficient":
      return `🎒 你的數量不足，無法託管 ${pending.qty} 個（目前 ${result.have ?? 0}）。`;
    case "insufficient_coins":
      return `💰 餘額不足！需要 **${(result.need ?? 0).toLocaleString()}** ${COIN_EMOJI}（含手續費），你目前 **${(result.balance ?? 0).toLocaleString()}** ${COIN_EMOJI}。`;
    case "insufficient_fee":
      return `💰 上架費不足！需要 **${(result.need ?? 0).toLocaleString()}** ${COIN_EMOJI}，你目前 **${(result.balance ?? 0).toLocaleString()}** ${COIN_EMOJI}。請改選較短的時長或補足金幣。`;
    case "grant_failed":
      return "🔧 金幣託管失敗，請稍後再試。";
    case "same_item":
      return "❌ 想要與付的物品不能相同！";
    case "no_give_item":
      return "❌ 找不到「付出物品」。";
    case "no_want_item":
      return "❌ 找不到「想要物品」。";
    case "bad_give_qty":
    case "bad_want_qty":
      return "❌ 數量無效，請填正整數。";
    case "untradeable":
      return "❌ 這些物品不可用於交易。";
    default:
      return "🔧 上架失敗，請稍後再試。";
  }
}

// 建立成功後的「公開掛單卡」（含成交按鈕），沿用各單型原本的呈現。
function buildSuccessCard(pending, result) {
  const l = result.listing;
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);

  if (pending.kind === "sell") {
    const feeRate = Math.round((marketplace.sellFeeRate ?? 0.05) * 100);
    const bag = pending.params.subtype === "fish" ? "魚袋" : pending.params.subtype === "veggie" ? "菜籃" : "背包";
    const title = pending.params.subtype === "fish" ? "🐟 賣魚掛牌成功" : pending.params.subtype === "veggie" ? "🌾 賣菜掛牌成功" : "💰 賣礦掛牌成功";
    const container = new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${title}\n` +
            (l.title ? `📌 ${l.title}\n` : "") +
            `**#${l.listing_id}** ・ ${itemAccess.itemLabel(pending.itemType, pending.itemKey, l.qty)}\n` +
            `一口價：**${l.price.toLocaleString()}** ${COIN_EMOJI}\n` +
            `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
            `-# 買方成交時加收 ${feeRate}% 手續費，賣方拿全額；無人購買將自動退回${bag}。`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${BUY_PREFIX}${l.listing_id}`)
            .setLabel("立即購買")
            .setEmoji("💰")
            .setStyle(ButtonStyle.Success),
        ),
      );
    return container;
  }

  if (pending.kind === "auction") {
    const feeRate = Math.round(((marketplace.auction || {}).feeRate ?? 0.05) * 100);
    const buyoutLine = l.buyout_price
      ? `\n💰 一口價：**${l.buyout_price.toLocaleString()}** ${COIN_EMOJI}（出到這價立即成交）`
      : "";
    return new ContainerBuilder()
      .setAccentColor(0xe1b12c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🏷️ 競標掛牌成功\n` +
            (l.title ? `📌 ${l.title}\n` : "") +
            `**#${l.listing_id}** ・ ${itemAccess.itemLabel(pending.itemType, pending.itemKey, l.qty)}\n` +
            `起標價：**${l.start_price.toLocaleString()}** ${COIN_EMOJI}${buyoutLine}\n` +
            `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
            `-# 得標者加收 ${feeRate}% 手續費，賣方拿全額；無人出價會自動退回${itemAccess.bagName(pending.itemType)}。`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(VIEW_MYSTALL_ID).setLabel("查看我的攤位").setEmoji("📦").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(VIEW_BROWSE_ID).setLabel("查看市集").setEmoji("🏪").setStyle(ButtonStyle.Secondary),
        ),
      );
  }

  if (pending.kind === "bulk") {
    return new ContainerBuilder()
      .setAccentColor(0x16a085)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🛒 收購開單成功\n` +
            (l.title ? `📌 ${l.title}\n` : "") +
            `**#${l.listing_id}** ・ 收購 ${itemAccess.itemLabel(pending.itemType, pending.itemKey)} ×**${l.qty.toLocaleString()}**\n` +
            `單價 **${l.unit_price.toLocaleString()}** ${COIN_EMOJI}／個\n` +
            `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
            `-# 其他玩家可直接點下方「賣給他」分批賣給你；收滿或到期後，未用完的金額會自動退回。`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${BULK_SELL_PREFIX}${l.listing_id}`).setLabel("賣給他").setEmoji("🛒").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(VIEW_MYSTALL_ID).setLabel("查看我的攤位").setEmoji("📦").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(VIEW_BROWSE_ID).setLabel("查看市集").setEmoji("🏪").setStyle(ButtonStyle.Secondary),
        ),
      );
  }

  if (pending.kind === "bulk_sell") {
    const feeRate = Math.round(((marketplace.bulkSell || {}).feeRate ?? 0.05) * 100);
    return new ContainerBuilder()
      .setAccentColor(0x2980b9)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 📦 賣單開單成功\n` +
            (l.title ? `📌 ${l.title}\n` : "") +
            `**#${l.listing_id}** ・ 出售 ${itemAccess.itemLabel(pending.itemType, pending.itemKey)} ×**${l.qty.toLocaleString()}**\n` +
            `單價 **${l.unit_price.toLocaleString()}** ${COIN_EMOJI}／個\n` +
            `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
            `-# 其他玩家可分批向你購買；每筆成交扣 ${feeRate}% 手續費，售滿或到期後未賣出的會自動退回你的袋子。`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${BULKSELL_BUY_PREFIX}${l.listing_id}`).setLabel("購買").setEmoji("📦").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(VIEW_MYSTALL_ID).setLabel("查看我的攤位").setEmoji("📦").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(VIEW_BROWSE_ID).setLabel("查看市集").setEmoji("🏪").setStyle(ButtonStyle.Secondary),
        ),
      );
  }

  if (pending.kind === "swap") {
    const give = l.give || {};
    const want = l.want || {};
    const giveLabel = itemAccess.itemLabel(give.type, give.key, give.qty);
    const wantLabel = itemAccess.itemLabel(want.type, want.key, want.qty);
    return new ContainerBuilder()
      .setAccentColor(0x9b59b6)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🔄 物物交換掛牌成功\n` +
            (l.title ? `📌 ${l.title}\n` : "") +
            `**#${l.listing_id}**\n` +
            `付出 ${giveLabel}（已從你${itemAccess.bagName(give.type)}託管），想換 ${wantLabel}\n` +
            `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
            `-# 有貨的玩家可直接點下方「賣給他」分批交換；換滿或到期後未換出的會自動退回。`,
        ),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${SWAP_SELL_PREFIX}${l.listing_id}`).setLabel("賣給他").setEmoji("🔄").setStyle(ButtonStyle.Primary),
        ),
      );
  }

  // want（付金幣）
  const wantLabel = itemAccess.itemLabel(pending.itemType, pending.itemKey, l.want_qty ?? pending.qty);
  return new ContainerBuilder()
    .setAccentColor(0x8e44ad)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📋 徵求掛牌成功\n` +
          (l.title ? `📌 ${l.title}\n` : "") +
          `**#${l.listing_id}**\n` +
          `徵求 ${wantLabel}，付出 **${pending.totalPrice.toLocaleString()}** ${COIN_EMOJI}（已從你帳戶託管）\n` +
          `截止時間：<t:${expiresEpoch}:R>（<t:${expiresEpoch}:f>）\n` +
          `-# 有貨的玩家可直接點下方「賣給他」成交；無人賣出則取消時退回付款。`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${FULFILL_PREFIX}${l.listing_id}`)
          .setLabel("賣給他")
          .setEmoji("📋")
          .setStyle(ButtonStyle.Primary),
      ),
    );
}

// 賣家／買家自己看的私密確認：把金額類資訊（鎖定金額、滿額可得）放這裡，不進公開卡。
function buildAckText(pending, result) {
  const l = result.listing;
  const head = `✅ 已上架 **#${l?.listing_id}**（掛單卡已公開在頻道）`;
  if (pending.kind === "bulk") {
    return head +
      `\n-# 已從你帳戶鎖定 **${result.totalEscrow.toLocaleString()}** ${COIN_EMOJI}` +
      `（本金 ${l.pay_coin.toLocaleString()} + 手續費 ${result.fee.toLocaleString()}）；收滿或到期未用完會退回。`;
  }
  if (pending.kind === "bulk_sell") {
    const feeRate = Math.round(((marketplace.bulkSell || {}).feeRate ?? 0.05) * 100);
    const total = (l.unit_price || 0) * (l.qty || 0);
    return head + `\n-# 全部售出可得 **${total.toLocaleString()}** ${COIN_EMOJI}（每筆成交前扣 ${feeRate}% 手續費）。`;
  }
  if (pending.kind === "swap") {
    const give = l.give || {};
    return head + `\n-# 已從你${itemAccess.bagName(give.type)}託管 ${itemAccess.itemLabel(give.type, give.key, give.qty)}；換滿或到期未換出的會退回。`;
  }
  return head;
}

// 執行建立：回傳 { ok, errorText? , publicCard? , ackText? }
async function finalize(client, pending) {
  const result = await callCreate(client, pending);
  if (!result.ok) return { ok: false, errorText: fmtErr(pending, result) };
  const live = LIVE_KINDS.has(pending.kind);
  return {
    ok: true,
    // 有進度的單型（收購/賣單/物物交換）用可即時更新的公開卡；其餘沿用開單成功卡
    publicCard: live ? buildLiveListingCard(result.listing) : buildSuccessCard(pending, result),
    ackText: buildAckText(pending, result),
    live,
    listingId: result.listing?.listing_id,
    guildId: result.listing?.guild_id,
  };
}

module.exports = {
  CONFIRM_PREFIX,
  EDIT_PREFIX,
  CANCEL_PREFIX,
  EDIT_MODAL_PREFIX,
  stash,
  getPending,
  drop,
  buildPreview,
  buildEditModal,
  applyEdit,
  finalize,
  simpleContainer,
};
