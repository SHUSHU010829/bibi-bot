const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
require("colors");

const { loadPanels, savePanels } = require("../../utils/rolePanelsStore");

// 面板是靜態按鈕：按下後 bot 會即時讀取資料庫並回傳個人化選單，
// 所以新增 / 移除遊戲時不需要編輯這則訊息。
function createPanelContainer() {
  const button = new ButtonBuilder()
    .setCustomId("role_panel_open")
    .setLabel("領取 / 管理遊戲身份組")
    .setEmoji("🎮")
    .setStyle(ButtonStyle.Primary);

  return new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🎮 遊戲身份組領取"),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "點擊下方按鈕開啟個人化選單。\n" +
          "✨ 已擁有的身份組會自動勾選，未變更的會保留。",
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(button),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 操作只有你看得到，放心點 👀",
      ),
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setup-roles")
    .setDescription("🎮 遊戲身份組選單管理")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("send")
        .setDescription("在固定頻道發送角色選單（管理員）"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("新增遊戲到選單（管理員）")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("遊戲名稱（全大寫）")
            .setRequired(true),
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("對應的身份組")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("emoji")
            .setDescription("顯示的 emoji（選填）")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("從選單移除遊戲（管理員）")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("要移除的遊戲名稱")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("列出所有已設定的遊戲角色"),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  // 預設僅管理員可見/可用；各子命令仍保留內部檢查，作為伺服器覆寫權限時的防線
  userPermissions: [],
  botPermissions: [PermissionFlagsBits.ManageRoles],

  run: async (client, interaction) => {
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case "send":
          await handleSend(client, interaction);
          break;
        case "add":
          await handleAdd(client, interaction);
          break;
        case "remove":
          await handleRemove(client, interaction);
          break;
        case "list":
          await handleList(client, interaction);
          break;
      }
    } catch (error) {
      console.log(`[ERROR] 執行 setup-roles 指令時出錯：\n${error}`.red);

      // 只在還沒回覆時才回覆錯誤訊息
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ 執行指令時發生錯誤！",
          flags: 64, // MessageFlags.Ephemeral
        });
      }
    }
  },
};

async function handleSend(client, interaction) {
  // 檢查管理員權限
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: "❌ 此功能僅限管理員使用！",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  const data = await loadPanels(client);

  if (!data.targetChannelId) {
    return interaction.reply({
      content:
        "❌ 未設定目標頻道 ID！請在 role-panels.json 中設定 targetChannelId。",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  if (data.roles.length === 0) {
    return interaction.reply({
      content:
        "❌ 尚未設定任何遊戲角色！請先使用 `/setup-roles add` 新增遊戲。",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  try {
    const channel = await client.channels.fetch(data.targetChannelId);
    if (!channel) {
      return interaction.reply({
        content: "❌ 找不到目標頻道！請確認頻道 ID 正確。",
        flags: 64, // MessageFlags.Ephemeral
      });
    }

    // 刪除舊的面板訊息（包含舊版多頁選單）
    const oldMessageIds = Object.keys(data.panels || {});
    await Promise.all(
      oldMessageIds.map(async (oldMessageId) => {
        try {
          const oldMessage = await channel.messages.fetch(oldMessageId);
          await oldMessage.delete();
        } catch (error) {
          console.log(
            `[WARNING] 無法刪除舊面板訊息 ${oldMessageId}：${error.message}`
              .yellow,
          );
        }
      }),
    );
    data.panels = {};

    const container = createPanelContainer();
    const message = await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    data.panels[message.id] = true;
    await savePanels(client, data);

    await interaction.reply({
      content: `✅ 已在 <#${data.targetChannelId}> 發送遊戲身份組面板！`,
      flags: 64, // MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log(`[ERROR] 發送角色選單時出錯：${error}`.red);

    // 如果還沒回覆，則回覆錯誤訊息
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ 發送角色選單時發生錯誤！請檢查 bot 權限和頻道設定。",
        flags: 64, // MessageFlags.Ephemeral
      });
    }
  }
}

async function handleAdd(client, interaction) {
  // 檢查管理員權限
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: "❌ 此功能僅限管理員使用！",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  const name = interaction.options.getString("name").toUpperCase();
  const role = interaction.options.getRole("role");
  const emoji = interaction.options.getString("emoji");

  const data = await loadPanels(client);

  // 檢查是否已存在
  const exists = data.roles.find(
    (r) => r.name === name || r.roleId === role.id,
  );
  if (exists) {
    return interaction.reply({
      content: "❌ 此遊戲或身份組已存在於選單中！",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  // 新增角色
  const newRole = {
    name,
    roleId: role.id,
  };
  if (emoji) {
    newRole.emoji = emoji;
  }
  data.roles.push(newRole);

  await savePanels(client, data);

  const emojiText = emoji ? `${emoji} ` : "";
  await interaction.reply({
    content: `✅ 已新增遊戲：${emojiText}${name} (${role})！\n下次使用者點擊面板按鈕時會看到此選項。`,
    flags: 64, // MessageFlags.Ephemeral
  });
}

async function handleRemove(client, interaction) {
  // 檢查管理員權限
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: "❌ 此功能僅限管理員使用！",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  const name = interaction.options.getString("name").toUpperCase();
  const data = await loadPanels(client);

  const index = data.roles.findIndex((r) => r.name === name);
  if (index === -1) {
    return interaction.reply({
      content: "❌ 找不到此遊戲！",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  const removed = data.roles.splice(index, 1)[0];
  await savePanels(client, data);

  const emojiText = removed.emoji ? `${removed.emoji} ` : "";
  await interaction.reply({
    content: `✅ 已移除遊戲：${emojiText}${removed.name}！\n下次使用者點擊面板按鈕時即看不到此選項。`,
    flags: 64, // MessageFlags.Ephemeral
  });
}

async function handleList(client, interaction) {
  const data = await loadPanels(client);

  if (data.roles.length === 0) {
    return interaction.reply({
      content: "❌ 目前沒有任何遊戲角色設定。",
      flags: 64, // MessageFlags.Ephemeral
    });
  }

  const listText = data.roles
    .map((role, index) => {
      const emojiText = role.emoji ? `${role.emoji} ` : "";
      return `**${index + 1}.** ${emojiText}${role.name} - <@&${role.roleId}>`;
    })
    .join("\n");

  const container = new ContainerBuilder()
    .setAccentColor(0x0099ff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🎮 已設定的遊戲角色"),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(listText))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 共 ${data.roles.length} 個遊戲 ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

  await interaction.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
