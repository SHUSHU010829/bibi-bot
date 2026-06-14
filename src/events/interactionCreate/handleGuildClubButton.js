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
//   gc_view_<userId>                                 — 開啟資訊 ephemeral（自己公會）
//   gc_view_club_<userId>_<guildClubId>              — 從排行榜開啟指定公會 ephemeral
//   gc_rank_<userId>                                 — 開啟排行榜 ephemeral
//   gc_quest_claim_<leaderId>                        — 一鍵領取週任務獎勵
//   gc_kick_<leaderId>_<targetId>                    — 從資訊頁面踢人
//   gc_edit_desc_<userId>                            — 編輯公會簡介（彈出 Modal）
//   gc_desc_modal_<userId>                           — Modal submit：寫入簡介
//   gc_apps_<userId>                                 — 開啟待審申請列表（會長/副會長）
//   gc_manage_kick_<leaderId>                        — 公會管理：開啟踢人選單
//   gc_manage_transfer_<leaderId>                    — 公會管理：開啟轉讓選單
//   gc_manage_promote_vice_<leaderId>                — 公會管理：開啟指派副會長選單
//   gc_manage_demote_vice_<leaderId>                 — 公會管理：開啟撤銷副會長選單
//   gc_manage_disband_<leaderId>                     — 公會管理：開啟解散確認
//   gc_select_<mode>_<leaderId>                      — UserSelectMenu 選人完成
//   gc_transfer_confirm_<leaderId>_<targetId>        — 確定轉讓
//   gc_transfer_cancel_<leaderId>                    — 取消轉讓

require("colors");
const { MessageFlags } = require("discord.js");

const { guildWarehouse } = require("../../config");
const guildClubService = require("../../features/guild_club/guildClubService");
const guildClubMembership = require("../../features/guild_club/guildClubMembership");
const guildClubQuest = require("../../features/guild_club/guildClubQuest");
const guildClubView = require("../../features/guild_club/guildClubView");
const guildClubAnnouncer = require("../../features/guild_club/guildClubAnnouncer");
const guildClubContribution = require("../../features/guild_club/guildClubContribution");
const warehouseService = require("../../features/guild_club/warehouse/warehouseService");

async function loadClubAndMembers(client, guild_club_id) {
  const club = await guildClubService.getClubById(client, guild_club_id);
  if (!club) return null;
  const members = await guildClubService.listMembers(client, guild_club_id);
  return { club, members };
}

// 統一組出 /公會 資訊 首頁元件，讓各按鈕刷新路徑與 slash 指令呈現一致
// （建築等級 / 公會材料 / 倉庫摘要 / 功能快捷鈕）。
async function buildInfoView(client, interaction, { club, members, viewerMembership }) {
  const isMember =
    !!viewerMembership && viewerMembership.guild_club_id === club.guild_club_id;
  const viewerRole = isMember ? viewerMembership.role : null;
  const isLeader = viewerRole === "leader";

  let warehouseSummary = null;
  let warehouseInventory = null;
  if (isMember && (club.level || 1) >= (guildWarehouse?.unlockLevel || 2)) {
    warehouseSummary = await warehouseService
      .getSummary(client, club.guild_club_id)
      .catch(() => null);
    warehouseInventory = await warehouseService
      .getInventory(client, club.guild_club_id)
      .catch(() => []);
  }

  let pendingApplicationCount = 0;
  if (isLeader || viewerRole === "vice_leader") {
    pendingApplicationCount = await client.guildClubApplicationsCollection
      .countDocuments({ guild_club_id: club.guild_club_id, status: "pending" })
      .catch(() => 0);
  }

  return guildClubView.buildInfoContainer({
    viewerId: interaction.user.id,
    club,
    members,
    isMember,
    isLeader,
    viewerRole,
    warehouseSummary,
    warehouseInventory,
    pendingApplicationCount,
    guild: interaction.guild,
  });
}

