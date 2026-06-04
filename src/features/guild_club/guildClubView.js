const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { guildClub } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const {
  levelDef,
  nextLevelDef,
  maxLevel,
  descriptionMaxLength,
} = require("./guildClubService");

const EDIT_DESC_MODAL_PREFIX = "gc_desc_modal_";

const COLOR_GOLD = 0xf1c40f;
const COLOR_ERROR = 0xe74c3c;
const COLOR_WARN = 0xe67e22;
const COLOR_SUCCESS = 0x2ecc71;

const BUFF_LABELS = {
  mining_qty_bonus: (v) => `挖礦每次數量 +${v}`,
  mining_luck_pct: (v) => `挖礦 luck +${Math.round(v * 100)}%（吃 luckCap）`,
  work_income_multiplier: (v) => `打工收入 +${Math.round(v * 100)}%`,
  dungeon_stamina_max: (v) => `地下城體力上限 +${v}`,
  boss_atk_pct: (v) => `BOSS 戰攻擊力 +${Math.round(v * 100)}%`,
  boss_attack_limit_bonus: (v) => `BOSS 戰每場攻擊次數 +${v}`,
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
  viewerRole,
  bossContributions,
  warehouseSummary,
  pendingApplicationCount,
}) {
  const def = levelDef(club.level);
  const next = nextLevelDef(club.level);
  const role = viewerRole || (isLeader ? "leader" : isMember ? "member" : null);
  const isManager = role === "leader" || role === "vice_leader";
  const container = new ContainerBuilder().setAccentColor(COLOR_GOLD);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🏰 ${club.name}　Lv.${club.level}${club.level >= maxLevel() ? "（已滿級）" : ""}`
    )
  );
  container.addSeparatorComponents(new SeparatorBuilder());

  const viceLeaders = members.filter((m) => m.role === "vice_leader");
  const viceLine =
    viceLeaders.length > 0
      ? `\n副會長：${viceLeaders.map((m) => `<@${m.userId}>`).join("、")}`
      : "";
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `會長：<@${club.leader_id}>${viceLine}　成員：${members.length}/${club.max_members}`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  if (club.description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📜 公會簡介 / 會規**\n${club.description}`
      )
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📜 公會簡介 / 會規**\n-# ${isManager ? "尚未撰寫，點下方按鈕新增。" : "會長尚未撰寫簡介。"}`
      )
    );
  }
  if (isManager) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gc_edit_desc_${viewerId}`)
        .setLabel(club.description ? "編輯簡介 / 會規" : "撰寫簡介 / 會規")
        .setEmoji("📝")
        .setStyle(ButtonStyle.Primary)
    );
    if (pendingApplicationCount > 0) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`gc_apps_${viewerId}`)
          .setLabel(`待審申請 ${pendingApplicationCount}`)
          .setEmoji("📨")
          .setStyle(ButtonStyle.Danger)
      );
    }
    container.addActionRowComponents(row);
  }

  const lockedAmount = club.treasury_locked || 0;
  const treasuryLine = next
    ? `金庫（累積）：${(club.treasury || 0).toLocaleString()} / ${next.threshold.toLocaleString()} ${COIN_EMOJI}\n餘額（可分配）：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`
    : `金庫（累積）：${(club.treasury || 0).toLocaleString()} ${COIN_EMOJI}\n餘額（可分配）：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(treasuryLine)
  );
  if (lockedAmount > 0) {
    const entries = Array.isArray(club.locked_entries) ? club.locked_entries : [];
    const nextUnlock = entries
      .slice()
      .sort((a, b) => new Date(a.unlocksAt) - new Date(b.unlocksAt))[0];
    const tail = nextUnlock
      ? `（最早 <t:${Math.floor(new Date(nextUnlock.unlocksAt).getTime() / 1000)}:R> 解鎖）`
      : "";
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 鎖定中（任務獎勵）：${lockedAmount.toLocaleString()} ${COIN_EMOJI} ${tail}`
      )
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  if (def.buffs.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**共享 Buff**\n-# 尚未解鎖`)
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**共享 Buff**\n${def.buffs.map((b) => `・${formatBuff(b)}`).join("\n")}`
      )
    );
  }
  const lockedBuffs = collectLockedBuffs(club.level);
  if (lockedBuffs.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 未解鎖：${lockedBuffs.join("・")}`
      )
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  if (members.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**成員**\n-# 尚無成員`)
    );
  } else {
    const roleWeight = (r) => (r === "leader" ? 0 : r === "vice_leader" ? 1 : 2);
    const sorted = [...members].sort((a, b) => {
      const wa = roleWeight(a.role);
      const wb = roleWeight(b.role);
      if (wa !== wb) return wa - wb;
      return (b.total_donated || 0) - (a.total_donated || 0);
    });
    const lines = sorted.map((m) => {
      const roleEmoji =
        m.role === "leader" ? "👑" : m.role === "vice_leader" ? "🛡️" : "・";
      const donated = (m.total_donated || 0).toLocaleString();
      return `${roleEmoji} <@${m.userId}>　捐款 ${donated} ${COIN_EMOJI}`;
    });
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**成員**（${members.length}）\n${lines.join("\n")}`)
    );
  }

  if (warehouseSummary) {
    const warehouseView = require("./warehouse/warehouseView");
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      warehouseView.buildWarehouseSummaryBlock(warehouseSummary)
    );
    if (isMember) {
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`gcw_refresh_${viewerId}`)
            .setLabel("開啟倉庫")
            .setEmoji("📦")
            .setStyle(ButtonStyle.Primary)
        )
      );
    }
  }

  if (bossContributions && bossContributions.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder());
    const lines = bossContributions.slice(0, 5).map((c, i) => {
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
      return `${medal} <@${c.userId}>　${(c.weeklyContribution || 0).toLocaleString()} 點`;
    });
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🐉 本週 BOSS 貢獻 Top 5**\n${lines.join("\n")}`
      )
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 每場 BOSS 結算時，依造成傷害換算成貢獻點。`
      )
    );
  }

  if (role === "leader") {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 你是會長。可使用 /公會 邀請、/公會 踢人、/公會 指派副會長、/公會 解散；上方按鈕可編輯簡介、處理申請。`
      )
    );
  } else if (role === "vice_leader") {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 你是副會長。可使用 /公會 邀請、/公會 踢人（會長轉讓與解散僅會長可用）；上方按鈕可編輯簡介、處理申請。`
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

// 列出當前等級之後才解鎖的新增 buff，做為 -# 未解鎖：A（Lv.4）・B（Lv.5）。
function collectLockedBuffs(currentLevel) {
  const out = [];
  const seen = new Set();
  for (const b of (guildClub?.levels || []).find((l) => l.level === currentLevel)?.buffs || []) {
    seen.add(`${b.type}:${b.value}`);
  }
  for (const lvDef of guildClub?.levels || []) {
    if (lvDef.level <= currentLevel) continue;
    for (const b of lvDef.buffs || []) {
      const key = `${b.type}:${b.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${formatBuff(b)}（Lv.${lvDef.level}）`);
    }
  }
  return out;
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
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gc_view_${userId}`)
          .setLabel("查看公會")
          .setEmoji("🏰")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  return container;
}

