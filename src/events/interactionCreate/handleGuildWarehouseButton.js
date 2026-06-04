// 公會倉庫按鈕處理器
//
// customId 格式（prefix `gcw_`）：
//   gcw_take_<userId>_<itemId>_<qty>   — 取礦快捷按鈕
//   gcw_refresh_<userId>               — 重整倉庫畫面
//   gcw_log_<userId>                   — 開倉庫紀錄（會長 / 副會長）
//   gcw_settings_<userId>              — 開倉庫設定 modal（會長 / 副會長）
//   gcw_help_<userId>                  — 顯示存礦說明

require("colors");
const { MessageFlags } = require("discord.js");

const guildClubService = require("../../features/guild_club/guildClubService");
const warehouseService = require("../../features/guild_club/warehouse/warehouseService");
const warehouseView = require("../../features/guild_club/warehouse/warehouseView");
const warehouseEligibility = require("../../features/guild_club/warehouse/warehouseEligibility");
const warehouseSettings = require("../../features/guild_club/warehouse/warehouseSettings");

module.exports = async (client, interaction) => {
  const id = interaction.customId || "";
  if (!id.startsWith("gcw_")) return;
  if (!interaction.isButton()) return;

  if (id.startsWith("gcw_take_")) return handleTake(client, interaction);
  if (id.startsWith("gcw_refresh_")) return handleRefresh(client, interaction);
  if (id.startsWith("gcw_log_")) return handleLog(client, interaction);
  if (id.startsWith("gcw_help_")) return handleHelp(client, interaction);
  if (id.startsWith("gcw_settings_")) return handleSettingsStub(client, interaction);
};

function parseOwner(prefix, customId) {
  const rest = customId.slice(prefix.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx < 0) return { ownerId: rest, payload: "" };
  return { ownerId: rest.slice(0, sepIdx), payload: rest.slice(sepIdx + 1) };
}

