# 🎟️ feds.lol Ticket Bot

A modern **Discord ticket system** built with **discord.js v14**.

This bot allows servers to create structured support tickets with categories, collect information through a modal form, notify users when staff respond, and automatically store transcripts in a PostgreSQL database.

It also provides a **secure web dashboard to view ticket transcripts directly from Render**.

Designed to run locally or on cloud platforms such as **Render**.

---

# ✨ Features

- 🎫 Ticket panel with category selection
- 📝 Modal ticket form (brief description + Feds URL)
- 🛑 Anti-spam protection  
  - prevents multiple open tickets per user  
  - ticket creation cooldown
- 🔒 Close ticket command
- 📜 Full message transcript capture
- 🌐 Web dashboard to browse transcripts
- 🗄️ Transcript storage in PostgreSQL
- 📩 DM notification when staff reply in a ticket
- 👮 Support role permissions
- 🧠 Ticket ownership stored in database
- ⚡ Slash command support
- 📂 Modular command/event architecture
- ☁️ Cloud deployment ready (Render compatible)

---

# 📂 Project Structure

ticket-bot/
│
├─ commands/
│   ├─ close.js
│   └─ panel.js
│
├─ events/
│   ├─ interactionCreate.js
│   └─ messageCreate.js
│
├─ database.js
├─ deploy-commands.js
├─ index.js
├─ package.json
└─ README.md

---

# ⚙️ Requirements

- Node.js 18+
- PostgreSQL database
- Discord Bot Token
- Discord Application Client ID
- Discord Guild ID

---

# 🔧 Installation

Clone the repository:

git clone https://github.com/4VTmNzSJ5PPpIeDy5XeGjgGOq1Vl4cgV/feds.lol-Tickets.git
cd feds.lol-Tickets

Install dependencies:

npm install

---

# 🔑 Environment Variables

Create a `.env` file in the root directory.

TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
GUILD_ID=your_server_id
DATABASE_URL=your_postgres_connection_string

SUPPORT_ROLE_IDS=role_id_1,role_id_2

CATEGORY_GENERAL_SUPPORT=category_id
CATEGORY_REPORT_USER=category_id
CATEGORY_ACCOUNT_RECOVERY=category_id
CATEGORY_PURCHASE_BILLING=category_id
CATEGORY_BADGE_APPLICATION=category_id

LOG_CHANNEL_ID=log_channel_id

TRANSCRIPT_BASE_URL=https://your-render-service.onrender.com
TRANSCRIPT_VIEW_KEY=your_secure_access_key

Example:

SUPPORT_ROLE_IDS=1408259930267451512,1457845846157561990

---

# 🚀 Deploy Slash Commands

Before running the bot, deploy slash commands to your server:

npm run deploy:guild

---

# ▶️ Running the Bot

Start the bot locally:

npm start

Expected startup logs:

[boot] dotenv loaded
[boot] Database ready
[commands] Loaded command: close
[commands] Loaded command: panel
[events] Registered event: interactionCreate
[events] Registered event: messageCreate
[ready] Logged in as BotName

---

# 🎫 Ticket Flow

1. Admin runs `/panel`
2. Users select a ticket category
3. Bot shows a modal form requesting:
   - Brief description
   - Feds URL
4. Ticket channel is created automatically
5. Staff are pinged
6. Staff replies trigger DM notifications to the ticket owner
7. `/close` generates transcripts and deletes the channel

---

# 📜 Transcript System

When a ticket is closed:

1. A full text transcript is saved to PostgreSQL
2. An HTML transcript file is generated
3. The HTML transcript is uploaded to Catbox
4. A Render dashboard link is generated

Staff logs include:

- Ticket owner
- Ticket category
- Brief description
- Feds URL
- Render dashboard transcript link
- HTML transcript link

---

# 🌐 Transcript Dashboard

Example:

https://your-render-service.onrender.com/transcripts?key=YOUR_KEY

Features:

- Search transcripts by ticket ID, user, or channel
- View readable transcripts
- Secure access via key

Example:

https://feds-lol-tickets.onrender.com/transcripts?key=yourkey

---

# 🛑 Anti-Spam Protection

The bot prevents ticket abuse by:

- blocking multiple open tickets per user
- applying a ticket creation cooldown
- validating ticket ownership through the database

---

# 📩 User Notifications

When a staff member replies inside a ticket channel:

- The ticket owner receives a DM notification
- The DM includes a preview of the staff message

Users are not notified for their own messages.

---

# 🗄️ Database

The bot automatically creates two tables.

tickets

id | SERIAL  
guild_id | TEXT  
channel_id | TEXT  
user_id | TEXT  
username | TEXT  
category_key | TEXT  
brief_description | TEXT  
feds_url | TEXT  
status | TEXT  
created_at | TIMESTAMP  
closed_at | TIMESTAMP  

transcripts

id | SERIAL  
channel_name | TEXT  
closed_by | TEXT  
content | TEXT  
created_at | TIMESTAMP  

---

# ☁️ Deploying to Render

Recommended deployment: Render Web Service

Steps:

1. Create a Web Service
2. Connect your GitHub repository
3. Set start command:

npm start

4. Add all environment variables in the Render dashboard.

---

# 🧪 Troubleshooting

Bot won't start

- Ensure TOKEN is correct
- Check Node.js version (18+)
- Confirm all environment variables are set

Slash commands not appearing

Run:

npm run deploy:guild

Tickets not creating

Check:

- category IDs are valid
- support role IDs are correct
- bot has permission to create channels

Transcript dashboard returns 502

This can happen if Render is waking up or the database connection is still initializing. Refreshing after a few seconds normally resolves it.

---

# 🔐 Security

Never commit `.env` files.

If a bot token is leaked:

1. Regenerate the token in the Discord Developer Portal
2. Update your environment variables
3. Restart the service

---

# 📜 License

MIT License

---

# 👤 Author

Developed for **feds.lol Support Infrastructure**

Created by  
@dxiv — https://github.com/dxiv  
@Intro — https://github.com/4VTmNzSJ5PPpIeDy5XeGjgGOq1Vl4cgV
