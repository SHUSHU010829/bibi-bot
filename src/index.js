require("dotenv/config");
require("dns").setDefaultResultOrder("ipv4first");

// Cloudflare（Discord API 邊緣）會主動 FIN 閒置長連線。undici 預設
// keepAliveTimeout 4s 但 Cloudflare 有時更短，留太久重用會撞上
// "SocketError: other side closed"，而 discord.js 的 shouldRetry 不認
// 這個錯只認 ECONNRESET/AbortError，retry 救不到。
// 把 timeout 壓到比 Cloudflare 短、再放寬連線建立 timeout 即可避免。
const { setGlobalDispatcher, Agent } = require("undici");
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 10_000,
    connect: { timeout: 10_000 },
  })
);

const { Client, GatewayIntentBits, Partials } = require("discord.js");

const eventHandlers = require("./handlers/eventHandler.js");
const startHttpServer = require("./httpServer");
require("./utils/eventLoopMonitor");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  rest: { timeout: 30_000 },
});

eventHandlers(client);
startHttpServer(client);

client.on("error", (err) => {
  console.error("[Client error]", err);
});

// discord.js 的 shouldRetry 只認 ECONNRESET / AbortError，不認 undici
// 的 "SocketError: other side closed"（Cloudflare 主動 FIN 時會出現）。
// 包一層 makeRequest 自己 retry 這個錯誤，避免 /二十一點 之類帶圖片的
// 互動因為單次 socket race 直接吐 [ERROR] 給使用者。
const _origMakeRequest = client.rest.options.makeRequest;
client.rest.options.makeRequest = async function patchedMakeRequest(url, init) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _origMakeRequest(url, init);
    } catch (err) {
      const transient =
        err?.code === "UND_ERR_SOCKET" ||
        err?.code === "UND_ERR_CONNECT_TIMEOUT" ||
        /other side closed|socket hang up|ECONNRESET/i.test(err?.message || "");
      if (!transient || attempt === MAX_RETRIES) throw err;
      console.log(
        `[RestRetry] ${init?.method || "?"} ${url} attempt ${attempt + 1} after: ${err.message}`
      );
    }
  }
};

client.rest.on("restDebug", (msg) => {
  console.log(`[RestDebug] ${msg}`);
});
client.rest.on("rateLimited", (info) => {
  console.log(`[RateLimited] ${JSON.stringify(info)}`);
});
client.rest.on("response", (req, res) => {
  console.log(
    `[RestResponse] ${req.method} ${req.path} -> ${res.status} (took ${res.headers?.get?.("x-runtime") || "?"})`
  );
});
client.rest.on("invalidRequestWarning", (info) => {
  console.log(`[InvalidRequestWarning] ${JSON.stringify(info)}`);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

client.login(process.env.BOT_TOKEN);
