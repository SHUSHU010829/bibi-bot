const { buildChoices } = require("../../utils/choiceInput");

// 食物名稱的選項來源：autocomplete 清單與「刪除」的輸入解析共用同一份。
// 同名分屬不同飲料店時顯示會加上店名，但 value 一定是食物名稱本身（依名稱刪除）。
const FOOD_NAME_STRIP = [/\([^)]*\)/g];

async function foodNameChoices(client, interaction) {
  const collection = client.collection;
  if (!collection) return [];

  const category = interaction.options.getString("類別");
  const beverageStore = interaction.options.getString("飲料店");

  const filter = {};
  if (category) filter.category = category;
  if (category === "beverage" && beverageStore) filter.beverageStore = beverageStore;

  const docs = await collection
    .find(filter, { projection: { name: 1, beverageStore: 1, category: 1 } })
    .limit(200)
    .toArray();

  const seen = new Set();
  const items = [];
  for (const doc of docs) {
    if (!doc.name) continue;
    const label =
      doc.category === "beverage" && doc.beverageStore
        ? `${doc.name}（${doc.beverageStore}）`
        : doc.name;
    const key = `${label}|${doc.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ label, name: doc.name });
  }

  return buildChoices(items, (it) => ({ name: it.label, value: it.name, search: it.name }));
}

module.exports = { foodNameChoices, FOOD_NAME_STRIP };
