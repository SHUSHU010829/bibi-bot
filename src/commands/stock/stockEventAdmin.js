require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  InteractionContextType,
} = require("discord.js");

const { stockSystem } = require("../../config");
const {
  fireEvent,
  getMergedEventDefs,
  getStaticEventDefs,
} = require("../../features/stock/eventEngine");

const TARGET_ALL = "ALL";

function normalizeSymbol(input) {
  if (!input) return TARGET_ALL;
  const v = String(input).trim().toUpperCase();
  return v === "" || v === "ALL" || v === "全部" ? TARGET_ALL : v;
}

function slugifyId(name) {
  // 將事件名稱壓成簡短英數 id，失敗則回傳 time-based fallback
  const cleaned = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned) return `custom_${cleaned}`.slice(0, 64);
  return `custom_${Date.now().toString(36)}`;
}

async function ensureSymbolExists(client, guildId, symbol) {
  if (symbol === TARGET_ALL) return true;
  if (!client.stockMarketCollection) return false;
  const found = await client.stockMarketCollection.findOne({ guildId, symbol });
  return !!found;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stock-event")
    .setDescription("[ADMIN] Manage stock market events (one-time fire or add to event book)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sc) =>
      sc
        .setName("fire")
        .setDescription("[ADMIN] Fire a one-time custom event immediately (not saved to event book)")
        .addStringOption((o) =>
          o.setName("name").setDescription("Event display name, e.g. 央行救市").setRequired(true)
        )
        .addNumberOption((o) =>
          o
            .setName("change")
            .setDescription("Percent change, e.g. 5 = +5%, -7 = -7% (range -50 ~ 50)")
            .setMinValue(-50)
            .setMaxValue(50)
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("target")
            .setDescription("Stock symbol (e.g. TSPP); leave empty or ALL for whole market")
            .setRequired(false)
        )
        .addBooleanOption((o) =>
          o
            .setName("skip-cooldown")
            .setDescription("Whether to bypass event cooldown (default true)")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("fire-by-id")
        .setDescription("[ADMIN] Fire an existing event by id (does not add to event book)")
        .addStringOption((o) =>
          o.setName("id").setDescription("Event id; use `list` to view available ids").setRequired(true)
        )
        .addBooleanOption((o) =>
          o
            .setName("skip-cooldown")
            .setDescription("Whether to bypass event cooldown (default true)")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("[ADMIN] Add a new event to the event book (will randomly trigger later)")
        .addStringOption((o) =>
          o.setName("name").setDescription("Event display name").setRequired(true)
        )
        .addNumberOption((o) =>
          o
            .setName("change")
            .setDescription("Percent change, e.g. 8 = +8% (range -50 ~ 50)")
            .setMinValue(-50)
            .setMaxValue(50)
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName("target")
            .setDescription("Stock symbol (e.g. TSPP); leave empty or ALL for whole market")
            .setRequired(false)
        )
        .addStringOption((o) =>
          o
            .setName("id")
            .setDescription("Custom event id (alphanumeric/underscore); auto-generated from name if omitted")
            .setRequired(false)
        )
        .addBooleanOption((o) =>
          o
            .setName("fire-now")
            .setDescription("Also fire it once immediately after adding (default false)")
            .setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("[ADMIN] Remove a custom event from the event book")
        .addStringOption((o) =>
          o.setName("id").setDescription("Event id to remove").setRequired(true)
        )
    )
    .addSubcommand((sc) =>
      sc.setName("list").setDescription("[ADMIN] List all available events (static + custom)")
    )
    .toJSON(),

  userPermissions: [PermissionFlagsBits.Administrator],

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
      if (!client.stockMarketCollection || !client.stockEventsCollection) {
        return interaction.editReply("🔧 股市系統尚未就緒。");
      }

      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (sub === "fire") {
        const name = interaction.options.getString("name").trim();
        const pct = interaction.options.getNumber("change");
        const target = normalizeSymbol(interaction.options.getString("target"));
        const force = interaction.options.getBoolean("skip-cooldown") ?? true;

        if (pct === 0) return interaction.editReply("❌ 漲跌幅不能為 0。");
        const exists = await ensureSymbolExists(client, guildId, target);
        if (!exists) return interaction.editReply(`❌ 找不到股票代號 \`${target}\`。`);

        const effect = pct / 100;
        const def = {
          id: `adhoc_${Date.now().toString(36)}`,
          name,
          effect,
          stock: target,
          dir: effect >= 0 ? "up" : "dn",
        };
        const result = await fireEvent(client, guildId, def.id, {
          force,
          customDef: def,
          triggeredBy: interaction.user.id,
        });
        if (!result) {
          return interaction.editReply(
            "⚠️ 事件未產生任何價格變動（可能標的不存在或變動被地板價限制）。"
          );
        }
        const sign = effect >= 0 ? "+" : "";
        return interaction.editReply(
          `✅ 已觸發一次性事件 **${name}**｜目標 \`${target}\`｜${sign}${(effect * 100).toFixed(1)}%｜影響 ${result.changes.length} 支`
        );
      }

      if (sub === "fire-by-id") {
        const eventId = interaction.options.getString("id").trim();
        const force = interaction.options.getBoolean("skip-cooldown") ?? true;
        const result = await fireEvent(client, guildId, eventId, {
          force,
          triggeredBy: interaction.user.id,
        });
        if (!result) {
          return interaction.editReply(
            `⚠️ 觸發失敗：找不到 id \`${eventId}\`，或在冷卻中、或無價格變動。`
          );
        }
        const sign = result.def.effect >= 0 ? "+" : "";
        return interaction.editReply(
          `✅ 已觸發 **${result.def.name}** (\`${result.def.id}\`)｜${sign}${(result.def.effect * 100).toFixed(1)}%｜影響 ${result.changes.length} 支`
        );
      }

      if (sub === "add") {
        if (!client.stockEventDefsCollection) {
          return interaction.editReply("🔧 事件簿尚未就緒（StockEventDefs collection 不存在）。");
        }
        const name = interaction.options.getString("name").trim();
        const pct = interaction.options.getNumber("change");
        const target = normalizeSymbol(interaction.options.getString("target"));
        const rawId = interaction.options.getString("id");
        const fireNow = interaction.options.getBoolean("fire-now") ?? false;

        if (pct === 0) return interaction.editReply("❌ 漲跌幅不能為 0。");
        const exists = await ensureSymbolExists(client, guildId, target);
        if (!exists) return interaction.editReply(`❌ 找不到股票代號 \`${target}\`。`);

        const id = rawId
          ? String(rawId).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 64)
          : slugifyId(name);
        if (!id) return interaction.editReply("❌ id 格式無效。");

        // 不允許覆蓋 static 預設事件
        const staticHit = getStaticEventDefs().find((e) => e.id === id);
        if (staticHit) {
          return interaction.editReply(
            `❌ 該 id \`${id}\` 與預設事件衝突，請改用其他 id。`
          );
        }

        const effect = pct / 100;
        const doc = {
          guildId,
          id,
          name,
          effect,
          stock: target,
          dir: effect >= 0 ? "up" : "dn",
          enabled: true,
          createdAt: new Date(),
          createdBy: interaction.user.id,
        };
        try {
          await client.stockEventDefsCollection.updateOne(
            { guildId, id },
            { $set: doc },
            { upsert: true }
          );
        } catch (e) {
          return interaction.editReply(`❌ 寫入失敗：${e?.message || e}`);
        }

        let suffix = "";
        if (fireNow) {
          const result = await fireEvent(client, guildId, id, {
            force: true,
            triggeredBy: interaction.user.id,
          });
          suffix = result
            ? `\n• 已立即觸發，影響 ${result.changes.length} 支`
            : "\n• 立即觸發未產生變動";
        }
        const sign = effect >= 0 ? "+" : "";
        return interaction.editReply(
          `✅ 已加入事件簿：\n• id：\`${id}\`\n• 名稱：${name}\n• 目標：\`${target}\`\n• 幅度：${sign}${(effect * 100).toFixed(1)}%${suffix}`
        );
      }

      if (sub === "remove") {
        if (!client.stockEventDefsCollection) {
          return interaction.editReply("🔧 事件簿尚未就緒。");
        }
        const id = interaction.options.getString("id").trim();
        const res = await client.stockEventDefsCollection.deleteOne({ guildId, id });
        if (res.deletedCount === 0) {
          return interaction.editReply(`⚠️ 找不到自訂事件 \`${id}\`（預設事件無法移除）。`);
        }
        return interaction.editReply(`✅ 已移除自訂事件 \`${id}\``);
      }

      if (sub === "list") {
        const defs = await getMergedEventDefs(client, guildId);
        if (defs.length === 0) return interaction.editReply("（無）");
        const staticDefs = defs.filter((d) => d.source !== "dynamic");
        const dynamicDefs = defs.filter((d) => d.source === "dynamic");

        const fmt = (d) => {
          const sign = d.effect >= 0 ? "+" : "";
          return `\`${d.id}\` ${d.name}｜\`${d.stock}\`｜${sign}${(d.effect * 100).toFixed(1)}%`;
        };
        const container = new ContainerBuilder()
          .setAccentColor(0x3498db)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("# 📒 股市事件清單"),
          )
          .addSeparatorComponents(new SeparatorBuilder());
        if (staticDefs.length) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**預設事件（${staticDefs.length}）**\n${staticDefs.slice(0, 25).map(fmt).join("\n") || "（無）"}`,
            ),
          );
        }
        if (dynamicDefs.length) {
          container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**自訂事件（${dynamicDefs.length}）**\n${dynamicDefs.slice(0, 25).map(fmt).join("\n") || "（無）"}`,
            ),
          );
        }
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      return interaction.editReply("❌ 未知子指令。");
    } catch (error) {
      console.log(`[ERROR] /stock-event:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply(`🔧 指令失敗：${error?.message || error}`)
        .catch(() => {});
    }
  },
};