function buildDisbandConfirmContainer({
  leaderId,
  club,
  members,
  eligibleCount,
  ineligibleCount,
  payoutPerMember,
}) {
  const elig = eligibleCount ?? members.length;
  const inelig = ineligibleCount ?? 0;
  const lockedAmount = club.treasury_locked || 0;
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
        `成員 ${members.length} 人　可分配餘額 ${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}\n→ 符合分配資格 ${elig} 人，每人分得 **${payoutPerMember.toLocaleString()} ${COIN_EMOJI}**`
      )
    );

  if (inelig > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${inelig} 名新加入成員（未滿入會時間門檻）不分配，防拉人頭分錢。`
      )
    );
  }
  if (lockedAmount > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ⚠️ 鎖定中的任務獎勵 ${lockedAmount.toLocaleString()} ${COIN_EMOJI} 將被沒收（解散時尚未解鎖的任務金不分配）。`
      )
    );
  }

  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 此操作不可逆，公會資料會被歸檔。解散後你將進入重建冷卻。`
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

function buildDisbandSuccessContainer({
  club,
  memberCount,
  eligibleCount,
  ineligibleCount,
  payoutPerMember,
  lockedForfeit,
}) {
  const elig = eligibleCount ?? memberCount;
  const inelig = ineligibleCount ?? 0;
  const totalPaid = payoutPerMember * elig;
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
        `${elig} 名符合資格成員平分 ${totalPaid.toLocaleString()} ${COIN_EMOJI}\n每人分得 ${payoutPerMember.toLocaleString()} ${COIN_EMOJI}`
      )
    );
  if (inelig > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${inelig} 名未滿入會時間門檻的成員未分配。`
      )
    );
  }
  if (lockedForfeit && lockedForfeit > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 沒收鎖定中任務獎勵 ${lockedForfeit.toLocaleString()} ${COIN_EMOJI}（尚未解鎖）。`
      )
    );
  }
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
        `🎉 <@${userId}> 加入了「${club.name}」${tag}`
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

function buildQuestListContainer({ viewerId, club, period, items, isLeader }) {
  const container = new ContainerBuilder().setAccentColor(COLOR_GOLD);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🏆 「${club.name}」週任務（${period}）`
    )
  );
  items.forEach((q) => {
    container.addSeparatorComponents(new SeparatorBuilder());
    const stateEmoji =
      q.state === "claimed" ? "🎁" : q.state === "ready" ? "🏆" : "🔄";
    const stateLabel =
      q.state === "claimed"
        ? "已領取"
        : q.state === "ready"
          ? "可領取"
          : `${q.progress.toLocaleString()}/${q.target.toLocaleString()}`;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${stateEmoji} **${q.name}**　${stateLabel}\n${q.description}\n獎勵：${q.reward.toLocaleString()} ${COIN_EMOJI}（入金庫，先鎖定）`
      )
    );
  });

  const lockHours = guildClub?.antiLaundering?.questRewardLockHours || 0;
  if (lockHours > 0) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 任務金鎖定 ${lockHours} 小時才解鎖到可分配餘額。期間解散公會，鎖定部分將被沒收（防止任務金被當天分掉洗錢）。`
      )
    );
  }

  const anyReady = items.some((i) => i.state === "ready");
  if (anyReady) {
    container.addSeparatorComponents(new SeparatorBuilder());
    if (isLeader) {
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`gc_quest_claim_${viewerId}`)
            .setLabel("一鍵領取入金庫")
            .setEmoji("🎁")
            .setStyle(ButtonStyle.Success)
        )
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 有任務可領取，請會長開 /公會 任務 點上方「一鍵領取」按鈕。`
        )
      );
    }
  }
  return container;
}

function buildQuestClaimSuccessContainer({ club, claimed, totalReward, levelUp, leaderId }) {
  const lockHours = guildClub?.antiLaundering?.questRewardLockHours || 0;
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏆 「${club.name}」領取週任務獎勵`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `完成 ${claimed.length} 項任務：\n${claimed.map((q) => `・${q.name}　+${q.reward.toLocaleString()} ${COIN_EMOJI}`).join("\n")}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `金庫累計入帳：**+${totalReward.toLocaleString()} ${COIN_EMOJI}**（已計入升級進度）`
      )
    );
  if (lockHours > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 防洗錢機制：此筆獎勵將在 ${lockHours} 小時後解鎖到可分配餘額，期間解散公會這筆會被沒收。`
      )
    );
  }
  if (levelUp) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🎉 公會升級到 Lv.${levelUp.toLevel}！`
        )
      );
  }
  if (leaderId) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gc_view_${leaderId}`)
          .setLabel("查看公會")
          .setEmoji("🏰")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`gc_rank_${leaderId}`)
          .setLabel("查看排行")
          .setEmoji("🏆")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }
  return container;
}

