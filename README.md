# Ticket Bot (TypeScript)

Discord ticket bot for **feds.lol** support: category-based tickets, modal forms, transcripts, and a web dashboard. Built with **discord.js v14**, **TypeScript**, and **PostgreSQL**, deployed as a **Render web service**.

![Node](https://img.shields.io/badge/node-18%2B-green)
![discord.js](https://img.shields.io/badge/discord.js-v14-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)
![Database](https://img.shields.io/badge/database-PostgreSQL-blue)
![Deploy](https://img.shields.io/badge/deploy-Render-purple)

---

## Quick start

```bash
npm install
cp .env.example .env   # edit .env with your values
npm run build
npm run deploy        # or: npm run deploy:guild
npm start
```

- **Render / production:** `node index.js` (or `npm start`) — loads compiled `dist/index.js`.
- **Local dev:** `npm run dev` — runs TypeScript via `ts-node index.ts`.

---

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| **start** | `npm start` | Runs `node index.js` (loads `dist/index.js`). Use on Render. |
| **build** | `npm run build` | Compiles TypeScript to `dist/` with `tsc`. |
| **dev** | `npm run dev` | Runs `ts-node index.ts` for local development. |
| **deploy** | `npm run deploy` | Registers slash commands in your guild (same as `deploy:guild`). |
| **deploy:guild** | `npm run deploy:guild` | Runs `ts-node deploy-commands.ts` to register `/panel` and `/close`. |

`postinstall` runs `npm run build`, so Render builds TypeScript after `npm install`.

---

## Environment variables

Copy `.env.example` to `.env` and fill in values. Never commit `.env` (it is in `.gitignore`).

**Required:**

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` or `TOKEN` | Discord bot token |
| `CLIENT_ID` | Application (client) ID for slash commands |
| `GUILD_ID` | Server ID where commands are registered |
| `DATABASE_URL` | Full PostgreSQL URL (use **External** URL from Render when running locally; host must be e.g. `xxx.oregon-postgres.render.com`) |
| `ADMIN_USER_ID` | Your user ID for status/alert DMs |

**Optional:**

| Variable | Description |
|----------|-------------|
| `LOG_CHANNEL_ID` | Channel for ticket open/close logs |
| `SUPPORT_ROLE_IDS` | Comma-separated role IDs mentioned in new tickets |
| `TRANSCRIPT_BASE_URL` | Base URL of this service (e.g. `https://your-app.onrender.com`) |
| `TRANSCRIPT_VIEW_KEY` | Secret for `/transcripts?key=...` access |
| `CATEGORY_GENERAL_SUPPORT` | Discord category channel ID for General Support tickets |
| `CATEGORY_REPORT_USER` | Category ID for Report User |
| `CATEGORY_ACCOUNT_RECOVERY` | Category ID for Account Recovery |
| `CATEGORY_PURCHASE_BILLING` | Category ID for Purchase / Billing |
| `CATEGORY_BADGE_APPLICATION` | Category ID for Badge Application |
| `GIST_BACKUP_ENABLED` | Enable 12-hour logical DB backups to a GitHub Gist (`true/1/yes`) |
| `GITHUB_GIST_ID` | Target gist ID to update with `backup.json` |
| `GITHUB_GIST_TOKEN` | GitHub token that can edit the gist |
| `BACKUP_RUN_KEY` | Secret key to manually trigger backup via `/backup/run?key=...` |
| `PORT` | HTTP server port (default 3000) |
| `NODE_ENV` | e.g. `production` |

---

## Web dashboard

| Endpoint | Description |
|----------|-------------|
| `/healthz` | Health check, returns `ok` |
| `/status` | HTML status page (bot state, gateway, diagnostics) |
| `/status.json` | JSON status |
| `/logs` | HTML runtime logs |
| `/logs.json` | JSON logs |
| `/transcripts?key=YOUR_KEY` | Transcript list (requires `TRANSCRIPT_VIEW_KEY`) |
| `/transcripts/:id?key=YOUR_KEY` | Single transcript |
| `/backup/run?key=YOUR_KEY` | Manually trigger gist backup (requires `BACKUP_RUN_KEY`) |

---

## Project structure

```
ticket-bot/
├── commands/
│   ├── close.ts      # /close — close ticket
│   └── panel.ts      # /panel — send ticket panel
├── events/
│   ├── interactionCreate.ts   # slash commands, modals, buttons, select menu
│   └── messageCreate.ts       # DM notifications when staff reply
├── dist/             # Compiled JS (generated; in .gitignore)
├── database.ts       # PostgreSQL pool, tickets & transcripts
├── deploy-commands.ts
├── clear-commands.ts # Optional: clear guild commands (run with ts-node)
├── index.ts          # Main bot + web server
├── index.js          # Loader: require("./dist/index.js")
├── tsconfig.json
├── package.json
├── .env.example
└── README.md
```

---

## Database schema

**tickets**

| Column | Type |
|--------|------|
| id | SERIAL PRIMARY KEY |
| guild_id | TEXT |
| channel_id | TEXT UNIQUE |
| user_id | TEXT |
| username | TEXT |
| category_key | TEXT |
| brief_description | TEXT |
| feds_url | TEXT |
| status | TEXT (default 'open') |
| created_at | TIMESTAMP |
| closed_at | TIMESTAMP |

**transcripts**

| Column | Type |
|--------|------|
| id | SERIAL PRIMARY KEY |
| channel_name | TEXT |
| closed_by | TEXT |
| content | TEXT |
| created_at | TIMESTAMP |

Tables are created automatically on first run via `database.init()`.

---

## Deploying to Render

1. Create a **Web Service**, connect your repo.
2. **Build command:** `npm install` (postinstall runs `npm run build`).
3. **Start command:** `npm start`
4. Add all required (and optional) environment variables in the Render dashboard.
5. Deploy.

---

## Troubleshooting

- **Database connection fails (ENOTFOUND):** Use the full **External** database URL from Render (host like `xxx.oregon-postgres.render.com`), not the internal hostname.
- **Categories show MISSING:** Set each `CATEGORY_*` in `.env` to the Discord **category** channel ID (right‑click category → Copy ID). Restart the bot.
- **Slash commands missing:** Run `npm run deploy` (or `npm run deploy:guild`) and wait a few minutes for Discord to update.
- **Build fails:** Ensure Node 18+ and run `npm install` then `npm run build`.

---

## Security

- Never commit `.env`.
- Keep `TRANSCRIPT_VIEW_KEY` private; transcript URLs are only for dashboard/log use, not shared in ticket channels.
- If a token leaks, regenerate it in the Discord Developer Portal and update env vars.

---

## License

MIT

---

**Maintainer:** [@dxiv](https://github.com/dxiv) & [@intro](https://github.com/4VTmNzSJ5PPpIeDy5XeGjgGOq1Vl4cgV)
