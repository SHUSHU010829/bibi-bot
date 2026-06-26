// 把牌面代碼轉成 Discord 應用程式 emoji，取代 Canvas 生圖以降低伺服器負擔。
// 應用程式 emoji 不需加入各伺服器，bot 在任何地方都能用 <:name:id> 直接渲染。
//
// 牌面代碼沿用各牌局的 2 字元編碼：rank + suit
//   rank: A 2 3 4 5 6 7 8 9 T J Q K（T 在 emoji 名稱對應 "10"）
//   suit: S H D C
// emoji 名稱格式 <rank>_<suit>：例如 "AS" → A_S、"TD" → 10_D。

const { cards: CARD_IDS, backs: BACK_IDS, backDefault: BACK_DEFAULT } =
  require("../../config/cardEmojis.json");

const RANK_TO_NAME = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

function emojiTag(name, id) {
  return `<:${name}:${id}>`;
}

function cardEmoji(card) {
  const name = `${RANK_TO_NAME[card[0]]}_${card[1]}`;
  const id = CARD_IDS[name];
  return id ? emojiTag(name, id) : `[${card}]`;
}

function cardBackEmoji(color = BACK_DEFAULT) {
  const key = color in BACK_IDS ? color : BACK_DEFAULT;
  return emojiTag(`back_${key}`, BACK_IDS[key]);
}

function handEmojis(hand) {
  return hand.map(cardEmoji).join(" ");
}

module.exports = { cardEmoji, cardBackEmoji, handEmojis };
