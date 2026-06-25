// /dev — 開發者測試工具總入口,把 level / daily / slot 測試指令收攏到同一個指令底下。
//
// 結構:
//   /dev level givexp / levelupcard / reset
//   /dev daily preview / reset
//   /dev slot  spin    / preview
//
// 子指令邏輯與原本的 /leveltest /dailytest /slottest 完全一致;這個檔案只負責
// SlashCommandBuilder 與 dispatch,實作搬到下面的 run* function。

require("colors");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { DateTime } = require("luxon");

const { levelSystem } = require("../../config");
const grantXp = require("../../features/leveling/grantXp");
const generateCheckinCard = require("../../utils/generateCheckinCard");
const generateLevelUpCard = require("../../utils/generateLevelUpCard");
const { getLevelProgress } = require("../../utils/levelMath");
const { spin, evaluateLine } = require("../../features/casino/slot/slotMachine");
const { SYMBOL_BY_ID, PAYLINES } = require("../../features/casino/slot/paytable");
const generateSlotGif = require("../../utils/generateSlotGif");
const { rawFollowUpWithImage } = require("../../utils/rawWebhookUpload");
const { flush: flushCommandStats } = require("../../utils/commandUsageTracker");

const SLOT_PREVIEW_CHOICES = [
  { name: "JACKPOT (七七七)", value: "jackpot" },
  { name: "三連線 (三星)", value: "triple" },
  { name: "兩個櫻桃", value: "double_cherry" },
  { name: "兩個一樣", value: "double" },
  { name: "沒中", value: "none" },
];

