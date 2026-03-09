require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const {
  Client,
  GatewayIntentBits,
  Collection,
  ActivityType
} = require("discord.js");

console.log("==> BUILD MARKER: 2026-03-09-LOGIN-CLEAN-V1");

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err?.stack || err);
});

process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", err?.stack || err);
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`[boot] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const TOKEN = requireEnv("TOKEN");

console.log("[boot] dotenv loaded");
console.log("[boot] TOKEN exists:", !!TOKEN);
console.log("[boot] TOKEN length:", TOKEN.length);
console.log("[boot] NODE_ENV:", process.env.NODE_ENV || "not set");
console.log("[boot] PORT:", process.env.PORT || "not set");
console.log("[boot] HTTP_PROXY:", process.env.HTTP_PROXY || "not set");
console.log("[boot] HTTPS_PROXY:", process.env.HTTPS_PROXY || "not set");
console.log("[boot] http_proxy:", process.env.http_proxy || "not set");
console.log("[boot] https_proxy:", process.env.https_proxy || "not set");
console.log("[boot] ALL_PROXY:", process.env.ALL_PROXY || "not set");
console.log("[boot] all_proxy:", process.env.all_proxy || "not set");

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(process.env.PORT || 3000, () => {
    console.log(`[boot] Keep-alive server running on port ${process.env.PORT || 3000}`);
  });

async function loadDatabase() {
  console.log("[boot] Loading database.js");
  const db = require("./database.js");
  await db.init();
  console.log("[boot] Database ready");
  return db;
}

function loadCommands(client) {
  const commandsPath = path.join(__dirname, "commands");

  if (!fs.existsSync(commandsPath)) {
    console.warn("[commands] Commands folder not found, skipping");
    return;
  }

  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  console.log(`[commands] Found ${commandFiles.length} command file(s):`, commandFiles);

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);

    if (!command?.data || !command?.execute) {
      console.warn(`[commands] Skipping ${file} - missing "data" or "execute"`);
      continue;
    }

    client.commands.set(command.data.name, command);
    console.log(`[commands] Loaded command: ${command.data.name}`);
  }
}

function loadEvents(client) {
  const eventsPath = path.join(__dirname, "events");

  if (!fs.existsSync(eventsPath)) {
    console.warn("[events] Events folder not found, skipping");
    return;
  }

  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter((file) => file.endsWith(".js"));

  console.log(`[events] Found ${eventFiles.length} event file(s):`, eventFiles);

  for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);

    if (!event?.name || typeof event.execute !== "function") {
      console.warn(`[events] Skipping ${file} - missing valid "name" or "execute"`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }

    console.log(`[events] Registered event: ${event.name} (once=${!!event.once})`);
  }
}

async function main() {
  console.log("[boot] Creating Discord client");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  client.commands = new Collection();

  client.on("error", (err) => {
    console.error("[client error]", err?.stack || err);
  });

  client.on("shardError", (err, shardId) => {
    console.error(`[shard error] shard=${shardId}`, err?.stack || err);
  });

  client.on("warn", (msg) => {
    console.warn("[client warn]", msg);
  });

  client.on("debug", (msg) => {
    const lower = msg.toLowerCase();
    if (
      lower.includes("gateway") ||
      lower.includes("session") ||
      lower.includes("heartbeat") ||
      lower.includes("provided token") ||
      lower.includes("429")
    ) {
      console.log("[client debug]", msg);
    }
  });

  client.on("interactionCreate", (interaction) => {
    console.log(
      `[interaction] type=${interaction.type} id=${interaction.customId ?? interaction.commandName ?? "unknown"}`
    );
  });

  client.once("clientReady", () => {
    console.log(`[ready] Logged in as ${client.user.tag}`);

    try {
      client.user.setActivity("feds.lol", {
        type: ActivityType.Streaming,
        url: "https://www.twitch.tv/twitch"
      });
      console.log("[ready] Activity set");
    } catch (err) {
      console.error("[ready] Failed to set activity:", err?.stack || err);
    }
  });

  await loadDatabase();
  loadCommands(client);
  loadEvents(client);

  console.log("[boot] About to call client.login()");

  try {
    await client.login(TOKEN);
    console.log("[boot] client.login() resolved successfully");
  } catch (err) {
    console.error("[boot] Failed to login full error:", err);
    console.error("[boot] Failed to login stack:", err?.stack);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[fatal] main() failed:", err?.stack || err);
  process.exit(1);
});
