// /排行榜 dispatcher：根據選定類別 + 時間 fetch + 渲染 V2 container，
// 並掛上「類別下拉選單」與「時間區間按鈕」。

require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require("discord.js");

const {
  CATEGORIES,
  CAT_BY_KEY,
  PERIODS,
  periodLabel,
  normalize,
} = require("./categories");

// customId 設計
// - 類別下拉：lb_cat|<currentPeriod>   value = newCategory
// - 期間按鈕：lb_per|<category>|<newPeriod>
const SELECT_PREFIX = "lb_cat|";
const PERIOD_PREFIX = "lb_per|";

function isLeaderboardCustomId(customId) {
  return (
    typeof customId === "string" &&
    (customId.startsWith(SELECT_PREFIX) || customId.startsWith(PERIOD_PREFIX))
  );
}

function parseSelectCustomId(customId) {
  if (!customId?.startsWith(SELECT_PREFIX)) return null;
  const period = customId.slice(SELECT_PREFIX.length);
  return { period };
}

function parsePeriodCustomId(customId) {
  if (!customId?.startsWith(PERIOD_PREFIX)) return null;
  const parts = customId.slice(PERIOD_PREFIX.length).split("|");
  if (parts.length !== 2) return null;
  return { categoryKey: parts[0], period: parts[1] };
}

const MEDALS = ["🥇", "🥈", "🥉"];

function renderRows(rows) {
  return rows
    .map((row, idx) => {
      const medal = MEDALS[idx] || `**${idx + 1}.**`;
      return `${medal} ${row.mention} ・ ${row.detail}`;
    })
    .join("\n");
}

function buildCategorySelect(currentCategoryKey, currentPeriod) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${SELECT_PREFIX}${currentPeriod}`)
    .setPlaceholder("切換排行榜類別")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      CATEGORIES.map((c) => ({
        label: `${c.emoji} ${c.label}`,
        value: c.key,
        description: c.description,
        default: c.key === currentCategoryKey,
      }))
    );
  return new ActionRowBuilder().addComponents(menu);
}

function buildPeriodRow(cat, currentPeriod) {
  // 只有一個期間（如挖礦／等級）就不畫按鈕列
  if (cat.periods.length <= 1) return null;
  const buttons = cat.periods.map((p) =>
    new ButtonBuilder()
      .setCustomId(`${PERIOD_PREFIX}${cat.key}|${p}`)
      .setLabel(periodLabel(p))
      .setStyle(p === currentPeriod ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(p === currentPeriod)
  );
  return new ActionRowBuilder().addComponents(buttons);
}

function buildContainer({ cat, period, result }) {
  const container = new ContainerBuilder()
    .setAccentColor(cat.accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${cat.emoji} ${cat.label}排行榜 ・ ${periodLabel(period)}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
    );

  if (result.disabled) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(result.disabled)
    );
  } else if (!result.rows || result.rows.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        result.emptyHint || "📊 目前還沒有資料"
      )
    );
  } else {
    const top3 = result.rows.slice(0, 3);
    const rest = result.rows.slice(3);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(renderRows(top3))
    );
    if (rest.length > 0) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            rest
              .map((row, i) => {
                const num = i + 3 + 1;
                return `**${num}.** ${row.mention} ・ ${row.detail}`;
              })
              .join("\n")
          )
        );
    }
  }

  if (result.myRank && result.myDetail) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**你的排名**：#${result.myRank} ・ ${result.myDetail}`
        )
      );
  }

  if (result.footer) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${result.footer}`)
      );
  }

  return container;
}

async function renderLeaderboard(client, { categoryKey, period, interaction }) {
  const { cat, period: effPeriod } = normalize(categoryKey, period);

  let result;
  try {
    result = await cat.fetch(client, {
      guild: interaction.guild,
      guildId: interaction.guildId,
      viewerId: interaction.user.id,
      viewerMember: interaction.member,
      period: effPeriod,
    });
  } catch (error) {
    console.log(
      `[ERROR] /排行榜 fetch (${cat.key}/${effPeriod}):\n${error}\n${error.stack}`
        .red
    );
    result = { rows: [], disabled: "🔧 排行榜載入失敗，請稍後再試。" };
  }

  const container = buildContainer({ cat, period: effPeriod, result });
  const components = [container];
  components.push(buildCategorySelect(cat.key, effPeriod));
  const periodRow = buildPeriodRow(cat, effPeriod);
  if (periodRow) components.push(periodRow);

  return {
    components,
    flags: MessageFlags.IsComponentsV2,
  };
}

module.exports = {
  renderLeaderboard,
  isLeaderboardCustomId,
  parseSelectCustomId,
  parsePeriodCustomId,
  SELECT_PREFIX,
  PERIOD_PREFIX,
};
