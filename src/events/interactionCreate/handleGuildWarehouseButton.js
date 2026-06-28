// 公會倉庫按鈕處理器
//
// customId 格式（prefix `gcw_`）：
//   gcw_takeopen_<userId>_<itemId>_<maxTake>  — 點按鈕後跳 Modal 問數量
//   gcw_takedo_<userId>_<itemId>              — Modal 送出（實際領取）
//   gcw_refresh_<userId>[_<view>]             — 重整倉庫畫面（保留當前 view）
//   gcw_tab_<userId>_<view>                   — 切換分類頁籤（home/backpack_mining/...）
//   gcw_log_<userId>                          — 開倉庫紀錄（會長 / 副會長）
//   gcw_settings_<userId>                     — 開倉庫設定 modal（會長 / 副會長）
//   gcw_help_<userId>                         — 顯示存入說明

require("colors");
const { MessageFlags } = require("discord.js");

const guildClubService = require("../../features/guild_club/guildClubService");
const warehouseService = require("../../features/guild_club/warehouse/warehouseService");
const warehouseView = require("../../features/guild_club/warehouse/warehouseView");
const warehouseEligibility = require("../../features/guild_club/warehouse/warehouseEligibility");
const warehouseSettings = require("../../features/guild_club/warehouse/warehouseSettings");
const warehouseSettingsService = require("../../features/guild_club/warehouse/warehouseSettingsService");
const guildWarehouseListingService = require("../../features/guild_club/warehouse/guildWarehouseListingService");
const { deferReplySafe, deferUpdateSafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  const id = interaction.customId || "";
  if (!id.startsWith("gcw_")) return;

  if (interaction.isModalSubmit?.()) {
    if (id.startsWith(warehouseView.SETTINGS_MODAL_PREFIX))
      return handleSettingsSubmit(client, interaction);
    if (id.startsWith(warehouseView.TAKE_MODAL_PREFIX))
      return handleTakeModalSubmit(client, interaction);
    if (id.startsWith(warehouseView.CONSIGN_MODAL_PREFIX))
      return handleConsignModalSubmit(client, interaction);
    if (id.startsWith(warehouseView.PTM_MODAL_PREFIX))
      return handlePerTakeMaxSubmit(client, interaction);
    return;
  }
  if (!interaction.isButton()) return;

  if (id.startsWith("gcw_takeopen_")) return handleTakeOpen(client, interaction);
  if (id.startsWith("gcw_consign_")) return handleConsignOpen(client, interaction);
  if (id.startsWith("gcw_refresh_")) return handleRefresh(client, interaction);
  if (id.startsWith("gcw_tab_")) return handleTab(client, interaction);
  if (id.startsWith("gcw_log_")) return handleLog(client, interaction);
  if (id.startsWith("gcw_help_")) return handleHelp(client, interaction);
  if (id.startsWith("gcw_settings_")) return handleSettingsOpen(client, interaction);
  if (id.startsWith("gcw_ptmopen_")) return handlePerTakeMaxOpen(client, interaction);
  if (id.startsWith("gcw_ptm_")) return handlePerTakeMaxPicker(client, interaction);
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

async function handleTakeOpen(client, interaction) {
  const { ownerId, payload } = parseOwner("gcw_takeopen_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "領取按鈕");
  const parts = payload.split("_");
  if (parts.length < 2)
    return interaction.reply({ content: "❌ 按鈕格式錯誤", flags: MessageFlags.Ephemeral });
  const maxTake = parseInt(parts[parts.length - 1], 10);
  const itemId = parts.slice(0, -1).join("_");
  if (!Number.isInteger(maxTake) || maxTake <= 0)
    return interaction.reply({ content: "❌ 按鈕資料錯誤", flags: MessageFlags.Ephemeral });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership)
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🏰 你還沒加入公會",
          body: "倉庫是公會專屬功能。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club)
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({ title: "❌ 公會資料異常", body: "公會已不存在。" }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

  return interaction.showModal(
    warehouseView.buildTakeModal({
      userId: interaction.user.id,
      club,
      itemId,
      maxTake,
    })
  );
}

async function handleTakeModalSubmit(client, interaction) {
  const rest = interaction.customId.slice(warehouseView.TAKE_MODAL_PREFIX.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx < 0)
    return interaction.reply({ content: "❌ Modal 格式錯誤", flags: MessageFlags.Ephemeral });
  const ownerId = rest.slice(0, sepIdx);
  const itemId = rest.slice(sepIdx + 1);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "領取視窗");

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const qtyRaw = (interaction.fields.getTextInputValue("qty") || "").trim();
  const qty = parseInt(qtyRaw, 10);
  if (!Number.isInteger(qty) || qty <= 0)
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "❌ 數量格式錯誤",
          body: `請輸入正整數，你輸入了「${qtyRaw}」。`,
          hint: "重新點按鈕再試一次。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

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
    console.log(`[GUILD_WAREHOUSE] take modal 失敗：${e.stack || e.message}`.red);
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

async function handleConsignOpen(client, interaction) {
  const { ownerId, payload } = parseOwner("gcw_consign_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "寄售按鈕");
  const parts = payload.split("_");
  if (parts.length < 2)
    return interaction.reply({ content: "❌ 按鈕格式錯誤", flags: MessageFlags.Ephemeral });
  const maxQty = parseInt(parts[parts.length - 1], 10);
  const itemId = parts.slice(0, -1).join("_");
  if (!Number.isInteger(maxQty) || maxQty <= 0)
    return interaction.reply({ content: "❌ 按鈕資料錯誤", flags: MessageFlags.Ephemeral });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership || !guildClubService.isManager(membership.role)) {
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🚫 僅會長 / 副會長可上架寄售",
          body: "請會長或副會長使用。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club)
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({ title: "❌ 公會資料異常", body: "公會已不存在。" }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

  return interaction.showModal(
    warehouseView.buildConsignModal({
      userId: interaction.user.id,
      itemId,
      maxQty,
    })
  );
}

async function handleConsignModalSubmit(client, interaction) {
  const rest = interaction.customId.slice(warehouseView.CONSIGN_MODAL_PREFIX.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx < 0)
    return interaction.reply({ content: "❌ Modal 格式錯誤", flags: MessageFlags.Ephemeral });
  const ownerId = rest.slice(0, sepIdx);
  const itemId = rest.slice(sepIdx + 1);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "寄售視窗");

  if (!(await deferReplySafe(interaction, {}))) return;

  const qtyRaw = (interaction.fields.getTextInputValue("qty") || "").trim();
  const priceRaw = (interaction.fields.getTextInputValue("price") || "")
    .replace(/[,，\s]/g, "")
    .trim();
  const qty = parseInt(qtyRaw, 10);
  const price = parseInt(priceRaw, 10);
  if (!Number.isInteger(qty) || qty <= 0)
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "❌ 數量格式錯誤",
          body: `請輸入正整數，你輸入了「${qtyRaw}」。`,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  if (!Number.isInteger(price) || price <= 0)
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "❌ 售價格式錯誤",
          body: `請輸入正整數，你輸入了「${priceRaw}」。`,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

  try {
    const result = await guildWarehouseListingService.createListing(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      sellerName: interaction.member?.displayName || interaction.user.username,
      itemId,
      qty,
      price,
    });

    if (!result.ok) {
      return interaction.editReply({
        components: [warehouseView.buildConsignErrorContainer(result, itemId)],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    return interaction.editReply({
      components: [
        warehouseView.buildConsignSuccessContainer({
          userId: interaction.user.id,
          club: result.club,
          itemDefArg: result.item,
          listing: result.listing,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(`[GUILD_WAREHOUSE] consign modal 失敗：${e.stack || e.message}`.red);
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

async function handlePerTakeMaxPicker(client, interaction) {
  const { ownerId } = parseOwner("gcw_ptm_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "物品上限按鈕");

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership || !guildClubService.isManager(membership.role)) {
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🚫 僅會長 / 副會長可調設定",
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

  return interaction.editReply({
    components: [
      warehouseView.buildPerTakeMaxPickerContainer({
        userId: interaction.user.id,
        club,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handlePerTakeMaxOpen(client, interaction) {
  const { ownerId, payload } = parseOwner("gcw_ptmopen_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "物品上限按鈕");
  const group = payload;
  if (!warehouseView.PTM_GROUPS[group])
    return interaction.reply({ content: "❌ 未知分類", flags: MessageFlags.Ephemeral });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership || !guildClubService.isManager(membership.role)) {
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🚫 僅會長 / 副會長可調設定",
          body: "請會長或副會長使用。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club)
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({ title: "❌ 公會資料異常", body: "公會已不存在。" }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

  return interaction.showModal(
    warehouseView.buildPerTakeMaxModal({ userId: interaction.user.id, club, group })
  );
}

async function handlePerTakeMaxSubmit(client, interaction) {
  const rest = interaction.customId.slice(warehouseView.PTM_MODAL_PREFIX.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx < 0)
    return interaction.reply({ content: "❌ Modal 格式錯誤", flags: MessageFlags.Ephemeral });
  const ownerId = rest.slice(0, sepIdx);
  const group = rest.slice(sepIdx + 1);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "物品上限視窗");
  if (!warehouseView.PTM_GROUPS[group])
    return interaction.reply({ content: "❌ 未知分類", flags: MessageFlags.Ephemeral });

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

  const inputs = {};
  for (const itemId of warehouseView.itemsInPtmGroup(group)) {
    inputs[itemId] = interaction.fields.getTextInputValue(itemId);
  }

  const result = await warehouseSettingsService.updatePerTakeMax(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    inputs,
  });

  if (!result.ok) {
    if (result.reason === "validation_failed") {
      const lines = result.errors.map((e) => {
        const d = warehouseSettings.itemDef(e.itemId);
        const name = d ? `${d.emoji} ${d.name}` : e.itemId;
        if (e.reason === "not_integer") return `・${name}：請填整數`;
        if (e.reason === "out_of_range") return `・${name}：請填 ${e.lo}–${e.hi}`;
        return `・${name}：${e.reason}`;
      });
      return interaction.editReply({
        components: [
          warehouseView.buildErrorContainer({
            title: "❌ 設定值不合法",
            body: lines.join("\n"),
            hint: "範圍依設計上下限自動 clamp，不能超出。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    if (result.reason === "no_change")
      return interaction.editReply({
        components: [
          warehouseView.buildErrorContainer({
            title: "🟡 沒有可儲存的變更",
            body: "你沒有填任何欄位，設定維持原狀。",
            hint: "想恢復預設？把對應欄位填空白後送出。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    return interaction.editReply({
      components: [
        warehouseView.buildErrorContainer({
          title: "❌ 設定更新失敗",
          body: `原因：${result.reason}`,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      warehouseView.buildPerTakeMaxUpdatedContainer({
        club: result.club,
        applied: result.applied,
        userId: interaction.user.id,
        group,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleRefresh(client, interaction) {
  const { ownerId, payload } = parseOwner("gcw_refresh_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "倉庫畫面");
  return renderWarehouse(client, interaction, { view: payload || "home", mode: "reply" });
}

async function handleTab(client, interaction) {
  const { ownerId, payload } = parseOwner("gcw_tab_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "倉庫頁籤");
  return renderWarehouse(client, interaction, { view: payload || "home", mode: "update" });
}

async function renderWarehouse(client, interaction, { view, mode }) {
  if (mode === "update") {
    if (!(await deferUpdateSafe(interaction))) return;
  } else {
    if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  }

  const editPayload = (components) =>
    interaction.editReply({ components, flags: MessageFlags.IsComponentsV2 });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership) {
    return editPayload([
      warehouseView.buildErrorContainer({
        title: "🏰 你還沒加入公會",
        body: "倉庫是公會專屬功能。",
      }),
    ]);
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) {
    return editPayload([
      warehouseView.buildErrorContainer({
        title: "❌ 公會資料異常",
        body: "公會已不存在。",
      }),
    ]);
  }

  const inventory = await warehouseService.getInventory(client, club.guild_club_id);
  const daily = await warehouseEligibility.getDailyDoc(
    client,
    interaction.user.id,
    interaction.guildId
  );
  const isManagerNow = guildClubService.isManager(membership.role);
  const flow = isManagerNow
    ? await warehouseService.getNetFlow(client, club.guild_club_id, 7)
    : null;

  return editPayload([
    warehouseView.buildWarehouseContainer({
      viewerId: interaction.user.id,
      club,
      inventory,
      isManager: isManagerNow,
      todayItemsTaken: daily?.items_taken || [],
      todayTimesUsed: daily?.times_used || 0,
      netFlow7d: flow?.net,
      view,
    }),
  ]);
}

async function handleLog(client, interaction) {
  const { ownerId } = parseOwner("gcw_log_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "倉庫紀錄按鈕");

  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;

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
          "存入：`/公會 存入 物品:鐵礦 數量:30`\n" +
          "領取：點上方分類頁籤 → 找到物品 → 按「領取」按鈕\n" +
          "快捷指令：`/公會 領取 物品:鐵礦 數量:5`（適合知道要什麼的老手）\n" +
          "・存入後 1 小時保護期，全員都不能領\n" +
          "・領取每日 2 次，同種類一天限領一次\n" +
          "・手續費 = 市價 × 10%（最低 20 幣），費用進公會金庫",
        hint: "存入後不可收回，等同捐贈。",
      }),
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

async function handleSettingsOpen(client, interaction) {
  const { ownerId } = parseOwner("gcw_settings_", interaction.customId);
  if (interaction.user.id !== ownerId) return denyNotOwner(interaction, "設定按鈕");

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership || !guildClubService.isManager(membership.role)) {
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({
          title: "🚫 僅會長 / 副會長可調設定",
          body: "請會長或副會長使用。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club)
    return interaction.reply({
      components: [
        warehouseView.buildErrorContainer({ title: "❌ 公會資料異常", body: "公會已不存在。" }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

  return interaction.showModal(
    warehouseView.buildSettingsModal({ userId: interaction.user.id, club })
  );
}

async function handleSettingsSubmit(client, interaction) {
  if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) return;
  const inputs = {};
  for (const key of warehouseSettingsService.SETTING_KEYS) {
    inputs[key] = interaction.fields.getTextInputValue(key);
  }

  const result = await warehouseSettingsService.updateSettings(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    inputs,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [settingsErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      warehouseView.buildSettingsUpdatedContainer({
        club: result.club,
        applied: result.applied,
        userId: interaction.user.id,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

function settingsErrorView(result) {
  if (result.reason === "not_manager")
    return warehouseView.buildErrorContainer({
      title: "🚫 僅會長 / 副會長可調設定",
      body: "請會長或副會長使用。",
    });
  if (result.reason === "no_change")
    return warehouseView.buildErrorContainer({
      title: "🟡 沒有可儲存的變更",
      body: "你沒有填任何欄位，設定維持原狀。",
      hint: "想恢復預設？把對應欄位填空白後送出。",
    });
  if (result.reason === "validation_failed") {
    const lines = result.errors.map((e) => {
      const label = warehouseView.SETTING_LABEL[e.key] || e.key;
      if (e.reason === "not_integer") return `・${label}：請填整數`;
      if (e.reason === "not_number") return `・${label}：請填數字（可帶 % ）`;
      if (e.reason === "out_of_range") {
        const lo = e.kind === "rate" ? `${e.lo * 100}%` : e.lo;
        const hi = e.kind === "rate" ? `${e.hi * 100}%` : e.hi;
        return `・${label}：請填 ${lo}–${hi}`;
      }
      return `・${label}：${e.reason}`;
    });
    return warehouseView.buildErrorContainer({
      title: "❌ 設定值不合法",
      body: lines.join("\n"),
      hint: "範圍依設計上下限自動 clamp，不能超出。",
    });
  }
  return warehouseView.buildErrorContainer({
    title: "❌ 設定更新失敗",
    body: `原因：${result.reason}`,
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
      hint: "可用 /公會 捐款 或 /公會 存入 補貢獻。",
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
  if (reason === "qty_over_personal_limit")
    return warehouseView.buildErrorContainer({
      title: "❌ 超過單次上限",
      body: `${name} 單次最多 ${result.limit} 個，你想領 ${result.asked}。`,
      hint: "請填 1～上限之間的整數。",
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
    title: "❌ 領取失敗",
    body: `原因：${reason}`,
  });
}
