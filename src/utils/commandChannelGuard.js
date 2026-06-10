require("colors");

const fs = require("fs");
const path = require("path");
const { PermissionFlagsBits } = require("discord.js");

const COMMANDS_ROOT = path.join(__dirname, "..", "commands");

// 依資料夾分流到頻道桶：casino 資料夾→賭場頻道、stock→股票頻道、其餘→一般頻道。
const FOLDER_BUCKET = {
  casino: "casino",
  stock: "stock",
  mining: "mining",
  fishing: "fishing",
  farm: "farm",
  shop: "marketplace",
  boss: "boss",
  ask: "citizen",
  draw: "citizen",
  food: "citizen",
  post: "citizen",
  recommendation: "citizen",
  roles: "citizen",
  ticket: "citizen",
  weather: "citizen",
};
const DEFAULT_BUCKET = "general";

// 指令名稱 -> 所屬資料夾（首次呼叫時掃描一次後快取）
let folderMap = null;
function getFolderMap() {
  if (folderMap) return folderMap;
  folderMap = {};
  const folders = fs
    .readdirSync(COMMANDS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const folder of folders) {
    const dir = path.join(COMMANDS_ROOT, folder);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      try {
        const mod = require(path.join(dir, file));
        if (mod?.data?.name) folderMap[mod.data.name] = folder;
      } catch {
        /* 載入失敗的指令略過，不影響頻道判斷 */
      }
    }
  }
  return folderMap;
}

function isAdminCommand(commandObject) {
  const bit = PermissionFlagsBits.Administrator;
  const dmp = commandObject?.data?.default_member_permissions;
  if (dmp != null) {
    try {
      if ((BigInt(dmp) & bit) === bit) return true;
    } catch {
      /* noop */
    }
  }
  return (commandObject?.userPermissions || []).some(
    (p) => p === "Administrator" || p === bit,
  );
}

// 回傳該指令允許使用的頻道清單；null = 不限制（豁免）。
// 豁免條件：標記 ephemeral 的私人指令、管理員 / 開發者指令。
//
// 指令可在 module 上覆寫 `channelBuckets: ["general", "mining", …]`，
// 同時收進多個 bucket 對應的所有頻道（用於跨領域的查看類指令）。
function allowedChannelsFor(commandObject, restrictions) {
  if (!commandObject?.data?.name || !restrictions) return null;
  if (commandObject.ephemeral === true) return null;
  if (commandObject.skipChannelGuard === true) return null;
  if (commandObject.devOnly || isAdminCommand(commandObject)) return null;

  const explicit = commandObject.channelBuckets;
  if (Array.isArray(explicit) && explicit.length) {
    const channels = explicit.flatMap((b) => restrictions[b] || []);
    return channels.length ? channels : null;
  }

  const folder = getFolderMap()[commandObject.data.name];
  const bucket = FOLDER_BUCKET[folder] || DEFAULT_BUCKET;
  const channels = restrictions[bucket];
  return Array.isArray(channels) && channels.length ? channels : null;
}

module.exports = { allowedChannelsFor, isAdminCommand };
