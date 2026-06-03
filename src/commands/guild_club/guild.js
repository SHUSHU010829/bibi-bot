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
const guildClubQuest = require("../../features/guild_club/guildClubQuest");
const guildClubView = require("../../features/guild_club/guildClubView");
const guildClubAnnouncer = require("../../features/guild_club/guildClubAnnouncer");

// 公會指令類別白名單。Thread 走 parent channel 的 parentId（祖父類別）。
// 空 / 未設定 → 不限制。
function isChannelInAllowedCategory(channel) {
  const ids = guildClub?.allowedCategoryIds || [];
  if (ids.length === 0) return true;
  if (!channel) return false;
  const categoryId = channel.isThread?.()
    ? channel.parent?.parentId
    : channel.parentId;
  return !!categoryId && ids.includes(categoryId);
}

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
const SUB_QUEST = "任務";
const SUB_CLAIM = "領獎";
const SUB_RANK = "排行";

module.exports = {
  // /公會 自己會檢查 allowedCategoryIds，跳過全域桶分流以免兩層互打。
  skipChannelGuard: true,
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
    )
    .addSubcommand((sub) =>
      sub.setName(SUB_QUEST).setDescription("查看本週公會任務進度")
    )
    .addSubcommand((sub) =>
      sub
        .setName(SUB_CLAIM)
        .setDescription("一鍵領取所有達標的週任務獎勵（僅會長）")
    )
    .addSubcommand((sub) =>
      sub.setName(SUB_RANK).setDescription("查看伺服器公會排行榜")
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

    if (!isChannelInAllowedCategory(interaction.channel)) {
      const ids = guildClub?.allowedCategoryIds || [];
      const links = ids.map((id) => `<#${id}>`).join("、");
      return interaction.reply({
        components: [
          guildClubView.buildErrorContainer({
            title: "🔒 此頻道不能使用公會指令",
            body: `請至 ${links} 類別下的頻道使用 /公會。`,
            hint: "此限制適用於所有 /公會 subcommand。",
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
      if (sub === SUB_QUEST) return runQuest(client, interaction);
      if (sub === SUB_CLAIM) return runClaim(client, interaction);
      if (sub === SUB_RANK) return runRank(client, interaction);
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
  if (reason === "recreate_cooldown") {
    return guildClubView.buildErrorContainer({
      title: "🧊 解散冷卻中，暫不能再建公會",
      body: `你最近才解散過公會，請在 <t:${Math.floor(result.readyAt / 1000)}:R> 後再嘗試。`,
      hint: "此冷卻是為了防止「拉人→解散→分錢」的洗錢循環。",
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

  // 解散冷靜期：未過就直接擋下，不顯示確認 UI
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

  const members = await guildClubService.listMembers(
    client,
    club.guild_club_id
  );
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

// ───────── 任務 ─────────

async function runQuest(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const status = await guildClubQuest.getQuestStatus(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  if (!status.ok) {
    return interaction.editReply({
      components: [questStatusErrorView(status)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  return interaction.editReply({
    components: [
      guildClubView.buildQuestListContainer({
        viewerId: interaction.user.id,
        club: status.club,
        period: status.period,
        items: status.items,
        isLeader: status.isLeader,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 領獎 ─────────

async function runClaim(client, interaction) {
  await interaction.deferReply();

  const result = await guildClubQuest.claimAllReady(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });

  if (!result.ok) {
    return interaction.editReply({
      components: [questClaimErrorView(result)],
      flags: MessageFlags.IsComponentsV2,
    });
  }

  if (result.levelUp) {
    guildClubAnnouncer.announceLevelUp(client, result.levelUp).catch(() => {});
  }
  guildClubAnnouncer
    .announceQuestReward(client, {
      club: result.club,
      claimed: result.claimed,
      totalReward: result.totalReward,
      leaderId: interaction.user.id,
    })
    .catch(() => {});

  return interaction.editReply({
    components: [
      guildClubView.buildQuestClaimSuccessContainer({
        club: result.club,
        claimed: result.claimed,
        totalReward: result.totalReward,
        levelUp: result.levelUp,
        leaderId: interaction.user.id,
      }),
    ],
    flags: MessageFlags.IsComponentsV2,
  });
}

// ───────── 排行 ─────────

async function runRank(client, interaction) {
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

// ───────── 錯誤 view helpers ─────────

function questStatusErrorView(result) {
  if (result.reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "先加入公會才能查任務。",
    });
  if (result.reason === "club_missing")
    return guildClubView.buildErrorContainer({
      title: "❌ 公會資料異常",
      body: "公會已不存在。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 查詢失敗",
    body: `原因：${result.reason}`,
  });
}

function questClaimErrorView(result) {
  if (result.reason === "not_in_club")
    return guildClubView.buildErrorContainer({
      title: "🏰 你還沒加入公會",
      body: "沒有公會可領獎。",
    });
  if (result.reason === "not_leader")
    return guildClubView.buildErrorContainer({
      title: "🚫 只有會長可以領獎",
      body: "請會長執行 /公會 領獎。",
    });
  if (result.reason === "nothing_to_claim") {
    const lines = (result.items || []).map((q) => {
      const tag =
        q.state === "claimed" ? "🎁 已領取" : `🔄 ${q.progress}/${q.target}`;
      return `・${q.name}：${tag}`;
    });
    return guildClubView.buildErrorContainer({
      title: "🏆 目前沒有可領取的任務",
      body:
        lines.length > 0
          ? `本週任務狀態：\n${lines.join("\n")}`
          : "本週尚未設定任務。",
      hint: "繼續挖礦、打地下城、賭場玩起來，達標就能領。",
    });
  }
  if (result.reason === "all_claimed_by_other")
    return guildClubView.buildErrorContainer({
      title: "❌ 已被搶先領取",
      body: "別的途徑剛剛領完了。",
    });
  return guildClubView.buildErrorContainer({
    title: "❌ 領獎失敗",
    body: `原因：${result.reason}`,
  });
}

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
  if (reason === "invitee_rejoin_cooldown")
    return guildClubView.buildErrorContainer({
      title: "🧊 對方仍在退會冷卻",
      body: `對方最近才${result.source === "kicked_from_club" ? "被踢出" : "退出"}公會，需等到 <t:${Math.floor(result.readyAt / 1000)}:R> 才能加入新公會。`,
      hint: "此冷卻防止短期換會洗錢。",
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
  if (reason === "rejoin_cooldown") {
    return guildClubView.buildErrorContainer({
      title: "🧊 退會冷卻中，暫不能申請新公會",
      body: `你最近才${result.source === "kicked_from_club" ? "被踢出" : "退出"}公會，請在 <t:${Math.floor(result.readyAt / 1000)}:R> 後再申請。`,
      hint: "此冷卻防止短期換會洗錢。",
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
