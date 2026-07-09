require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { theft } = require("../../config");
const theftService = require("../../features/theft/theftService");
const {
  errorContainer,
  broadcast,
  reportBadEventContainer,
  reportBadEventBroadcast,
} = require("../../features/theft/theftView");
const { COIN_EMOJI } = require("../../constants/coin");

module.exports = {
  ephemeral: true,
  data: (() => {
    const builder = new SlashCommandBuilder()
      .setName("報案")
      .setDescription("花錢委託偵探，查出近期是誰偷了你的錢 🔎")
      .setContexts(InteractionContextType.Guild);
    builder.addStringOption((opt) => {
      opt.setName("偵探").setDescription("挑一位偵探——越貴查到率越高、越少出包").setRequired(false);
      for (const t of theftService.reportTiers()) {
        opt.addChoices({
          name: `${t.emoji} ${t.name}（${t.fee.toLocaleString()} 幣）· ${t.desc}`.slice(0, 100),
          value: t.key,
        });
      }
      return opt;
    });
    return builder;
  })(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!theft?.enabled || !client.theftLogsCollection) {
        return interaction.editReply("🔧 盜賊系統尚未啟動！");
      }

      const result = await theftService.report(client, {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.member?.displayName || interaction.user.username,
        tierKey: interaction.options.getString("偵探") || undefined,
      });

      const tierLabel = result.tier ? `${result.tier.emoji} ${result.tier.name}` : "偵探";

      if (!result.ok) {
        if (result.reason === "insufficient") {
          return interaction.editReply({
            components: [
              errorContainer(
                "💸 委託費不足",
                `委託 ${tierLabel} 需要 **${result.fee.toLocaleString()}** ${COIN_EMOJI}，你只有 **${result.have.toLocaleString()}**。`,
                "換便宜一點的偵探，或先賺點錢再來報案。"
              ),
            ],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply({
          components: [errorContainer("🔧 報案失敗", "系統忙碌或未啟動。", "稍後再試或呼叫舒舒。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      if (result.badEvent) {
        const extra = result.extraStolen || result.araleLoss || 0;
        broadcast(client, reportBadEventBroadcast(result.badEvent, interaction.user.id, tierLabel)).catch(
          () => {}
        );
        return interaction.editReply({
          components: [
            reportBadEventContainer(result.badEvent, {
              tierLabel,
              fee: result.fee,
              extra,
              ownerId: interaction.user.id,
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      if (result.noCase) {
        return interaction.editReply({
          components: [
            new ContainerBuilder()
              .setAccentColor(0x2ecc71)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  "# 🔎 沒有案件\n近期沒人偷過你，偵探費用不收。"
                )
              ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const container = new ContainerBuilder().setAccentColor(0x9b59b6);

      if (!result.found) {
        container
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 🔎 查無結果\n${tierLabel} 收了 **${result.fee.toLocaleString()}** ${COIN_EMOJI}，` +
                `近期有 ${result.totalCases} 起竊案，但線索太少查不出兇手…` +
                (result.refunded ? "\n（已退還委託費）" : "")
            )
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("-# 兇手很專業。換更高階的偵探（神探 / 王牌）查到率更高。")
          );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🔎 偵探回報\n${tierLabel} 收了 **${result.fee.toLocaleString()}** ${COIN_EMOJI}，查出以下嫌犯：` +
            (result.informant ? "\n🐦 **線人爆料**，直接鎖定了主嫌！" : "")
        )
      );
      for (const c of result.culprits) {
        const recover = Math.floor((c.amount || 0) / 2);
        const bountyAmount = theftService.bountyPlaceAmount(c.totalStolen ?? c.amount);
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `<@${c.actorId}>　偷了你 **${c.amount.toLocaleString()}** ${COIN_EMOJI}（${c.count} 次）`
            )
          )
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`theft_revenge_${interaction.user.id}_${c.actorId}`)
                .setLabel(`強制決鬥討回 ${recover.toLocaleString()}`)
                .setEmoji("🗡️")
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`theft_bounty_${interaction.user.id}_${c.actorId}`)
                .setLabel(`懸賞通緝 -${bountyAmount.toLocaleString()}`)
                .setEmoji("🎯")
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId(`theft_forgive_${interaction.user.id}_${c.actorId}`)
                .setLabel("放過他")
                .setEmoji("🕊️")
                .setStyle(ButtonStyle.Secondary)
            )
          );
      }
      const bountyPct = Math.round((theft?.report?.bountyPlacePct ?? 0.5) * 100);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 🗡️ 強制決鬥：對方不用同意，攻擊力高者勝；**贏了討回一半、每個兇手只能打一次**。\n" +
            `-# 🎯 懸賞通緝：付「被偷金額的 ${bountyPct}%」把他掛上通緝榜給全服追捕（按鈕上的數字就是要付的懸賞金），他不能自首；被抓你拿回贖罪金分成，逃掉賞金進治安基金。\n` +
            "-# 🕊️ 放過他：這筆帳一筆勾銷，之後報案不會再列出他。"
        )
      );

      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /報案:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 報案失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
