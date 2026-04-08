import "dotenv/config";

import fs from "fs";
import path from "path";
import http from "http";
import { URL } from "url";

import {
  ActivityType,
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Collection as DiscordCollection
} from "discord.js";

import * as db from "./database";
import { reconcileStaleTicketChannels } from "./lib/reconcileTicketChannels";
import { startGistBackupScheduler } from "./lib/gistBackup";

type LogLevel = "log" | "warn" | "error";

interface RuntimeLogEntry {
  time: string;
  level: LogLevel;
  message: string;
}

type BotState =
  | "starting"
  | "logging_in"
  | "login_stalled"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "startup_failed";

interface BotStatus {
  state: BotState | string;
  startedAt: string;
  lastLoginAttempt: string | null;
  lastReady: string | null;
  lastDisconnect: unknown;
  lastError: unknown;
  lastWarn: unknown;
  lastDebug: unknown;
}

const runtimeLogs: RuntimeLogEntry[] = [];
const MAX_RUNTIME_LOGS = 300;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function addRuntimeLog(level: LogLevel, args: unknown[]): void {
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

console.log = (...args: unknown[]) => {
  addRuntimeLog("log", args);
  originalConsoleLog(...args);
};

console.warn = (...args: unknown[]) => {
  addRuntimeLog("warn", args);
  originalConsoleWarn(...args);
};

console.error = (...args: unknown[]) => {
  addRuntimeLog("error", args);
  originalConsoleError(...args);
};

console.log("==> BUILD MARKER: CLEAN-STABLE-BOOT-GATEWAY-DEBUG-NOTIFY-COOLDOWN");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`[boot] Missing required env variable: ${name}`);
  }
  return value.trim();
}

const TOKEN = (process.env.DISCORD_TOKEN || process.env.TOKEN)?.trim();
if (!TOKEN) {
  throw new Error("[boot] Missing TOKEN or DISCORD_TOKEN in .env");
}

console.log("[boot] dotenv loaded");
console.log("[boot] NODE_ENV:", process.env.NODE_ENV || "not set");
console.log("[boot] PORT:", process.env.PORT || "not set");
console.log("[boot] MESSAGE_CONTENT_INTENT_REQUIRED:", true);

const botStatus: BotStatus = {
  state: "starting",
  startedAt: new Date().toISOString(),
  lastLoginAttempt: null,
  lastReady: null,
  lastDisconnect: null,
  lastError: null,
  lastWarn: null,
  lastDebug: null
};

function updateStatus(patch: Partial<BotStatus>): void {
  Object.assign(botStatus, patch);
}

