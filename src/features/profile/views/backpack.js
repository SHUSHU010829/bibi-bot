// 背包分頁：沿用 features/shop/backpackView 的 buildBackpackView，
// 把它原本附帶的 IsComponentsV2 / Ephemeral 旗標統一交由 /檔案 dispatcher 處理。
require("colors");
const { mining, shop } = require("../../../config");
const { buildBackpackView: buildRaw } = require("../../shop/backpackView");

async function buildBackpackView(client, { target, member, guildId }) {
  if (!mining?.enabled && !shop?.enabled) {
    return { content: "🔧 背包系統尚未啟動！" };
  }

  const view = await buildRaw(client, {
    userId: target.id,
    guildId,
    displayName: member?.displayName || target.username,
  });

  return {
    useV2: true,
    components: view.components,
  };
}

module.exports = { buildBackpackView };
