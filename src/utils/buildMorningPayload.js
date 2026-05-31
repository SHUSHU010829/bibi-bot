const { DateTime } = require("luxon");
const { AttachmentBuilder } = require("discord.js");

const { guildId } = require("../config");
const rankService = require("../features/mining/rankService");
const getStraw = require("./getStraw");
const getLunarInfo = require("./getLunarInfo");
const findNextSpecialDay = require("./findNextSpecialDay");
const buildCardData = require("./buildCardData");
const generateMorningCard = require("./generateMorningCard");

module.exports = async function buildMorningPayload({ timezone, client }) {
  const now = DateTime.now().setZone(timezone);
  const strawResult = await getStraw();
  const lunarInfo = await getLunarInfo(now.year, now.month, now.day);
  const { nextSpecialDay, daysUntilSpecialDay } = findNextSpecialDay(
    now,
    timezone
  );

  // 昨日全服挖到的鑽石總量（資料來自 mine_logs，僅統計挖礦掉落）
  const start = now.startOf("day").minus({ days: 1 }).toJSDate();
  const end = now.startOf("day").toJSDate();
  const diamondCount = await rankService
    .oreTotalInRange(client, guildId, "diamond", { start, end })
    .catch(() => 0);

  const cardData = buildCardData({
    now,
    lunarInfo,
    strawResult,
    nextSpecialDay,
    daysUntilSpecialDay,
    diamondCount,
  });

  const pngBuffer = await generateMorningCard(cardData);
  const fileName = `morning-${cardData.serialNo}.png`;
  const attachment = new AttachmentBuilder(pngBuffer, { name: fileName });

  return { cardData, pngBuffer, attachment, fileName };
};
