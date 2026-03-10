require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const {
  Client,
  GatewayIntentBits,
  Collection,
  ActivityType,
  Partials
} = require("discord.js");

console.log("==> BUILD MARKER: 2026-03-10-GATEWAY-BACKOFF-V1");

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
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(process.env.PORT || 3000, "0.0.0.0", () => {
    console.log(`[boot] Keep-alive server running on port ${process.env.PORT || 3000}`);
  });

async function loadDatabase() {
  console.log("[boot] Loading database.js");
  const db = require("./database.js");
  await db.init();
  console.log("[boot] Database ready");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseResetMs(line) {
  const m = String(line || "").match(/Reset\s+(\d+)\s+\((\d+)ms left\)/i);
  if (!m) return null;
  const msLeft = Number(m[2]);
  return Number.isFinite(msLeft) ? msLeft : null;
}

function createBackoffManager() {
  return {
    attempt: 0,
    nextConnectAt: 0,
    baseDelayMs: 30_000,
    maxDelayMs: 10 * 60_000,
    jitterMaxMs: 1500,

    reset() {
      this.attempt = 0;
      this.nextConnectAt = 0;
    },

    schedule(waitMs, reason) {
      const jitter = Math.floor(Math.random() * this.jitterMaxMs);
      const total = waitMs + jitter;
      this.nextConnectAt = Date.now() + total;
      console.warn("[backoff] scheduled", {
        reason,
        wait_ms: total,
        next: new Date(this.nextConnectAt).toISOString()
      });
      return total;
    },

    scheduleExponential(reason) {
      const raw = Math.min(
        Math.floor(this.baseDelayMs * Math.pow(1.8, this.attempt)),
        this.maxDelayMs
      );
      this.attempt += 1;
      return this.schedule(raw, reason);
    },

    getRemainingMs() {
      return Math.max(0, this.nextConnectAt - Date.now());
    }
  };
}

function createClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
  });

  client.commands = new Collection();
  return client;
}

async function waitForReady(client, loginTimeoutMs = 30_000, readyTimeoutMs = 45_000) {
  let saw429ResetMs = null;
  let sawGateway429 = false;

  return await new Promise(async (resolve, reject) => {
    let finished = false;
    let loginResolved = false;

    const cleanup = async () => {
      clearTimeout(loginTimer);
      clearTimeout(readyTimer);
      client.removeAllListeners("error");
      client.removeAllListeners("warn");
      client.removeAllListeners("shardError");
      client.removeAllListeners("shardDisconnect");
      client.removeAllListeners("shardReconnecting");
      client.removeAllListeners("shardResume");
      client.removeAllListeners("shardReady");
      client.removeAllListeners("shardConnecting");
      client.removeAllListeners("debug");
      client.removeAllListeners("ready");
    };

    const finishOk = async () => {
      if (finished) return;
      finished = true;
      await cleanup();
      resolve({ sawGateway429, saw429ResetMs });
    };

    const finishErr = async (err) => {
      if (finished) return;
      finished = true;
      await cleanup();
      reject(err);
    };

    const loginTimer = setTimeout(() => {
      finishErr(new Error(`Login timed out after ${loginTimeoutMs}ms`));
    }, loginTimeoutMs);

    const readyTimer = setTimeout(() => {
      finishErr(new Error(`Ready event did not fire within ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);

    client.on("error", (err) => {
      console.error("[client error]", err?.stack || err);
    });

    client.on("warn", (msg) => {
      console.warn("[client warn]", msg);
    });

    client.on("shardError", (err, shardId) => {
      console.error(`[shardError] shard=${shardId}`, err?.stack || err);
    });

    client.on("shardDisconnect", (event, shardId) => {
      console.error(`[shardDisconnect] shard=${shardId}`, {
        code: event?.code,
        reason: event?.reason,
        wasClean: event?.wasClean
      });
    });

    client.on("shardReconnecting", (shardId) => {
      console.log(`[shardReconnecting] shard=${shardId}`);
    });

    client.on("shardResume", (shardId, replayedEvents) => {
      console.log(`[shardResume] shard=${shardId} replayed=${replayedEvents}`);
    });

    client.on("shardReady", (shardId, unavailableGuilds) => {
      console.log(`[shardReady] shard=${shardId} unavailableGuilds=${unavailableGuilds?.size ?? 0}`);
    });

    client.on("shardConnecting", (shardId) => {
      console.log(`[shardConnecting] shard=${shardId}`);
    });

    client.on("debug", (msg) => {
      const s = String(msg || "");
      const lower = s.toLowerCase();

      if (lower.includes("provided token")) return;

      if (
        lower.includes("gateway") ||
        lower.includes("session") ||
        lower.includes("heartbeat") ||
        lower.includes("identify") ||
        lower.includes("resume") ||
        lower.includes("shard") ||
        lower.includes("ready") ||
        lower.includes("429")
      ) {
        console.log("[client debug]", s);
      }

      const isGateway429 = lower.includes("gateway") && lower.includes("429");
      if (isGateway429) {
        sawGateway429 = true;
        const parsed = parseResetMs(s);
        if (parsed != null && parsed >= 60_000) {
          saw429ResetMs = parsed;
        }
      }
    });

    client.once("ready", async () => {
      try {
        console.log(`[ready] Logged in as ${client.user.tag}`);
        client.user.setActivity("feds.lol", {
          type: ActivityType.Streaming,
          url: "https://www.feds.lol/register"
        });
        console.log("[ready] Activity set");
      } catch (err) {
        console.error("[ready] Failed to set activity:", err?.stack || err);
      }

      await finishOk();
    });

    try {
      console.log("[boot] About to call client.login()");
      await client.login(TOKEN);
      loginResolved = true;
      clearTimeout(loginTimer);
      console.log("[boot] client.login() resolved successfully");
    } catch (err) {
      if (!loginResolved) {
        await finishErr(err);
      }
    }
  });
}

async function boot() {
  await loadDatabase();

  const backoff = createBackoffManager();

  setInterval(() => {
    console.log("[heartbeat] process alive", {
      at: new Date().toISOString(),
      nextConnectAt: backoff.nextConnectAt ? new Date(backoff.nextConnectAt).toISOString() : null,
      waitRemainingMs: backoff.getRemainingMs()
    });
  }, 15000);

  while (true) {
    const remaining = backoff.getRemainingMs();
    if (remaining > 0) {
      console.log(`[boot] waiting ${remaining}ms before next connect attempt`);
      await sleep(remaining);
    }

    console.log("[boot] Creating Discord client");
    const client = createClient();

    try {
      loadCommands(client);
      loadEvents(client);

      const result = await waitForReady(client, 30_000, 45_000);

      backoff.reset();
      console.log("[boot] Client is fully ready");
      return;
    } catch (err) {
      console.error("[boot] Login attempt failed:", err?.stack || err);

      let waitMs;

      const msg = String(err?.message || err || "").toLowerCase();

      if (msg.includes("429") || msg.includes("1015")) {
        waitMs = backoff.schedule(30 * 60_000, "explicit 429/1015 failure");
      } else {
        waitMs = backoff.scheduleExponential("generic login/ready failure");
      }

      try {
        if (client.isReady()) {
          await client.destroy();
        } else {
          client.destroy();
        }
      } catch (destroyErr) {
        console.error("[boot] Failed to destroy client cleanly:", destroyErr?.stack || destroyErr);
      }

      await sleep(waitMs);
    }
  }
}

boot().catch((err) => {
  console.error("[fatal] boot failed:", err?.stack || err);
  process.exit(1);
});
