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
/* Runtime log capture                                                         */
/* -------------------------------------------------------------------------- */

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

const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

console.log = (...args) => {
  addRuntimeLog("log", args);
  originalConsoleLog(...args);
};

console.warn = (...args) => {
  addRuntimeLog("warn", args);
  originalConsoleWarn(...args);
};

console.error = (...args) => {
  addRuntimeLog("error", args);
  originalConsoleError(...args);
};


/* -------------------------------------------------------------------------- */
/* Boot logging                                                                */
/* -------------------------------------------------------------------------- */

console.log("==> BUILD MARKER: CLEAN-STABLE-BOOT-GATEWAY-DEBUG-NOTIFY-COOLDOWN");

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

/* hardcoded temporarily because you can't access Render env right now */
const ADMIN_USER_ID = "261265820678619137";

console.log("[boot] dotenv loaded");
console.log("[boot] NODE_ENV:", process.env.NODE_ENV || "not set");
console.log("[boot] PORT:", process.env.PORT || "not set");
console.log("[boot] MESSAGE_CONTENT_INTENT_REQUIRED:", true);


/* -------------------------------------------------------------------------- */
/* Runtime status                                                              */
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

function isoNow() {
  return new Date().toISOString();
}


/* -------------------------------------------------------------------------- */
/* DM notifications with cooldown                                              */
/* -------------------------------------------------------------------------- */

const notificationCooldowns = new Map();
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

function canSendNotification(key) {
  const now = Date.now();
  const last = notificationCooldowns.get(key) || 0;

  if (now - last < NOTIFY_COOLDOWN_MS) {
    return false;
  }

  notificationCooldowns.set(key, now);
  return true;
}

async function sendAdminDm(client, title, lines = [], options = {}) {
  const cooldownKey = options.cooldownKey || title;
  const bypassCooldown = options.bypassCooldown === true;

  if (!bypassCooldown && !canSendNotification(cooldownKey)) {
    console.log(`[notify] Cooldown active, skipped DM: ${title}`);
    return;
  }

  try {
    const user = await client.users.fetch(ADMIN_USER_ID);

    const content = [
      `**${title}**`,
      ...lines
    ].join("\n");

    await user.send(content);
    console.log(`[notify] DM sent: ${title}`);
  } catch (err) {
    console.warn(`[notify] Failed to send DM: ${title}`, err?.message || err);
  }
}


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

function isTranscriptAuthorised(urlObj) {
  const expected = process.env.TRANSCRIPT_VIEW_KEY;
  if (!expected) return false;
  return urlObj.searchParams.get("key") === expected;
}

function statusTone(state) {
  switch (state) {
    case "ready":
      return { label: "READY", color: "#3fb950" };
    case "logging_in":
      return { label: "LOGGING IN", color: "#d29922" };
    case "login_stalled":
      return { label: "LOGIN STALLED", color: "#f85149" };
    case "reconnecting":
      return { label: "RECONNECTING", color: "#d29922" };
    case "disconnected":
      return { label: "DISCONNECTED", color: "#f85149" };
    case "startup_failed":
      return { label: "STARTUP FAILED", color: "#f85149" };
    default:
      return { label: String(state || "UNKNOWN").toUpperCase(), color: "#8b949e" };
  }
}

function levelTone(level) {
  switch (level) {
    case "error":
      return "#f85149";
    case "warn":
      return "#d29922";
    default:
      return "#3b82f6";
  }
}