module.exports = async (client, interaction) => {
  const id = interaction.customId || "";
  if (!id.startsWith("gc_")) return;

  if (interaction.isModalSubmit?.() && id.startsWith(guildClubView.EDIT_DESC_MODAL_PREFIX)) {
    return handleEditDescriptionSubmit(client, interaction);
  }

  if (interaction.isUserSelectMenu?.()) {
    if (id.startsWith("gc_select_kick_")) return handleManageSelect(client, interaction, "kick");
    if (id.startsWith("gc_select_transfer_")) return handleManageSelect(client, interaction, "transfer");
    if (id.startsWith("gc_select_promote_vice_")) return handleManageSelect(client, interaction, "promote_vice");
    if (id.startsWith("gc_select_demote_vice_")) return handleManageSelect(client, interaction, "demote_vice");
    return;
  }

  if (!interaction.isButton()) return;

  if (id.startsWith("gc_edit_desc_")) {
    return handleEditDescriptionButton(client, interaction);
  }

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
  if (id.startsWith("gc_view_club_")) {
    return handleViewClub(client, interaction);
  }
  if (id.startsWith("gc_view_")) {
    return handleQuickView(client, interaction);
  }
  if (id.startsWith("gc_contrib_")) {
    return handleContributionRank(client, interaction);
  }
  if (id.startsWith("gc_rank_")) {
    return handleQuickRank(client, interaction);
  }
  if (id.startsWith("gc_quest_claim_")) {
    return handleQuestClaim(client, interaction);
  }
  if (id.startsWith("gc_kick_")) {
    return handleQuickKick(client, interaction);
  }
  if (id.startsWith("gc_apps_")) {
    return handleOpenApplications(client, interaction);
  }
  if (id.startsWith("gc_manage_kick_")) return handleManageOpen(client, interaction, "kick");
  if (id.startsWith("gc_manage_transfer_")) return handleManageOpen(client, interaction, "transfer");
  if (id.startsWith("gc_manage_promote_vice_")) return handleManageOpen(client, interaction, "promote_vice");
  if (id.startsWith("gc_manage_demote_vice_")) return handleManageOpen(client, interaction, "demote_vice");
  if (id.startsWith("gc_manage_disband_")) return handleManageDisband(client, interaction);
  if (id.startsWith("gc_transfer_confirm_")) return handleTransferConfirm(client, interaction);
  if (id.startsWith("gc_transfer_cancel_")) return handleTransferCancel(client, interaction);
};

