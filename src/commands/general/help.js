require("colors");

const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require("discord.js");

const HOME_COLOR = 0x00ae86;
const CATEGORY_COLOR = 0x5865f2;
const COMMAND_COLOR = 0xfaa61a;
const TIMEOUT_MS = 3 * 60 * 1000;
const COMMANDS_ROOT = path.join(__dirname, "..");

// 想顯示「隱私權聲明 / 服務條款」連結時，把網址填進來即可（null = 不顯示）
const PRIVACY_URL = null;
const TERMS_URL = null;
const WEBSITE_URL = "https://bibi.shushu.tw/";

// 少數幾個「大分類」。每個分類聚合多個原始指令資料夾（folders）。
// 管理員 / 開發者指令會自動歸到 admin 分類，不受 folders 影響。
const GROUPS = {
  utility: {
    label: "實用工具",
    emoji: "🛠️",
    order: 1,
    blurb: "天氣、匯率、美食、抽籤、推薦、問是非、情勒文",
    folders: ["weather", "currency", "food", "draw", "ask", "recommendation", "post", "general"],
  },
  economy: {
    label: "經濟系統",
    emoji: "💰",
    order: 2,
    blurb: "錢包、轉帳、定期存款、每日任務、商店、背包",
    folders: ["economy", "shop"],
  },
  casino: {
    label: "賭場",
    emoji: "🎰",
    order: 3,
    blurb: "拉霸、21點、HI-LO、樂透、賽馬等賭博遊戲，盈虧自負",
    folders: ["casino"],
  },
  stock: {
    label: "股市",
    emoji: "📈",
    order: 4,
    blurb: "報價、買賣、持股、配息、歷史走勢（手續費 1%）",
    folders: ["stock"],
  },
  level: {
    label: "等級與統計",
    emoji: "🏅",
    order: 5,
    blurb: "個人檔案、稱號、等級卡、徽章、簽到、排行榜、訊息/語音統計",
    folders: ["profile", "level", "leaderboard", "stats"],
  },
  community: {
    label: "社群互動",
    emoji: "🎉",
    order: 6,
    blurb: "活動、預測問答、遊戲身份組、票務投票",
    folders: ["event", "quiz", "roles", "ticket"],
  },
  admin: {
    label: "管理 / 開發者",
    emoji: "🔧",
    order: 7,
    blurb: "僅限管理員與開發者使用的工具",
    folders: [],
  },
};

const FALLBACK_GROUP = "utility";

const FOLDER_TO_GROUP = (() => {
  const map = {};
  for (const [key, meta] of Object.entries(GROUPS)) {
    for (const folder of meta.folders) map[folder] = key;
  }
  return map;
})();

const OPTION_TYPE_LABEL = {
  [ApplicationCommandOptionType.Subcommand]: "子指令",
  [ApplicationCommandOptionType.SubcommandGroup]: "子指令群組",
  [ApplicationCommandOptionType.String]: "文字",
  [ApplicationCommandOptionType.Integer]: "整數",
  [ApplicationCommandOptionType.Boolean]: "是/否",
  [ApplicationCommandOptionType.User]: "用戶",
  [ApplicationCommandOptionType.Channel]: "頻道",
  [ApplicationCommandOptionType.Role]: "身份組",
  [ApplicationCommandOptionType.Mentionable]: "可提及對象",
  [ApplicationCommandOptionType.Number]: "數字",
  [ApplicationCommandOptionType.Attachment]: "附件",
};

let cachedIndex = null;

function isAdminOnly(cmd) {
  const adminBit = PermissionFlagsBits.Administrator;
  if (cmd.defaultMemberPermissions != null) {
    try {
      const bits = BigInt(cmd.defaultMemberPermissions);
      if ((bits & adminBit) === adminBit) return true;
    } catch {
      /* noop */
    }
  }
  return cmd.userPermissions.some(
    (p) => p === "Administrator" || p === adminBit,
  );
}

