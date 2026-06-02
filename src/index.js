require("dotenv/config");
require("dns").setDefaultResultOrder("ipv4first");

// Tencent Tokyo Droplet 上 Cloudflare（Discord API 邊緣）會主動 FIN
// 閒置連線，連線池裡常有「本地以為活著、實際被遠端關掉」的殭屍連線。
// undici 拿到後送 PATCH multipart 中途斷線 → SocketError: other side closed
// 或更糟的是抓到不死不活的 socket 慢慢 hang 直到 30s timeout AbortError。
//
// 最徹底解：keepAliveTimeout 設極短（≈ 不留池）+ 卡死 5 分鐘的
// headersTimeout/bodyTimeout 拉到 15s。每次請求新 TLS handshake（多
// ~200ms）換取連線一定是活的。
const { setGlobalDispatcher, Agent } = require("undici");
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connect: { timeout: 10_000 },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
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