function isoNow(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// NOTE: Admin DM notifications and DM cleanup are intentionally removed to reduce REST traffic/rate-limits.
// Errors still surface via logs and the /logs + /status endpoints.

function formatThrown(reason: unknown): string {
  if (reason instanceof Error) return reason.stack || reason.message;
  return String(reason);
}

function tryNotifyInteractionError(eventName: string, _err: unknown, args: unknown[]): void {
  const first = args[0];
  if (
    !first ||
    typeof first !== "object" ||
    !("isRepliable" in first) ||
    typeof (first as { isRepliable?: () => boolean }).isRepliable !== "function" ||
    !(first as { isRepliable: () => boolean }).isRepliable()
  ) {
    return;
  }

  const interaction = first as unknown as {
    replied?: boolean;
    deferred?: boolean;
    reply: (o: unknown) => Promise<unknown>;
    followUp: (o: unknown) => Promise<unknown>;
  };

  void (async () => {
    try {
      const payload = {
        content: "Something went wrong processing that action.",
        flags: MessageFlags.Ephemeral
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (replyErr) {
      console.error(
        `[events/${eventName}] Could not send error reply to user:`,
        (replyErr as Error)?.message || replyErr
      );
    }
  })();
}

process.on("unhandledRejection", (reason) => {
  const text = formatThrown(reason);
  console.error("[process] unhandledRejection:", text);
});

process.on("uncaughtException", (err) => {
  const text = formatThrown(err);
  console.error("[process] uncaughtException:", text);
  setTimeout(() => process.exit(1), 1000);
});

process.on("warning", (w) => {
  console.warn("[process] NodeWarning:", w.name, w.message);
  if (w.stack) console.warn(w.stack);
});

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isTranscriptAuthorised(urlObj: URL): boolean {
  const expected = process.env.TRANSCRIPT_VIEW_KEY;
  if (!expected) return false;
  return urlObj.searchParams.get("key") === expected;
}

function statusTone(state: BotStatus["state"]): { label: string; color: string } {
  switch (state) {
    case "ready":
    case "clientReady":
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
      return {
        label: String(state || "UNKNOWN").toUpperCase(),
        color: "#8b949e"
      };
  }
}

function levelTone(level: LogLevel): string {
  switch (level) {
    case "error":
      return "#f85149";
    case "warn":
      return "#d29922";
    default:
      return "#3b82f6";
  }
}

function basePage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0f172a">
<title>${escapeHtml(title)} — Feds Agent</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0f172a;
  --bg-elevated: #1e293b;
  --bg-card: #1e293b;
  --border: #334155;
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --accent: #6366f1;
  --accent-hover: #818cf8;
  --success: #22c55e;
  --warn: #eab308;
  --error: #ef4444;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 4px 6px -1px rgba(0,0,0,.2), 0 2px 4px -2px rgba(0,0,0,.15);
  --font: 'DM Sans', system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  background-image: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(99,102,241,.15), transparent);
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.6;
}
.page {
  max-width: 1120px;
  margin: 0 auto;
  padding: 2rem 1.5rem 3rem;
}
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
  margin-bottom: 2rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
}
.header h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.header .subtitle {
  margin: .25rem 0 0;
  color: var(--text-muted);
  font-size: .875rem;
  font-weight: 400;
}
.nav {
  display: flex;
  flex-wrap: wrap;
  gap: .5rem;
}
.nav a {
  display: inline-flex;
  align-items: center;
  padding: .5rem 1rem;
  color: var(--text);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: .875rem;
  font-weight: 500;
  text-decoration: none;
  transition: border-color .15s, background .15s;
}
.nav a:hover {
  background: var(--bg-elevated);
  border-color: var(--accent);
}
.grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 1.25rem;
}
.card {
  grid-column: span 12;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem 1.5rem;
  box-shadow: var(--shadow);
}
.card h2 {
  margin: 0 0 1rem;
  font-size: .9375rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: .05em;
}
.kpi {
  grid-column: span 3;
}
.kpi-value {
  margin-top: .25rem;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.kpi-label {
  font-size: .75rem;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: .06em;
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: .35rem .75rem;
  border-radius: 999px;
  font-size: .75rem;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.muted { color: var(--text-muted); }
.code {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: .8125rem;
}
.stack { display: flex; flex-direction: column; gap: 0; }
.row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  padding: .75rem 0;
  border-bottom: 1px solid var(--border);
}
.row:last-child { border-bottom: none; }
.row .code { max-width: 70%; text-align: right; word-break: break-word; }
.logs { display: flex; flex-direction: column; gap: .75rem; }
.log {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1rem 1.25rem;
}
.log-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: .5rem;
  margin-bottom: .5rem;
}
.log-level {
  font-size: .6875rem;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.log-message {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: .8125rem;
  line-height: 1.5;
  color: var(--text);
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); }
pre {
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: 1.25rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: .8125rem;
  line-height: 1.55;
  overflow-x: auto;
}
input[type="text"] {
  width: 100%;
  max-width: 420px;
  padding: .625rem 1rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: .9375rem;
}
input[type="text"]:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(99,102,241,.2);
}
.btn {
  padding: .5rem 1rem;
  background: var(--accent);
  border: none;
  border-radius: var(--radius-sm);
  color: #fff;
  font-family: var(--font);
  font-size: .9375rem;
  font-weight: 500;
  cursor: pointer;
  transition: background .15s;
}
.btn:hover { background: var(--accent-hover); }
.search-card {
  margin-bottom: 1.5rem;
}
.search-card form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
.transcript-card {
  display: block;
  padding: 1.25rem 1.5rem;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-decoration: none;
  color: inherit;
  transition: border-color .15s, background .15s;
}
.transcript-card:hover {
  background: var(--bg-elevated);
  border-color: var(--accent);
}
.transcript-card strong { font-size: 1rem; }
.transcript-card .meta {
  margin-top: .35rem;
  font-size: .8125rem;
  color: var(--text-muted);
}
.transcript-card .open-link {
  display: inline-block;
  margin-top: .75rem;
  font-size: .875rem;
  font-weight: 500;
  color: var(--accent);
}
.empty-state {
  text-align: center;
  padding: 2.5rem 1.5rem;
  color: var(--text-muted);
  font-size: .9375rem;
}
.detail-meta {
  margin-bottom: 1.25rem;
}
.detail-meta strong { display: block; margin-bottom: .25rem; }
.detail-meta .meta { font-size: .875rem; color: var(--text-muted); }
@media (max-width: 900px) { .kpi { grid-column: span 6; } }
@media (max-width: 640px) { .kpi { grid-column: span 12; } .page { padding: 1.25rem 1rem; } }
</style>
</head>
<body>
<main class="page">
  ${body}