function groupForCommand(cmd) {
  if (cmd.devOnly || isAdminOnly(cmd)) return "admin";
  return FOLDER_TO_GROUP[cmd.folder] || FALLBACK_GROUP;
}

function loadCommandIndex() {
  if (cachedIndex) return cachedIndex;

  const folders = fs
    .readdirSync(COMMANDS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const commands = [];
  for (const folder of folders) {
    const dirPath = path.join(COMMANDS_ROOT, folder);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      try {
        const mod = require(path.join(dirPath, file));
        if (!mod || !mod.data || !mod.data.name) continue;
        if (mod.deleted) continue;
        if (mod.data.name === "help") continue;

        const cmd = {
          name: mod.data.name,
          description: mod.data.description || "（無描述）",
          options: Array.isArray(mod.data.options) ? mod.data.options : [],
          defaultMemberPermissions: mod.data.default_member_permissions,
          userPermissions: mod.userPermissions || [],
          devOnly: !!mod.devOnly,
          folder,
        };
        cmd.category = groupForCommand(cmd);
        commands.push(cmd);
      } catch (err) {
        console.log(
          `[WARN] /help 無法載入 ${folder}/${file}: ${err.message}`.yellow,
        );
      }
    }
  }

  commands.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

  const byCategory = new Map();
  for (const cmd of commands) {
    if (!byCategory.has(cmd.category)) byCategory.set(cmd.category, []);
    byCategory.get(cmd.category).push(cmd);
  }

  cachedIndex = { commands, byCategory };
  return cachedIndex;
}

function sortedCategories() {
  const { byCategory } = loadCommandIndex();
  return [...byCategory.entries()]
    .filter(([, cmds]) => cmds.length > 0)
    .sort(([a], [b]) => (GROUPS[a]?.order ?? 99) - (GROUPS[b]?.order ?? 99));
}

function formatOptionLine(option, indent = "") {
  const typeLabel = OPTION_TYPE_LABEL[option.type] || "參數";
  const required = option.required ? "必填" : "可選";
  const desc = option.description || "";
  return `${indent}• \`${option.name}\` (${required}, ${typeLabel}) — ${desc}`;
}

function formatSubcommandBlock(sub) {
  const lines = [`▸ \`${sub.name}\` — ${sub.description || ""}`];
  for (const opt of sub.options || []) {
    lines.push(formatOptionLine(opt, "　"));
  }
  return lines.join("\n");
}

function buildCommandText(cmd) {
  const opts = cmd.options || [];
  const subs = opts.filter(
    (o) => o.type === ApplicationCommandOptionType.Subcommand,
  );
  const flat = opts.filter(
    (o) =>
      o.type !== ApplicationCommandOptionType.Subcommand &&
      o.type !== ApplicationCommandOptionType.SubcommandGroup,
  );

  const lock = isAdminOnly(cmd) ? " 🔒" : "";
  const lines = [`### \`/${cmd.name}\`${lock}`, cmd.description];

  if (flat.length) {
    lines.push("");
    lines.push(...flat.map((o) => formatOptionLine(o)));
  }
  if (subs.length) {
    if (flat.length) lines.push("");
    lines.push(...subs.map(formatSubcommandBlock));
  }

  return lines.join("\n");
}

