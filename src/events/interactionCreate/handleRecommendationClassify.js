require("colors");

const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");

const { deferUpdateSafe } = require("../../utils/safeAck");
const { TYPES } = require("../../constants/recommendationCategories");
const {
  buildClassifyComponents,
  buildClassifyContainer,
  buildConfirmedContainer,
} = require("../../features/recommendation/classifyUI");

function withRows(container, rows) {
  for (const row of rows) container.addActionRowComponents(row);
  return container;
}

const PREFIX = "rec_class_";

function parseCustomId(customId) {
  if (!customId || !customId.startsWith(PREFIX)) return null;
  const rest = customId.slice(PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) return null;
  return {
    action: rest.slice(0, colonIdx),
    messageId: rest.slice(colonIdx + 1),
  };
}

function buildEditModal(messageId, doc) {
  const modal = new ModalBuilder()
    .setCustomId(`rec_class_modal:${messageId}`)
    .setTitle("編輯推薦資訊");

  const fields = [
    { id: "name", label: "店名", value: doc.name, max: 100 },
    { id: "cuisine", label: "料理／子類別", value: doc.cuisine, max: 50 },
    { id: "area", label: "地區", value: doc.area, max: 50 },
    { id: "summary", label: "特色（一句話）", value: doc.summary, max: 200 },
  ];

  for (const f of fields) {
    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label)
      .setStyle(f.id === "summary" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(f.max);
    if (f.value) input.setValue(String(f.value).slice(0, f.max));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
}

function normalizeField(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed.length === 0 ? null : trimmed;
}

module.exports = async (client, interaction) => {
  if (
    !interaction.isButton() &&
    !interaction.isStringSelectMenu() &&
    !interaction.isModalSubmit?.()
  ) {
    return;
  }
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  const collection = client.recommendationsCollection;
  if (!collection) {
    await interaction
      .reply({
        content: "🔧 推薦資料庫尚未就緒，請稍後再試。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const { action, messageId } = parsed;

  // edit 走 showModal（不能 defer，且彈窗本身就是 ack）；其餘分支最終都以
  // interaction.update 重繪面板，必須先 deferUpdate 再做 DB 查詢避免 10062。
  if (action !== "edit") {
    if (!(await deferUpdateSafe(interaction))) return;
  }

  try {
    const doc = await collection.findOne({ messageId });
    if (!doc) {
      const notFound = {
        content: "找不到對應的推薦紀錄，可能已被刪除。",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(notFound).catch(() => {});
      } else {
        await interaction.reply(notFound).catch(() => {});
      }
      return;
    }

    if (action === "select" && interaction.isStringSelectMenu()) {
      const newType = interaction.values?.[0];
      if (!newType || !TYPES[newType]) {
        await interaction
          .followUp({
            content: "無效的分類選項。",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
        return;
      }

      const update = {
        type: newType,
        updatedAt: new Date(),
      };
      // 從餐廳改成非餐廳時，清掉 cuisine 比較合理
      if (newType !== "restaurant") update.cuisine = null;

      await collection.updateOne({ messageId }, { $set: update });
      const updatedDoc = { ...doc, ...update };

      await interaction.editReply({
        components: [
          withRows(
            buildClassifyContainer(updatedDoc),
            buildClassifyComponents(messageId, newType, false),
          ),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
      console.log(
        `[Recommendation] ${interaction.user.username} 改分類 ${doc.type} → ${newType} (${messageId})`
          .cyan,
      );
      return;
    }

    if (action === "edit" && interaction.isButton()) {
      await interaction.showModal(buildEditModal(messageId, doc));
      return;
    }

    if (action === "modal" && interaction.isModalSubmit()) {
      const update = {
        name: normalizeField(interaction.fields.getTextInputValue("name")),
        cuisine: normalizeField(
          interaction.fields.getTextInputValue("cuisine"),
        ),
        area: normalizeField(interaction.fields.getTextInputValue("area")),
        summary: normalizeField(
          interaction.fields.getTextInputValue("summary"),
        ),
        updatedAt: new Date(),
      };

      await collection.updateOne({ messageId }, { $set: update });
      const updatedDoc = { ...doc, ...update };

      await interaction.editReply({
        components: [
          withRows(
            buildClassifyContainer(updatedDoc),
            buildClassifyComponents(messageId, updatedDoc.type, false),
          ),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
      console.log(
        `[Recommendation] ${interaction.user.username} 編輯推薦資訊 (${messageId})`
          .cyan,
      );
      return;
    }

    if (action === "confirm" && interaction.isButton()) {
      await collection.updateOne(
        { messageId },
        {
          $set: {
            classifyConfirmed: true,
            classifyConfirmedAt: new Date(),
            updatedAt: new Date(),
          },
          $unset: { classifyPromptId: "" },
        },
      );

      // 確認後刪除提示訊息，保持頻道整潔
      try {
        await interaction.message.delete();
      } catch (deleteError) {
        // 刪不掉就退回 editReply 顯示已確認
        await interaction
          .editReply({
            components: [
              withRows(
                buildConfirmedContainer(doc),
                buildClassifyComponents(messageId, doc.type, true),
              ),
            ],
            flags: MessageFlags.IsComponentsV2,
          })
          .catch(() => {});
      }
      console.log(
        `[Recommendation] ${interaction.user.username} 確認分類 [${doc.type}] (${messageId})`
          .cyan,
      );
      return;
    }
  } catch (error) {
    console.log(`[ERROR] 推薦分類互動失敗：\n${error}`.red);
    try {
      const payload = {
        content: "🔧 處理分類時發生錯誤，請稍後再試。",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (_) {
      /* noop */
    }
  }
};