function basePage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
:root{
  --bg:#0b0b0f;
  --panel:#12131a;
  --panel-2:#161823;
  --border:#262b36;
  --text:#edf2f7;
  --muted:#9aa4b2;
  --link:#8ab4ff;
}
*{box-sizing:border-box}
body{
  margin:0;
  background:linear-gradient(180deg,#0b0b0f 0%,#0f1118 100%);
  color:var(--text);
  font-family:Inter,Segoe UI,Arial,sans-serif;
}
.wrap{
  max-width:1200px;
  margin:0 auto;
  padding:24px;
}
.topbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:16px;
  margin-bottom:24px;
  flex-wrap:wrap;
}
.title{
  font-size:28px;
  font-weight:700;
  letter-spacing:-0.02em;
}
.subtitle{
  color:var(--muted);
  margin-top:6px;
  font-size:14px;
}
.nav{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}
.nav a{
  color:var(--text);
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:10px;
  padding:10px 14px;
  text-decoration:none;
  font-size:14px;
}
.nav a:hover{
  border-color:#3b82f6;
}
.grid{
  display:grid;
  grid-template-columns:repeat(12,1fr);
  gap:16px;
}
.card{
  grid-column:span 12;
  background:var(--panel);
  border:1px solid var(--border);
  border-radius:16px;
  padding:18px;
  box-shadow:0 10px 30px rgba(0,0,0,.25);
}
.card h2{
  margin:0 0 12px;
  font-size:16px;
}
.kpi{
  grid-column:span 3;
}
.kpi-value{
  font-size:24px;
  font-weight:700;
  margin-top:6px;
}
.kpi-label{
  color:var(--muted);
  font-size:12px;
  text-transform:uppercase;
  letter-spacing:.08em;
}
.badge{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:8px 12px;
  border-radius:999px;
  font-size:12px;
  font-weight:700;
  letter-spacing:.06em;
  text-transform:uppercase;
  border:1px solid transparent;
}
.muted{
  color:var(--muted);
}
.code{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;
}
.stack{
  display:flex;
  flex-direction:column;
  gap:12px;
}
.row{
  display:flex;
  justify-content:space-between;
  gap:16px;
  padding:12px 0;
  border-bottom:1px solid rgba(255,255,255,.06);
}
.row:last-child{
  border-bottom:none;
}
.logs{
  display:flex;
  flex-direction:column;
  gap:10px;
}
.log{
  border:1px solid var(--border);
  background:var(--panel-2);
  border-radius:12px;
  padding:12px 14px;
}
.log-top{
  display:flex;
  justify-content:space-between;
  gap:12px;
  margin-bottom:8px;
  flex-wrap:wrap;
}
.log-level{
  font-size:11px;
  font-weight:700;
  letter-spacing:.08em;
  text-transform:uppercase;
}
.log-message{
  white-space:pre-wrap;
  word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:13px;
  line-height:1.5;
}
a{
  color:var(--link);
}
pre{
  white-space:pre-wrap;
  word-break:break-word;
  background:var(--panel-2);
  border:1px solid var(--border);
  border-radius:12px;
  padding:14px;
  margin:0;
}
input{
  width:100%;
  max-width:420px;
  padding:10px;
  border-radius:8px;
  border:1px solid #2d2d3a;
  background:#101017;
  color:#f3f3f5;
}
@media (max-width: 900px){
  .kpi{ grid-column:span 6; }
}
@media (max-width: 640px){
  .kpi{ grid-column:span 12; }
}
</style>
</head>
<body>
<div class="wrap">
  ${body}