// V2 TextDisplay 上限 ~4000 字，把多筆指令分段塞，避免單塊爆長
function chunkCommandTexts(texts, limit = 3500) {
  const chunks = [];
  let current = "";
  for (const text of texts) {
    if (current && current.length + text.length + 2 > limit) {
      chunks.push(current);
      current = text;
    } else {
      current = current ? `${current}\n\n${text}` : text;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildCategorySelect(currentCategory, disabled = false) {
  const categories = sortedCategories();
  const options = categories.slice(0, 25).map(([key, cmds]) => {
    const meta = GROUPS[key] || { label: key, emoji: "📁", blurb: "" };
    return {
      label: `${meta.label} (${cmds.length})`,
      description: meta.blurb ? meta.blurb.slice(0, 100) : undefined,
      value: key,
      emoji: meta.emoji,
      default: key === currentCategory,
    };
  });
  return new StringSelectMenuBuilder()
    .setCustomId("help_category")
    .setPlaceholder("📖 指令教學 — 選擇一個分類...")
    .setDisabled(disabled)
    .addOptions(options);
}

function buildHomeButton({ disabled }) {
  return new ButtonBuilder()
    .setCustomId("help_home")
    .setLabel("回首頁")
    .setEmoji("🏠")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

function appendControls(container, { currentCategory, disabled }) {
  container
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        buildCategorySelect(currentCategory, disabled),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        buildHomeButton({ disabled: disabled || currentCategory == null }),
      ),
    );
}

function buildFooterText(extra) {
  const lines = ["-# 🔒 標記 = 僅限管理員 / 開發者使用"];
  const links = [];
  if (PRIVACY_URL) links.push(`[隱私權聲明](${PRIVACY_URL})`);
  if (TERMS_URL) links.push(`[服務條款](${TERMS_URL})`);
  if (links.length) lines.push(`-# 使用本服務即表示你同意 ${links.join(" 及 ")}`);
  if (extra) lines.push(`-# ${extra}`);
  return lines.join("\n");
}

function buildHomeContainer({ controlsDisabled = false } = {}) {
  const categories = sortedCategories();
  const total = categories.reduce((n, [, arr]) => n + arr.length, 0);

  const container = new ContainerBuilder()
    .setAccentColor(HOME_COLOR)
    // 介紹區塊：機器人自我介紹
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📖 逼逼機器人 指令教學\n` +
          `嗨嗨 d(˙∀˙)b 我是 **逼逼機器人** 🤖\n` +
          `我的目標是讓你的伺服器更好玩、更好管理！\n\n` +
          `📂 共 **${total}** 個指令、分成 **${categories.length}** 大類\n` +
          `👇 從下方選單挑一個分類來看\n` +
          `🔎 或用 \`/help 指令:<名稱>\` 直接查單一指令\n` +
          `🌐 官方網站：${WEBSITE_URL}`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
    );

  const categoryLines = categories.map(([key, cmds]) => {
    const meta = GROUPS[key] || { label: key, emoji: "📁", blurb: "" };
    return `${meta.emoji} **${meta.label}** ・ ${cmds.length} 個指令\n-# ${meta.blurb || ""}`;
  });

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(categoryLines.join("\n\n")),
  );

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        buildFooterText(
          controlsDisabled ? "互動已逾時，請重新執行 /help" : null,
        ),
      ),
    );

  appendControls(container, {
    currentCategory: null,
    disabled: controlsDisabled,
  });

  return container;
}

function buildCategoryContainer(categoryKey, { controlsDisabled = false } = {}) {
  const { byCategory } = loadCommandIndex();
  const cmds = byCategory.get(categoryKey) || [];
  const meta = GROUPS[categoryKey] || {
    label: categoryKey,
    emoji: "📁",
    blurb: "",
  };

  const container = new ContainerBuilder()
    .setAccentColor(CATEGORY_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${meta.emoji} ${meta.label}\n${meta.blurb || `共 ${cmds.length} 個指令`}`,
      ),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
    );

  if (cmds.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("（此分類目前沒有可用指令）"),
    );
  } else {
    const cmdTexts = cmds.map(buildCommandText);
    const chunks = chunkCommandTexts(cmdTexts);
    chunks.forEach((chunk, idx) => {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(chunk),
      );
      if (idx < chunks.length - 1) {
        container.addSeparatorComponents(new SeparatorBuilder());
      }
    });
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        controlsDisabled
          ? `-# ${cmds.length} 個指令 ・ 互動已逾時，請重新執行 /help`
          : `-# ${cmds.length} 個指令・選單可切換其他分類`,
      ),
    );

  appendControls(container, {
    currentCategory: categoryKey,
    disabled: controlsDisabled,
  });

  return container;
}

