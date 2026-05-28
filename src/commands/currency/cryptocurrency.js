require("colors");

const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const getCryptocurrency = require("../../utils/getCryptocurrency");
const { MONEY_EMOJI } = require("../../constants/coin");

// 常見幣種，提供 autocomplete 建議
const POPULAR_COINS = [
  { code: "BTC", label: "比特幣 BTC" },
  { code: "ETH", label: "以太幣 ETH" },
  { code: "USDT", label: "泰達幣 USDT" },
  { code: "BNB", label: "幣安幣 BNB" },
  { code: "SOL", label: "Solana SOL" },
  { code: "XRP", label: "瑞波幣 XRP" },
  { code: "USDC", label: "USDC" },
  { code: "ADA", label: "Cardano ADA" },
  { code: "DOGE", label: "狗狗幣 DOGE" },
  { code: "TRX", label: "波場幣 TRX" },
  { code: "AVAX", label: "Avalanche AVAX" },
  { code: "DOT", label: "波卡 DOT" },
  { code: "MATIC", label: "Polygon MATIC" },
  { code: "LTC", label: "萊特幣 LTC" },
  { code: "SHIB", label: "柴犬幣 SHIB" },
  { code: "LINK", label: "Chainlink LINK" },
  { code: "ATOM", label: "Cosmos ATOM" },
  { code: "BCH", label: "比特幣現金 BCH" },
  { code: "NEAR", label: "NEAR Protocol NEAR" },
  { code: "APT", label: "Aptos APT" },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("加密貨幣")
    .setDescription("查詢加密貨幣即時美金報價（資料來源：CryptoCompare）")
    .addStringOption((option) =>
      option
        .setName("貨幣代碼")
        .setDescription("輸入或選擇幣種代碼，例：BTC、ETH、SOL")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  autocomplete: async (client, interaction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "貨幣代碼") {
      return interaction.respond([]).catch(() => {});
    }
    const query = (focused.value || "").trim().toLowerCase();
    const results = POPULAR_COINS.filter(
      (c) =>
        !query ||
        c.code.toLowerCase().includes(query) ||
        c.label.toLowerCase().includes(query)
    )
      .slice(0, 25)
      .map((c) => ({ name: c.label, value: c.code }));
    await interaction.respond(results).catch(() => {});
  },

  run: async (client, interaction) => {
    const rawCoin = interaction.options.getString("貨幣代碼") || "";
    const coin = rawCoin.trim().toUpperCase();

    if (!coin) {
      return interaction.reply({
        content: "❌ 請輸入加密貨幣代碼（例：BTC）。",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      const cryptocurrencyData = await getCryptocurrency(coin);

      if (cryptocurrencyData && cryptocurrencyData.USD != null) {
        const price = Number(cryptocurrencyData.USD);
        const formattedPrice =
          price >= 1
            ? price.toLocaleString("en-US", { maximumFractionDigits: 2 })
            : price.toString();

        const container = new ContainerBuilder()
          .setAccentColor(0xf7931a)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `即時價格 ⬇️\n# ${MONEY_EMOJI} ${coin} 即時報價`,
            ),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**價格 (USD)**\n\`$${formattedPrice}\``,
            ),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `-# 資料來源：CryptoCompare ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
            ),
          );

        await interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      } else {
        await interaction.editReply(
          `❌ 找不到 \`${coin}\` 的報價。\n` +
            `💡 請輸入有效的幣種代碼（如：BTC、ETH），輸入時可從建議清單挑選。`
        );
      }
    } catch (error) {
      await interaction.editReply("發生錯誤，無法完成查詢。");
      console.log(
        `[ERROR] An error occurred inside the cryptocurrency:\n${error}`.red
      );
    }
  },
};