module.exports = {
  devOnly: true,

  data: new SlashCommandBuilder()
    .setName("dev")
    .setDescription("[DEV ONLY] 開發者測試工具")
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((g) =>
      g
        .setName("level")
        .setDescription("等級系統測試工具")
        .addSubcommand((sub) =>
          sub
            .setName("givexp")
            .setDescription("給自己或他人加 XP(會觸發升級流程)")
            .addIntegerOption((opt) =>
              opt
                .setName("amount")
                .setDescription("要加的 XP")
                .setMinValue(1)
                .setMaxValue(100000)
                .setRequired(true)
            )
            .addUserOption((opt) =>
              opt
                .setName("user")
                .setDescription("不填預設給自己")
                .setRequired(false)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("levelupcard")
            .setDescription("純預覽升級卡(不寫 DB、不公告)")
            .addIntegerOption((opt) =>
              opt
                .setName("from")
                .setDescription("升級前等級")
                .setMinValue(0)
                .setMaxValue(998)
                .setRequired(true)
            )
            .addIntegerOption((opt) =>
              opt
                .setName("to")
                .setDescription("升級後等級")
                .setMinValue(1)
                .setMaxValue(999)
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("reset")
            .setDescription("把自己或他人的 XP / 等級歸零(保留簽到、徽章)")
            .addUserOption((opt) =>
              opt
                .setName("user")
                .setDescription("不填預設重置自己")
                .setRequired(false)
            )
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("daily")
        .setDescription("簽到卡測試工具")
        .addSubcommand((sub) =>
          sub
            .setName("preview")
            .setDescription("產生一張簽到卡(不寫 DB、不給 XP)")
            .addIntegerOption((opt) =>
              opt
                .setName("streak")
                .setDescription("模擬連勝天數(預設 1)")
                .setMinValue(1)
                .setMaxValue(365)
                .setRequired(false)
            )
            .addIntegerOption((opt) =>
              opt
                .setName("pastdays")
                .setDescription("模擬最近 30 天有幾天簽到過(預設 = 連勝天數)")
                .setMinValue(0)
                .setMaxValue(30)
                .setRequired(false)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("reset")
            .setDescription("刪掉今日簽到紀錄,讓你重新測試(XP 不會退還)")
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("slot")
        .setDescription("拉霸測試工具")
        .addSubcommand((sub) =>
          sub
            .setName("spin")
            .setDescription("跑一次抽獎,回傳純 JSON(不扣錢、不出圖)")
            .addIntegerOption((opt) =>
              opt
                .setName("bet")
                .setDescription("下注金額(僅用於計算 payout)")
                .setMinValue(1)
                .setMaxValue(10000)
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("preview")
            .setDescription("預覽指定狀態的圖卡(不寫 DB)")
            .addStringOption((opt) =>
              opt
                .setName("kind")
                .setDescription("狀態")
                .setRequired(true)
                .addChoices(...SLOT_PREVIEW_CHOICES)
            )
            .addIntegerOption((opt) =>
              opt
                .setName("bet")
                .setDescription("下注金額")
                .setMinValue(1)
                .setMaxValue(10000)
                .setRequired(false)
            )
        )
    )
    .addSubcommandGroup((g) =>
      g
        .setName("upload")
        .setDescription("圖卡上傳路徑診斷（discord.js vs raw undici）")
        .addSubcommand((sub) =>
          sub
            .setName("test")
            .setDescription("用同一張 PNG buffer 並排測試兩條上傳路徑")
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("cmdstats")
        .setDescription("查看 slash command 使用量排行（找出冷門指令）")
        .addStringOption((opt) =>
          opt
            .setName("order")
            .setDescription("排序方向（預設由少到多）")
            .setRequired(false)
            .addChoices(
              { name: "由少到多（找冷門）", value: "asc" },
              { name: "由多到少（找熱門）", value: "desc" }
            )
        )
        .addIntegerOption((opt) =>
          opt
            .setName("limit")
            .setDescription("顯示前幾名（預設 30）")
            .setMinValue(5)
            .setMaxValue(100)
            .setRequired(false)
        )
    )
    .toJSON(),

  run: async (client, interaction) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (!group && sub === "cmdstats") return runCmdStats(client, interaction);

    if (group === "level") {
      if (sub === "givexp") return runGrantXp(client, interaction);
      if (sub === "levelupcard") return runPreviewLevelUp(client, interaction);
      if (sub === "reset") return runLevelReset(client, interaction);
    }
    if (group === "daily") {
      if (sub === "preview") return runCheckinPreview(client, interaction);
      if (sub === "reset") return runCheckinReset(client, interaction);
    }
    if (group === "slot") {
      if (sub === "spin") return runSlotSpin(interaction);
      if (sub === "preview") return runSlotPreview(interaction);
    }
    if (group === "upload") {
      if (sub === "test") return runUploadTest(interaction);
    }
  },
};

async function runUploadTest(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const renderStart = Date.now();
    const buf = await generateLevelUpCard({
      username: interaction.member?.displayName || interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ extension: "png", size: 256 }),
      beforeLevel: 10,
      afterLevel: 11,
      totalXp: 9999,
    });
    const renderMs = Date.now() - renderStart;

    const sig = buf.subarray(0, 8).toString("hex");
    const tail = buf.subarray(-12).toString("hex");
    const isPng = sig === "89504e470d0a1a0a";

    const lines = [
      `🧪 上傳路徑診斷`,
      `渲染：${renderMs}ms`,
      `buffer：${buf.length} bytes, isBuffer=${Buffer.isBuffer(buf)}`,
      `PNG 開頭：${sig} ${isPng ? "✅" : "❌"}`,
      `結尾 12 bytes：${tail}`,
      ``,
    ];

    let aLine = "Path A (discord.js followUp): ";
    const aStart = Date.now();
    try {
      await interaction.followUp({
        content: "🅰️ discord.js path",
        files: [new AttachmentBuilder(buf, { name: "test-a.png" })],
        flags: MessageFlags.Ephemeral,
      });
      aLine += `✅ ${Date.now() - aStart}ms`;
    } catch (e) {
      aLine += `❌ ${Date.now() - aStart}ms — ${e?.code || ""} ${e?.message || e}`.trim();
    }
    lines.push(aLine);

    let bLine = "Path B (raw undici): ";
    try {
      const r = await rawFollowUpWithImage(interaction, {
        content: "🅱️ raw undici path",
        buffer: buf,
        filename: "test-b.png",
        ephemeral: true,
      });
      bLine +=
        r.status >= 200 && r.status < 300
          ? `✅ ${r.took}ms (HTTP ${r.status}, body=${r.bodySize}b)`
          : `❌ ${r.took}ms (HTTP ${r.status}, body=${r.bodySize}b)\n${r.text.slice(0, 300)}`;
    } catch (e) {
      bLine += `❌ ${e?.code || ""} ${e?.message || e}`.trim();
    }
    lines.push(bLine);

    await interaction.editReply(lines.join("\n"));
  } catch (error) {
    console.log(`[ERROR] /dev upload test:\n${error}\n${error.stack}`.red);
    await interaction
      .editReply(`🔧 上傳測試失敗：${error?.message || error}`)
      .catch(() => {});
  }
}

// ─────────────────────────── /dev level ───────────────────────────
async function runGrantXp(client, interaction) {
  await interaction.deferReply();
  try {
    const target = interaction.options.getUser("user") || interaction.user;
    const amount = interaction.options.getInteger("amount");
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);

    const result = await grantXp(client, {
      userId: target.id,
      guildId: interaction.guildId,
      username: target.username,
      avatarHash: target.avatar,
      amount,
      source: "admin",
      counterField: "xpFromAdmin",
      member,
      channel: interaction.channel,
    });

    if (!result) {
      return interaction.editReply("🔧 給 XP 失敗");
    }

    await interaction.editReply(
      `✅ 已給 ${target.username} **+${amount} XP**\n` +
        `Lv.${result.before} → **Lv.${result.after}**`
    );
  } catch (error) {
    console.log(`[ERROR] /dev level givexp:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 給 XP 失敗,看 console").catch(() => {});
  }
}

async function runPreviewLevelUp(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const beforeLevel = interaction.options.getInteger("from");
    const afterLevel = interaction.options.getInteger("to");

    if (afterLevel <= beforeLevel) {
      return interaction.editReply("升級後等級必須大於升級前");
    }

    const buf = await generateLevelUpCard({
      username: interaction.member?.displayName || interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ extension: "png", size: 256 }),
      beforeLevel,
      afterLevel,
      totalXp: 9999,
    });

    const attachment = new AttachmentBuilder(buf, { name: `levelup-preview.png` });

    const container = new ContainerBuilder()
      .setAccentColor(0xc9302c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## 🧪 升級卡預覽\nLv.${beforeLevel} → Lv.${afterLevel}`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder()
            .setURL(`attachment://levelup-preview.png`)
            .setDescription("Level up preview")
        )
      );

    await interaction.editReply({
      components: [container],
      files: [attachment],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.log(`[ERROR] /dev level levelupcard:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 預覽失敗,看 console").catch(() => {});
  }
}

async function runLevelReset(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const target = interaction.options.getUser("user") || interaction.user;

    const before = await client.userLevelsCollection.findOne({
      userId: target.id,
      guildId: interaction.guildId,
    });
    if (!before) {
      return interaction.editReply(`${target.username} 沒有等級資料`);
    }

    await client.userLevelsCollection.updateOne(
      { _id: before._id },
      {
        $set: {
          totalXp: 0,
          level: 0,
          xpFromMessage: 0,
          xpFromVoice: 0,
          xpFromDaily: 0,
          xpFromReaction: 0,
          xpFromAdmin: 0,
          totalMessages: 0,
          totalVoiceMinutes: 0,
          totalReactionsReceived: 0,
          updatedAt: new Date(),
        },
      }
    );

    await interaction.editReply(
      `🔄 已重置 ${target.username} 的 XP 與來源計數\n` +
        `Lv.${getLevelProgress(before.totalXp).level} → Lv.0\n` +
        `(簽到、徽章、稱號、streak 不動)`
    );
  } catch (error) {
    console.log(`[ERROR] /dev level reset:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 重置失敗,看 console").catch(() => {});
  }
}

// ─────────────────────────── /dev daily ───────────────────────────
async function runCheckinPreview(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const cfg = levelSystem.daily;
    const tz = cfg.resetTimezone || "Asia/Taipei";
    const today = DateTime.now().setZone(tz).toISODate();

    const streak = interaction.options.getInteger("streak") ?? 1;
    const checkedDaysOpt = interaction.options.getInteger("pastdays");
    const checkedDays = checkedDaysOpt ?? Math.min(streak, 30);

    let xp = cfg.baseXp;
    const bonusDays = Math.min(streak, cfg.streakBonusCapDays || 30);
    xp += bonusDays * (cfg.streakBonusPerDay || 0);
    let multiplier = 1;
    if (streak >= 30) multiplier = cfg.streak30Multiplier || 2.0;
    else if (streak >= 7) multiplier = cfg.streak7Multiplier || 1.5;
    xp = Math.floor(xp * multiplier);

    const checkinDates = new Set();
    for (let i = 0; i < checkedDays; i++) {
      const d = DateTime.now().setZone(tz).minus({ days: i }).toISODate();
      checkinDates.add(d);
    }
    checkinDates.add(today);

    const userDoc = await client.userLevelsCollection?.findOne({
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    const fakeAfterLevel = userDoc
      ? getLevelProgress(userDoc.totalXp + xp).level
      : 0;

    const buf = await generateCheckinCard({
      username: interaction.member?.displayName || interaction.user.username,
      avatarUrl: interaction.user.displayAvatarURL({ extension: "png", size: 256 }),
      streak,
      totalCheckins: (userDoc?.totalCheckins || 0) + 1,
      xpEarned: xp,
      multiplier,
      afterLevel: fakeAfterLevel,
      checkinDates,
      today,
      timezone: tz,
    });

    const fileName = `checkin-preview-${today}.png`;
    const attachment = new AttachmentBuilder(buf, { name: fileName });

    const container = new ContainerBuilder()
      .setAccentColor(0xc9302c)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## 🧪 簽到卡預覽(不寫 DB)\n` +
            `連勝 **${streak}** 天 ・ +${xp} XP` +
            (multiplier > 1 ? ` ・ 加成 x${multiplier}` : "") +
            ` ・ 模擬最近 ${checkedDays} 天有簽到`
        )
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder()
            .setURL(`attachment://${fileName}`)
            .setDescription("Check-in preview")
        )
      );

    await interaction.editReply({
      components: [container],
      files: [attachment],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.log(`[ERROR] /dev daily preview:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 預覽失敗,請看 console").catch(() => {});
  }
}

async function runCheckinReset(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!client.dailyCheckinCollection || !client.userLevelsCollection) {
      return interaction.editReply("🔧 等級系統尚未啟動");
    }

    const cfg = levelSystem.daily;
    const tz = cfg.resetTimezone || "Asia/Taipei";
    const today = DateTime.now().setZone(tz).toISODate();

    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    const todayDoc = await client.dailyCheckinCollection.findOne({
      userId,
      guildId,
      date: today,
    });
    if (!todayDoc) {
      return interaction.editReply(
        "今天沒有簽到紀錄,可以直接跑 `/每日簽到 簽到` 測試!"
      );
    }

    await client.dailyCheckinCollection.deleteOne({ _id: todayDoc._id });

    const userDoc = await client.userLevelsCollection.findOne({
      userId,
      guildId,
    });

    const recentDocs = await client.dailyCheckinCollection
      .find({ userId, guildId, date: { $lt: today } })
      .project({ date: 1 })
      .sort({ date: -1 })
      .limit(60)
      .toArray();

    const dateSet = new Set(recentDocs.map((d) => d.date));

    let newStreak = 0;
    let newLastDailyAt = null;

    if (recentDocs.length > 0) {
      newLastDailyAt = recentDocs[0].date;
      let cursor = DateTime.fromISO(newLastDailyAt, { zone: tz });
      while (dateSet.has(cursor.toISODate())) {
        newStreak += 1;
        cursor = cursor.minus({ days: 1 });
      }
    }

    const newTotalCheckins = Math.max(0, (userDoc?.totalCheckins || 0) - 1);

    await client.userLevelsCollection.updateOne(
      { userId, guildId },
      {
        $set: {
          lastDailyAt: newLastDailyAt,
          streak: newStreak,
          totalCheckins: newTotalCheckins,
          updatedAt: new Date(),
        },
      }
    );

    await interaction.editReply(
      `🔄 已重置今日簽到紀錄。\n` +
        `streak ${userDoc?.streak ?? 0} → ${newStreak}(從歷史紀錄反推)\n` +
        `lastDailyAt → ${newLastDailyAt ?? "null"}\n` +
        `totalCheckins ${userDoc?.totalCheckins ?? 0} → ${newTotalCheckins}\n` +
        `XP **不會**退還(${todayDoc.reward?.xp ?? 0} XP 仍記在帳上)。\n` +
        `現在可以重跑 \`/每日簽到 簽到\`。`
    );
  } catch (error) {
    console.log(`[ERROR] /dev daily reset:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 重置失敗,請看 console").catch(() => {});
  }
}

// ─────────────────────────── /dev slot ───────────────────────────
async function runSlotSpin(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const bet = interaction.options.getInteger("bet");
    const result = spin({ bet });
    const json = JSON.stringify(result, null, 2);
    await interaction.editReply(`\`\`\`json\n${json}\n\`\`\``);
  } catch (error) {
    console.log(`[ERROR] /dev slot spin:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 spin 失敗,看 console").catch(() => {});
  }
}

// 給 /dev slot preview 用：產一個指定中獎類型的 3x3 grid，
// 並用真正的 evaluateLine 套到 5 條 payline 上算出各線結果。
function buildSlotPreviewGrid(kind) {
  const sym = (id) => ({ id, emoji: SYMBOL_BY_ID[id].emoji });
  // 預設背景：每格都不同，確保不會誤觸其他線
  const base = [
    [sym("lemon"), sym("watermelon"), sym("bell")],
    [sym("bell"), sym("star"), sym("cherry")],
    [sym("watermelon"), sym("cherry"), sym("lemon")],
  ];

  // 把中排（row=1）改成指定情境
  switch (kind) {
    case "jackpot":
      base[1] = [sym("seven"), sym("seven"), sym("seven")];
      break;
    case "triple":
      base[1] = [sym("star"), sym("star"), sym("star")];
      break;
    case "double_cherry":
      base[1] = [sym("cherry"), sym("cherry"), sym("lemon")];
      break;
    case "double":
      base[1] = [sym("bell"), sym("watermelon"), sym("bell")];
      break;
    default:
      // 不動：所有線都 none
      break;
  }
  return base;
}

function buildSlotPreviewResult(kind, bet) {
  const grid = buildSlotPreviewGrid(kind);
  const lineCount = PAYLINES.length;
  const perLineBet = Math.max(1, Math.floor(bet / lineCount));

  const lines = PAYLINES.map((pl, idx) => {
    const cellSymbols = pl.cells.map(([r, c]) => grid[r][c]);
    const ev = evaluateLine(cellSymbols);
    return {
      index: idx,
      id: pl.id,
      name: pl.name,
      cells: pl.cells,
      cellSymbols,
      matchType: ev.matchType,
      multiplier: ev.multiplier,
      matchedSymbol: ev.matchedSymbol,
      payout: ev.multiplier > 0 ? Math.floor(perLineBet * ev.multiplier) : 0,
    };
  });

  const TIER = { none: 0, double: 1, double_cherry: 2, triple: 3, jackpot: 4 };
  const totalPayout = lines.reduce((s, l) => s + l.payout, 0);
  const bestLine = lines.reduce(
    (best, cur) => (TIER[cur.matchType] > TIER[best?.matchType ?? "none"] ? cur : best),
    null
  );
  const matchType = bestLine?.matchType ?? "none";
  const aggMult = bet > 0 ? Math.round((totalPayout / bet) * 100) / 100 : 0;

  return {
    grid,
    lines,
    matchType,
    matchedSymbol: bestLine?.matchedSymbol ?? null,
    multiplier: aggMult,
    payout: totalPayout,
  };
}

// ─────────────────────────── /dev cmdstats ───────────────────────────
async function runCmdStats(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!client.commandStatsCollection) {
      return interaction.editReply("🔧 commandStats collection 尚未初始化");
    }

    const order = interaction.options.getString("order") || "asc";
    const limit = interaction.options.getInteger("limit") || 30;

    // 先 flush 一次記憶體計數，讓查詢看到最新數字
    await flushCommandStats(client).catch(() => {});

    const docs = await client.commandStatsCollection
      .find({})
      .sort({ count: order === "desc" ? -1 : 1, name: 1 })
      .limit(limit)
      .toArray();

    if (docs.length === 0) {
      return interaction.editReply(
        "目前還沒有任何指令使用紀錄（每 10 分鐘 flush 一次，可能要等下一輪）"
      );
    }

    const totalDoc = await client.commandStatsCollection
      .aggregate([
        { $group: { _id: null, total: { $sum: "$count" }, cmds: { $sum: 1 } } },
      ])
      .toArray();
    const total = totalDoc[0]?.total ?? 0;
    const cmds = totalDoc[0]?.cmds ?? 0;

    const lines = docs.map((d, i) => {
      const last = d.lastUsedAt
        ? new Date(d.lastUsedAt).toISOString().slice(0, 16).replace("T", " ")
        : "—";
      const rank = String(i + 1).padStart(2, " ");
      const name = `/${d.name}`.padEnd(22, " ");
      const count = String(d.count).padStart(6, " ");
      return `${rank}. ${name} ${count} 次   (最後使用 ${last})`;
    });

    const header =
      `📊 指令使用量（${order === "desc" ? "由多到少" : "由少到多"}，前 ${docs.length} 名）\n` +
      `總計 ${cmds} 個指令、累計 ${total.toLocaleString()} 次呼叫\n`;

    await interaction.editReply(
      `${header}\`\`\`\n${lines.join("\n")}\n\`\`\``
    );
  } catch (error) {
    console.log(`[ERROR] /dev cmdstats:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 查詢失敗，看 console").catch(() => {});
  }
}

async function runSlotPreview(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const kind = interaction.options.getString("kind");
    const bet = interaction.options.getInteger("bet") ?? 100;
    const preview = buildSlotPreviewResult(kind, bet);

    const buf = await generateSlotGif({
      userId: interaction.user.id,
      username: interaction.member?.displayName || interaction.user.username,
      grid: preview.grid,
      lines: preview.lines,
      matchType: preview.matchType,
      matchedSymbol: preview.matchedSymbol,
      bet,
      payout: preview.payout,
      multiplier: preview.multiplier,
      balance: 9999,
    });

    const attachment = new AttachmentBuilder(buf, {
      name: `slot-preview-${kind}.gif`,
    });

    await interaction.editReply({
      content: `🧪 預覽 \`${kind}\`(bet=${bet}, payout=${preview.payout})`,
      files: [attachment],
    });
  } catch (error) {
    console.log(`[ERROR] /dev slot preview:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 preview 失敗,看 console").catch(() => {});
  }
}