function buildCommandContainer(cmd) {
  const meta = GROUPS[cmd.category] || {
    label: cmd.category,
    emoji: "📁",
  };
  const lock = isAdminOnly(cmd) ? "  🔒" : "";

  const container = new ContainerBuilder()
    .setAccentColor(COMMAND_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# /${cmd.name}${lock}\n${cmd.description || ""}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 分類：${meta.emoji} ${meta.label}`,
      ),
    );

  const opts = cmd.options || [];
  const subs = opts.filter(
    (o) => o.type === ApplicationCommandOptionType.Subcommand,
  );
  const flat = opts.filter(
    (o) =>
      o.type !== ApplicationCommandOptionType.Subcommand &&
      o.type !== ApplicationCommandOptionType.SubcommandGroup,
  );

  if (flat.length || subs.length) {
    container.addSeparatorComponents(new SeparatorBuilder());
  }

  if (flat.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**參數**\n${flat.map((o) => formatOptionLine(o)).join("\n")}`,
      ),
    );
  }

  if (subs.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**子指令**\n${subs.map(formatSubcommandBlock).join("\n\n")}`,
      ),
    );
  }

  if (isAdminOnly(cmd)) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("-# 🔒 僅限管理員 / 開發者使用"),
    );
  }

  return container;
}

function normalizeQuery(query) {
  return (query || "").trim().replace(/^\//, "").toLowerCase();
}

function findCommand(query) {
  const { commands } = loadCommandIndex();
  const normalized = normalizeQuery(query);
  if (!normalized) return null;

  // 「food draw」之類的子指令查詢：取第一段當父指令名
  const head = normalized.split(/\s+/)[0];

  return (
    commands.find((c) => c.name.toLowerCase() === normalized) ||
    commands.find((c) => c.name.toLowerCase() === head) ||
    commands.find((c) => c.name.toLowerCase().includes(normalized)) ||
    null
  );
}

function buildAutocompleteEntries() {
  const { commands } = loadCommandIndex();
  const entries = [];
  for (const cmd of commands) {
    entries.push({ label: `/${cmd.name}`, value: cmd.name });
    const opts = cmd.options || [];
    for (const opt of opts) {
      if (opt.type === ApplicationCommandOptionType.Subcommand) {
        entries.push({
          label: `/${cmd.name} ${opt.name}`,
          value: `${cmd.name} ${opt.name}`,
        });
      } else if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
        for (const inner of opt.options || []) {
          if (inner.type === ApplicationCommandOptionType.Subcommand) {
            entries.push({
              label: `/${cmd.name} ${opt.name} ${inner.name}`,
              value: `${cmd.name} ${opt.name} ${inner.name}`,
            });
          }
        }
      }
    }
  }
  return entries;
}

// 找不到指令時：依名稱與描述比對打分排序，比 charAt(0) 過濾準確很多
function suggestCommands(query, limit = 5) {
  const { commands } = loadCommandIndex();
  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const scored = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    const desc = (cmd.description || "").toLowerCase();
    let score = 0;
    if (name === normalized) score += 100;
    else if (name.startsWith(normalized)) score += 60;
    else if (name.includes(normalized)) score += 40;
    if (desc.includes(normalized)) score += 15;
    // 字元重疊度（短查詢時當作 fallback）
    if (score === 0) {
      const overlap = [...new Set(normalized)].filter((ch) => name.includes(ch)).length;
      if (overlap > 0) score = overlap;
    }
    if (score > 0) scored.push({ cmd, score });
  }

  scored.sort((a, b) => b.score - a.score || a.cmd.name.length - b.cmd.name.length);
  return scored.slice(0, limit).map((s) => s.cmd);
}

