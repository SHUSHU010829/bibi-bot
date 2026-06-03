// 公會系統按鈕處理器（Phase A）
//
// customId 格式：
//   gc_disband_confirm_<leaderId>_<guildClubId>      — 確定解散
//   gc_disband_cancel_<leaderId>                     — 取消解散
//   gc_invite_accept_<inviteeId>_<invitationId>      — 接受邀請
//   gc_invite_decline_<inviteeId>_<invitationId>     — 婉拒邀請
//   gc_app_approve_<leaderId>_<applicationId>        — 批准申請
//   gc_app_reject_<leaderId>_<applicationId>         — 拒絕申請
//   gc_donate_<userId>_<amount>                      — 快捷再捐款
//   gc_view_<userId>                                 — 開啟資訊 ephemeral
//   gc_quest_claim_<leaderId>                        — 一鍵領取週任務獎勵

require("colors");
const { MessageFlags } = require("discord.js");

const guildClubService = require("../../features/guild_club/guildClubService");
const guildClubMembership = require("../../features/guild_club/guildClubMembership");
const guildClubQuest = require("../../features/guild_club/guildClubQuest");
const guildClubView = require("../../features/guild_club/guildClubView");
const guildClubAnnouncer = require("../../features/guild_club/guildClubAnnouncer");

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
  if (id.startsWith("gc_invite_accept_") || id.startsWith("gc_invite_decline_")) {
    return handleInviteResponse(client, interaction);
  }
  if (id.startsWith("gc_app_approve_") || id.startsWith("gc_app_reject_")) {
    return handleApplicationResponse(client, interaction);
  }
  if (id.startsWith("gc_donate_")) {
    return handleQuickDonate(client, interaction);
  }
  if (id.startsWith("gc_view_")) {
    return handleQuickView(client, interaction);
  }
  if (id.startsWith("gc_quest_claim_")) {
    return handleQuestClaim(client, interaction);
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

async function handleInviteResponse(client, interaction) {
  const id = interaction.customId;
  const accept = id.startsWith("gc_invite_accept_");
  const prefix = accept ? "gc_invite_accept_" : "gc_invite_decline_";
  const rest = id.slice(prefix.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx <= 0) return;
  const inviteeId = rest.slice(0, sepIdx);
  const invitationId = rest.slice(sepIdx + 1);

  if (interaction.user.id !== inviteeId) {
    return interaction.reply({
      content: "🚫 這不是你的邀請！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();

  try {
    const result = await guildClubMembership.respondInvitation(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      invitation_id: invitationId,
      accept,
    });

    if (!result.ok) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: accept ? "❌ 無法加入" : "❌ 婉拒失敗",
            body: inviteFailureBody(result.reason),
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    if (result.accepted) {
      return interaction.editReply({
        components: [
          guildClubView.buildJoinAnnouncementContainer({
            userId: interaction.user.id,
            club: result.club,
            via: "invite",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "🙅 邀請已婉拒",
          body: `<@${interaction.user.id}> 婉拒了這次邀請。`,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(
      `[GUILD_CLUB] invite response 失敗：${e.stack || e.message}`.red
    );
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 處理失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
}

function inviteFailureBody(reason) {
  if (reason === "invitation_missing") return "邀請已不存在。";
  if (reason === "not_invitee") return "這不是寫給你的邀請。";
  if (reason === "invitation_not_pending") return "邀請已被處理過。";
  if (reason === "invitation_expired") return "邀請已過期（7 天）。";
  if (reason === "club_missing") return "公會已解散。";
  if (reason === "already_in_club") return "你已經屬於另一個公會。";
  if (reason === "club_full") return "公會已滿員。";
  return `原因：${reason}`;
}

async function handleApplicationResponse(client, interaction) {
  const id = interaction.customId;
  const approve = id.startsWith("gc_app_approve_");
  const prefix = approve ? "gc_app_approve_" : "gc_app_reject_";
  const rest = id.slice(prefix.length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx <= 0) return;
  const leaderId = rest.slice(0, sepIdx);
  const applicationId = rest.slice(sepIdx + 1);

  if (interaction.user.id !== leaderId) {
    return interaction.reply({
      content: "🚫 這不是你的申請列表！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();

  try {
    const result = await guildClubMembership.respondApplication(client, {
      leaderId: interaction.user.id,
      guildId: interaction.guildId,
      application_id: applicationId,
      approve,
    });

    if (!result.ok) {
      return interaction.followUp({
        components: [
          guildClubView.buildErrorContainer({
            title: approve ? "❌ 批准失敗" : "❌ 拒絕失敗",
            body: applicationFailureBody(result.reason),
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    // 批准成功 → 公開公告新成員加入
    if (result.approved) {
      await interaction.followUp({
        components: [
          guildClubView.buildJoinAnnouncementContainer({
            userId: result.applicantId,
            club: result.club,
            via: "application",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      }).catch(() => {});
    }

    // 不論批准或拒絕，刷新會長的申請列表（移除已處理那筆）
    const refreshed = await guildClubMembership.listPendingApplications(client, {
      leaderId: interaction.user.id,
      guildId: interaction.guildId,
    });
    if (refreshed.ok) {
      return interaction.editReply({
        components: [
          guildClubView.buildApplicationListContainer({
            leaderId: interaction.user.id,
            club: refreshed.club,
            applications: refreshed.applications,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  } catch (e) {
    console.log(
      `[GUILD_CLUB] application response 失敗：${e.stack || e.message}`.red
    );
    return interaction.followUp({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 處理失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

async function handleQuickDonate(client, interaction) {
  const rest = interaction.customId.slice("gc_donate_".length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx <= 0) return;
  const ownerId = rest.slice(0, sepIdx);
  const amountStr = rest.slice(sepIdx + 1);
  const amount = parseInt(amountStr, 10);

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的捐款按鈕！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();

  try {
    const result = await guildClubService.donate(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      member: interaction.member,
      amount,
    });

    if (!result.ok) {
      return interaction.followUp({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 捐款失敗",
            body: donateFailureBody(result),
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    if (result.levelUp) {
      guildClubAnnouncer
        .announceLevelUp(client, result.levelUp)
        .catch(() => {});
    }

    return interaction.editReply({
      components: [
        guildClubView.buildDonateSuccessContainer({
          userId: interaction.user.id,
          club: result.club,
          donated: result.donated,
          totalDonated: result.totalDonated,
          levelUp: result.levelUp,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(
      `[GUILD_CLUB] quick donate 失敗：${e.stack || e.message}`.red
    );
    return interaction.followUp({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 捐款失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

function donateFailureBody(result) {
  const { reason } = result;
  if (reason === "not_in_club") return "你已不在公會。";
  if (reason === "invalid_amount") return "金額無效。";
  if (reason === "insufficient_funds")
    return `需要 ${result.need.toLocaleString()}，你目前有 ${result.have.toLocaleString()}。`;
  if (reason === "club_missing") return "公會已解散，捐款已退回。";
  return `原因：${reason}`;
}

async function handleQuickView(client, interaction) {
  const ownerId = interaction.customId.slice("gc_view_".length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的查看按鈕！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "🏰 你還沒加入公會",
          body: "可以等會長邀請、或用 /公會 申請。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const club = await guildClubService.getClubById(
    client,
    membership.guild_club_id
  );
  if (!club) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 公會資料異常",
          body: "你所屬的公會已不存在。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const members = await guildClubService.listMembers(client, club.guild_club_id);

  return interaction.editReply({
    components: [
      guildClubView.buildInfoContainer({
        viewerId: interaction.user.id,
        club,
        members,
        isMember: true,
        isLeader: membership.role === "leader",
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleQuestClaim(client, interaction) {
  const leaderId = interaction.customId.slice("gc_quest_claim_".length);
  if (interaction.user.id !== leaderId) {
    return interaction.reply({
      content: "🚫 這不是你的領獎按鈕！",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();

  try {
    const result = await guildClubQuest.claimAllReady(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    if (!result.ok) {
      return interaction.followUp({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 領獎失敗",
            body: questClaimFailureBody(result),
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    if (result.levelUp) {
      guildClubAnnouncer
        .announceLevelUp(client, result.levelUp)
        .catch(() => {});
    }
    guildClubAnnouncer
      .announceQuestReward(client, {
        club: result.club,
        claimed: result.claimed,
        totalReward: result.totalReward,
        leaderId: interaction.user.id,
      })
      .catch(() => {});

    const refreshed = await guildClubQuest.getQuestStatus(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    if (refreshed.ok) {
      return interaction.editReply({
        components: [
          guildClubView.buildQuestListContainer({
            viewerId: interaction.user.id,
            club: refreshed.club,
            period: refreshed.period,
            items: refreshed.items,
            isLeader: refreshed.isLeader,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  } catch (e) {
    console.log(
      `[GUILD_CLUB] quest claim 失敗：${e.stack || e.message}`.red
    );
    return interaction.followUp({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 領獎失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

function questClaimFailureBody(result) {
  if (result.reason === "not_leader") return "只有會長能領獎。";
  if (result.reason === "nothing_to_claim") return "目前沒有可領取的任務。";
  if (result.reason === "all_claimed_by_other") return "別的途徑剛剛領完了。";
  if (result.reason === "club_missing") return "公會已解散。";
  return `原因：${result.reason}`;
}

function applicationFailureBody(reason) {
  if (reason === "application_missing") return "申請已不存在。";
  if (reason === "not_your_club_application") return "這不是你公會的申請。";
  if (reason === "application_not_pending") return "申請已被處理過。";
  if (reason === "club_missing") return "公會已解散。";
  if (reason === "applicant_already_in_club") return "申請者已加入其他公會。";
  if (reason === "club_full") return "公會已滿員。";
  if (reason === "not_in_club") return "你不在任何公會。";
  if (reason === "not_leader") return "你不是會長。";
  return `原因：${reason}`;
}
