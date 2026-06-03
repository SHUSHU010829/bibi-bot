const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { guildClub } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const { levelDef, nextLevelDef, maxLevel } = require("./guildClubService");

const COLOR_GOLD = 0xf1c40f;
const COLOR_ERROR = 0xe74c3c;
const COLOR_WARN = 0xe67e22;
const COLOR_SUCCESS = 0x2ecc71;

const BUFF_LABELS = {
  mining_qty_bonus: (v) => `挖礦每次數量 +${v}`,
  mining_luck_pct: (v) => `挖礦 luck +${Math.round(v * 100)}%（吃 luckCap）`,
  work_income_multiplier: (v) => `打工收入 +${Math.round(v * 100)}%`,
  dungeon_stamina_max: (v) => `地下城體力上限 +${v}`,
};

const formatBuff = (b) => {
  const fn = BUFF_LABELS[b.type];
  return fn ? fn(b.value) : `${b.type}: ${b.value}`;
};

function buildInfoContainer({
  viewerId,
  club,
  members,
  isMember,
  isLeader,
}) {
  const def = levelDef(club.level);
  const next = nextLevelDef(club.level);
  const container = new ContainerBuilder().setAccentColor(COLOR_GOLD);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🏰 ${club.name}　Lv.${club.level}${club.level >= maxLevel() ? "（已滿級）" : ""}`
    )
  );
  container.addSeparatorComponents(new SeparatorBuilder());

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `會長：<@${club.leader_id}>　成員：${members.length}/${club.max_members}`
    )
  );

  const treasuryLine = next
    ? `金庫（累積）：${(club.treasury || 0).toLocaleString()} / ${next.threshold.toLocaleString()} ${COIN_EMOJI}\n餘額（可分配）：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`
    : `金庫（累積）：${(club.treasury || 0).toLocaleString()} ${COIN_EMOJI}\n餘額（可分配）：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(treasuryLine)
  );

  container.addSeparatorComponents(new SeparatorBuilder());

  if (def.buffs.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**共享 Buff**\n-# 尚未解鎖，達成 Lv.2 後開始解鎖`
      )
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**共享 Buff**\n${def.buffs.map((b) => `・${formatBuff(b)}`).join("\n")}`
      )
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  if (members.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**成員**\n-# 尚無成員`)
    );
  } else {
    const lines = members.map((m) => {
      const role = m.role === "leader" ? "👑" : "・";
      const donated = (m.total_donated || 0).toLocaleString();
      return `${role} <@${m.userId}>　捐款 ${donated} ${COIN_EMOJI}`;
    });
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**成員**\n${lines.join("\n")}`)
    );
  }

  if (isLeader) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 你是會長。可使用 /公會 邀請、/公會 申請列表、/公會 解散 等指令。`
      )
    );
  } else if (!isMember) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 想加入？等會長邀請，或使用 /公會 申請 ${club.name}`
      )
    );
  }

  return container;
}

function buildCreateSuccessContainer({ userId, club, cost }) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ 公會「${club.name}」成立！`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${userId}> 花費 ${cost.toLocaleString()} ${COIN_EMOJI} 創立了公會。\n等級 Lv.1　人數上限 ${club.max_members} 人`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 下一步：用 /公會 邀請 @user 邀請成員，累積金庫升級解鎖 Buff。`
      )
    );
  return container;
}

function buildDisbandConfirmContainer({ leaderId, club, members, payoutPerMember }) {
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_WARN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ⚠️ 確定要解散「${club.name}」？`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `成員 ${members.length} 人　餘額 ${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}\n→ 每人可分得 **${payoutPerMember.toLocaleString()} ${COIN_EMOJI}**`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 此操作不可逆，公會資料會被歸檔。`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gc_disband_confirm_${leaderId}_${club.guild_club_id}`)
          .setLabel("確定解散")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`gc_disband_cancel_${leaderId}`)
          .setLabel("取消")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  return container;
}

function buildDisbandSuccessContainer({ club, memberCount, payoutPerMember }) {
  const totalPaid = payoutPerMember * memberCount;
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_WARN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💔 公會「${club.name}」已解散`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${memberCount} 名成員平分 ${totalPaid.toLocaleString()} ${COIN_EMOJI}\n每人分得 ${payoutPerMember.toLocaleString()} ${COIN_EMOJI}`
      )
    );
  return container;
}

function buildInvitationContainer({ inviterId, inviteeId, club, invitationId }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_GOLD)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📨 公會邀請\n<@${inviterId}> 邀請 <@${inviteeId}> 加入「${club.name}」（Lv.${club.level}）`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 7 天內未回覆將自動失效。`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gc_invite_accept_${inviteeId}_${invitationId}`)
          .setLabel("加入")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`gc_invite_decline_${inviteeId}_${invitationId}`)
          .setLabel("婉拒")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Secondary)
      )
    );
}