const REPLY_FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("📚 查看逼逼機器人使用手冊")
    .addStringOption((opt) =>
      opt
        .setName("指令")
        .setDescription("直接跳到特定指令的說明（例如：food draw）")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  autocomplete: async (client, interaction) => {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused.name !== "指令") return interaction.respond([]);

      const q = (focused.value || "").trim().toLowerCase();
      const entries = buildAutocompleteEntries();
      const filtered = entries.filter((e) =>
        !q ||
        e.value.toLowerCase().includes(q) ||
        e.label.toLowerCase().includes(q),
      );

      // 偏好完全前綴匹配
      filtered.sort((a, b) => {
        const av = a.value.toLowerCase();
        const bv = b.value.toLowerCase();
        const aStarts = av.startsWith(q) ? 0 : 1;
        const bStarts = bv.startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return av.length - bv.length;
      });

      await interaction.respond(
        filtered.slice(0, 25).map((e) => ({ name: e.label, value: e.value })),
      );
    } catch (error) {
      console.log(`[ERROR] /help autocomplete: ${error}`.red);
      try {
        await interaction.respond([]);
      } catch {}
    }
  },

  run: async (client, interaction) => {
    try {
      const targetName = interaction.options.getString("指令");

      if (targetName) {
        const cmd = findCommand(targetName);
        if (!cmd) {
          const suggestions = suggestCommands(targetName);
          const hint = suggestions
            .map((c) => {
              const meta = GROUPS[c.category];
              const emoji = meta?.emoji ? `${meta.emoji} ` : "";
              return `${emoji}\`/${c.name}\``;
            })
            .join("、");
          return interaction.reply({
            content:
              `❌ 找不到指令 \`/${targetName}\`。\n` +
              (hint
                ? `你是不是要找：${hint}？`
                : "使用 `/help` 看完整指令清單。"),
            flags: MessageFlags.Ephemeral,
          });
        }
        return interaction.reply({
          components: [buildCommandContainer(cmd)],
          flags: REPLY_FLAGS,
        });
      }

      // 瀏覽模式
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let currentCategory = null;
      const message = await interaction.editReply({
        components: [buildHomeContainer()],
        flags: REPLY_FLAGS,
      });

      const collector = message.createMessageComponentCollector({
        time: TIMEOUT_MS,
      });

      collector.on("collect", async (i) => {
        if (i.user.id !== interaction.user.id) {
          return i.reply({
            content: "🚫 只有發起者能操作這個選單！",
            flags: MessageFlags.Ephemeral,
          });
        }

        try {
          await i.deferUpdate();

          if (i.customId === "help_home") {
            currentCategory = null;
            await interaction.editReply({
              components: [buildHomeContainer()],
              flags: REPLY_FLAGS,
            });
          } else if (
            i.customId === "help_category" &&
            i.isStringSelectMenu()
          ) {
            currentCategory = i.values[0];
            await interaction.editReply({
              components: [buildCategoryContainer(currentCategory)],
              flags: REPLY_FLAGS,
            });
          }

          collector.resetTimer();
        } catch (err) {
          console.log(`[ERROR] /help 互動處理失敗：${err}`.red);
        }
      });

      collector.on("end", async () => {
        try {
          // 逾時：用同樣版面但停用控制元件，提示重新呼叫 /help
          const finalContainer =
            currentCategory == null
              ? buildHomeContainer({ controlsDisabled: true })
              : buildCategoryContainer(currentCategory, {
                  controlsDisabled: true,
                });
          await interaction.editReply({
            components: [finalContainer],
            flags: REPLY_FLAGS,
          });
        } catch {
          /* 訊息可能已被刪除，忽略 */
        }
      });
    } catch (error) {
      console.log(
        `[ERROR] /help 指令出錯：\n${error}\n${error.stack}`.red,
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ 載入幫助手冊時發生錯誤，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};
