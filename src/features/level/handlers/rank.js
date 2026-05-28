require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require("discord.js");

const { getLevelProgress } = require("../../../utils/levelMath");
const { getTier } = require("../../../utils/levelTier");
const { getTwitchSubBonus } = require("../../../utils/twitchSubBonus");
const { getServerBoostBonus } = require("../../../utils/serverBoostBonus");

function getPersonalMultiplier(member) {
  if (!member) return 1;
  const sub = getTwitchSubBonus(member);
  const boost = getServerBoostBonus(member);
  return sub.multiplier * boost.multiplier;
}

function formatMultiplier(mult) {
  return Number.isInteger(mult) ? `${mult}` : `${mult.toFixed(2)}`;
}

const PAGE_SIZE = 10;
const PAGINATION_TIMEOUT = 5 * 60 * 1000;

function buildButtons(currentPage, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("first")
      .setLabel("⏮️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId("prev")
      .setLabel("◀️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId("page_info")
      .setLabel(`${currentPage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("next")
      .setLabel("▶️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === totalPages - 1),
    new ButtonBuilder()
      .setCustomId("last")
      .setLabel("⏭️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(currentPage === totalPages - 1)
  );
}

function renderRow(doc, globalIndex, memberMap) {
  const prog = getLevelProgress(doc.totalXp);
  const tier = getTier(prog.level);
  const medals = ["🥇", "🥈", "🥉"];
  const medal = medals[globalIndex] || `**${globalIndex + 1}.**`;

  const member = memberMap?.get(doc.userId);
  const totalMult = getPersonalMultiplier(member);
  const bonusBadge = totalMult > 1 ? ` ✨x${formatMultiplier(totalMult)}` : "";

  return `${medal} <@${doc.userId}> ・ ${tier.emoji} **Lv.${prog.level}** ・ ${doc.totalXp.toLocaleString()} XP${bonusBadge}`;
}

async function buildMemberMap(guild, docs) {
  const map = new Map();
  if (!guild) return map;
  const missing = [];
  for (const d of docs) {
    const cached = guild.members.cache.get(d.userId);
    if (cached) map.set(d.userId, cached);
    else missing.push(d.userId);
  }
  if (missing.length > 0) {
    try {
      const fetched = await guild.members.fetch({ user: missing });
      fetched.forEach((m) => map.set(m.id, m));
    } catch {
      /* 部分成員可能已離開伺服器，忽略 */
    }
  }
  return map;
}

function buildContainer({
  pageDocs,
  currentPage,
  totalPages,
  total,
  myRank,
  myDoc,
  memberMap,
  myMember,
  withControls = true,
}) {
  const container = new ContainerBuilder()
    .setAccentColor(0xffd700)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🏆 等級排行榜`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
    );

  if (pageDocs.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("（這頁沒有資料）")
    );
  } else {
    const offset = currentPage * PAGE_SIZE;
    const lines = pageDocs.map((d, i) => renderRow(d, offset + i, memberMap));

    if (currentPage === 0 && pageDocs.length > 3) {
      const top3 = lines.slice(0, 3).join("\n");
      const rest = lines.slice(3).join("\n");
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(top3)
      );
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(rest)
        );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join("\n"))
      );
    }
  }

  if (myRank && myDoc) {
    const myProg = getLevelProgress(myDoc.totalXp);
    const myTier = getTier(myProg.level);
    const myMult = getPersonalMultiplier(myMember);
    const myBonusBadge = myMult > 1 ? ` ✨x${formatMultiplier(myMult)}` : "";
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**你的排名**：#${myRank} ・ ${myTier.emoji} Lv.${myProg.level} ・ ${myDoc.totalXp.toLocaleString()} XP${myBonusBadge}`
        )
      );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 第 ${currentPage + 1} / ${totalPages} 頁 ・ 共 ${total} 人 ・ 用 \`/檔案\` 看詳細卡片`
      )
    );

  if (totalPages > 1 && withControls) {
    container.addActionRowComponents(buildButtons(currentPage, totalPages));
  }

  return container;
}

async function fetchPage(client, guildId, page) {
  return client.userLevelsCollection
    .find({ guildId })
    .sort({ totalXp: -1 })
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .toArray();
}

async function run(client, interaction) {
  await interaction.deferReply();

  try {
    if (!client.userLevelsCollection) {
      return interaction.editReply("🔧 等級系統尚未啟動");
    }

    const total = await client.userLevelsCollection.countDocuments({
      guildId: interaction.guildId,
    });

    if (total === 0) {
      return interaction.editReply("📊 還沒有人累積等級資料～");
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const myDoc = await client.userLevelsCollection.findOne({
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    let myRank = null;
    if (myDoc) {
      myRank =
        (await client.userLevelsCollection.countDocuments({
          guildId: interaction.guildId,
          totalXp: { $gt: myDoc.totalXp },
        })) + 1;
    }

    let currentPage = 0;
    let pageDocs = await fetchPage(client, interaction.guildId, currentPage);
    let memberMap = await buildMemberMap(interaction.guild, pageDocs);

    const message = await interaction.editReply({
      components: [
        buildContainer({
          pageDocs,
          currentPage,
          totalPages,
          total,
          myRank,
          myDoc,
          memberMap,
          myMember: interaction.member,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });

    if (totalPages <= 1) return;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: PAGINATION_TIMEOUT,
    });

    collector.on("collect", async (btn) => {
      switch (btn.customId) {
        case "first":
          currentPage = 0;
          break;
        case "prev":
          currentPage = Math.max(0, currentPage - 1);
          break;
        case "next":
          currentPage = Math.min(totalPages - 1, currentPage + 1);
          break;
        case "last":
          currentPage = totalPages - 1;
          break;
      }

      pageDocs = await fetchPage(client, interaction.guildId, currentPage);
      memberMap = await buildMemberMap(interaction.guild, pageDocs);

      await btn.update({
        components: [
          buildContainer({
            pageDocs,
            currentPage,
            totalPages,
            total,
            myRank,
            myDoc,
            memberMap,
            myMember: interaction.member,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    });

    collector.on("end", () => {
      interaction
        .editReply({
          components: [
            buildContainer({
              pageDocs,
              currentPage,
              totalPages,
              total,
              myRank,
              myDoc,
              memberMap,
              myMember: interaction.member,
              withControls: false,
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => {});
    });
  } catch (error) {
    console.log(`[ERROR] /level rank:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 排行榜載入失敗！").catch(() => {});
  }
}

module.exports = { run };