</div>
</body>
</html>`;
}

function renderStatusPage() {
  const tone = statusTone(botStatus.state);

  const details = [
    ["State", tone.label],
    ["Started At", botStatus.startedAt || "—"],
    ["Last Login Attempt", botStatus.lastLoginAttempt || "—"],
    ["Last Ready", botStatus.lastReady || "—"],
    ["Last Disconnect", botStatus.lastDisconnect ? JSON.stringify(botStatus.lastDisconnect, null, 2) : "—"],
    ["Last Warning", botStatus.lastWarn ? JSON.stringify(botStatus.lastWarn, null, 2) : "—"],
    ["Last Error", botStatus.lastError ? JSON.stringify(botStatus.lastError, null, 2) : "—"],
    ["Last Debug", botStatus.lastDebug ? JSON.stringify(botStatus.lastDebug, null, 2) : "—"]
  ];

  const rows = details.map(([label, value]) => `
    <div class="row">
      <div class="muted">${escapeHtml(label)}</div>
      <div class="code" style="max-width:65%; text-align:right;">${escapeHtml(value)}</div>
    </div>
  `).join("");

  return basePage("Feds Agent Status", `
    <div class="topbar">
      <div>
        <div class="title">Feds Agent Status</div>
        <div class="subtitle">Live runtime overview for the bot and web service.</div>
      </div>
      <div class="nav">
        <a href="/status">Status</a>
        <a href="/logs">Logs</a>
        <a href="/status.json">Status JSON</a>
        <a href="/logs.json">Logs JSON</a>
        <a href="/healthz">Health</a>
      </div>
    </div>

    <div class="grid">
      <div class="card kpi">
        <div class="kpi-label">Service</div>
        <div class="kpi-value">feds-agent</div>
      </div>

      <div class="card kpi">
        <div class="kpi-label">Current State</div>
        <div class="kpi-value">
          <span class="badge" style="background:${tone.color}22;border-color:${tone.color};color:${tone.color}">
            ${escapeHtml(tone.label)}
          </span>
        </div>
      </div>

      <div class="card kpi">
        <div class="kpi-label">Runtime Logs</div>
        <div class="kpi-value">${runtimeLogs.length}</div>
      </div>

      <div class="card kpi">
        <div class="kpi-label">Now</div>
        <div class="kpi-value code">${escapeHtml(isoNow())}</div>
      </div>

      <div class="card">
        <h2>Bot State</h2>
        <div class="stack">
          ${rows}
        </div>
      </div>
    </div>
  `);
}

function renderLogsPage() {
  const logsHtml = runtimeLogs.length
    ? runtimeLogs.slice().reverse().map((entry) => `
      <div class="log">
        <div class="log-top">
          <div class="log-level" style="color:${levelTone(entry.level)}">${escapeHtml(entry.level)}</div>
          <div class="muted code">${escapeHtml(entry.time)}</div>
        </div>
        <div class="log-message">${escapeHtml(entry.message)}</div>
      </div>
    `).join("")
    : `<div class="card">No runtime logs captured yet.</div>`;

  return basePage("Feds Agent Logs", `
    <div class="topbar">
      <div>
        <div class="title">Feds Agent Logs</div>
        <div class="subtitle">Latest ${runtimeLogs.length} in-memory runtime events.</div>
      </div>
      <div class="nav">
        <a href="/status">Status</a>
        <a href="/logs">Logs</a>
        <a href="/status.json">Status JSON</a>
        <a href="/logs.json">Logs JSON</a>
        <a href="/healthz">Health</a>
      </div>
    </div>

    <div class="logs">
      ${logsHtml}
    </div>
  `);
}


/* -------------------------------------------------------------------------- */
/* Web server                                                                  */
/* -------------------------------------------------------------------------- */

function shouldLogRequest(req, pathname) {
  if (req.method === "HEAD") return false;

  const ignored = new Set([
    "/",
    "/favicon.ico",
    "/healthz",
    "/status",
    "/logs",
    "/status.json",
    "/transcripts",
    "/logs.json"
  ]);

  if (ignored.has(pathname)) return false;

  return true;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const logThisRequest = shouldLogRequest(req, pathname);

  if (logThisRequest) {
  console.log(`[web] ${req.method} ${pathname}`);
}

  try {
    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
      return;
    }

    if (pathname === "/status") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderStatusPage());
      if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
      return;
    }

    if (pathname === "/status.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "feds-agent",
        bot: botStatus,
        now: isoNow()
      }, null, 2));
      if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
      return;
    }

    if (pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLogsPage());
      if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
      return;
    }

    if (pathname === "/logs.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "feds-agent",
        count: runtimeLogs.length,
        logs: runtimeLogs,
        now: isoNow()
      }, null, 2));
      if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
      return;
    }

    if (pathname === "/transcripts" || pathname.startsWith("/transcripts/")) {
      if (!isTranscriptAuthorised(urlObj)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
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
          <div class="topbar">
            <div>
              <div class="title">Ticket Transcripts</div>
              <div class="subtitle">Latest ${filtered.length} result(s)</div>
            </div>
            <div class="nav">
              <a href="/status">Status</a>
              <a href="/logs">Logs</a>
            </div>
          </div>

          <div class="card">
            <form method="GET" action="/transcripts">
              <input type="hidden" name="key" value="${escapeHtml(urlObj.searchParams.get("key") || "")}">
              <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search by channel, closer, or ID">
            </form>
          </div>

          ${cards}
        `;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(basePage("Ticket Transcripts", html));
        if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
        return;
      }

      const idMatch = pathname.match(/^\/transcripts\/(\d+)$/);

      if (idMatch) {
        const transcript = await db.getTranscriptById(Number(idMatch[1]));

        if (!transcript) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Transcript not found");
          if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
          return;
        }

        const html = `
          <div class="topbar">
            <div>
              <div class="title">Transcript #${escapeHtml(transcript.id)}</div>
              <div class="subtitle">${escapeHtml(transcript.channel_name)}</div>
            </div>
            <div class="nav">
              <a href="/transcripts?key=${encodeURIComponent(urlObj.searchParams.get("key") || "")}">Back to transcripts</a>
              <a href="/status">Status</a>
              <a href="/logs">Logs</a>
            </div>
          </div>

          <div class="card">
            <strong>Channel:</strong> ${escapeHtml(transcript.channel_name)}
            <div class="meta">
              Closed by ${escapeHtml(transcript.closed_by)}
              • ${new Date(transcript.created_at).toLocaleString("en-GB")}
            </div>
          </div>

          <pre>${escapeHtml(transcript.content)}</pre>
        `;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(basePage(`Transcript #${transcript.id}`, html));
        if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    if (logThisRequest) {   console.log(`[web] finished in ${Date.now() - started}ms`); }
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

  client.once("ready", async () => {
    updateStatus({
      state: "ready",
      lastReady: isoNow()
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

    await sendAdminDm(client, "🟢 Feds Agent Online", [
      `Bot: ${client.user.tag}`,
      `Time: ${isoNow()}`,
      `State: READY`
    ], {
      cooldownKey: "ready"
    });
  });

  client.on("shardDisconnect", async (e) => {
    updateStatus({
      state: "disconnected",
      lastDisconnect: {
        time: isoNow(),
        code: e?.code ?? null,
        reason: e?.reason ?? null,
        wasClean: e?.wasClean ?? null
      }
    });

    console.warn("[gateway] disconnect", e?.code, e?.reason);

    await sendAdminDm(client, "🔴 Feds Agent Disconnected", [
      `Time: ${isoNow()}`,
      `Code: ${e?.code ?? "unknown"}`,
      `Reason: ${e?.reason ?? "unknown"}`,
      `Was Clean: ${String(e?.wasClean ?? false)}`
    ], {
      cooldownKey: "disconnect"
    });
  });

  client.on("shardReconnecting", async () => {
    updateStatus({ state: "reconnecting" });
    console.log("[gateway] reconnecting...");

    await sendAdminDm(client, "🟠 Feds Agent Reconnecting", [
      `Time: ${isoNow()}`,
      `State: RECONNECTING`
    ], {
      cooldownKey: "reconnecting"
    });
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
        time: isoNow(),
        error: err?.stack || String(err)
      }
    });

    console.error("[client error]", err);
  });

  client.on("warn", (msg) => {
    updateStatus({
      lastWarn: {
        time: isoNow(),
        warn: String(msg)
      }
    });

    console.warn("[client warn]", msg);
  });

    client.on("debug", (msg) => {
    const text = String(msg || "").toLowerCase();
  
    if (
      text.includes("gateway") ||
      text.includes("identify") ||
      text.includes("session") ||
      text.includes("heartbeat") ||
      text.includes("resume") ||
      text.includes("ready") ||
      text.includes("connecting") ||
      text.includes("connected")
    ) {
      updateStatus({
        lastDebug: {
          time: isoNow(),
          message: msg
        }
      });
  
      console.log("[client debug]", msg);
    }
  });

  loadCommands(client);
  loadEvents(client);

  updateStatus({
    state: "logging_in",
    lastLoginAttempt: isoNow()
  });

  setTimeout(async () => {
    if (botStatus.state === "logging_in" && !botStatus.lastReady) {
      updateStatus({
        state: "login_stalled",
        lastWarn: {
          time: isoNow(),
          warn: "Login has not reached ready after 45 seconds"
        }
      });

      console.warn("[boot] Login has not reached ready after 45 seconds");

      await sendAdminDm(client, "🟡 Feds Agent Login Stalled", [
        `Time: ${isoNow()}`,
        `State: LOGIN_STALLED`,
        `Last Debug: ${botStatus.lastDebug?.message || "none"}`
      ], {
        cooldownKey: "login_stalled"
      });
    }
  }, 45000);

  console.log("[boot] Logging into Discord...");

  await client.login(TOKEN);
}

startBot().catch(async (err) => {
  updateStatus({
    state: "startup_failed",
    lastError: {
      time: isoNow(),
      error: err?.stack || String(err)
    }
  });

  console.error("[fatal] bot failed:", err?.stack || err);

  try {
    const tempClient = new Client({
      intents: [GatewayIntentBits.Guilds]
    });

    await tempClient.login(TOKEN);

    await sendAdminDm(tempClient, "💥 Feds Agent Startup Failed", [
      `Time: ${isoNow()}`,
      `Error: ${err?.message || String(err)}`
    ], {
      cooldownKey: "startup_failed",
      bypassCooldown: true
    });

    await tempClient.destroy();
  } catch (_) {}

  process.exit(1);
});
