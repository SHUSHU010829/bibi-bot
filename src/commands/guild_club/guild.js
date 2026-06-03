require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { guildClub } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const guildClubService = require("../../features/guild_club/guildClubService");
const guildClubMembership = require("../../features/guild_club/guildClubMembership");
const guildClubView = require("../../features/guild_club/guildClubView");
const guildClubAnnouncer = require("../../features/guild_club/guildClubAnnouncer");

const SUB_CREATE = "建立";
const SUB_INFO = "資訊";
const SUB_DISBAND = "解散";
const SUB_INVITE = "邀請";
const SUB_APPLY = "申請";
const SUB_APPLICATIONS = "申請列表";
const SUB_LEAVE = "退會";
const SUB_KICK = "踢人";
const SUB_TRANSFER = "轉讓";
const SUB_DONATE = "捐款";

module.exports = {
  data: new SlashCommandBuilder()
    .setName("公會")
    .setDescription("公會系統 🏰")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName(SUB_CREATE)
        .setDescription(`建立公會（花費 ${guildClub?.createCost || 5000} 幣）`)
        .addStringOption((opt) =>
          opt
            .setName("名稱")
            .setDescription(
              `公會名稱（${guildClub?.name?.minLength || 1}–${guildClub?.name?.maxLength || 12} 字）`
            )
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_INFO)
        .setDescription("查看公會詳情（不填名稱＝查自己的公會）")
        .addStringOption((opt) =>
          opt
            .setName("名稱")
            .setDescription("公會名稱（不填則查你目前所屬的公會）")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_DISBAND)
        .setDescription("解散公會（僅會長可用，金庫平分給成員）")
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_INVITE)
        .setDescription("邀請玩家加入公會（僅會長）")
        .addUserOption((opt) =>
          opt.setName("使用者").setDescription("要邀請的玩家").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_APPLY)
        .setDescription("申請加入指定公會（會長批准後生效）")
        .addStringOption((opt) =>
          opt.setName("名稱").setDescription("公會名稱").setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("理由")
            .setDescription(
              `想跟會長說的話（最多 ${guildClub?.application?.messageMaxLength || 100} 字，可省略）`
            )
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_APPLICATIONS)
        .setDescription("查看 / 處理待審申請（僅會長）")
    )
    .addSubcommand((sub) =>
      sub.setName(SUB_LEAVE).setDescription("退出目前所屬公會")
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_KICK)
        .setDescription("踢出公會成員（僅會長）")
        .addUserOption((opt) =>
          opt.setName("使用者").setDescription("要踢出的成員").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_TRANSFER)
        .setDescription("把會長身分轉讓給其他成員")
        .addUserOption((opt) =>
          opt.setName("使用者").setDescription("新的會長").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_DONATE)
        .setDescription("捐款進公會金庫")
        .addIntegerOption((opt) =>
          opt
            .setName("金額")
            .setDescription("要捐多少幣（正整數）")
            .setRequired(true)
            .setMinValue(1)
        )
    ),

  run: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();

    if (!guildClub?.enabled) {
      return interaction.reply({
        components: [
          guildClubView.buildErrorContainer({
            title: "🔧 公會系統未啟用",
            body: "目前無法使用公會功能。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    try {
      if (sub === SUB_CREATE) return runCreate(client, interaction);
      if (sub === SUB_INFO) return runInfo(client, interaction);
      if (sub === SUB_DISBAND) return runDisband(client, interaction);
      if (sub === SUB_INVITE) return runInvite(client, interaction);
      if (sub === SUB_APPLY) return runApply(client, interaction);
      if (sub === SUB_APPLICATIONS) return runApplications(client, interaction);
      if (sub === SUB_LEAVE) return runLeave(client, interaction);
      if (sub === SUB_KICK) return runKick(client, interaction);
      if (sub === SUB_TRANSFER) return runTransfer(client, interaction);
      if (sub === SUB_DONATE) return runDonate(client, interaction);
    } catch (e) {
      console.log(`[GUILD_CLUB] /公會 ${sub} 失敗：${e.stack || e.message}`.red);
      const reply = {
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 操作失敗",
            body: "出了點狀況，請稍後再試。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  },
};

function createErrorView(result) {
  const { reason } = result;
  if (reason === "name_too_short") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱太短",
      body: `公會名稱至少要 ${result.min} 個字。`,
    });
  }
  if (reason === "name_too_long") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱太長",
      body: `公會名稱最多 ${result.max} 個字。`,
    });
  }
  if (reason === "name_forbidden_char") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱含禁字",
      body: `名稱不能包含「${result.char}」。`,
      hint: `禁字清單：${result.all.join("・")}`,
    });
  }
  if (reason === "name_taken") {
    return guildClubView.buildErrorContainer({
      title: "❌ 名稱已被使用",
      body: "本伺服器已有同名公會，請換一個名字。",
    });
  }
  if (reason === "already_in_club") {
    return guildClubView.buildErrorContainer({
      title: "❌ 你已在公會中",
      body: "每人在同一伺服器只能加入一個公會。",
      hint: "若想另立門戶，先 /公會 退會 或 /公會 解散。",
    });
  }
  if (reason === "insufficient_funds") {
    return guildClubView.buildErrorContainer({
      title: "❌ 餘額不足",
      body: `建立公會需要 ${result.need.toLocaleString()} ${COIN_EMOJI}，你目前有 ${result.have.toLocaleString()} ${COIN_EMOJI}。`,
      hint: "再去打工、挖礦或賣礦累積一下吧。",
    });
  }
  return guildClubView.buildErrorContainer({
    title: "❌ 建立失敗",
    body: `原因：${reason}`,
  });
}

