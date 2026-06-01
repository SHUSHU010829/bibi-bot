// server config：guild ID 與開發者白名單從環境變數讀（避免公開 repo 直接寫死）。
// 其餘 channel / role ID 屬於公開識別碼，留在 server.json。
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
};
