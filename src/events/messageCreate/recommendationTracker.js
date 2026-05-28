require("colors");

const config = require("../../config");
const {
  extractMapUrls,
  looksLikeRecommendation,
  stripUrls,
} = require("../../utils/recommendationParser");
const {
  analyzeRecommendation,
} = require("../../services/recommendationClassifier");
const { fetchMapMetaForUrls } = require("../../services/mapMetaFetcher");
const { MessageFlags } = require("discord.js");
const {
  buildClassifyComponents,
  buildClassifyContainer,
} = require("../../features/recommendation/classifyUI");

module.exports = async (client, message) => {
  if (message.author?.bot) return;
  if (!message.guild) return;

  const channelId = config.recommendation?.channelId;
  if (!channelId || message.channel.id !== channelId) return;

  const minTextLength = config.recommendation?.minTextLength ?? 2;
  const content = message.content || "";
  if (!looksLikeRecommendation(content, minTextLength)) return;

  const collection = client.recommendationsCollection;
  if (!collection) return;

  try {
    const mapUrls = extractMapUrls(content);
    const cleanText = stripUrls(content);

    const mapMetas = await fetchMapMetaForUrls(mapUrls);
    const analysis = await analyzeRecommendation(content, { mapMetas });

    const attachments = Array.from(message.attachments?.values?.() || [])
      .map((a) => a.url)
      .filter(Boolean);

    const doc = {
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guild.id,
      authorId: message.author.id,
      authorName: message.author.username,
      authorTag: message.author.tag || message.author.username,
      content,
      cleanText,
      mapUrls,
      mapMetas,
      attachments,
      messageUrl: `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
      type: analysis.type,
      cuisine: analysis.cuisine,
      mealTimes: analysis.mealTimes,
      area: analysis.area,
      name: analysis.name,
      summary: analysis.summary,
      keywords: analysis.keywords,
      classifyConfirmed: false,
      createdAt: message.createdAt || new Date(),
      updatedAt: new Date(),
    };

    await collection.updateOne(
      { messageId: message.id },
      { $set: doc },
      { upsert: true },
    );

    console.log(
      `[Recommendation] 記錄推薦：${doc.name || "(無名)"} [${doc.type}] by ${doc.authorName}`
        .cyan,
    );

    // 在頻道公開回覆分類確認提示；按下「確認」後會自動刪除
    try {
      const container = buildClassifyContainer(doc);
      for (const row of buildClassifyComponents(message.id, doc.type)) {
        container.addActionRowComponents(row);
      }
      const prompt = await message.reply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { repliedUser: false },
      });

      await collection.updateOne(
        { messageId: message.id },
        { $set: { classifyPromptId: prompt.id } },
      );
    } catch (promptError) {
      console.log(
        `[Recommendation] 發送分類確認提示失敗：${promptError.message}`.yellow,
      );
    }
  } catch (error) {
    console.log(`[ERROR] 推薦追蹤失敗：\n${error}`.red);
  }
};
