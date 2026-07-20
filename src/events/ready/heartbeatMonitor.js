const { registerCron } = require("../../utils/cronRegistry");

// 存活心跳:每分鐘往外部監控服務 push 一次。網址放環境變數 HEALTHCHECK_URL
// (Healthchecks.io / Uptime Kuma / Better Stack 皆通用),換服務只改 .env。
// 只有 gateway 真的連上 (ws.status === 0) 才 push;bot 掛掉或整台機器凍住時
// 自然停止 push,監控服務收不到心跳就判定 down 並通知。留空則不送。
const HEARTBEAT_URL = process.env.HEALTHCHECK_URL;

async function sendHeartbeat(client) {
  if (!HEARTBEAT_URL) return { sent: false, reason: "no_url" };
  if (client.ws.status !== 0) return { sent: false, reason: "ws_not_ready" };
  const ping = Math.round(client.ws.ping);
  await fetch(HEARTBEAT_URL, {
    method: "POST",
    body: `discord gateway ping: ${ping}ms`,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
  return { sent: true, ping };
}

module.exports = (client) => {
  registerCron(client, {
    name: "heartbeat.monitor",
    label: "健康檢查心跳",
    schedule: "* * * * *",
    runner: () => sendHeartbeat(client),
  });
};
