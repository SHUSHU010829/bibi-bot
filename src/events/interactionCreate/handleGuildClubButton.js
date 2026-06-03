// 公會系統按鈕處理器（Phase A）
//
// customId 格式：
//   gc_disband_confirm_<leaderId>_<guildClubId>  — 確定解散
//   gc_disband_cancel_<leaderId>                 — 取消解散

require("colors");
const { MessageFlags } = require("discord.js");

const guildClubService = require("../../features/guild_club/guildClubService");
const guildClubView = require("../../features/guild_club/guildClubView");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const id = interaction.customId || "";
  if (!id.startsWith("gc_")) return;

  if (id.startsWith("gc_disband_confirm_")) {
    return handleDisbandConfirm(client, interaction);
  }
  if (id.startsWith("gc_disband_cancel_")) {
    return handleDisbandCancel(client, interaction);
  }
};

async function handleDisbandConfirm(client, interaction) {
  const rest = interaction.customId.slice("gc_disband_confirm_".length);
  const sepIdx = rest.indexOf("_");
  const leaderId = sepIdx > 0 ? rest.slice(0, sepIdx) : rest;
  const guildClubId = sepIdx > 0 ? rest.slice(sepIdx + 1) : null;

  if (interaction.user.id !== leaderId) {
    return interaction.reply({
      content: "🚫 這不是你的解散確認！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();

  try {
    const result = await guildClubService.disband(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
    });

    if (!result.ok) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 解散失敗",
            body: disbandFailureBody(result.reason),
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    return interaction.editReply({
      components: [
        guildClubView.buildDisbandSuccessContainer({
          club: result.club,
          memberCount: result.memberCount,
          payoutPerMember: result.payoutPerMember,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(`[GUILD_CLUB] disband_confirm 失敗：${e.stack || e.message}`.red);
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 解散失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
}

async function handleDisbandCancel(client, interaction) {
  const leaderId = interaction.customId.slice("gc_disband_cancel_".length);
  if (interaction.user.id !== leaderId) {
    return interaction.reply({
      content: "🚫 這不是你的解散確認！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferUpdate();
  return interaction.editReply({
    components: [
      guildClubView.buildErrorContainer({
        title: "✅ 已取消解散",
        body: "公會仍在，繼續加油。",
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

function disbandFailureBody(reason) {
  if (reason === "not_in_club") return "你已不在任何公會。";
  if (reason === "not_leader") return "你不是會長，無法解散公會。";
  if (reason === "club_missing") return "公會已不存在。";
  if (reason === "already_disbanded") return "公會已被解散。";
  return `原因：${reason}`;
}
