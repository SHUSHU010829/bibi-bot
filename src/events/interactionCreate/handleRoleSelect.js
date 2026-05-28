const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { loadPanels } = require("../../utils/rolePanelsStore");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");

const ITEMS_PER_MENU = 25; // Discord StringSelectMenu 每頁最多 25 個選項

function buildPersonalizedRows(allRoles, currentRoleIdSet) {
  const rows = [];
  const totalPages = Math.max(1, Math.ceil(allRoles.length / ITEMS_PER_MENU));

  for (let page = 0; page < totalPages; page++) {
    const start = page * ITEMS_PER_MENU;
    const end = Math.min(start + ITEMS_PER_MENU, allRoles.length);
    const pageRoles = allRoles.slice(start, end);

    if (pageRoles.length === 0) continue;

    const options = pageRoles.map((role) => {
      const option = {
        label: role.name,
        value: role.roleId,
        default: currentRoleIdSet.has(role.roleId),
      };
      if (role.emoji) {
        option.emoji = role.emoji;
      }
      return option;
    });

    const placeholder =
      totalPages > 1
        ? `選擇你想要的遊戲身份組（第 ${page + 1}/${totalPages} 頁）`
        : "選擇你想要的遊戲身份組";

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`role_select_${page}`)
      .setPlaceholder(placeholder)
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);

    rows.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  return rows;
}

async function safeUserReply(interaction, content) {
  const payload = { content, flags: 64 };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply(payload);
    }
  } catch (_) { /* noop */ }
}

async function ensureMember(interaction) {
  if (!interaction.guild) {
    await safeUserReply(interaction, "❌ 此功能只能在伺服器中使用。");
    return null;
  }

  let member = interaction.member;
  if (!member) {
    try {
      member = await interaction.guild.members.fetch(interaction.user.id);
    } catch (error) {
      logger.error(
        { source: "role-select", userId: interaction.user?.id, err: error.message },
        "無法獲取 member"
      );
      trackError("role-select", error, { phase: "ensureMember" });
      await safeUserReply(interaction, "❌ 無法獲取你的身份組資訊，請稍後再試。");
      return null;
    }
  }

  if (!member.roles || !member.roles.cache) {
    await safeUserReply(interaction, "❌ 無法獲取你的身份組資訊，請稍後再試。");
    return null;
  }

  return member;
}

async function handleOpenPanel(client, interaction) {
  // 先 defer，避免 members.fetch + loadPanels 讓 3 秒 token 過期觸發 10062
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (deferErr) {
    if (deferErr?.code === 10062) {
      logger.warn(
        { source: "role-panel-open", customId: interaction.customId },
        "互動已逾期,無法 defer"
      );
      trackError("role-panel-open", deferErr, { reason: "expired" });
      return;
    }
    logger.error(
      { source: "role-panel-open", err: deferErr.message },
      "defer 失敗"
    );
    trackError("role-panel-open", deferErr);
    return;
  }

  try {
    const member = await ensureMember(interaction);
    if (!member) return;

    const data = await loadPanels(client);
    if (!data.roles || data.roles.length === 0) {
      return await interaction.editReply({
        content: "❌ 目前沒有任何遊戲身份組可供選擇，請聯絡管理員設定。",
      });
    }

    const menuRoleIdSet = new Set(data.roles.map((r) => r.roleId));
    const currentRoleIdSet = new Set();
    member.roles.cache.forEach((role) => {
      if (menuRoleIdSet.has(role.id)) {
        currentRoleIdSet.add(role.id);
      }
    });

    const rows = buildPersonalizedRows(data.roles, currentRoleIdSet);

    const container = new ContainerBuilder()
      .setAccentColor(0x00ff00)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "# 🎮 你的遊戲身份組\n已自動勾選你目前擁有的身份組，未變更的會保留。",
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder());
    for (const row of rows) container.addActionRowComponents(row);

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    logger.error(
      { source: "role-panel-open", userId: interaction.user?.id, err: error.message, stack: error.stack },
      "開啟角色選單時出錯"
    );
    trackError("role-panel-open", error, { userId: interaction.user?.id });
    try {
      await interaction.editReply({
        content: "❌ 開啟身份組選單時發生錯誤！請聯絡管理員。",
      });
    } catch (replyError) {
      logger.error({ source: "role-panel-open", err: replyError.message }, "回覆錯誤訊息失敗");
      trackError("role-panel-open", replyError);
    }
  }
}