async function handleOpenApplications(client, interaction) {
  const ownerId = interaction.customId.slice("gc_apps_".length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的申請列表！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await guildClubMembership.listPendingApplications(client, {
    leaderId: interaction.user.id,
    guildId: interaction.guildId,
  });
  if (!result.ok) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: result.reason === "not_leader" ? "🚫 只有會長可以查看" : "❌ 無法查看",
          body:
            result.reason === "not_in_club"
              ? "你還沒加入公會。"
              : result.reason === "not_leader"
                ? "請會長使用此按鈕處理申請。"
                : `原因：${result.reason}`,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  return interaction.editReply({
    components: [
      guildClubView.buildApplicationListContainer({
        leaderId: interaction.user.id,
        club: result.club,
        applications: result.applications,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

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
            title: result.reason === "grace_period" ? "🧊 公會冷靜期中" : "❌ 解散失敗",
            body: disbandFailureBody(result.reason, result),
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
          eligibleCount: result.eligibleCount,
          ineligibleCount: result.ineligibleCount,
          payoutPerMember: result.payoutPerMember,
          lockedForfeit: result.lockedForfeit,
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

function disbandFailureBody(reason, result) {
  if (reason === "not_in_club") return "你已不在任何公會。";
  if (reason === "not_leader") return "你不是會長，無法解散公會。";
  if (reason === "club_missing") return "公會已不存在。";
  if (reason === "already_disbanded") return "公會已被解散。";
  if (reason === "grace_period")
    return `公會剛成立還在冷靜期，<t:${Math.floor(result.readyAt / 1000)}:R> 後才能解散。此冷靜期防止「建立→拉人→解散」洗錢循環。`;
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
            body: inviteFailureBody(result.reason, result),
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

function inviteFailureBody(reason, result) {
  if (reason === "invitation_missing") return "邀請已不存在。";
  if (reason === "not_invitee") return "這不是寫給你的邀請。";
  if (reason === "invitation_not_pending") return "邀請已被處理過。";
  if (reason === "invitation_expired") return "邀請已過期（7 天）。";
  if (reason === "club_missing") return "公會已解散。";
  if (reason === "already_in_club") return "你已經屬於另一個公會。";
  if (reason === "club_full") return "公會已滿員。";
  if (reason === "rejoin_cooldown")
    return `你最近才${result?.source === "kicked_from_club" ? "被踢出" : "退出"}公會，<t:${Math.floor(result.readyAt / 1000)}:R> 後才能加入新公會（防洗錢冷卻）。`;
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
            body: applicationFailureBody(result.reason, result),
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
      await buildInfoView(client, interaction, {
        club,
        members,
        viewerMembership: membership,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleContributionRank(client, interaction) {
  const ownerId = interaction.customId.slice("gc_contrib_".length);
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
          body: "加入公會後才能查看貢獻排行。",
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
  const weeklyTop = await guildClubContribution
    .getWeeklyTop(client, club.guild_club_id, 10)
    .catch(() => []);

  return interaction.editReply({
    components: [
      guildClubView.buildContributionRankContainer({
        viewerId: interaction.user.id,
        club,
        members,
        weeklyTop,
        guild: interaction.guild,
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

async function handleViewClub(client, interaction) {
  const rest = interaction.customId.slice("gc_view_club_".length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx <= 0) return;
  const ownerId = rest.slice(0, sepIdx);
  const guildClubId = rest.slice(sepIdx + 1);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的查看按鈕！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const loaded = await loadClubAndMembers(client, guildClubId);
  if (!loaded) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 公會已解散",
          body: "找不到這個公會。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const myMembership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  return interaction.editReply({
    components: [
      await buildInfoView(client, interaction, {
        club: loaded.club,
        members: loaded.members,
        viewerMembership: myMembership,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleQuickRank(client, interaction) {
  const ownerId = interaction.customId.slice("gc_rank_".length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的查看按鈕！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const clubs = await guildClubQuest.getLeaderboard(client, {
    guildId: interaction.guildId,
    limit: 10,
  });
  const myMembership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  return interaction.editReply({
    components: [
      guildClubView.buildLeaderboardContainer({
        viewerId: interaction.user.id,
        clubs,
        viewerClubId: myMembership?.guild_club_id || null,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleQuickKick(client, interaction) {
  const rest = interaction.customId.slice("gc_kick_".length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx <= 0) return;
  const leaderId = rest.slice(0, sepIdx);
  const targetId = rest.slice(sepIdx + 1);
  if (interaction.user.id !== leaderId) {
    return interaction.reply({
      content: "🚫 這不是你的踢人按鈕！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await guildClubMembership.kick(client, {
      leaderId: interaction.user.id,
      guildId: interaction.guildId,
      targetId,
    });
    if (!result.ok) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 踢人失敗",
            body:
              result.reason === "target_not_in_your_club"
                ? `<@${targetId}> 已不在你的公會（可能已退會）。`
                : result.reason === "cannot_kick_self"
                  ? "不能踢自己。"
                  : `原因：${result.reason}`,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    // 從 ephemeral 觸發的按鈕踢人不公開廣播（要公開請用 /公會 踢人）
    const loaded = await loadClubAndMembers(client, result.club.guild_club_id);
    if (!loaded) return;
    const myMembership = await guildClubService.getMembership(
      client,
      interaction.user.id,
      interaction.guildId
    );
    return interaction.editReply({
      components: [
        await buildInfoView(client, interaction, {
          club: loaded.club,
          members: loaded.members,
          viewerMembership: myMembership,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(`[GUILD_CLUB] quick kick 失敗：${e.stack || e.message}`.red);
  }
}

async function handleEditDescriptionButton(client, interaction) {
  const ownerId = interaction.customId.slice("gc_edit_desc_".length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的編輯按鈕！",
      flags: MessageFlags.Ephemeral,
    });
  }
  const membership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  if (!membership || !guildClubService.isManager(membership.role)) {
    return interaction.reply({
      components: [
        guildClubView.buildErrorContainer({
          title: "🚫 沒有編輯權限",
          body: "只有會長或副會長可以編輯公會簡介。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) {
    return interaction.reply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 公會已不存在",
          body: "找不到你的公會。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  }
  return interaction.showModal(
    guildClubView.buildEditDescriptionModal({
      userId: interaction.user.id,
      club,
    })
  );
}

async function handleEditDescriptionSubmit(client, interaction) {
  const ownerId = interaction.customId.slice(guildClubView.EDIT_DESC_MODAL_PREFIX.length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的編輯表單！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const raw = interaction.fields.getTextInputValue("gc_desc_text");
  try {
    const result = await guildClubService.setDescription(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      description: raw,
    });
    if (!result.ok) {
      return interaction.editReply({
        components: [editDescriptionFailureView(result)],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    return interaction.editReply({
      components: [
        guildClubView.buildDescriptionUpdatedContainer({
          club: result.club,
          cleared: result.cleared,
          role: result.role,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(`[GUILD_CLUB] edit description 失敗：${e.stack || e.message}`.red);
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 更新失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
}

function editDescriptionFailureView(result) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你已不在公會",
      body: "沒有公會可編輯。",
    });
  if (reason === "not_manager")
    return guildClubView.buildErrorContainer({
      title: "🚫 沒有編輯權限",
      body: "只有會長或副會長可以編輯公會簡介。",
    });
  if (reason === "club_missing")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會已不存在",
      body: "公會已解散。",
    });
  if (reason === "description_too_long")
    return guildClubView.buildErrorContainer({
      title: "❌ 內容過長",
      body: `最多 ${result.max} 字，目前 ${result.length} 字。`,
      hint: "精簡一下再送出。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 更新失敗",
    body: `原因：${reason}`,
  });
}

function questClaimFailureBody(result) {
  if (result.reason === "not_leader") return "只有會長能領獎。";
  if (result.reason === "nothing_to_claim") return "目前沒有可領取的任務。";
  if (result.reason === "all_claimed_by_other") return "別的途徑剛剛領完了。";
  if (result.reason === "club_missing") return "公會已解散。";
  return `原因：${result.reason}`;
}

async function handleManageOpen(client, interaction, mode) {
  const prefix = `gc_manage_${mode}_`;
  const ownerId = interaction.customId.slice(prefix.length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的管理按鈕！",
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
          title: "🏰 你已不在公會",
          body: "沒有公會可管理。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const leaderOnly = mode !== "kick";
  if (leaderOnly && membership.role !== "leader") {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "🚫 只有會長能操作",
          body: "此功能僅會長可用。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  if (mode === "kick" && !guildClubService.isManager(membership.role)) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "🚫 沒有踢人權限",
          body: "只有會長或副會長能踢人。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 公會資料異常",
          body: "公會已不存在。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  return interaction.editReply({
    components: [
      guildClubView.buildManagePanelContainer({
        viewerId: interaction.user.id,
        mode,
        club,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleManageDisband(client, interaction) {
  const ownerId = interaction.customId.slice("gc_manage_disband_".length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的解散按鈕！",
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
          body: "沒有公會可解散。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  if (membership.role !== "leader") {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "🚫 只有會長能解散公會",
          body: "如要退出公會，請使用 /公會 退會。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  let club = await guildClubService.getClubById(
    client,
    membership.guild_club_id
  );
  if (!club) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 公會資料異常",
          body: "公會已不存在。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }
  const graceMs = guildClubService.hoursToMs(
    guildClubService.antiLaunderingCfg().newClubGracePeriodHours
  );
  if (graceMs > 0 && club.created_at) {
    const readyAt = new Date(club.created_at).getTime() + graceMs;
    if (Date.now() < readyAt) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "🧊 公會冷靜期中",
            body: `公會剛成立還在冷靜期，<t:${Math.floor(readyAt / 1000)}:R> 後才能解散。`,
            hint: "此冷靜期防止「建立→拉人→解散」的洗錢循環。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }
  club = await guildClubService.settleLockedTreasury(client, club);
  const members = await guildClubService.listMembers(client, club.guild_club_id);
  const tenureMs = guildClubService.hoursToMs(
    guildClubService.antiLaunderingCfg().memberPayoutMinTenureHours
  );
  const eligibleMembers = guildClubService.eligibleForPayout(members, tenureMs);
  const eligibleCount = eligibleMembers.length;
  const ineligibleCount = members.length - eligibleCount;
  const payoutPerMember =
    eligibleCount > 0
      ? Math.floor((club.treasury_current || 0) / eligibleCount)
      : 0;
  return interaction.editReply({
    components: [
      guildClubView.buildDisbandConfirmContainer({
        leaderId: interaction.user.id,
        club,
        members,
        eligibleCount,
        ineligibleCount,
        payoutPerMember,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function handleManageSelect(client, interaction, mode) {
  const prefix = `gc_select_${mode}_`;
  const ownerId = interaction.customId.slice(prefix.length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的選單！",
      flags: MessageFlags.Ephemeral,
    });
  }
  const targetId = interaction.values?.[0];
  if (!targetId) return;
  await interaction.deferUpdate();

  try {
    if (mode === "kick") {
      const result = await guildClubMembership.kick(client, {
        leaderId: interaction.user.id,
        guildId: interaction.guildId,
        targetId,
      });
      if (!result.ok) {
        return interaction.editReply({
          components: [
            guildClubView.buildErrorContainer({
              title: "❌ 踢人失敗",
              body: kickFailureBody(result, targetId),
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply({
        components: [
          guildClubView.buildKickSuccessContainer({
            club: result.club,
            targetId,
            leaderId: interaction.user.id,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    if (mode === "transfer") {
      const club = await guildClubService.getClubById(
        client,
        (await guildClubService.getMembership(
          client,
          interaction.user.id,
          interaction.guildId
        ))?.guild_club_id
      );
      if (!club) {
        return interaction.editReply({
          components: [
            guildClubView.buildErrorContainer({
              title: "❌ 公會資料異常",
              body: "公會已不存在。",
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply({
        components: [
          guildClubView.buildTransferConfirmContainer({
            viewerId: interaction.user.id,
            club,
            targetId,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    if (mode === "promote_vice") {
      const result = await guildClubMembership.promoteViceLeader(client, {
        leaderId: interaction.user.id,
        guildId: interaction.guildId,
        targetId,
      });
      if (!result.ok) {
        return interaction.editReply({
          components: [promoteViceFailureView(result, targetId)],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply({
        components: [
          guildClubView.buildPromoteViceSuccessContainer({
            club: result.club,
            leaderId: interaction.user.id,
            targetId,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    if (mode === "demote_vice") {
      const result = await guildClubMembership.demoteViceLeader(client, {
        leaderId: interaction.user.id,
        guildId: interaction.guildId,
        targetId,
      });
      if (!result.ok) {
        return interaction.editReply({
          components: [demoteViceFailureView(result, targetId)],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply({
        components: [
          guildClubView.buildDemoteViceSuccessContainer({
            club: result.club,
            leaderId: interaction.user.id,
            targetId,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  } catch (e) {
    console.log(`[GUILD_CLUB] manage_select(${mode}) 失敗：${e.stack || e.message}`.red);
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 操作失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    }).catch(() => {});
  }
}

async function handleTransferConfirm(client, interaction) {
  const rest = interaction.customId.slice("gc_transfer_confirm_".length);
  const sepIdx = rest.indexOf("_");
  if (sepIdx <= 0) return;
  const ownerId = rest.slice(0, sepIdx);
  const targetId = rest.slice(sepIdx + 1);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的轉讓確認！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferUpdate();
  try {
    const result = await guildClubMembership.transfer(client, {
      leaderId: interaction.user.id,
      guildId: interaction.guildId,
      newLeaderId: targetId,
    });
    if (!result.ok) {
      return interaction.editReply({
        components: [transferFailureView(result, targetId)],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    return interaction.editReply({
      components: [
        guildClubView.buildTransferSuccessContainer({
          club: result.club,
          oldLeaderId: interaction.user.id,
          newLeaderId: targetId,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    console.log(`[GUILD_CLUB] transfer_confirm 失敗：${e.stack || e.message}`.red);
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 轉讓失敗",
          body: "出了點狀況，請稍後再試。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    }).catch(() => {});
  }
}

async function handleTransferCancel(client, interaction) {
  const ownerId = interaction.customId.slice("gc_transfer_cancel_".length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "🚫 這不是你的轉讓確認！",
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferUpdate();
  return interaction.editReply({
    components: [
      guildClubView.buildErrorContainer({
        title: "✅ 已取消轉讓",
        body: "會長身分維持不變。",
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

function kickFailureBody(result, targetId) {
  const { reason } = result;
  if (reason === "not_in_club") return "你已不在公會。";
  if (reason === "not_leader") return "你不是會長 / 副會長。";
  if (reason === "cannot_kick_self") return "不能踢自己（要退會請用 /公會 退會）。";
  if (reason === "target_not_in_your_club") return `<@${targetId}> 不在你的公會。`;
  return `原因：${reason}`;
}

function transferFailureView(result, targetId) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你已不在公會",
      body: "沒有公會可轉讓。",
    });
  if (reason === "not_leader")
    return guildClubView.buildErrorContainer({
      title: "🚫 只有會長能轉讓",
      body: "請會長使用此功能。",
    });
  if (reason === "cannot_transfer_to_self")
    return guildClubView.buildErrorContainer({
      title: "❌ 不能轉讓給自己",
      body: "請選擇其他成員。",
    });
  if (reason === "target_not_in_your_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方不在你的公會",
      body: `<@${targetId}> 不在你的公會。`,
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 轉讓失敗",
    body: `原因：${reason}`,
  });
}

function promoteViceFailureView(result, targetId) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你已不在公會",
      body: "沒有公會可管理。",
    });
  if (reason === "not_leader")
    return guildClubView.buildErrorContainer({
      title: "🚫 只有會長可指派副會長",
      body: "請會長使用此功能。",
    });
  if (reason === "cannot_promote_self")
    return guildClubView.buildErrorContainer({
      title: "❌ 不能指派自己",
      body: "你已經是會長了。",
    });
  if (reason === "target_not_in_your_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方不在你的公會",
      body: `<@${targetId}> 不在你的公會。`,
    });
  if (reason === "already_vice_leader")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方已經是副會長",
      body: `<@${targetId}> 已經是副會長。`,
    });
  if (reason === "target_is_leader")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方是會長",
      body: "會長不能被指派為副會長。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 指派失敗",
    body: `原因：${reason}`,
  });
}

function demoteViceFailureView(result, targetId) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你已不在公會",
      body: "沒有公會可管理。",
    });
  if (reason === "not_leader")
    return guildClubView.buildErrorContainer({
      title: "🚫 只有會長可撤銷副會長",
      body: "請會長使用此功能。",
    });
  if (reason === "target_not_in_your_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方不在你的公會",
      body: `<@${targetId}> 不在你的公會。`,
    });
  if (reason === "target_not_vice_leader")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方不是副會長",
      body: `<@${targetId}> 不是副會長，無需撤銷。`,
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 撤銷失敗",
    body: `原因：${reason}`,
  });
}

function applicationFailureBody(reason, result) {
  if (reason === "application_missing") return "申請已不存在。";
  if (reason === "not_your_club_application") return "這不是你公會的申請。";
  if (reason === "application_not_pending") return "申請已被處理過。";
  if (reason === "club_missing") return "公會已解散。";
  if (reason === "applicant_already_in_club") return "申請者已加入其他公會。";
  if (reason === "club_full") return "公會已滿員。";
  if (reason === "not_in_club") return "你不在任何公會。";
  if (reason === "not_leader") return "你不是會長。";
  if (reason === "applicant_rejoin_cooldown")
    return `申請者最近才${result?.source === "kicked_from_club" ? "被踢出" : "退出"}公會，<t:${Math.floor(result.readyAt / 1000)}:R> 後才能加入新公會（防洗錢冷卻）。`;
  return `原因：${reason}`;
}