async function denyNotOwner(interaction, label) {
  return interaction.reply({
    content: `🚫 這不是你的${label}！`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTake(client, interaction) {
  const { ownerId, payload } = parseOwner("gcw_take_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "取礦按鈕");
  const parts = payload.split("_");
  if (parts.length < 2)
    return interaction.reply({ content: "❌ 按鈕格式錯誤", flags: MessageFlags.Ephemeral });
  const qty = parseInt(parts[parts.length - 1], 10);
  const itemId = parts.slice(0, -1).join("_");
  if (!Number.isInteger(qty) || qty <= 0)
    return interaction.reply({ content: "❌ 數量錯誤", flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const result = await warehouseService.withdraw(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      itemId,
      qty,
    });

    if (!result.ok) {
      return interaction.editReply({
        components: [withdrawButtonErrorView(result, itemId)],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    return interaction.editReply({
      components: [
        warehouseView.buildWithdrawSuccessContainer({
          userId: interaction.user.id,
          club: result.club,
          itemDefArg: result.item,
          withdrawn: result.withdrawn,
          fee: result.fee,
          newTotal: result.new_total,
          dailyRemaining: result.daily_remaining,
          dailyMax: result.daily_max,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(`[GUILD_WAREHOUSE] take button 失敗：${e.stack || e.message}`.red);
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "❌ 操作失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
}

async function handleRefresh(client, interaction) {
  const { ownerId } = parseOwner("gcw_refresh_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "倉庫畫面");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership) {
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🏰 你還沒加入公會",
          body: "倉庫是公會專屬功能。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club)
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({ title: "❌ 公會資料異常", body: "公會已不存在。" }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

  const inventory = await warehouseService.getInventory(client, club.guild_club_id);
  const daily = await warehouseEligibility.getDailyDoc(
    client,
    interaction.user.id,
    interaction.guildId
  );
  return interaction.editReply({
    components: [
      warehouseView.buildWarehouseContainer({
        viewerId: interaction.user.id,
        club,
        inventory,
        isManager: guildClubService.isManager(membership.role),
        todayItemsTaken: daily?.items_taken || [],
        todayTimesUsed: daily?.times_used || 0,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleLog(client, interaction) {
  const { ownerId } = parseOwner("gcw_log_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "倉庫紀錄按鈕");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership || !guildClubService.isManager(membership.role)) {
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🚫 僅會長 / 副會長可看紀錄",
          body: "請會長或副會長使用。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club)
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({ title: "❌ 公會資料異常", body: "公會已不存在。" }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const entries = await client.guildClubWarehouseLogsCollection
    .find({ guild_club_id: club.guild_club_id, created_at: { $gte: since } })
    .sort({ created_at: -1 })
    .limit(100)
    .toArray();

  return interaction.editReply({
    components: [
      warehouseView.buildLogContainer({
        club,
        entries,
        isVice: membership.role === "vice_leader",
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleHelp(client, interaction) {
  const { ownerId } = parseOwner("gcw_help_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "說明按鈕");

  return interaction.reply({
    components: [
      warehouseView.buildErrorContainer({
        title: "📦 怎麼用公會倉庫",
        body:
          "存礦：`/公會 存礦 物品:鐵礦 數量:30`\n" +
          "取礦：`/公會 取礦 物品:鐵礦 數量:5`（或直接點上方按鈕）\n" +
          "・存入後 1 小時保護期，全員都不能領\n" +
          "・取礦每日 2 次，同種類一天限領一次\n" +
          "・手續費 = 市價 × 10%（最低 20 幣），費用進公會金庫",
        hint: "存礦不可收回，等同捐贈。",
      }),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function handleSettingsStub(client, interaction) {
  const { ownerId } = parseOwner("gcw_settings_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "設定按鈕");
  return interaction.reply({
    components: [
      warehouseView.buildErrorContainer({
        title: "🛠️ 倉庫設定即將開放",
        body: "可微調項目：每日次數、手續費率、入會時間門檻、最低貢獻。",
        hint: "M2 階段釋出 modal 編輯介面。",
      }),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

function withdrawButtonErrorView(result, itemId) {
  const name = warehouseSettings.itemDef(itemId)?.name || itemId;
  const { reason } = result;
  if (reason === "tenure_not_enough")
    return warehouseView.buildErrorContainer({
      title: "🔒 入會時間不足",
      body: `需 ${result.needHours} 小時，目前 ${result.haveHours} 小時。`,
      hint: `<t:${Math.floor(result.readyAt / 1000)}:R> 後可使用。`,
    });
  if (reason === "contribution_not_enough")
    return warehouseView.buildErrorContainer({
      title: "🔒 公會貢獻不足",
      body: `需 ${result.need}，目前 ${result.have}（差 ${result.need - result.have}）。`,
      hint: "可用 /公會 捐款 或 /公會 存礦 補貢獻。",
    });
  if (reason === "daily_limit_reached")
    return warehouseView.buildErrorContainer({
      title: "🧊 今日次數用完",
      body: `已取 ${result.used}/${result.max} 次。`,
    });
  if (reason === "item_already_taken_today")
    return warehouseView.buildErrorContainer({
      title: "🧊 今天已領過此項",
      body: `${name} 一天限領一次。`,
    });
  if (reason === "self_deposit_24h_lock")
    return warehouseView.buildErrorContainer({
      title: "🧊 24h 內存過此項",
      body: `你最近存了 ${result.qty} 個 ${name}，自存自領鎖至 <t:${Math.floor(result.unlock_at / 1000)}:R>。`,
    });
  if (reason === "qty_over_available")
    return warehouseView.buildErrorContainer({
      title: "❌ 倉庫可取量不足",
      body: `${name} 可取 ${result.available}（總 ${result.total}）。`,
    });
  if (reason === "warehouse_empty")
    return warehouseView.buildErrorContainer({
      title: "📦 倉庫暫時沒有此項",
      body: `${name} 目前可取 0。`,
    });
  if (reason === "insufficient_funds_for_fee")
    return warehouseView.buildErrorContainer({
      title: "❌ 手續費不足",
      body: `需 ${result.need} 幣，有 ${result.have} 幣。`,
    });
  if (reason === "race_lost")
    return warehouseView.buildErrorContainer({
      title: "❌ 已被搶先領取",
      body: "別的會員剛剛領走了。",
    });
  if (reason === "club_level_locked")
    return warehouseView.buildErrorContainer({
      title: "🔒 公會倉庫尚未解鎖",
      body: `倉庫於 Lv.${result.need} 解鎖。\n目前：Lv.${result.have}`,
    });
  return warehouseView.buildErrorContainer({
    title: "❌ 取礦失敗",
    body: `原因：${reason}`,
  });
}
