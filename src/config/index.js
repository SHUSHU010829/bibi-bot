// 統一 config 入口：合併拆檔後的 JSON 區塊。
// 各區塊請改 src/config/<區塊>.json，merge conflict 才會局部化。
const server = require("./server.json");
const voting = require("./voting.json");
const suggestion = require("./suggestion.json");
const level = require("./level.json");
const steamDeals = require("./steamDeals.json");
const freeGames = require("./freeGames.json");
const twitch = require("./twitch.json");
const casino = require("./casino.json");
const shop = require("./shop.json");
const welfare = require("./welfare.json");
const quests = require("./quests.json");
const stocks = require("./stocks.json");
const stockEvents = require("./stockEvents.json");
const recommendation = require("./recommendation.json");
const invite = require("./invite.json");
const mining = require("./mining.json");
const work = require("./work.json");
const craft = require("./craft.json");
const dungeon = require("./dungeon.json");
const auction = require("./auction.json");

module.exports = {
  ...server,
  voting: voting,
  ...suggestion,
  ...level,
  ...steamDeals,
  ...freeGames,
  ...twitch,
  ...casino,
  ...shop,
  ...welfare,
  ...quests,
  ...stocks,
  ...stockEvents,
  ...recommendation,
  ...invite,
  ...mining,
  ...work,
  ...craft,
  ...dungeon,
  ...auction,
};