async function handleRoleSubmit(interaction) {
  // 先 defer，避免 members.fetch + roles.add/remove 讓 3 秒 token 過期觸發 10062
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (deferErr) {
    if (deferErr?.code === 10062) {
      logger.warn(
        { source: "role-submit", customId: interaction.customId },
        "互動已逾期,無法 defer"
      );
      trackError("role-submit", deferErr, { reason: "expired" });
      return;
    }
    logger.error(
      { source: "role-submit", err: deferErr.message },
      "defer 失敗"
    );
    trackError("role-submit", deferErr);
    return;
  }

  try {
    const member = await ensureMember(interaction);
    if (!member) return;

    if (!interaction.values || !Array.isArray(interaction.values)) {
      logger.error(
        { source: "role-submit", userId: interaction.user?.id },
        "interaction.values 不存在或不是陣列"
      );
      trackError("role-submit", new Error("invalid interaction.values"));
      return await interaction.editReply({
        content: "❌ 無法讀取你的選擇，請重試。",
      });
    }

    // 只針對本次選單實際顯示的角色做加減 — 避免分頁時 A 頁提交誤刪 B 頁的角色，
    // 也讓個人化選單的「未勾選」只代表「想取消這頁的這幾個」。
    const menuOptionRoleIds = (interaction.component?.options || []).map(
      (opt) => opt.value,
    );

    if (menuOptionRoleIds.length === 0) {
      logger.warn(
        { source: "role-submit", userId: interaction.user?.id },
        "無法從 interaction.component 取得選項"
      );
      trackError("role-submit", new Error("empty component options"));
      return await interaction.editReply({
        content: "❌ 無法讀取選單資訊，請重試。",
      });
    }

    const menuOptionRoleIdSet = new Set(menuOptionRoleIds);
    const selectedRoleIdSet = new Set(interaction.values);

    const currentRoleIdSet = new Set();
    member.roles.cache.forEach((role) => {
      if (menuOptionRoleIdSet.has(role.id)) {
        currentRoleIdSet.add(role.id);
      }
    });

    const toAdd = [...selectedRoleIdSet].filter(
      (id) => !currentRoleIdSet.has(id),
    );
    const toRemove = [...currentRoleIdSet].filter(
      (id) => !selectedRoleIdSet.has(id),
    );

    const addedRoles = [];
    const removedRoles = [];
    const failedRoles = [];

    await Promise.all([
      ...toAdd.map(async (roleId) => {
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          failedRoles.push(roleId);
          logger.warn({ source: "role-submit", roleId }, "找不到角色");
          return;
        }
        try {
          await member.roles.add(role);
          addedRoles.push(role.name);
        } catch (error) {
          failedRoles.push(roleId);
          logger.error(
            { source: "role-submit", roleId, err: error.message },
            "新增角色時出錯"
          );
          trackError("role-submit", error, { op: "add", roleId });
        }
      }),
      ...toRemove.map(async (roleId) => {
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          logger.warn({ source: "role-submit", roleId }, "找不到角色");
          return;
        }
        try {
          await member.roles.remove(role);
          removedRoles.push(role.name);
        } catch (error) {
          logger.error(
            { source: "role-submit", roleId, err: error.message },
            "移除角色時出錯"
          );
          trackError("role-submit", error, { op: "remove", roleId });
        }
      }),
    ]);

    let message = "";

    if (addedRoles.length > 0) {
      message += `✅ **已新增身份組：**\n${addedRoles.map((name) => `• ${name}`).join("\n")}\n\n`;
    }

    if (removedRoles.length > 0) {
      message += `🗑️ **已移除身份組：**\n${removedRoles.map((name) => `• ${name}`).join("\n")}\n\n`;
    }

    if (addedRoles.length === 0 && removedRoles.length === 0) {
      message = "ℹ️ 你的身份組沒有變更。";
    }

    if (failedRoles.length > 0) {
      message += `⚠️ 部分角色處理失敗，請聯絡管理員。`;
    }

    await interaction.editReply({
      content: message.trim(),
    });
    trackSuccess("role-submit");
  } catch (error) {
    logger.error(
      { source: "role-submit", userId: interaction.user?.id, err: error.message, stack: error.stack },
      "處理角色選單互動時出錯"
    );
    trackError("role-submit", error, { userId: interaction.user?.id });

    try {
      await interaction.editReply({
        content: "❌ 處理身份組時發生錯誤！請聯絡管理員。",
      });
    } catch (replyError) {
      logger.error({ source: "role-submit", err: replyError.message }, "回覆錯誤訊息失敗");
      trackError("role-submit", replyError);
    }
  }
}

module.exports = async (client, interaction) => {
  // 處理「打開個人化選單」按鈕
  if (interaction.isButton() && interaction.customId === "role_panel_open") {
    return handleOpenPanel(client, interaction);
  }

  // 處理身份組選單提交
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId &&
    interaction.customId.startsWith("role_select_")
  ) {
    return handleRoleSubmit(interaction);
  }
};
