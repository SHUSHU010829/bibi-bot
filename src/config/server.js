// server config：把敏感 ID（guild、channel、role）改成從環境變數讀。
// 非敏感欄位（文案、cron、emoji）保留在 server.json。
const base = require("./server.json");

const parseList = (raw) =>
  (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
  ...base,

  serverId: process.env.GUILD_ID,
  developersId: parseList(process.env.DEVELOPER_IDS),

  normalChannelId: process.env.NORMAL_CHANNEL_ID,
  createVoiceChannelId: process.env.CREATE_VOICE_CHANNEL_ID,
  memberCountChannelId: process.env.MEMBER_COUNT_CHANNEL_ID,
  roleMessageChannelId: process.env.ROLE_MESSAGE_CHANNEL_ID,

  commandChannels: {
    general: parseList(process.env.CMD_CHANNELS_GENERAL),
    casino: parseList(process.env.CMD_CHANNELS_CASINO),
    stock: parseList(process.env.CMD_CHANNELS_STOCK),
    mining: parseList(process.env.CMD_CHANNELS_MINING),
    marketplace: parseList(process.env.CMD_CHANNELS_MARKETPLACE),
    fishing: parseList(process.env.CMD_CHANNELS_FISHING),
  },

  weeklyReport: {
    ...base.weeklyReport,
    channelId: process.env.WEEKLY_REPORT_CHANNEL_ID,
  },

  hostedEvents: {
    ...base.hostedEvents,
    publishChannelId: process.env.HOSTED_EVENTS_PUBLISH_CHANNEL_ID,
  },

  ticket: {
    ...base.ticket,
    categoryId: process.env.TICKET_CATEGORY_ID,
    supportRoleId: process.env.TICKET_SUPPORT_ROLE_ID,
  },
};
