import "dotenv/config";

import { REST, Routes } from "discord.js";

const TOKEN = process.env.TOKEN!;
const CLIENT_ID = process.env.CLIENT_ID!;
const GUILD_ID = process.env.GUILD_ID!;

const rest = new REST().setToken(TOKEN);

(async () => {
  try {
    console.log("Clearing all guild commands...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: [] }
    );
    console.log("All guild commands cleared.");
  } catch (err) {
    console.error(err);
  }
})();
