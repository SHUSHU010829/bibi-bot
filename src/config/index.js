// 統一 config 入口：合併拆檔後的 JSON 區塊。
// 各區塊請改 src/config/<區塊>.json，merge conflict 才會局部化。
const server = require("./server");
const voting = require("./voting.json");
const suggestion = require("./suggestion.json");
const level = require("./level.json");
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
const welcome = require("./welcome.json");
const mining = require("./mining.json");
const work = require("./work.json");
const craft = require("./craft.json");
const dungeon = require("./dungeon.json");
const gift = require("./gift.json");
const twitchPerks = require("./twitch_perks.json");
const boosterPerks = require("./booster_perks.json");
const titles = require("./titles.json");
const donation = require("./donation.json");
const events = require("./events.json");
const eventFundraise = require("./eventFundraise.json");
const encounters = require("./encounters.json");
const marketplace = require("./marketplace.json");
const fishing = require("./fishing.json");
const farming = require("./farming.json");
const barter = require("./barter.json");
const treasureMap = require("./treasureMap.json");
const coinHistory = require("./coinHistory.json");
const boss = require("./boss.json");
const guildClub = require("./guild_club.json");
const guildWarehouse = require("./guild_warehouse.json");
const guildForge = require("./guild_forge.json");
const guildBuildings = require("./guild_buildings.json");
const guildBanquet = require("./guild_banquet.json");
const worldEvents = require("./world_events.json");
const survey = require("./survey");
const gameRoom = require("./gameRoom.json");
const rssWeeklySchedule = require("./rssWeeklySchedule.json");
const theft = require("./theft.json");
const bank = require("./bank.json");
const countdown = require("./countdown.json");
const dbMaintenance = require("./dbMaintenance.json");
const maintenance = require("./maintenance.json");

module.exports = {
  ...server,
  voting: voting,
  ...suggestion,
  ...level,
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
  ...welcome,
  ...mining,
  ...work,
  ...craft,
  ...dungeon,
  ...gift,
  ...twitchPerks,
  ...boosterPerks,
  ...titles,
  ...donation,
  ...events,
  ...eventFundraise,
  ...encounters,
  ...marketplace,
  ...fishing,
  ...farming,
  ...barter,
  ...treasureMap,
  ...coinHistory,
  ...boss,
  ...guildClub,
  ...guildWarehouse,
  ...guildForge,
  ...guildBuildings,
  ...guildBanquet,
  ...worldEvents,
  ...survey,
  ...gameRoom,
  ...rssWeeklySchedule,
  ...theft,
  ...bank,
  ...countdown,
  ...dbMaintenance,
  ...maintenance,
};