function buildJoinAnnouncementContainer({ userId, club, via }) {
  const tag = via === "invite" ? "（接受邀請）" : via === "application" ? "（申請通過）" : "";
  return new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎉 <@${userId}> 加入了「${club.name}」${tag}`
      )
    );
}

function buildApplicationSentContainer({ club }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ✅ 申請已送出`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `已送出加入「${club.name}」的申請，請等候會長批准。`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 7 天內未審批將自動過期。若被拒絕，24 小時後才能再申請同公會。`
      )
    );
}

function buildApplicationListContainer({ leaderId, club, applications }) {
  const container = new ContainerBuilder().setAccentColor(COLOR_GOLD);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 📬 「${club.name}」待處理申請（${applications.length} 筆）`
    )
  );
  if (applications.length === 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 目前沒有待處理申請。`)
      );
    return container;
  }
  applications.forEach((app) => {
    container.addSeparatorComponents(new SeparatorBuilder());
    const elapsed = formatElapsed(app.createdAt);
    const msgLine = app.message ? `\n> ${app.message}` : "";
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `<@${app.applicant_id}>　${elapsed}前申請${msgLine}`
      )
    );
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gc_app_approve_${leaderId}_${app.application_id}`)
          .setLabel("批准")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`gc_app_reject_${leaderId}_${app.application_id}`)
          .setLabel("拒絕")
          .setEmoji("❌")
          .setStyle(ButtonStyle.Danger)
      )
    );
  });
  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 拒絕後 24 小時內該玩家不能再申請。`
      )
    );
  return container;
}

function buildDonateSuccessContainer({
  userId,
  club,
  donated,
  totalDonated,
  levelUp,
}) {
  const def = levelDef(club.level);
  const next = nextLevelDef(club.level);
  const container = new ContainerBuilder()
    .setAccentColor(levelUp ? COLOR_GOLD : COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 💰 <@${userId}> 捐了 ${donated.toLocaleString()} ${COIN_EMOJI} 給「${club.name}」`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const treasuryLine = next
    ? `金庫累積：${(club.treasury || 0).toLocaleString()} / ${next.threshold.toLocaleString()}\n餘額：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`
    : `金庫累積：${(club.treasury || 0).toLocaleString()} ${COIN_EMOJI}（已滿級）\n餘額：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(treasuryLine)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 你的累積捐款：${totalDonated.toLocaleString()} ${COIN_EMOJI}`
    )
  );

  if (levelUp) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🎉 **公會升級到 Lv.${levelUp.toLevel}！** 人數上限 ${club.max_members} 人`
        )
      );
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gc_donate_${userId}_1000`)
      .setLabel("再捐 1000")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gc_view_${userId}`)
      .setLabel("查看公會")
      .setEmoji("🏰")
      .setStyle(ButtonStyle.Secondary)
  );
  container.addActionRowComponents(row);

  return container;
}

function buildLevelUpAnnouncementContainer({ club, fromLevel, toLevel, crossedThresholds }) {
  const def = levelDef(toLevel);
  const oldDef = levelDef(fromLevel);
  const newBuffs = def.buffs.filter(
    (b) => !oldDef.buffs.some((o) => o.type === b.type && o.value === b.value)
  );
  const title =
    crossedThresholds >= 2
      ? `# ⚡ 「${club.name}」一口氣跨越 ${crossedThresholds} 個門檻！`
      : `# ⬆️ 「${club.name}」升級到 Lv.${toLevel}！`;
  const subtitle =
    crossedThresholds >= 2
      ? `本次升到 Lv.${toLevel}（剩餘金額將繼續累計升等）`
      : `Lv.${fromLevel} → Lv.${toLevel}`;

  const container = new ContainerBuilder()
    .setAccentColor(COLOR_GOLD)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${subtitle}\n人數上限：${oldDef.maxMembers} → ${def.maxMembers} 人`
      )
    );

  if (newBuffs.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**新解鎖 Buff**\n${newBuffs.map((b) => `・${formatBuff(b)}`).join("\n")}`
      )
    );
  }
  return container;
}

function buildLeaveSuccessContainer({ club, userId }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_WARN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 👋 <@${userId}> 退出了「${club.name}」`
      )
    );
}

function buildKickSuccessContainer({ club, targetId, leaderId }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_WARN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🚪 <@${targetId}> 被會長 <@${leaderId}> 踢出「${club.name}」`
      )
    );
}

function buildTransferSuccessContainer({ club, oldLeaderId, newLeaderId }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_GOLD)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 👑 「${club.name}」會長已轉讓\n<@${oldLeaderId}> → <@${newLeaderId}>`
      )
    );
}

function formatElapsed(date) {
  if (!date) return "";
  const ms = Date.now() - date.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "剛剛";
  if (min < 60) return `${min} 分鐘`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時`;
  return `${Math.floor(hr / 24)} 天`;
}

function buildErrorContainer({ title, body, hint }) {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR_ERROR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint)
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${hint}`)
    );
  return c;
}

module.exports = {
  buildInfoContainer,
  buildCreateSuccessContainer,
  buildDisbandConfirmContainer,
  buildDisbandSuccessContainer,
  buildInvitationContainer,
  buildJoinAnnouncementContainer,
  buildApplicationSentContainer,
  buildApplicationListContainer,
  buildDonateSuccessContainer,
  buildLevelUpAnnouncementContainer,
  buildLeaveSuccessContainer,
  buildKickSuccessContainer,
  buildTransferSuccessContainer,
  buildErrorContainer,
  formatBuff,
};
