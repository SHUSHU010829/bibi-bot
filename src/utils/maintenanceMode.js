// 維修模式：資料庫搬遷 / 停機作業時，暫停所有「會變更資料」的互動，避免寫入遺失。
//
// 開關：環境變數 MAINTENANCE_MODE=true（改 .env 後重啟 bot 生效）。
// 放行規則（維修中）：
//   - 查閱類 slash 指令（config.maintenance.readCommands，純讀不寫）→ 放行
//   - 其餘 slash 指令 + 所有按鈕 / 選單 / Modal（會寫 DB）→ 擋下並回維修公告
//   - autocomplete（純讀）→ 放行
//   - 開發者（DEVELOPER_IDS）→ 全部豁免，方便維護期間操作
//
// 攔截點在 handlers/eventHandler.js 的 interactionCreate 派發前，因為按鈕 handler
// 各自獨立、事件迴圈不會短路，只有在總派發點攔截才擋得住下游的 DB 寫入。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { maintenance, developersId } = require("../config");

function isEnabled() {
  return process.env.MAINTENANCE_MODE === "true";
}

function isDeveloper(userId) {
  return Array.isArray(developersId) && developersId.includes(userId);
}

const readCommands = new Set(maintenance?.readCommands || []);

// 這個互動在維修模式下是否該被擋。false = 放行（照常派發給 handler）。
function isBlockedInteraction(interaction) {
  if (!isEnabled()) return false;
  if (isDeveloper(interaction.user?.id)) return false;

  // 純讀：autocomplete 一律放行
  if (interaction.isAutocomplete?.()) return false;

  // slash 指令：查閱白名單放行，其餘擋下
  if (interaction.isChatInputCommand?.()) {
    return !readCommands.has(interaction.commandName);
  }

  // 按鈕 / 各種選單 / Modal 一律會動到資料，全擋
  if (
    interaction.isButton?.() ||
    interaction.isAnySelectMenu?.() ||
    interaction.isModalSubmit?.()
  ) {
    return true;
  }

  return false;
}

function buildNoticeContainer() {
  const n = maintenance?.notice || {};
  return new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${n.title || "🔧 系統維護中"}`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        n.reason || "維護作業進行中，暫停所有會變更資料的操作。",
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${n.hint || ""}`),
    );
}

// 送出維修公告。idempotent：interactionCreate 有兩個 listener（validations /
// interactionCreate 兩個資料夾）都會觸發到這裡，已回覆過就直接跳過，避免重複發。
async function sendNotice(interaction) {
  if (interaction.replied || interaction.deferred) return;
  try {
    await interaction.reply({
      components: [buildNoticeContainer()],
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  } catch (err) {
    // 10062：互動逾期；或已被另一個 listener 搶先回覆 → 皆無需處理
    if (err?.code !== 10062 && err?.code !== 40060) {
      console.log(`[WARN] 維修公告回覆失敗：${err?.message || err}`);
    }
  }
}

module.exports = { isEnabled, isBlockedInteraction, sendNotice };
