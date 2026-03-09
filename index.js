require("dotenv").config();
console.log("==> [1] dotenv loaded");

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

const { Client, GatewayIntentBits, Collection, ActivityType } = require("discord.js");
console.log("==> [2] discord.js loaded");

const fs = require("fs");
const path = require("path");
const http = require("http");

http.createServer((req, res) => res.end("OK")).listen(process.env.PORT || 3000, () => {
  console.log(`==> [3] Keep-alive server running on port ${process.env.PORT || 3000}`);
});

const db = require("./database.js");
console.log("==> [4] database.js loaded");
db.init().then(() => console.log("==> [5] Database ready")).catch(console.error);

console.log("==> [6] Creating Discord client");
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
console.log("==> [7] Discord client created");

client.commands = new Collection();
const commandFiles = fs
  .readdirSync(path.join(__dirname, "commands"))
  .filter((f) => f.endsWith(".js"));
console.log(`==> [8] Found ${commandFiles.length} command file(s):`, commandFiles);

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
  console.log(`==> [9] Loaded command: ${command.data.name}`);
}

const eventFiles = fs
  .readdirSync(path.join(__dirname, "events"))
  .filter((f) => f.endsWith(".js"));
console.log(`==> [10] Found ${eventFiles.length} event file(s):`, eventFiles);

for (const file of eventFiles) {
  const event = require(`./events/${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
  console.log(`==> [11] Registered event: ${event.name} (once=${!!event.once})`);
}

client.on("interactionCreate", (interaction) => {
  console.log(`Interaction received: type=${interaction.type} id=${interaction.customId ?? interaction.commandName ?? "unknown"}`);
});

client.once("clientReady", () => {
  console.log(`==> [12] Logged in as ${client.user.tag}`);
  client.user.setActivity("feds.lol", {
    type: ActivityType.Streaming,
    url: "https://www.twitch.tv/twitch",
  });
});

console.log('[boot] TOKEN exists:', !!process.env.TOKEN)
console.log('[boot] TOKEN length:', process.env.TOKEN ? process.env.TOKEN.length : 0)
console.log('[boot] HTTP_PROXY:', process.env.HTTP_PROXY || 'not set')
console.log('[boot] HTTPS_PROXY:', process.env.HTTPS_PROXY || 'not set')
console.log('[boot] NODE_ENV:', process.env.NODE_ENV || 'not set')

client.login(process.env.TOKEN).then(() => {
  console.log("==> [17] client.login() resolved successfully");
}).catch(err => {
  console.error("==> [17] Failed to login:", err.message);
});