function buildLeaderboardContainer({ viewerId, clubs, viewerClubId }) {
  const container = new ContainerBuilder().setAccentColor(COLOR_GOLD);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🏆 公會排行榜（依累積金庫）`
    )
  );
  if (!clubs.length) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 本伺服器尚無公會，當第一個建立吧！`
        )
      );
    return container;
  }
  clubs.forEach((c, i) => {
    container.addSeparatorComponents(new SeparatorBuilder());
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    const me = c.guild_club_id === viewerClubId ? "👉 " : "";
    const line = `${me}${medal} **${c.name}**　Lv.${c.level}　${(c.treasury || 0).toLocaleString()} ${COIN_EMOJI}\n-# 餘額 ${(c.treasury_current || 0).toLocaleString()}　成員 ${c.member_count}/${c.max_members}`;
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(line))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`gc_view_club_${viewerId}_${c.guild_club_id}`)
            .setLabel("查看")
            .setEmoji("🏰")
            .setStyle(ButtonStyle.Secondary)
        )
    );
  });
  return container;
}

function buildQuestRewardAnnouncementContainer({ club, claimed, totalReward, leaderId }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_GOLD)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏆 「${club.name}」完成週任務`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `會長 <@${leaderId}> 領取 ${claimed.length} 項任務：\n${claimed.map((q) => `・${q.name}`).join("\n")}\n金庫 +${totalReward.toLocaleString()} ${COIN_EMOJI}`
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

function buildEditDescriptionModal({ userId, club }) {
  const modal = new ModalBuilder()
    .setCustomId(`${EDIT_DESC_MODAL_PREFIX}${userId}`)
    .setTitle(`編輯「${club.name}」簡介 / 會規`.slice(0, 45));
  const input = new TextInputBuilder()
    .setCustomId("gc_desc_text")
    .setLabel(`簡介 / 會規（最多 ${descriptionMaxLength()} 字，留空清除）`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(descriptionMaxLength())
    .setPlaceholder("例：歡迎大家！每週至少打 BOSS 一次，捐款隨意。");
  if (club.description) input.setValue(club.description);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function buildDescriptionUpdatedContainer({ club, cleared, role }) {
  const editorTitle = role === "vice_leader" ? "副會長" : "會長";
  const container = new ContainerBuilder()
    .setAccentColor(COLOR_SUCCESS)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ 「${club.name}」簡介已${cleared ? "清除" : "更新"}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder());
  if (cleared) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${editorTitle}清空了公會簡介 / 會規。`
      )
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📜 公會簡介 / 會規**\n${club.description}`
      )
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 由${editorTitle}更新。成員執行 /公會 資訊 即可看到。`
      )
    );
  }
  return container;
}

function buildPromoteViceSuccessContainer({ club, leaderId, targetId }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_GOLD)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🛡️ 新任副會長就任\n<@${leaderId}> 指派 <@${targetId}> 為「${club.name}」副會長`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 副會長擁有與會長相同權限（除解散公會、轉讓會長、指派/撤銷副會長外）。`
      )
    );
}

function buildDemoteViceSuccessContainer({ club, leaderId, targetId }) {
  return new ContainerBuilder()
    .setAccentColor(COLOR_WARN)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🪶 副會長已卸任\n<@${leaderId}> 撤銷了 <@${targetId}> 的副會長身分（仍是「${club.name}」成員）`
      )
    );
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
  buildQuestListContainer,
  buildQuestClaimSuccessContainer,
  buildLeaderboardContainer,
  buildQuestRewardAnnouncementContainer,
  buildErrorContainer,
  buildEditDescriptionModal,
  buildDescriptionUpdatedContainer,
  buildPromoteViceSuccessContainer,
  buildDemoteViceSuccessContainer,
  formatBuff,
  EDIT_DESC_MODAL_PREFIX,
};
