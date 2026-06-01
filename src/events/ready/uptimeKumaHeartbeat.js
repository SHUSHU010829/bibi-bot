require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const PUSH_URL =
  "https://shu-project.zeabur.app/api/push/CxqpuGWTytENoQFrhw0GFj4K2RC7goHo";

async function sendHeartbeat(client) {
  if (client.ws.status !== 0) return { sent: false, reason: "ws_not_ready" };
  const ping = Math.round(client.ws.ping);
  await fetch(`${PUSH_URL}?status=up&msg=OK&ping=${ping}`).catch(() => {});
  return { sent: true, ping };
}

module.exports = (client) => {
  registerCron(client, {
    name: "uptimeKuma.heartbeat",
    label: "Uptime Kuma 心跳",
    schedule: "* * * * *",
    runner: () => sendHeartbeat(client),
  });
};