</main>
</body>
</html>`;
}

function renderStatusPage(): string {
  const tone = statusTone(botStatus.state);

  const details: [string, string][] = [
    ["State", tone.label],
    ["Started At", botStatus.startedAt || "—"],
    ["Last Login Attempt", botStatus.lastLoginAttempt || "—"],
    ["Last Ready", botStatus.lastReady || "—"],
    [
      "Last Disconnect",
      botStatus.lastDisconnect ? JSON.stringify(botStatus.lastDisconnect, null, 2) : "—"
    ],
    ["Last Warning", botStatus.lastWarn ? JSON.stringify(botStatus.lastWarn, null, 2) : "—"],
    ["Last Error", botStatus.lastError ? JSON.stringify(botStatus.lastError, null, 2) : "—"],
    ["Last Debug", botStatus.lastDebug ? JSON.stringify(botStatus.lastDebug, null, 2) : "—"]
  ];

  const rows = details
    .map(
      ([label, value]) => `
    <div class="row">
      <div class="muted">${escapeHtml(label)}</div>
      <div class="code" style="max-width:65%; text-align:right;">${escapeHtml(
        value
      )}</div>
    </div>
  `
    )
    .join("");

  return basePage(
    "Feds Agent Status",
    `
    <header class="header">
      <div>
        <h1>Feds Agent Status</h1>
        <p class="subtitle">Live runtime overview for the bot and web service.</p>
      </div>
      <nav class="nav">
        <a href="/status">Status</a>
        <a href="/logs">Logs</a>
        <a href="/status.json">JSON</a>
        <a href="/logs.json">Logs JSON</a>
        <a href="/healthz">Health</a>
      </nav>
    </header>

    <div class="grid">
      <div class="card kpi">
        <div class="kpi-label">Service</div>
        <div class="kpi-value">feds-agent</div>
      </div>
      <div class="card kpi">
        <div class="kpi-label">Current State</div>
        <div class="kpi-value">
          <span class="badge" style="background:${tone.color}22;border:1px solid ${tone.color};color:${tone.color}">
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
  `
  );
}

function renderLogsPage(): string {
  const logsHtml = runtimeLogs.length
    ? runtimeLogs
        .slice()
        .reverse()
        .map(
          (entry) => `
      <div class="log">
        <div class="log-top">
          <div class="log-level" style="color:${levelTone(entry.level)}">${escapeHtml(
            entry.level
          )}</div>
          <div class="muted code">${escapeHtml(entry.time)}</div>
        </div>
        <div class="log-message">${escapeHtml(entry.message)}</div>
      </div>
    `
        )
        .join("")
    : `<div class="card empty-state">No runtime logs captured yet. Events will appear here after the bot runs.</div>`;

  return basePage(
    "Feds Agent Logs",
    `
    <header class="header">
      <div>
        <h1>Runtime Logs</h1>
        <p class="subtitle">Latest ${runtimeLogs.length} in-memory events. JSON: <a href="/logs.json">/logs.json</a></p>
      </div>
      <nav class="nav">
        <a href="/status">Status</a>
        <a href="/logs">Logs</a>
        <a href="/status.json">JSON</a>
        <a href="/logs.json">Logs JSON</a>
        <a href="/healthz">Health</a>
      </nav>
    </header>

    <div class="logs">
      ${logsHtml}
    </div>
  `
  );
}

function shouldLogRequest(req: http.IncomingMessage, pathname: string): boolean {
  if (req.method === "HEAD") return false;

  const ignored = new Set<string>([
    "/",
    "/favicon.ico",
    "/healthz",
    "/status",
    "/logs",
    "/status.json",
    "/logs.json"
  ]);

  if (ignored.has(pathname)) return false;
  // Ignore transcript routes (they can be noisy during browsing/search).
  if (pathname === "/transcripts" || pathname.startsWith("/transcripts/")) return false;

  return true;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlObj = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const logThisRequest = shouldLogRequest(req, pathname);

  if (logThisRequest) {
    console.log(`[web] ${req.method} ${pathname}`);
  }

  try {
    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      if (logThisRequest) {
        console.log(`[web] finished in ${Date.now() - started}ms`);
      }
      return;
    }

    if (pathname === "/status") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderStatusPage());
      if (logThisRequest) {
        console.log(`[web] finished in ${Date.now() - started}ms`);
      }
      return;
    }

    if (pathname === "/status.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            service: "feds-agent",
            bot: botStatus,
            now: isoNow()
          },
          null,
          2
        )
      );
      if (logThisRequest) {
        console.log(`[web] finished in ${Date.now() - started}ms`);
      }
      return;
    }

    if (pathname === "/logs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLogsPage());
      if (logThisRequest) {
        console.log(`[web] finished in ${Date.now() - started}ms`);
      }
      return;
    }

    if (pathname === "/logs.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            service: "feds-agent",
            count: runtimeLogs.length,
            logs: runtimeLogs,
            now: isoNow()
          },
          null,
          2
        )
      );
      if (logThisRequest) {
        console.log(`[web] finished in ${Date.now() - started}ms`);
      }
      return;
    }

    if (pathname === "/transcripts" || pathname.startsWith("/transcripts/")) {
      if (!isTranscriptAuthorised(urlObj)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        if (logThisRequest) {
          console.log(`[web] finished in ${Date.now() - started}ms`);
        }
        return;
      }

      if (pathname === "/transcripts") {
        const rows = await db.listTranscripts(200);
        const q = (urlObj.searchParams.get("q") || "").trim().toLowerCase();

        const filtered = q
          ? rows.filter(
              (row) =>
                String(row.channel_name).toLowerCase().includes(q) ||
                String(row.closed_by).toLowerCase().includes(q) ||
                String(row.id).includes(q)
            )
          : rows;

        const keyParam = encodeURIComponent(urlObj.searchParams.get("key") || "");
        const cards =
          filtered.length > 0
            ? filtered
                .map(
                  (row) => `
            <a href="/transcripts/${row.id}?key=${keyParam}" class="transcript-card">
              <strong>#${row.id} ${escapeHtml(row.channel_name)}</strong>
              <div class="meta">
                Closed by ${escapeHtml(row.closed_by)} · ${new Date(row.created_at).toLocaleString("en-GB")}
              </div>
              <span class="open-link">Open transcript →</span>
            </a>
          `
                )
                .join("")
            : `<div class="card empty-state">No transcripts found. Try a different search or check back later.</div>`;

        const html = `
          <header class="header">
            <div>
              <h1>Ticket Transcripts</h1>
              <p class="subtitle">${filtered.length} result(s). Search by channel name, closer, or ID.</p>
            </div>
            <nav class="nav">
              <a href="/status">Status</a>
              <a href="/logs">Logs</a>
              <a href="/transcripts?key=${keyParam}">Transcripts</a>
            </nav>
          </header>

          <div class="card search-card">
            <form method="GET" action="/transcripts">
              <input type="hidden" name="key" value="${escapeHtml(urlObj.searchParams.get("key") || "")}">
              <input type="text" name="q" value="${escapeHtml(q)}" placeholder="Search by channel, closer, or ID">
              <button type="submit" class="btn">Search</button>
            </form>
          </div>

          <div class="logs">
            ${cards}
          </div>
        `;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(basePage("Ticket Transcripts", html));
        if (logThisRequest) {
          console.log(`[web] finished in ${Date.now() - started}ms`);
        }
        return;
      }

      const idMatch = pathname.match(/^\/transcripts\/(\d+)$/);

      if (idMatch) {
        const transcript = await db.getTranscriptById(Number(idMatch[1]));

        if (!transcript) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Transcript not found");
          if (logThisRequest) {
            console.log(`[web] finished in ${Date.now() - started}ms`);
          }
          return;
        }

        const keyParam = encodeURIComponent(urlObj.searchParams.get("key") || "");
        const html = `
          <header class="header">
            <div>
              <h1>Transcript #${escapeHtml(String(transcript.id))}</h1>
              <p class="subtitle">${escapeHtml(transcript.channel_name)}</p>
            </div>
            <nav class="nav">
              <a href="/transcripts?key=${keyParam}">← Back to transcripts</a>
              <a href="/status">Status</a>
              <a href="/logs">Logs</a>
            </nav>
          </header>

          <div class="card detail-meta">
            <strong>Channel</strong>
            <div class="meta">${escapeHtml(transcript.channel_name)} · Closed by ${escapeHtml(transcript.closed_by)} · ${new Date(transcript.created_at).toLocaleString("en-GB")}</div>
          </div>

          <div class="card" style="padding:0; overflow:hidden;">
            <pre>${escapeHtml(transcript.content)}</pre>
          </div>
        `;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(basePage(`Transcript #${transcript.id}`, html));
        if (logThisRequest) {
          console.log(`[web] finished in ${Date.now() - started}ms`);
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      if (logThisRequest) {
        console.log(`[web] finished in ${Date.now() - started}ms`);
      }
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    if (logThisRequest) {
      console.log(`[web] finished in ${Date.now() - started}ms`);
    }
  } catch (err) {
    const detail = formatThrown(err);
    console.error("[web] route error:", detail);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 121000;

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`[boot] Web server running on ${port}`);
});

