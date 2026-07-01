require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { stockSystem, stockEventConfig } = require("../../config");
const { applyEvent } = require("./priceEngine");

function getStaticEventDefs() {
  return stockEventConfig?.events || [];
}

async function getDynamicEventDefs(client, guildId) {
  if (!client?.stockEventDefsCollection || !guildId) return [];
  return client.stockEventDefsCollection
    .find({ guildId, enabled: { $ne: false } })
    .toArray();
}

// 合併 static (config) + dynamic (DB) 事件定義；同 id 以 dynamic 覆蓋
async function getMergedEventDefs(client, guildId) {
  const statics = getStaticEventDefs();
  const dynamics = await getDynamicEventDefs(client, guildId);
  const map = new Map();
  for (const e of statics) map.set(e.id, { ...e, source: "static" });
  for (const e of dynamics) {
    map.set(e.id, {
      id: e.id,
      name: e.name,
      effect: e.effect,
      stock: e.stock,
      dir: e.dir,
      source: "dynamic",
    });
  }
  return Array.from(map.values());
}

async function findEventById(client, guildId, eventId) {
  const defs = await getMergedEventDefs(client, guildId);
  return defs.find((e) => e.id === eventId) || null;
}

async function isOnCooldown(client, guildId, eventId) {
  if (!client.stockEventsCollection) return false;
  const cooldownHours = stockEventConfig?.cooldownHours ?? 4;
  const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
  const recent = await client.stockEventsCollection.findOne({
    guildId,
    eventId,
    timestamp: { $gte: cutoff },
  });
  return !!recent;
}

// 隨機抽事件並嘗試觸發；回傳 applied 事件或 null
async function rollRandomEvent(client, guildId) {
  const chance = stockEventConfig?.randomEventChance ?? 0.05;
  if (Math.random() >= chance) return null;
  const events = await getMergedEventDefs(client, guildId);
  if (events.length === 0) return null;

  // 隨機抽一個還沒在 cooldown 中的
  const shuffled = [...events].sort(() => Math.random() - 0.5);
  for (const ev of shuffled) {
    if (await isOnCooldown(client, guildId, ev.id)) continue;
    return fireEvent(client, guildId, ev.id, { force: false });
  }
  return null;
}

function resolveSector(target) {
  return stockSystem?.sectors?.[target] || null;
}

async function applyEffectToStocks(client, guildId, targetSymbol, effect) {
  const filter = { guildId, enabled: { $ne: false } };
  if (targetSymbol && targetSymbol !== "ALL") {
    const sector = resolveSector(targetSymbol);
    filter.symbol = sector ? { $in: sector.symbols } : targetSymbol;
  }

  const stocks = await client.stockMarketCollection.find(filter).toArray();
  const changes = [];
  for (const s of stocks) {
    const before = s.currentPrice;
    const after = applyEvent(before, effect, s.floor);
    if (after === before) continue;
    await client.stockMarketCollection.updateOne(
      { _id: s._id },
      { $set: { currentPrice: after, updatedAt: new Date() } }
    );
    // 寫入歷史報價
    if (client.stockPricesCollection) {
      await client.stockPricesCollection.insertOne({
        guildId,
        symbol: s.symbol,
        price: after,
        timestamp: new Date(),
        source: "event",
      }).catch(() => {});
    }
    changes.push({ symbol: s.symbol, name: s.name, before, after });
  }
  return changes;
}

async function fireEvent(client, guildId, eventId, opts = {}) {
  // 支援 ad-hoc：opts.customDef 直接帶入定義（不需要事先註冊）
  const def = opts.customDef
    ? { ...opts.customDef, source: "adhoc" }
    : await findEventById(client, guildId, eventId);
  if (!def) return null;
  if (!opts.force && (await isOnCooldown(client, guildId, def.id))) return null;

  const changes = await applyEffectToStocks(client, guildId, def.stock, def.effect);
  if (changes.length === 0) return null;

  await client.stockEventsCollection.insertOne({
    guildId,
    eventId: def.id,
    name: def.name,
    effect: def.effect,
    stock: def.stock,
    dir: def.dir,
    forced: !!opts.force,
    triggeredBy: opts.triggeredBy || "system",
    changes,
    timestamp: new Date(),
  }).catch(() => {});

  await announceEvent(client, def, changes).catch((e) =>
    console.log(`[STOCK-EVENT] 推播失敗：${e?.message || e}`.yellow)
  );

  return { def, changes };
}

async function announceEvent(client, def, changes) {
  const channelId = stockSystem?.announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const arrow = def.dir === "up" ? "📈" : "📉";
  const pct = (def.effect * 100).toFixed(1);
  const sign = def.effect >= 0 ? "+" : "";
  const sector = resolveSector(def.stock);
  let scope;
  if (def.stock === "ALL") scope = "全市場";
  else if (sector) scope = sector.name;
  else scope = changes[0]?.name || def.stock;
  const title = `${arrow} 突發新聞｜${scope}`;
  const lines = changes
    .slice(0, 6)
    .map((c) => `\`${c.symbol}\` ${c.name}：${c.before.toFixed(1)} → **${c.after.toFixed(1)}**`);
  if (changes.length > 6) lines.push(`…還有 ${changes.length - 6} 支`);

  const container = new ContainerBuilder()
    .setAccentColor(def.dir === "up" ? 0x2ecc71 : 0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${title}\n**${def.name}** 影響股價 ${sign}${pct}%`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**成交價變動**\n${lines.join("\n") || "（無）"}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

module.exports = {
  rollRandomEvent,
  fireEvent,
  findEventById,
  isOnCooldown,
  getStaticEventDefs,
  getDynamicEventDefs,
  getMergedEventDefs,
};
