require("colors");

const PUSH_URL =
  "https://shu-project.zeabur.app/api/push/CxqpuGWTytENoQFrhw0GFj4K2RC7goHo";

module.exports = (client) => {
  setInterval(() => {
    if (client.ws.status !== 0) return;
    const ping = Math.round(client.ws.ping);
    fetch(`${PUSH_URL}?status=up&msg=OK&ping=${ping}`).catch(() => {});
  }, 60 * 1000);

  console.log("[SYSTEM] Uptime Kuma 心跳啟動（每 60 秒）".green);
};