async function loadDatabase(): Promise<void> {
  const maxAttempts = 5;
  const delayMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[boot] Initialising database... (attempt ${attempt}/${maxAttempts})`);
      await db.init();
      console.log("[boot] Database ready");
      return;
    } catch (err) {
      console.error(
        `[boot] Database init failed on attempt ${attempt}:`,
        (err as Error)?.stack || err
      );

      if (attempt === maxAttempts) {
        throw err;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

interface CommandModule {
  data: { name: string; toJSON(): unknown };
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
}

type CommandCollection = DiscordCollection<string, CommandModule>;

function loadCommands(client: Client & { commands: CommandCollection }): void {
  const commandsPath = path.join(__dirname, "commands");

  if (!fs.existsSync(commandsPath)) {
    console.warn("[commands] folder missing");
    return;
  }

  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));

  console.log(`[commands] Found ${files.length} command files`);

  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const command: CommandModule | undefined = require(path.join(commandsPath, file));

    if (!command?.data || !command?.execute) {
      console.warn(`[commands] skipping ${file}`);
      continue;
    }

    client.commands.set(command.data.name, command);
    console.log(`[commands] loaded ${command.data.name}`);
  }
}

interface EventModule {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => Promise<unknown> | unknown;
}

function loadEvents(client: Client & { commands: CommandCollection }): void {
  const eventsPath = path.join(__dirname, "events");

  if (!fs.existsSync(eventsPath)) {
    console.warn("[events] folder missing");
    return;
  }

  const files = fs.readdirSync(eventsPath).filter((f) => f.endsWith(".js"));

  console.log(`[events] Found ${files.length} event files`);

  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const event: EventModule | undefined = require(path.join(eventsPath, file));

    if (!event?.name || typeof event.execute !== "function") {
      console.warn(`[events] skipping ${file}`);
      continue;
    }

    const run = (...args: unknown[]) => {
      Promise.resolve(event.execute(...args, client)).catch((err) => {
        const detail = formatThrown(err);
        console.error(`[events/${event.name}]`, detail);
        tryNotifyInteractionError(event.name, err, args);
      });
    };

    if (event.once) {
      client.once(event.name, run);
    } else {
      client.on(event.name, run);
    }

    console.log(`[events] registered ${event.name}`);
  }
}

async function startBot(): Promise<void> {
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
  }) as Client & { commands: CommandCollection };

  client.commands = new Collection<string, CommandModule>() as unknown as CommandCollection;

  client.once(Events.ClientReady, async () => {
    updateStatus({
      state: "ready",
      lastReady: isoNow()
    });

    if (!client.user) return;

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

    await reconcileStaleTicketChannels(client);

    startGistBackupScheduler();

    // Quick permission sanity check (common root cause of "can't delete channels").
    try {
      const me = await client.user?.fetch();
      if (me) {
        for (const [guildId] of client.guilds.cache) {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) continue;
          const member = await guild.members.fetch(me.id).catch(() => null);
          if (!member) continue;
          const perms = member.permissions;
          const missing: string[] = [];
          if (!perms.has("ManageChannels")) missing.push("ManageChannels");
          if (!perms.has("ViewChannel")) missing.push("ViewChannel");
          if (missing.length) {
            console.warn(
              `[ready] Missing guild-level permissions in ${guild.name} (${guild.id}): ${missing.join(", ")}`
            );
          }
        }
      }
    } catch (e) {
      console.warn("[ready] Permission self-check failed:", (e as Error)?.message || e);
    }

  });

  client.on("shardDisconnect", async (e) => {
    updateStatus({
      state: "disconnected",
      lastDisconnect: {
        time: isoNow(),
        code: (e as any)?.code ?? null,
        reason: (e as any)?.reason ?? null,
        wasClean: (e as any)?.wasClean ?? null
      }
    });

    console.warn("[gateway] disconnect", (e as any)?.code, (e as any)?.reason);
  });

  client.on("shardReconnecting", async () => {
    updateStatus({ state: "reconnecting" });
    console.log("[gateway] reconnecting...");
  });

  client.on("shardResume", (id, replayedEvents) => {
    console.log(
      `[gateway] shard ${id} resumed (${replayedEvents} replayed events)`
    );
  });

  client.on("shardReady", (id, unavailableGuilds) => {
    console.log(
      `[gateway] shard ${id} ready (${(unavailableGuilds as any)?.size ?? 0} unavailable guilds)`
    );
  });

  client.on("error", (err) => {
    updateStatus({
      lastError: {
        time: isoNow(),
        error: (err as Error)?.stack || String(err)
      }
    });

    console.error("[client error]", err);
  });

  // Surface shard-level errors (useful when gateway never reaches READY).
  client.on("shardError", (err) => {
    updateStatus({
      lastError: { time: isoNow(), error: (err as Error)?.stack || String(err) }
    });
    console.error("[gateway] shardError", (err as Error)?.stack || err);
  });

  client.on("invalidated", () => {
    updateStatus({
      lastWarn: { time: isoNow(), warn: "Session invalidated" }
    });
    console.warn("[gateway] session invalidated");
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
      text.includes("connected") ||
      text.includes("prepare") ||
      text.includes("socket") ||
      text.includes("close") ||
      text.includes("error") ||
      text.includes("invalid")
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

  client.rest.on("rateLimited", (info) => {
    console.warn(
      "[rest] rateLimited",
      "route=",
      (info as { route?: string }).route,
      "limit=",
      (info as { limit?: number }).limit,
      "method=",
      (info as { method?: string }).method,
      "global=",
      (info as { global?: boolean }).global
    );
  });

  loadCommands(client);
  loadEvents(client);

  updateStatus({
    state: "logging_in",
    lastLoginAttempt: isoNow()
  });

  // If gateway login stalls, force a clean reconnect. This avoids “stuck” instances on host restarts.
  const LOGIN_STALL_MS = 120000;
  const MAX_LOGIN_RETRIES = 3;

  let loginRetries = 0;
  let stallTimer: NodeJS.Timeout | null = null;

  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(async () => {
      if (botStatus.state === "ready" || botStatus.lastReady) return;

      updateStatus({
        state: "login_stalled",
        lastWarn: {
          time: isoNow(),
          warn: `Login has not reached ready after ${Math.round(LOGIN_STALL_MS / 1000)} seconds`
        }
      });
      console.warn("[boot] Login has not reached ready in time; restarting gateway session");

      loginRetries++;
      if (loginRetries > MAX_LOGIN_RETRIES) {
        console.error("[boot] Max login retries exceeded; exiting for host restart");
        process.exit(1);
      }

      try {
        await client.destroy();
      } catch (e) {
        console.warn("[boot] client.destroy failed:", (e as Error)?.message || e);
      }

      await sleep(2000 * loginRetries);
      updateStatus({ state: "logging_in", lastLoginAttempt: isoNow() });
      armStallTimer();
      await client.login(TOKEN);
    }, LOGIN_STALL_MS);
  };

  armStallTimer();

  client.once(Events.ClientReady, () => {
    if (stallTimer) clearTimeout(stallTimer);
  });

  console.log("[boot] Logging into Discord...");

  await client.login(TOKEN);
}

startBot().catch(async (err) => {
  updateStatus({
    state: "startup_failed",
    lastError: {
      time: isoNow(),
      error: (err as Error)?.stack || String(err)
    }
  });

  console.error("[fatal] bot failed:", (err as Error)?.stack || err);

  process.exit(1);
});
