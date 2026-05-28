require("colors");
const { ObjectId } = require("mongodb");
const { assignColorRole, removeColorRole } = require("./roleColor");

// 將一筆 inventory item 設為 equipped；同類型只能裝備一件
async function equipItem(client, { userId, guildId, member, guild, inventoryId, titleText }) {
  if (!client.userInventoryCollection) {
    return { ok: false, error: "商店系統尚未就緒" };
  }
  let _id;
  try {
    _id = new ObjectId(inventoryId);
  } catch (e) {
    return { ok: false, error: "背包 ID 格式錯誤" };
  }
  const item = await client.userInventoryCollection.findOne({
    _id,
    userId,
    guildId,
  });
  if (!item) return { ok: false, error: "找不到該背包道具" };

  // 過期檢查
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) {
    return { ok: false, error: "這個道具已過期了" };
  }

  // 同類型其他已裝備 → 卸下（role_color 額外要把 Discord 身份組拿掉）
  const sameType = await client.userInventoryCollection
    .find({ userId, guildId, type: item.type, equipped: true })
    .toArray();
  for (const s of sameType) {
    if (s._id.equals(_id)) continue;
    if (s.type === "role_color" && guild && member && s.payload?.hex) {
      await removeColorRole(client, { guild, member, hex: s.payload.hex });
    }
    await client.userInventoryCollection.updateOne(
      { _id: s._id },
      { $set: { equipped: false, updatedAt: new Date() } },
    );
  }

  if (item.type === "role_color") {
    if (!guild || !member) return { ok: false, error: "缺少 guild/member 上下文" };
    const result = await assignColorRole(client, {
      guild,
      member,
      hex: item.payload?.hex,
      roleName: item.payload?.roleName || "Color",
    });
    if (!result.ok) return result;
  }

  if (item.type === "custom_title") {
    if (!titleText || !titleText.trim()) {
      return { ok: false, error: "請提供稱號文字（titleText）" };
    }
    const trimmed = titleText.trim().slice(0, 24);
    if (client.userLevelsCollection) {
      await client.userLevelsCollection.updateOne(
        { userId, guildId },
        { $set: { title: trimmed, updatedAt: new Date() } },
        { upsert: true },
      );
    }
    item.payload = { ...(item.payload || {}), title: trimmed };
  }

  if (item.type === "wallet_theme") {
    if (client.userLevelsCollection) {
      await client.userLevelsCollection.updateOne(
        { userId, guildId },
        {
          $set: {
            walletTheme: item.payload?.themeId || "default",
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  if (item.type === "card_accent") {
    if (client.userLevelsCollection) {
      await client.userLevelsCollection.updateOne(
        { userId, guildId },
        {
          $set: {
            cardAccent: item.payload?.themeKey || "default",
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  await client.userInventoryCollection.updateOne(
    { _id },
    {
      $set: {
        equipped: true,
        payload: item.payload,
        updatedAt: new Date(),
      },
    },
  );

  return { ok: true, item };
}

module.exports = equipItem;
