// /個人設定 面板的 Components V2 容器與按鈕。
//
// 目前只有「公開資料」一個開關（控制是否在 dashboard 公開排行榜 / 公開卡片
// 出現實名）。未來可以擴成更多項。
//
// 按鈕 customId 格式：usersettings_<userId>_<action>
//   action ∈ { publicProfile }

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const userSettings = require("./userSettings");

const CUSTOM_ID_PREFIX = "usersettings";
const ACTIONS = ["publicProfile"];

function buildCustomId(userId, action) {
  return `${CUSTOM_ID_PREFIX}_${userId}_${action}`;
}

function parseCustomId(customId) {
  if (typeof customId !== "string") return null;
  if (!customId.startsWith(`${CUSTOM_ID_PREFIX}_`)) return null;
  const rest = customId.slice(CUSTOM_ID_PREFIX.length + 1);
  const idx = rest.indexOf("_");
  if (idx < 0) return null;
  const userId = rest.slice(0, idx);
  const action = rest.slice(idx + 1);
  if (!ACTIONS.includes(action) || !userId) return null;
  return { userId, action };
}

async function buildContainer(client, userId, guildId) {
  const settings = await userSettings.get(client, userId, guildId);

  const isPublic = settings.publicProfile;

  const titleLine = "# ⚙️ 個人設定";
  const description =
    "管理你在 dashboard 公開頁面的顯示方式。\n" +
    "其他偏好（通知、排程提醒等）請用 `/通知設定`。";

  const publicProfileBlock =
    `### 公開資料\n` +
    `**目前：${isPublic ? "✅ 公開" : "🔒 私密"}**\n` +
    (isPublic
      ? "你的名稱、頭像、排行榜成績會顯示在 dashboard 的公開排行榜與個人卡片頁。\n" +
        "-# 想隱身可隨時關閉。"
      : "你不會出現在 dashboard 的公開排行榜（仍會佔名次，但顯示為「匿名玩家」），\n" +
        "公開卡片頁 `/u/<你的 ID>` 也會回 404。\n" +
        "-# 想參與排名 / 分享成就可以打開。");

  const toggleBtn = new ButtonBuilder()
    .setCustomId(buildCustomId(userId, "publicProfile"))
    .setLabel(isPublic ? "切換為私密" : "切換為公開")
    .setEmoji(isPublic ? "🔒" : "🌐")
    .setStyle(isPublic ? ButtonStyle.Secondary : ButtonStyle.Success);

  return new ContainerBuilder()
    .setAccentColor(isPublic ? 0x57f287 : 0x99aab5)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(titleLine),
      new TextDisplayBuilder().setContent(description),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(publicProfileBlock),
    )
    .addActionRowComponents(new ActionRowBuilder().addComponents(toggleBtn));
}

module.exports = { buildContainer, parseCustomId };
