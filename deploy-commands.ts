import "dotenv/config";

import { REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`[deploy] Missing required environment variable: ${name}`);
  }
  return value.trim();
}

// Support both TOKEN and DISCORD_TOKEN for flexibility
const TOKEN = (process.env.TOKEN || process.env.DISCORD_TOKEN)?.trim();
if (!TOKEN) {
  throw new Error("[deploy] Missing TOKEN or DISCORD_TOKEN in .env");
}
const CLIENT_ID = requireEnv("CLIENT_ID");
const GUILD_ID = requireEnv("GUILD_ID");

const commands: any[] = [];
const commandsPath = path.join(__dirname, "commands");

if (!fs.existsSync(commandsPath)) {
  throw new Error(`[deploy] Commands folder not found: ${commandsPath}`);
}

// Load both .ts (when run via ts-node) and .js (when run from dist)
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js") || file.endsWith(".ts"));

console.log(`[deploy] Found ${commandFiles.length} command file(s)`);

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const command = require(filePath);

  if (!command?.data || !command?.execute) {
    console.warn(
      `[deploy] Skipping ${file} - missing "data" or "execute"`
    );
    continue;
  }

  const json = command.data.toJSON();
  commands.push(json);
  console.log(`[deploy] Prepared command: ${json.name}`);
}

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log(
      `[deploy] Deploying ${commands.length} guild command(s) to guild ${GUILD_ID}...`
    );

    const data = (await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    )) as any[];

    console.log(
      `[deploy] Successfully deployed ${data.length} guild command(s).`
    );
  } catch (error) {
    console.error("[deploy] Failed to deploy commands:");
    console.error((error as Error)?.stack || error);
    process.exitCode = 1;
  }
})();
