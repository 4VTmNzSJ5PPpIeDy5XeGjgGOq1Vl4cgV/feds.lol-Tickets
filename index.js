require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

const {
  Client,
  GatewayIntentBits,
  Collection,
  ActivityType,
  Partials
} = require("discord.js");

const db = require("./database.js");



/* -------------------------------------------------------------------------- */
/* Boot logging                                                                */
/* -------------------------------------------------------------------------- */

console.log("==> BUILD MARKER: CLEAN-STABLE-BOOT-GATEWAY-DEBUG");

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err?.stack || err);
});

process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", err?.stack || err);
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`[boot] Missing required env variable: ${name}`);
  }
  return value.trim();
}

const TOKEN = requireEnv("TOKEN");

console.log("[boot] dotenv loaded");
console.log("[boot] NODE_ENV:", process.env.NODE_ENV || "not set");
console.log("[boot] PORT:", process.env.PORT || "not set");
console.log("[boot] MESSAGE_CONTENT_INTENT_REQUIRED:", true);



/* -------------------------------------------------------------------------- */
/* Runtime status + log buffer                                                 */
/* -------------------------------------------------------------------------- */

const botStatus = {
  state: "starting",
  startedAt: new Date().toISOString(),
  lastLoginAttempt: null,
  lastReady: null,
  lastDisconnect: null,
  lastError: null,
  lastWarn: null,
  lastDebug: null
};

function updateStatus(patch) {
  Object.assign(botStatus, patch);
}

const runtimeLogs = [];
const MAX_RUNTIME_LOGS = 300;

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function addRuntimeLog(level, args) {
  runtimeLogs.push({
    time: new Date().toISOString(),
    level,
    message: args.map(safeStringify).join(" ")
  });

  if (runtimeLogs.length > MAX_RUNTIME_LOGS) {
    runtimeLogs.shift();
  }
}

const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

console.log = (...args) => {
  addRuntimeLog("log", args);
  originalLog(...args);
};

console.warn = (...args) => {
  addRuntimeLog("warn", args);
  originalWarn(...args);
};

console.error = (...args) => {
  addRuntimeLog("error", args);
  originalError(...args);
};



