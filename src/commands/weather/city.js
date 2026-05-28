require("colors");

const axios = require("axios");

const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

function randomColor() {
  return Math.floor(Math.random() * 0xffffff);
}

const VALID_LOCATIONS = [
  "臺北市",
  "新北市",
  "桃園市",
  "臺中市",
  "臺南市",
  "高雄市",
  "基隆市",
  "新竹市",
  "嘉義市",
  "新竹縣",
  "苗栗縣",
  "彰化縣",
  "南投縣",
  "雲林縣",
  "嘉義縣",
  "屏東縣",
  "宜蘭縣",
  "花蓮縣",
  "臺東縣",
  "澎湖縣",
  "金門縣",
  "連江縣",
];

// 縣市暱稱 / 簡寫對應，輸入這些字也能命中（僅放跟正式名不同的別名）
const LOCATION_ALIASES = {
  台北: "臺北市",
  北市: "臺北市",
  新北: "新北市",
  桃園: "桃園市",
  台中: "臺中市",
  中市: "臺中市",
  台南: "臺南市",
  南市: "臺南市",
  高雄: "高雄市",
  基隆: "基隆市",
  苗栗: "苗栗縣",
  彰化: "彰化縣",
  南投: "南投縣",
  雲林: "雲林縣",
  屏東: "屏東縣",
  宜蘭: "宜蘭縣",
  花蓮: "花蓮縣",
  台東: "臺東縣",
  澎湖: "澎湖縣",
  金門: "金門縣",
  連江: "連江縣",
  馬祖: "連江縣",
};

function normalizeLocation(input) {
  if (!input) return "";
  const trimmed = input.trim().replace(/^台/, "臺");
  if (VALID_LOCATIONS.includes(trimmed)) return trimmed;
  return LOCATION_ALIASES[input.trim()] || trimmed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("天氣")
    .setDescription("查詢個別縣市今日天氣預報 🌤️")
    .addStringOption((option) =>
      option
        .setName("縣市名稱")
        .setDescription("輸入或從建議中選擇縣市（支援「台北」「新北」「馬祖」等簡寫）")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "縣市名稱") {
      return interaction.respond([]).catch(() => {});
    }
    const query = (focused.value || "").trim().toLowerCase();
    const normalizedQuery = query.replace(/^台/, "臺");

    const results = VALID_LOCATIONS.filter((loc) => {
      if (!query) return true;
      if (loc.toLowerCase().includes(normalizedQuery)) return true;
      // 也支援用暱稱搜尋
      return Object.entries(LOCATION_ALIASES).some(
        ([alias, target]) =>
          target === loc && alias.toLowerCase().includes(query)
      );
    })
      .slice(0, 25)
      .map((loc) => ({ name: loc, value: loc }));

    await interaction.respond(results).catch(() => {});
  },

  run: async (client, interaction) => {
    const locationName = interaction.options.getString("縣市名稱");
    const modifiedLocationName = normalizeLocation(locationName);

    // 先驗證縣市名稱再 defer，避免使用者看到「抓取中」後又秒被打回
    if (!VALID_LOCATIONS.includes(modifiedLocationName)) {
      return interaction.reply({
        content:
          `我找不到 [${locationName}] 這個縣市 <a:think:1196806259152789514>\n` +
          `💡 試試從輸入時跳出的建議清單中挑一個吧！`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      const apiUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001?Authorization=${process.env.WEATHER_API_KEY}&locationName=${modifiedLocationName}`;
      const response = await axios.get(apiUrl);
      const weatherData = response.data;

      if (weatherData.success !== "true") {
        console.log(
          `[ERROR] Weather API returned non-success for ${modifiedLocationName}`
            .red
        );
        return interaction.editReply("哎呀！氣象局可能罷工了。");
      }

      const locationData = weatherData.records.location[0];
      const weatherElement = locationData.weatherElement;

      const weatherInfo = {
        weather: weatherElement[0].time[0].parameter.parameterName, // 天氣狀況 (Wx)
        precipitation: `${weatherElement[1].time[0].parameter.parameterName}%`, // 降雨機率 (PoP)
        temperature: `${weatherElement[2].time[0].parameter.parameterName}°C - ${weatherElement[4].time[0].parameter.parameterName}°C`, // 溫度範圍 (MinT 和 MaxT)
      };

      const container = new ContainerBuilder()
        .setAccentColor(randomColor())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 今日${locationData.locationName}天氣預報 🌤️\n` +
              `-# 資料來源：[中央氣象署](https://www.cwa.gov.tw/V8/C/)`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🔅 溫度**\n${weatherInfo.temperature}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🔅 降雨機率**\n${weatherInfo.precipitation}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**🔅 天氣狀況**\n${weatherInfo.weather}`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      await interaction.editReply("哎呀！氣象局可能罷工了。");
      console.log(
        `[ERROR] An error occurred inside the weather city data:\n${error}`.red
      );
    }
  },
};
