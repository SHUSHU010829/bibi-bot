const { DateTime } = require("luxon");
const { AttachmentBuilder } = require("discord.js");

const getStraw = require("./getStraw");
const getLunarInfo = require("./getLunarInfo");
const findNextSpecialDay = require("./findNextSpecialDay");
const buildCardData = require("./buildCardData");
const generateMorningCard = require("./generateMorningCard");

module.exports = async function buildMorningPayload({ timezone }) {
  const now = DateTime.now().setZone(timezone);
  const strawResult = await getStraw();
  const lunarInfo = await getLunarInfo(now.year, now.month, now.day);
  const { nextSpecialDay, daysUntilSpecialDay } = findNextSpecialDay(
    now,
    timezone
  );

  const cardData = buildCardData({
    now,
    lunarInfo,
    strawResult,
    nextSpecialDay,
    daysUntilSpecialDay,
  });

  const pngBuffer = await generateMorningCard(cardData);
  const fileName = `morning-${cardData.serialNo}.png`;
  const attachment = new AttachmentBuilder(pngBuffer, { name: fileName });

  return { cardData, pngBuffer, attachment, fileName };
};
