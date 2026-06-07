require("colors");
const cron = require("node-cron");

/**
 * 統一 cron 註冊與監控。
 *
 * 設計動機：
 *   原本每個 scheduler 各自 `cron.schedule(...)`，dashboard 完全看不到狀態。
 *   改成在 ready handler 內呼叫 `registerCron(client, {...})`，由本模組：
 *     1. 在註冊時建立 cron.schedule，runner 自動包進 withCronLog（寫
 *        CronJobLog 起訖 / 成功失敗 / duration / error stack）
 *     2. 維護一個 in-memory registry，admin API 可列任務 + 手動觸發
 *     3. 連續錯誤 N 次自動停止（原有保護維持）
 *
 * 使用方式（migration pattern）：
 *
 *   舊：
 *     let task = null;
 *     module.exports = async (client) => {
 *       if (task) return;
 *       task = cron.schedule('0 0 * * *', async () => {
 *         try { await runJob(client); } catch (err) { ... }
 *       }, { timezone: 'Asia/Taipei' });
 *     };
 *
 *   新：
 *     const { registerCron } = require('../../utils/cronRegistry');
 *     module.exports = async (client) => {
 *       registerCron(client, {
 *         name: 'feature.action',
 *         label: '功能說明',
 *         schedule: '0 0 * * *',
 *         timezone: 'Asia/Taipei',
 *         runner: () => runJob(client),
 *       });
 *     };
 */

const MAX_CONSECUTIVE_ERRORS = 3;
// 成功 + 比這還快的 cron run 不寫 CronJobLog（純省 storage / write IO）。
// 慢 / 失敗的還是會寫。dashboard 透過 in-memory lastRun 看「最後跑過沒」。
const SLOW_RUN_MS = 3000;
const jobs = new Map();

function registerCron(client, opts) {
  const { name, label, schedule, timezone = "Asia/Taipei", runner } = opts;
  if (!name || !runner) {
    throw new Error("registerCron: name 與 runner 必填");
  }
  if (jobs.has(name)) {
    console.log(`[CRON] ${name} 已註冊，跳過`.gray);
    return;
  }

  const job = {
    name,
    label: label || name,
    schedule,
    timezone,
    runner,
    consecutiveErrors: 0,
    task: null,
    stopped: false,
    lastRun: null,
  };

  if (schedule) {
    job.task = cron.schedule(
      schedule,
      async () => {
        await runOnce(client, job, "scheduled");
        if (job.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && job.task) {
          job.task.stop();
          job.stopped = true;
          console.log(
            `[CRON] ${name} 連續錯誤 ${job.consecutiveErrors} 次，已停止`.red,
          );
        }
      },
      { timezone },
    );
    console.log(
      `[CRON] 註冊 ${name} (${label || name}) ${schedule} ${timezone}`.cyan,
    );
  } else {
    console.log(`[CRON] 註冊 ${name}（無排程，僅可手動觸發）`.cyan);
  }

  jobs.set(name, job);
}

async function runOnce(client, job, trigger) {
  const col = client.cronJobLogCollection;
  const startedAt = new Date();

  try {
    const result = await job.runner(client);
    const finishedAt = new Date();
    const durationMs = finishedAt - startedAt;
    job.consecutiveErrors = 0;
    job.lastRun = {
      startedAt,
      finishedAt,
      status: "success",
      durationMs,
      trigger,
      error: null,
    };
    if (col && durationMs >= SLOW_RUN_MS) {
      await col
        .insertOne({
          name: job.name,
          startedAt,
          finishedAt,
          status: "success",
          durationMs,
          trigger,
          slow: true,
          result: serializableResult(result),
        })
        .catch(() => null);
    }
    return { ok: true, result };
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = finishedAt - startedAt;
    job.consecutiveErrors += 1;
    const errMsg = String(err.message || err);
    job.lastRun = {
      startedAt,
      finishedAt,
      status: "failed",
      durationMs,
      trigger,
      error: errMsg,
    };
    console.log(
      `[CRON] ${job.name} failed (${job.consecutiveErrors}):\n${err.stack || err}`.red,
    );
    if (col) {
      await col
        .insertOne({
          name: job.name,
          startedAt,
          finishedAt,
          status: "failed",
          durationMs,
          trigger,
          error: errMsg,
          stack: err.stack || null,
        })
        .catch(() => null);
    }
    return { ok: false, error: err };
  }
}

function listJobs() {
  return Array.from(jobs.values()).map((j) => ({
    name: j.name,
    label: j.label,
    schedule: j.schedule || null,
    timezone: j.timezone,
    consecutiveErrors: j.consecutiveErrors,
    stopped: j.stopped,
    lastRun: j.lastRun || null,
  }));
}

function getJob(name) {
  return jobs.get(name) || null;
}

async function runJobNow(client, name) {
  const job = jobs.get(name);
  if (!job) return { ok: false, error: "job not registered" };
  return runOnce(client, job, "manual");
}

function serializableResult(v) {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

module.exports = { registerCron, listJobs, getJob, runJobNow };
