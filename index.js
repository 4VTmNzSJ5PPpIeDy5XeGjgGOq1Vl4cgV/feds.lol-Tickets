require("dotenv").config();
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
const { Client, GatewayIntentBits, Collection, ActivityType } = require("discord.js");
const fs = require("fs");
const path = require("path");
const http = require("http");

http.createServer((req, res) => res.end("OK")).listen(process.env.PORT || 3000, () => {
  console.log(`Keep-alive server running on port ${process.env.PORT || 3000}`);
});

const db = require("./database.js");
db.init().then(() => console.log("Database ready")).catch(console.error);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
const commandFiles = fs
  .readdirSync(path.join(__dirname, "commands"))
  .filter((f) => f.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
}

const eventFiles = fs
  .readdirSync(path.join(__dirname, "events"))
  .filter((f) => f.endsWith(".js"));

for (const file of eventFiles) {
  const event = require(`./events/${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

client.on("interactionCreate", (interaction) => {
  console.log(`Interaction received: type=${interaction.type} id=${interaction.customId ?? interaction.commandName ?? "unknown"}`);
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("feds.lol", {
    type: ActivityType.Streaming,
    url: "https://www.twitch.tv/twitch",
  });
});

console.log("TOKEN present:", !!process.env.TOKEN);
console.log("TOKEN length:", process.env.TOKEN?.length);
console.log("TOKEN start:", process.env.TOKEN?.slice(0, 20));

client.login(process.env.TOKEN).catch(err => {
  console.error("Failed to login:", err.message);
});