async function runCreate(client, interaction) {
  await interaction.deferReply();
  const name = interaction.options.getString("名稱", true);

  const result = await guildClubService.create(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    name,
    member: interaction.member,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [createErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildCreateSuccessContainer({
        userId: interaction.user.id,
        club: result.club,
        cost: result.cost,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runInfo(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const queryName = interaction.options.getString("名稱");

  let club = null;
  if (queryName) {
    club = await guildClubService.getClubByName(
      client,
      interaction.guildId,
      queryName.trim()
    );
    if (!club) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 找不到公會",
            body: `本伺服器沒有名為「${queryName}」的公會。`,
            hint: "可用 /公會 排行 看看有哪些公會。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  } else {
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
            body: "可以等會長邀請、或用 /公會 申請 [名稱] 主動申請。",
            hint: "想自己當會長？/公會 建立 [名稱]（花費 5,000 幣）",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
    club = await guildClubService.getClubById(client, membership.guild_club_id);
    if (!club) {
      return interaction.editReply({
        components: [
          guildClubView.buildErrorContainer({
            title: "❌ 公會資料異常",
            body: "你所屬的公會已不存在，請聯絡管理員。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  }

  const members = await guildClubService.listMembers(client, club.guild_club_id);
  const viewerMembership = await guildClubService.getMembership(
    client,
    interaction.user.id,
    interaction.guildId
  );
  const isMember =
    !!viewerMembership && viewerMembership.guild_club_id === club.guild_club_id;
  const isLeader = isMember && viewerMembership.role === "leader";

  return interaction.editReply({
    components: [
      guildClubView.buildInfoContainer({
        viewerId: interaction.user.id,
        club,
        members,
        isMember,
        isLeader,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

async function runDisband(client, interaction) {
  await interaction.deferReply();

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

  const club = await guildClubService.getClubById(
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

  const members = await guildClubService.listMembers(
    client,
    club.guild_club_id
  );
  const memberCount = members.length;
  const payoutPerMember =
    memberCount > 0
      ? Math.floor((club.treasury_current || 0) / memberCount)
      : 0;

  return interaction.editReply({
    components: [
      guildClubView.buildDisbandConfirmContainer({
        leaderId: interaction.user.id,
        club,
        members,
        payoutPerMember,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 邀請 ─────────

async function runInvite(client, interaction) {
  await interaction.deferReply();
  const invitee = interaction.options.getUser("使用者", true);

  if (invitee.bot) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 不能邀請機器人",
          body: "請選擇真人玩家。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const result = await guildClubMembership.invite(client, {
    leaderId: interaction.user.id,
    guildId: interaction.guildId,
    inviteeId: invitee.id,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [inviteErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    content: `<@${invitee.id}>`,
    components: [
      guildClubView.buildInvitationContainer({
        inviterId: interaction.user.id,
        inviteeId: invitee.id,
        club: result.club,
        invitationId: result.invitation_id,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: [invitee.id] },
  });
}

// ───────── 申請 ─────────

async function runApply(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = interaction.options.getString("名稱", true);
  const message = interaction.options.getString("理由") || null;

  const result = await guildClubMembership.apply(client, {
    applicantId: interaction.user.id,
    guildId: interaction.guildId,
    clubName: name,
    message,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [applyErrorView(result, name)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [guildClubView.buildApplicationSentContainer({ club: result.club })],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 申請列表 ─────────

async function runApplications(client, interaction) {
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
                ? "請會長使用此指令處理申請。"
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

// ───────── 退會 ─────────

async function runLeave(client, interaction) {
  await interaction.deferReply();

  const result = await guildClubMembership.leave(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [leaveErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildLeaveSuccessContainer({
        club: result.club,
        userId: interaction.user.id,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 踢人 ─────────

async function runKick(client, interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser("使用者", true);

  const result = await guildClubMembership.kick(client, {
    leaderId: interaction.user.id,
    guildId: interaction.guildId,
    targetId: target.id,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 無法踢人",
          body:
            result.reason === "not_in_club"
              ? "你還沒加入公會。"
              : result.reason === "not_leader"
                ? "只有會長能踢人。"
                : result.reason === "cannot_kick_self"
                  ? "不能踢自己（要退會請用 /公會 退會）。"
                  : result.reason === "target_not_in_your_club"
                    ? `<@${target.id}> 不在你的公會。`
                    : `原因：${result.reason}`,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildKickSuccessContainer({
        club: result.club,
        targetId: target.id,
        leaderId: interaction.user.id,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 轉讓 ─────────

async function runTransfer(client, interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser("使用者", true);

  if (target.bot) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 不能轉讓給機器人",
          body: "請選擇真人成員。",
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  const result = await guildClubMembership.transfer(client, {
    leaderId: interaction.user.id,
    guildId: interaction.guildId,
    newLeaderId: target.id,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [
        guildClubView.buildErrorContainer({
          title: "❌ 無法轉讓",
          body:
            result.reason === "not_in_club"
              ? "你還沒加入公會。"
              : result.reason === "not_leader"
                ? "只有會長能轉讓。"
                : result.reason === "cannot_transfer_to_self"
                  ? "不能轉讓給自己。"
                  : result.reason === "target_not_in_your_club"
                    ? `<@${target.id}> 不在你的公會。`
                    : `原因：${result.reason}`,
        }),
      ],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildTransferSuccessContainer({
        club: result.club,
        oldLeaderId: interaction.user.id,
        newLeaderId: target.id,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 捐款 ─────────

async function runDonate(client, interaction) {
  await interaction.deferReply();
  const amount = interaction.options.getInteger("金額", true);

  const result = await guildClubService.donate(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    amount,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [donateErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  if (result.levelUp) {
    guildClubAnnouncer.announceLevelUp(client, result.levelUp).catch(() => {});
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
}

// ───────── 錯誤 view helpers ─────────

function donateErrorView(result) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "請先加入公會才能捐款。",
      hint: "/公會 申請 [名稱] 或等會長邀請。",
    });
  if (reason === "invalid_amount")
    return guildClubView.buildErrorContainer({
      title: "❌ 金額無效",
      body: "請輸入正整數。",
    });
  if (reason === "insufficient_funds")
    return guildClubView.buildErrorContainer({
      title: "❌ 餘額不足",
      body: `需要 ${result.need.toLocaleString()} ${COIN_EMOJI}，你目前有 ${result.have.toLocaleString()} ${COIN_EMOJI}。`,
      hint: "再去打工、挖礦或賣礦累積一下吧。",
    });
  if (reason === "club_missing")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會已解散",
      body: "捐款已退回。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 捐款失敗",
    body: `原因：${reason}`,
  });
}

function inviteErrorView(result) {
  const { reason } = result;
  if (reason === "leader_not_in_club" || reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "請先 /公會 建立 一個公會。",
    });
  if (reason === "not_leader")
    return guildClubView.buildErrorContainer({
      title: "🚫 只有會長能邀請",
      body: "請會長使用此指令。",
    });
  if (reason === "cannot_invite_self")
    return guildClubView.buildErrorContainer({
      title: "❌ 不能邀請自己",
      body: "你已經是會長了。",
    });
  if (reason === "invitee_already_in_this_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方已在你的公會",
      body: "不需重複邀請。",
    });
  if (reason === "invitee_in_other_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 對方已屬其他公會",
      body: "請對方先退會再來。",
    });
  if (reason === "club_full")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會已滿員",
      body: `目前 ${result.current}/${result.max}。`,
      hint: "升級公會可擴張人數上限。",
    });
  if (reason === "already_invited")
    return guildClubView.buildErrorContainer({
      title: "❌ 已有 pending 邀請",
      body: "請等對方先回覆上一張邀請。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 邀請失敗",
    body: `原因：${reason}`,
  });
}

function applyErrorView(result, name) {
  const { reason } = result;
  if (reason === "already_in_club")
    return guildClubView.buildErrorContainer({
      title: "❌ 你已在公會中",
      body: "請先 /公會 退會 後再申請其他公會。",
    });
  if (reason === "club_not_found")
    return guildClubView.buildErrorContainer({
      title: "❌ 找不到公會",
      body: `本伺服器沒有「${name}」這個公會。`,
      hint: "可用 /公會 排行 看看有哪些公會。",
    });
  if (reason === "club_full")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會已滿員",
      body: `目前 ${result.current}/${result.max}。`,
      hint: "等公會升級擴張人數，或挑別家。",
    });
  if (reason === "already_pending")
    return guildClubView.buildErrorContainer({
      title: "❌ 已有申請待審",
      body: "請等會長處理上一筆申請。",
    });
  if (reason === "rejected_cooldown") {
    const remainMs = Math.max(0, result.readyAt - Date.now());
    const remainMin = Math.ceil(remainMs / 60000);
    const remainHr = Math.floor(remainMin / 60);
    const remainTxt = remainHr >= 1 ? `${remainHr} 小時` : `${remainMin} 分鐘`;
    return guildClubView.buildErrorContainer({
      title: "❌ 冷卻中",
      body: `你最近被「${name}」拒絕過，請再等 ${remainTxt}。`,
    });
  }
  return guildClubView.buildErrorContainer({
    title: "❌ 申請失敗",
    body: `原因：${reason}`,
  });
}

function leaveErrorView(result) {
  const { reason } = result;
  if (reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你不在任何公會",
      body: "沒有公會可退。",
    });
  if (reason === "leader_with_members")
    return guildClubView.buildErrorContainer({
      title: "👑 會長不能直接退會",
      body: `公會還有 ${result.memberCount - 1} 名其他成員。`,
      hint: "請先 /公會 轉讓 給其他成員，或 /公會 解散 公會。",
    });
  if (reason === "leader_must_disband")
    return guildClubView.buildErrorContainer({
      title: "👑 你是唯一的成員",
      body: "請使用 /公會 解散 結束公會。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 退會失敗",
    body: `原因：${reason}`,
  });
}
