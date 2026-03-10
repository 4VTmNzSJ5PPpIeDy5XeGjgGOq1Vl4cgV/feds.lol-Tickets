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

console.log("==> BUILD MARKER: CLEAN-STABLE-BOOT");

process.on("uncaughtException", err => {
  console.error("[fatal] uncaughtException:", err?.stack || err);
});

process.on("unhandledRejection", err => {
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



/*
|--------------------------------------------------------------------------
| Helper functions
|--------------------------------------------------------------------------
*/

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function renderLayout(title, body) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
body{background:#0b0b0f;color:#f3f3f5;font-family:Inter,Arial;padding:24px}
.card{background:#14141b;border:1px solid #262633;border-radius:12px;padding:16px;margin-bottom:14px}
.meta{color:#a7a7b5;font-size:14px;margin-top:6px}
a{color:#9bb8ff;text-decoration:none}
pre{background:#101017;padding:16px;border-radius:10px}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function isAuthorised(urlObj) {
  const expected = process.env.TRANSCRIPT_VIEW_KEY;
  if (!expected) return false;
  return urlObj.searchParams.get("key") === expected;
}



/*
|--------------------------------------------------------------------------
| Transcript Web Dashboard
|--------------------------------------------------------------------------
*/

const server = http.createServer(async (req,res) => {

  const started = Date.now();
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  console.log(`[web] ${req.method} ${pathname}`);

  try {

    if (pathname === "/healthz") {
      res.writeHead(200);
      return res.end("ok");
    }

    if (pathname === "/transcripts" || pathname.startsWith("/transcripts/")) {

      if (!isAuthorised(urlObj)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }

      if (pathname === "/transcripts") {

        const rows = await db.listTranscripts(200);

        const cards = rows.map(row => `
        <div class="card">
          <strong>#${row.id} ${escapeHtml(row.channel_name)}</strong>
          <div class="meta">
          Closed by ${escapeHtml(row.closed_by)}
          • ${new Date(row.created_at).toLocaleString("en-GB")}
          </div>
          <br>
          <a href="/transcripts/${row.id}?key=${urlObj.searchParams.get("key")}">Open transcript</a>
        </div>
        `).join("");

        res.writeHead(200,{"Content-Type":"text/html"});
        res.end(renderLayout("Ticket Transcripts",cards));
        return;
      }

      const idMatch = pathname.match(/^\/transcripts\/(\d+)$/);

      if (idMatch) {

        const transcript = await db.getTranscriptById(Number(idMatch[1]));

        if (!transcript) {
          res.writeHead(404);
          return res.end("Transcript not found");
        }

        const html = `
        <div class="card">
          <strong>Channel:</strong> ${escapeHtml(transcript.channel_name)}
          <div class="meta">
          Closed by ${escapeHtml(transcript.closed_by)}
          • ${new Date(transcript.created_at).toLocaleString("en-GB")}
          </div>
        </div>

        <pre>${escapeHtml(transcript.content)}</pre>
        `;

        res.writeHead(200,{"Content-Type":"text/html"});
        res.end(renderLayout("Transcript",html));
        return;
      }
    }

    res.writeHead(200);
    res.end("OK");

  } catch(err) {

    console.error("[web] route error:", err?.stack || err);

    res.writeHead(500);
    res.end("Server error");

  }

  console.log(`[web] finished in ${Date.now()-started}ms`);
});

server.listen(process.env.PORT || 3000,"0.0.0.0",()=>{
  console.log(`[boot] Web server running on ${process.env.PORT || 3000}`);
});



/*
|--------------------------------------------------------------------------
| Database
|--------------------------------------------------------------------------
*/

async function loadDatabase(){
  console.log("[boot] Initialising database...");
  await db.init();
  console.log("[boot] Database ready");
}



/*
|--------------------------------------------------------------------------
| Command loader
|--------------------------------------------------------------------------
*/

function loadCommands(client){

  const commandsPath = path.join(__dirname,"commands");

  if(!fs.existsSync(commandsPath)){
    console.warn("[commands] folder missing");
    return;
  }

  const files = fs.readdirSync(commandsPath)
  .filter(f=>f.endsWith(".js"));

  console.log(`[commands] Found ${files.length} command files`);

  for(const file of files){

    const command = require(path.join(commandsPath,file));

    if(!command?.data || !command?.execute){
      console.warn(`[commands] skipping ${file}`);
      continue;
    }

    client.commands.set(command.data.name,command);

    console.log(`[commands] loaded ${command.data.name}`);
  }
}



/*
|--------------------------------------------------------------------------
| Event loader
|--------------------------------------------------------------------------
*/

function loadEvents(client){

  const eventsPath = path.join(__dirname,"events");

  if(!fs.existsSync(eventsPath)){
    console.warn("[events] folder missing");
    return;
  }

  const files = fs.readdirSync(eventsPath)
  .filter(f=>f.endsWith(".js"));

  console.log(`[events] Found ${files.length} event files`);

  for(const file of files){

    const event = require(path.join(eventsPath,file));

    if(!event?.name || typeof event.execute !== "function"){
      console.warn(`[events] skipping ${file}`);
      continue;
    }

    if(event.once){
      client.once(event.name,(...args)=>event.execute(...args,client));
    }else{
      client.on(event.name,(...args)=>event.execute(...args,client));
    }

    console.log(`[events] registered ${event.name}`);
  }
}



/*
|--------------------------------------------------------------------------
| Discord Bot
|--------------------------------------------------------------------------
*/

async function startBot(){

  await loadDatabase();

  console.log("[boot] Creating Discord client");

  const client = new Client({
    intents:[
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials:[Partials.Channel]
  });

  client.commands = new Collection();

  client.once("ready",()=>{

    console.log(`[ready] Logged in as ${client.user.tag}`);

    client.user.setPresence({
      status:"idle",
      activities:[
        {
          name:"feds.lol support",
          type:ActivityType.Watching
        }
      ]
    });

    console.log("[ready] Presence set");
  });

  client.on("shardDisconnect",e=>{
    console.warn("[gateway] disconnect",e?.code,e?.reason);
  });

  client.on("shardReconnecting",()=>{
    console.log("[gateway] reconnecting...");
  });

  client.on("error",err=>{
    console.error("[client error]",err);
  });

  client.on("warn",msg=>{
    console.warn("[client warn]",msg);
  });

  loadCommands(client);
  loadEvents(client);

  console.log("[boot] Logging into Discord...");

  await client.login(TOKEN);
}



startBot().catch(err=>{
  console.error("[fatal] bot failed:",err?.stack || err);
  process.exit(1);
});