// /通知設定 面板的 Components V2 容器與按鈕（指令與按鈕處理器共用）。
//
// 面板集中管理玩家的所有私訊提醒偏好：
//   - 通知總開關（master）：一鍵靜音／開啟全部
//   - 挖礦 / 打工 / 火箭 到點通知（各自獨立）
//   - 任務完成 DM 通知（被動任務）
//
// 按鈕 customId 格式：notifyset_<action>_<userId>
//   action ∈ { master, mining, work, fish, crash, dungeon, farm, quest }

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const reminder = require("./cooldownReminderService");
const notifyPrefs = require("./notifyPrefs");
const questNotifyPref = require("../quests/questNotifyPref");

const CUSTOM_ID_PREFIX = "notifyset";

// 面板上會出現的「冷卻到點」類型（沿用 cooldownReminderService 的 type）。
// dungeon 嚴格來說不是冷卻，而是體力補滿提醒；通知行為相同所以共用同一條鏈路。
const COOLDOWN_ACTIONS = ["mining", "work", "fish", "crash", "dungeon", "farm"];
const ACTIONS = ["master", ...COOLDOWN_ACTIONS, "quest"];

function buildCustomId(action, userId) {
  return `${CUSTOM_ID_PREFIX}_${action}_${userId}`;
}

// 解析 notifyset_<action>_<userId>。userId 為純數字 Discord ID，不含底線。
function parseCustomId(customId) {
  if (typeof customId !== "string") return null;
  if (!customId.startsWith(`${CUSTOM_ID_PREFIX}_`)) return null;
  const rest = customId.slice(CUSTOM_ID_PREFIX.length + 1);
  const idx = rest.indexOf("_");
  if (idx < 0) return null;
  const action = rest.slice(0, idx);
  const userId = rest.slice(idx + 1);
  if (!ACTIONS.includes(action) || !userId) return null;
  return { action, userId };
}

function toggleButton(action, userId, enabled, label) {
  return new ButtonBuilder()
    .setCustomId(buildCustomId(action, userId))
    .setLabel(`${label}：${enabled ? "開" : "關"}`)
    .setEmoji(enabled ? "🔔" : "🔕")
    .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
}

// 讀取所有偏好並組出 /通知設定 的 V2 容器。
async function buildContainer(client, userId, guildId) {
  const [
    masterEnabled,
    miningState,
    workState,
    fishState,
    crashState,
    dungeonState,
    farmState,
    questEnabled,
  ] = await Promise.all([
    notifyPrefs.isMasterEnabled(client, userId, guildId),
    reminder.getState(client, { userId, guildId, type: "mining" }),
    reminder.getState(client, { userId, guildId, type: "work" }),
    reminder.getState(client, { userId, guildId, type: "fish" }),
    reminder.getState(client, { userId, guildId, type: "crash" }),
    reminder.getState(client, { userId, guildId, type: "dungeon" }),
    reminder.getState(client, { userId, guildId, type: "farm" }),
    questNotifyPref.isDmEnabled(client, userId, guildId),
  ]);

  const states = {
    mining: !!miningState?.enabled,
    work: !!workState?.enabled,
    fish: !!fishState?.enabled,
    crash: !!crashState?.enabled,
    dungeon: !!dungeonState?.enabled,
    farm: !!farmState?.enabled,
    quest: !!questEnabled,
  };

  const onOff = (v) => (v ? "已開啟 🔔" : "已關閉 🔕");

  const container = new ContainerBuilder()
    .setAccentColor(masterEnabled ? 0x57f287 : 0x99aab5)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔔 通知設定\n` +
          `集中管理所有私訊提醒。提醒都需要你對機器人開放私訊（DM）。`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🟢 通知總開關**：${onOff(masterEnabled)}\n` +
          `-# 關閉後，下面所有提醒都會靜音；個別設定會保留，重新開啟即恢復。`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**⏰ 到點通知**（冷卻結束或體力補滿時私訊你）\n` +
          `${reminder.TYPE_META.mining.emoji} 挖礦：${onOff(states.mining)}\n` +
          `${reminder.TYPE_META.work.emoji} 打工：${onOff(states.work)}\n` +
          `${reminder.TYPE_META.fish.emoji} 釣魚：${onOff(states.fish)}\n` +
          `${reminder.TYPE_META.crash.emoji} 火箭：${onOff(states.crash)}\n` +
          `${reminder.TYPE_META.dungeon.emoji} 地下城體力：${onOff(states.dungeon)}\n` +
          `${reminder.TYPE_META.farm.emoji} 農場成熟：${onOff(states.farm)}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📜 任務完成 DM**：${onOff(states.quest)}\n` +
          `-# 只影響被動任務（發言／語音／表情／賭博／股市等）完成時的 DM；指令觸發的任務一律是私人回覆，不受影響。`
      )
    );

  if (!masterEnabled) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ⚠️ 通知總開關目前關閉中，即使個別開關顯示「開」也不會收到提醒。`
      )
    );
  }

  // 第一排：總開關。後兩排：各情境（一排最多 5 顆）。
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId("master", userId))
        .setLabel(`通知總開關：${masterEnabled ? "開" : "關"}`)
        .setEmoji(masterEnabled ? "🔔" : "🔕")
        .setStyle(masterEnabled ? ButtonStyle.Success : ButtonStyle.Danger)
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      toggleButton("mining", userId, states.mining, "挖礦到點"),
      toggleButton("work", userId, states.work, "打工到點"),
      toggleButton("fish", userId, states.fish, "釣魚到點"),
      toggleButton("crash", userId, states.crash, "火箭到點"),
      toggleButton("dungeon", userId, states.dungeon, "地下城體力")
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      toggleButton("farm", userId, states.farm, "農場成熟"),
      toggleButton("quest", userId, states.quest, "任務完成 DM")
    )
  );

  return container;
}

module.exports = {
  CUSTOM_ID_PREFIX,
  COOLDOWN_ACTIONS,
  buildCustomId,
  parseCustomId,
  buildContainer,
};