/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderLayout(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
body{background:#0b0b0f;color:#f3f3f5;font-family:Inter,Arial,sans-serif;padding:24px}
.wrap{max-width:1100px;margin:0 auto}
.card{background:#14141b;border:1px solid #262633;border-radius:12px;padding:16px;margin-bottom:14px}
.meta{color:#a7a7b5;font-size:14px;margin-top:6px}
a{color:#9bb8ff;text-decoration:none}
a:hover{text-decoration:underline}
pre{background:#101017;padding:16px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
input{width:100%;max-width:420px;padding:10px;border-radius:8px;border:1px solid #2d2d3a;background:#101017;color:#f3f3f5}
</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

function isTranscriptAuthorised(urlObj) {
  const expected = process.env.TRANSCRIPT_VIEW_KEY;
  if (!expected) return false;
  return urlObj.searchParams.get("key") === expected;
}



/* -------------------------------------------------------------------------- */
/* Web server                                                                  */
/* -------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  console.log(`[web] ${req.method} ${pathname}`);

  try {
    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      console.log(`[web] finished in ${Date.now() - started}ms`);
      return;
    }

    if (pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "feds-agent",
        bot: botStatus,
        now: new Date().toISOString()
      }, null, 2));
      console.log(`[web] finished in ${Date.now() - started}ms`);
      return;
    }

    if (pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "feds-agent",
        count: runtimeLogs.length,
        logs: runtimeLogs,
        now: new Date().toISOString()
      }, null, 2));
      console.log(`[web] finished in ${Date.now() - started}ms`);
      return;
    }

    if (pathname === "/transcripts" || pathname.startsWith("/transcripts/")) {
      if (!isTranscriptAuthorised(urlObj)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        console.log(`[web] finished in ${Date.now() - started}ms`);
        return;
      }

      if (pathname === "/transcripts") {
        const rows = await db.listTranscripts(200);
        const q = (urlObj.searchParams.get("q") || "").trim().toLowerCase();

        const filtered = q
          ? rows.filter((row) =>
              String(row.channel_name).toLowerCase().includes(q) ||
              String(row.closed_by).toLowerCase().includes(q) ||
              String(row.id).includes(q)
            )
          : rows;

        const cards = filtered.length
          ? filtered.map((row) => `
            <div class="card">
              <strong>#${row.id} ${escapeHtml(row.channel_name)}</strong>
              <div class="meta">
                Closed by ${escapeHtml(row.closed_by)}
                • ${new Date(row.created_at).toLocaleString("en-GB")}
              </div>
              <br>
              <a href="/transcripts/${row.id}?key=${encodeURIComponent(urlObj.searchParams.get("key") || "")}">Open transcript</a>
            </div>
          `).join("")
          : `<div class="card">No transcripts found.</div>`;

        const html = `
          <div class="card">
            <strong>Ticket Transcripts</strong>
            <div class="meta">Latest ${filtered.length} result(s)</div>
            <br>
            <form method="GET" action="/transcripts">
              <input type="hidden" name="key" value="${escapeHtml(urlObj.searchParams.get("key") || "")}">
              <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search by channel, closer, or ID">
            </form>
          </div>
          ${cards}
        `;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderLayout("Ticket Transcripts", html));
        console.log(`[web] finished in ${Date.now() - started}ms`);
        return;
      }

      const idMatch = pathname.match(/^\/transcripts\/(\d+)$/);

      if (idMatch) {
        const transcript = await db.getTranscriptById(Number(idMatch[1]));

        if (!transcript) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Transcript not found");
          console.log(`[web] finished in ${Date.now() - started}ms`);
          return;
        }

        const html = `
          <div class="card">
            <strong>Channel:</strong> ${escapeHtml(transcript.channel_name)}
            <div class="meta">
              Closed by ${escapeHtml(transcript.closed_by)}
              • ${new Date(transcript.created_at).toLocaleString("en-GB")}
            </div>
            <br>
            <a href="/transcripts?key=${encodeURIComponent(urlObj.searchParams.get("key") || "")}">← Back to transcript list</a>
          </div>

          <pre>${escapeHtml(transcript.content)}</pre>
        `;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderLayout(`Transcript #${transcript.id}`, html));
        console.log(`[web] finished in ${Date.now() - started}ms`);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      console.log(`[web] finished in ${Date.now() - started}ms`);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    console.log(`[web] finished in ${Date.now() - started}ms`);
  } catch (err) {
    console.error("[web] route error:", err?.stack || err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 121000;

server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log(`[boot] Web server running on ${process.env.PORT || 3000}`);
});



/* -------------------------------------------------------------------------- */
/* Database                                                                    */
/* -------------------------------------------------------------------------- */

async function loadDatabase() {
  console.log("[boot] Initialising database...");
  await db.init();
  console.log("[boot] Database ready");
}



/* -------------------------------------------------------------------------- */
/* Command loader                                                              */
/* -------------------------------------------------------------------------- */

function loadCommands(client) {
  const commandsPath = path.join(__dirname, "commands");

  if (!fs.existsSync(commandsPath)) {
    console.warn("[commands] folder missing");
    return;
  }

  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));

  console.log(`[commands] Found ${files.length} command files`);

  for (const file of files) {
    const command = require(path.join(commandsPath, file));

    if (!command?.data || !command?.execute) {
      console.warn(`[commands] skipping ${file}`);
      continue;
    }

    client.commands.set(command.data.name, command);
    console.log(`[commands] loaded ${command.data.name}`);
  }
}



/* -------------------------------------------------------------------------- */
/* Event loader                                                                */
/* -------------------------------------------------------------------------- */

function loadEvents(client) {
  const eventsPath = path.join(__dirname, "events");

  if (!fs.existsSync(eventsPath)) {
    console.warn("[events] folder missing");
    return;
  }

  const files = fs.readdirSync(eventsPath).filter((f) => f.endsWith(".js"));

  console.log(`[events] Found ${files.length} event files`);

  for (const file of files) {
    const event = require(path.join(eventsPath, file));

    if (!event?.name || typeof event.execute !== "function") {
      console.warn(`[events] skipping ${file}`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }

    console.log(`[events] registered ${event.name}`);
  }
}



/* -------------------------------------------------------------------------- */
/* Discord bot                                                                 */
/* -------------------------------------------------------------------------- */

async function startBot() {
  await loadDatabase();

  console.log("[boot] Creating Discord client");

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

  client.once("ready", () => {
    updateStatus({
      state: "ready",
      lastReady: new Date().toISOString()
    });

    console.log(`[ready] Logged in as ${client.user.tag}`);

    client.user.setPresence({
      status: "dnd",
      activities: [
        {
          name: "classified operations",
          type: ActivityType.Watching
        }
      ]
    });

    console.log("[ready] Presence set");
  });

  client.on("shardDisconnect", (e) => {
    updateStatus({
      state: "disconnected",
      lastDisconnect: {
        time: new Date().toISOString(),
        code: e?.code ?? null,
        reason: e?.reason ?? null,
        wasClean: e?.wasClean ?? null
      }
    });

    console.warn("[gateway] disconnect", e?.code, e?.reason);
  });

  client.on("shardReconnecting", () => {
    updateStatus({ state: "reconnecting" });
    console.log("[gateway] reconnecting...");
  });

  client.on("shardResume", (id, replayedEvents) => {
    console.log(`[gateway] shard ${id} resumed (${replayedEvents} replayed events)`);
  });

  client.on("shardReady", (id, unavailableGuilds) => {
    console.log(`[gateway] shard ${id} ready (${unavailableGuilds?.size ?? 0} unavailable guilds)`);
  });

  client.on("error", (err) => {
    updateStatus({
      lastError: {
        time: new Date().toISOString(),
        error: err?.stack || String(err)
      }
    });

    console.error("[client error]", err);
  });

  client.on("warn", (msg) => {
    updateStatus({
      lastWarn: {
        time: new Date().toISOString(),
        warn: String(msg)
      }
    });

    console.warn("[client warn]", msg);
  });

  client.on("debug", (msg) => {
    const text = String(msg || "");
    const lower = text.toLowerCase();

    if (
      lower.includes("gateway") ||
      lower.includes("identify") ||
      lower.includes("session") ||
      lower.includes("heartbeat") ||
      lower.includes("resume") ||
      lower.includes("ready")
    ) {
      updateStatus({
        lastDebug: {
          time: new Date().toISOString(),
          message: text
        }
      });

      console.log("[client debug]", text);
    }
  });

  loadCommands(client);
  loadEvents(client);

  updateStatus({
    state: "logging_in",
    lastLoginAttempt: new Date().toISOString()
  });

  setTimeout(() => {
    if (botStatus.state === "logging_in" && !botStatus.lastReady) {
      updateStatus({
        state: "login_stalled",
        lastWarn: {
          time: new Date().toISOString(),
          warn: "Login has not reached ready after 45 seconds"
        }
      });

      console.warn("[boot] Login has not reached ready after 45 seconds");
    }
  }, 45000);

  console.log("[boot] Logging into Discord...");

  await client.login(TOKEN);
}

startBot().catch((err) => {
  updateStatus({
    state: "startup_failed",
    lastError: {
      time: new Date().toISOString(),
      error: err?.stack || String(err)
    }
  });

  console.error("[fatal] bot failed:", err?.stack || err);
  process.exit(1);
});