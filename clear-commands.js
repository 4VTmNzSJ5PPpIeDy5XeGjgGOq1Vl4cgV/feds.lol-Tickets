require("dotenv").config();
const { REST, Routes } = require("discord.js");

const rest = new REST().setToken(process.env.TOKEN);

(async () => {
  try {
    console.log("Clearing all guild commands...");
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: [] }
    );
    console.log("All guild commands cleared.");
  } catch (err) {
    console.error(err);
  }
})();