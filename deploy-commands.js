require("dotenv").config();

const { REST, Routes } = require("discord.js");
const fs = require("fs");
const path = require("path");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`[deploy] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const TOKEN = requireEnv("TOKEN");
const CLIENT_ID = requireEnv("CLIENT_ID");
const GUILD_ID = requireEnv("GUILD_ID");

const commands = [];
const commandsPath = path.join(__dirname, "commands");

if (!fs.existsSync(commandsPath)) {
  throw new Error(`[deploy] Commands folder not found: ${commandsPath}`);
}

const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"));

console.log(`[deploy] Found ${commandFiles.length} command file(s)`);

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if (!command?.data || !command?.execute) {
    console.warn(`[deploy] Skipping ${file} - missing "data" or "execute"`);
    continue;
  }

  const json = command.data.toJSON();
  commands.push(json);
  console.log(`[deploy] Prepared command: ${json.name}`);
}

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log(`[deploy] Deploying ${commands.length} guild command(s) to guild ${GUILD_ID}...`);

    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log(`[deploy] Successfully deployed ${data.length} guild command(s).`);
  } catch (error) {
    console.error("[deploy] Failed to deploy commands:");
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
})();
