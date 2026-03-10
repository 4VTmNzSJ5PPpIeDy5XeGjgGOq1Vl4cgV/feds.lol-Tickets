# 🎟️ Discord Ticket Bot

A lightweight **Discord ticket system bot** built with **discord.js v14**.

It allows servers to create support tickets, close them, and automatically store **HTML transcripts** in a PostgreSQL database.

The bot is designed to run locally or on cloud hosts such as **Render**.

---

# ✨ Features

- 🎫 Ticket creation panel
- 🔒 Close ticket command
- 📜 Automatic HTML transcripts
- 🗄️ Transcript storage using PostgreSQL
- ⚡ Slash command support
- 📂 Modular command and event system
- 🌐 Cloud deployment ready

---

# 📂 Project Structure

```
ticket-bot/
│
├─ commands/
│   ├─ close.js
│   └─ panel.js
│
├─ events/
│   └─ interactionCreate.js
│
├─ database.js
├─ deploy-commands.js
├─ index.js
├─ package.json
└─ README.md
```

---

# ⚙️ Requirements

- Node.js **18+**
- PostgreSQL database
- Discord Bot Token
- Discord Application Client ID
- Discord Guild ID (for slash commands)

---

# 🔧 Installation

Clone the repository:

```bash
git clone https://github.com/4VTmNzSJ5PPpIeDy5XeGjgGOq1Vl4cgV/feds.lol-Tickets.git
cd ticket-bot
```

Install dependencies:

```bash
npm install
```

---

# 🔑 Environment Variables

Create a `.env` file in the root directory.

```
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=your_server_id
DATABASE_URL=your_postgres_connection_string
```

Example:

```
TOKEN=MTxxxxxxxxxxxxxxxxxxxxxxxx
CLIENT_ID=123456789012345678
GUILD_ID=987654321098765432
DATABASE_URL=postgres://user:password@host:5432/dbname
```

---

# 🚀 Deploy Slash Commands

Before starting the bot, deploy slash commands to your server:

```bash
npm run deploy:guild
```

This registers all commands inside the specified guild.

---

# ▶️ Running the Bot

Start the bot locally:

```bash
npm start
```

Expected startup logs:

```
[boot] dotenv loaded
[boot] Database ready
[commands] Loaded command: close
[commands] Loaded command: panel
[events] Registered event: interactionCreate
[ready] Logged in as BotName
```

---

# 🎫 Commands

### `/panel`
Creates the ticket panel message where users can open support tickets.

### `/close`
Closes the ticket and saves a transcript to the database.

---

# 🗄️ Database

The bot automatically creates a table called:

```
transcripts
```

Schema:

| Column | Type |
|------|------|
| id | SERIAL |
| channel_name | TEXT |
| closed_by | TEXT |
| content | TEXT |
| created_at | TIMESTAMP |

---

# 🌐 Deploying to Render

Recommended: **Background Worker**

Steps:

1. Create a **Background Worker**
2. Connect your GitHub repository
3. Set start command:

```
npm start
```

4. Add the environment variables:

```
TOKEN
CLIENT_ID
GUILD_ID
DATABASE_URL
```

---

# 🧪 Troubleshooting

### Bot won't start
- Ensure `TOKEN` is valid
- Check Node.js version is **18+**

### Commands not appearing
Run:

```
npm run deploy:guild
```

### Database errors
Verify `DATABASE_URL` is correct and the database is accessible.

---

# 🔐 Security

Never commit `.env` files.

If a bot token is exposed:

1. Go to the **Discord Developer Portal**
2. Regenerate the token
3. Update your environment variables

---

# 📜 License

MIT License

---

# 👤 Author

Built using **discord.js v14** for simple Discord ticket management.
