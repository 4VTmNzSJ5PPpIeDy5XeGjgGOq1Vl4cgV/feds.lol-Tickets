import { PermissionFlagsBits, type Client, type Message } from "discord.js";
import * as db from "../database";
import { restoreFromGist } from "../lib/restoreGist";
import { runGistBackupOnce } from "../lib/gistBackup";

const SUPPORT_ROLE_IDS: string[] = process.env.SUPPORT_ROLE_IDS
  ? process.env.SUPPORT_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean)
  : [];

const OWNER_USER_ID = "261265820678619137";
const OWNER_PREFIX = "!agent";
const SYNC_PREFIX = "!sync";
const RESTORE_PREFIX = "!restore";
const BACKUP_PREFIX = "!backup";
const OWNER_ALLOWED_ROLE_IDS = [
  "1408259928736399433", // Server Owner
  "1457448238243254314", // Server Management
  "1408259929177063456", // Server Team
  "1408259930267451512" // Server Staff
] as const;

const SYNC_ALLOWED_ROLE_IDS = [
  "1408259928736399433", // Server Owner
  "1457448238243254314" // Server Management
] as const;

const dmCooldowns = new Map<string, number>();
const DM_COOLDOWN_MS = 60 * 1000;
const dmDisabledUsers = new Map<string, { at: number; reason: string }>();
let restoreInProgress = false;
let backupInProgress = false;

function shouldDisableDmForError(err: unknown): { disable: boolean; reason: string } {
  const anyErr = err as any;
  const code = anyErr?.code;
  const message = String(anyErr?.message || err || "").toLowerCase();

  // Common Discord API errors when the bot cannot DM the user.
  // - 50007: Cannot send messages to this user
  // - "no mutual guilds": user left guild / can't be DMed
  if (code === 50007) return { disable: true, reason: "DMs blocked (50007)" };
  if (message.includes("no mutual guilds")) return { disable: true, reason: "No mutual guilds" };
  if (message.includes("cannot send messages to this user"))
    return { disable: true, reason: "DMs blocked" };

  return { disable: false, reason: "Unknown DM failure" };
}

function isSupportMessage(message: Message): boolean {
  return SUPPORT_ROLE_IDS.some((roleId) =>
    message.member?.roles?.cache?.has(roleId)
  );
}

function passesOwnerGate(message: Message): boolean {
  const isOwnerUser = message.author.id === OWNER_USER_ID;
  const hasAllowedRole = OWNER_ALLOWED_ROLE_IDS.some((roleId) =>
    message.member?.roles?.cache?.has(roleId)
  );

  // Owner can run anywhere; role-based access is guild-only.
  return Boolean(isOwnerUser || hasAllowedRole);
}

function passesSyncGate(message: Message): boolean {
  const isOwnerUser = message.author.id === OWNER_USER_ID;
  const hasAllowedRole = SYNC_ALLOWED_ROLE_IDS.some((roleId) =>
    message.member?.roles?.cache?.has(roleId)
  );
  return Boolean(isOwnerUser || hasAllowedRole);
}

function loadGuildCommandJsons(): unknown[] {
  // Load .js command modules from the built dist folder at runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path") as typeof import("path");

  // messageCreate runs from dist/events, commands live in dist/commands.
  const commandsPath = path.join(__dirname, "..", "commands");
  if (!fs.existsSync(commandsPath)) return [];

  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith(".js"));
  const out: unknown[] = [];

  for (const file of files) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cmd = require(path.join(commandsPath, file));
      if (!cmd?.data?.toJSON) continue;
      out.push(cmd.data.toJSON());
    } catch {
      // ignore individual command load errors
    }
  }

  return out;
}

async function handleOwnerPrefixCommand(message: Message, client: Client): Promise<boolean> {
  const content = (message.content || "").trim();
  if (!content.toLowerCase().startsWith(OWNER_PREFIX)) return false;

  if (!passesOwnerGate(message)) return false;

  const args = content.slice(OWNER_PREFIX.length).trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "").toLowerCase();

  if (!sub || sub === "help") {
    await message.reply(
      `Owner commands:\n` +
        `- \`${OWNER_PREFIX} ping\`\n` +
        `- \`${OWNER_PREFIX} restart\``
    );
    return true;
  }

  if (sub === "ping") {
    const tag = client.user?.tag || "unknown";
    await message.reply(`pong (bot=${tag})`);
    return true;
  }

  if (sub === "restart") {
    await message.reply("Restarting now (Render should bring me back up)...").catch(() => {});
    setTimeout(() => process.exit(0), 750);
    return true;
  }

  await message.reply(`Unknown subcommand: \`${sub}\`. Try \`${OWNER_PREFIX} help\`.`);
  return true;
}

async function handleSyncPrefixCommand(message: Message, client: Client): Promise<boolean> {
  const content = (message.content || "").trim();
  if (!content.toLowerCase().startsWith(SYNC_PREFIX)) return false;
  if (!passesSyncGate(message)) return false;

  if (!message.guild) {
    await message.reply("`!sync` can only be used inside the server (not DMs).");
    return true;
  }

  const targetGuildId = process.env.GUILD_ID?.trim() || message.guild.id;

  await message.reply("Syncing slash commands for this guild...").catch(() => {});

  const jsons = loadGuildCommandJsons();
  if (!jsons.length) {
    await message
      .reply("No built command modules found. Make sure the bot is running compiled `dist/` output.")
      .catch(() => {});
    return true;
  }

  try {
    const guild =
      client.guilds.cache.get(targetGuildId) ??
      (await client.guilds.fetch(targetGuildId).catch(() => null));
    if (!guild) {
      await message.reply(`Could not fetch guild \`${targetGuildId}\`.`).catch(() => {});
      return true;
    }

    // Overwrites guild commands (clears old + applies new).
    await guild.commands.set(jsons as any);
    await message.reply(`✅ Synced ${jsons.length} guild command(s).`).catch(() => {});
  } catch (e) {
    await message
      .reply(`Sync failed: ${(e as Error)?.message || String(e)}`)
      .catch(() => {});
  }

  return true;
}

const event = {
  name: "messageCreate",

  async execute(message: Message, client: Client) {
    try {
      if (message.author.bot) return;

      // Owner-id-only: force an immediate gist backup.
      const maybeBackup = (message.content || "").trim();
      if (maybeBackup.toLowerCase().startsWith(BACKUP_PREFIX)) {
        if (message.author.id !== OWNER_USER_ID) return;
        if (!message.guild) {
          await message.reply("`!backup` can only be used inside the server (not DMs).");
          return;
        }
        if (backupInProgress) {
          await message.reply("Backup already running. Please wait for it to finish.");
          return;
        }

        backupInProgress = true;
        try {
          await message.reply("Starting gist backup now...");
          const r = await runGistBackupOnce();
          await message.reply(
            `✅ Gist backup complete. bytes=${r.bytes} hash=${r.hash.slice(0, 12)} file=${r.filename}`
          );
        } catch (e) {
          console.error("[backup] !backup failed:", e);
          await message
            .reply(`Backup failed: ${(e as Error)?.message || String(e)}`)
            .catch(() => {});
        } finally {
          backupInProgress = false;
        }
        return;
      }

      // Owner-id-only: restore DB from gist backup.json.
      const maybeRestore = (message.content || "").trim();
      if (maybeRestore.toLowerCase().startsWith(RESTORE_PREFIX)) {
        if (message.author.id !== OWNER_USER_ID) return;
        if (!message.guild) {
          await message.reply("`!restore` can only be used inside the server (not DMs).");
          return;
        }
        if (restoreInProgress) {
          await message.reply("Restore already running. Please wait for it to finish.");
          return;
        }

        restoreInProgress = true;
        try {
          const arg = maybeRestore.slice(RESTORE_PREFIX.length).trim();
          const gistIdOrUrl = arg || process.env.GITHUB_GIST_ID || "";
          if (!gistIdOrUrl) {
            await message.reply("Missing gist. Provide a gist url/id or set `GITHUB_GIST_ID`.");
            return;
          }
          const databaseUrl = process.env.DATABASE_URL || "";
          if (!databaseUrl.trim()) {
            await message.reply("Missing `DATABASE_URL` in environment.");
            return;
          }

          const statusMsg = await message.reply(
            "Starting DB restore from gist... (this may take a bit)"
          );

          let lastProgress = Date.now();
          const r = await restoreFromGist({
            databaseUrl,
            gistIdOrUrl,
            maxRevisionAttempts: 25,
            allowEmpty: arg.toLowerCase().includes("--allow-empty"),
            requireTranscripts: !arg.toLowerCase().includes("--allow-zero-transcripts"),
            onProgress: (p) => {
              const now = Date.now();
              if (now - lastProgress < 4000) return;
              lastProgress = now;
              if (p.stage === "fetch_gist")
                void statusMsg.edit(`Fetching gist \`${p.gistId}\`...`).catch(() => {});
              if (p.stage === "walk_revisions")
                void statusMsg
                  .edit(
                    `Latest backup looks empty; checking older revisions... (${p.attempted}/${p.max})`
                  )
                  .catch(() => {});
              if (p.stage === "parse_backup")
                void statusMsg
                  .edit(`Backup \`${p.createdAt}\` — tickets=${p.tickets} transcripts=${p.transcripts}`)
                  .catch(() => {});
              if (p.stage === "restore_tickets")
                void statusMsg
                  .edit(`Restoring tickets... ${p.current}/${p.total}`)
                  .catch(() => {});
              if (p.stage === "restore_transcripts")
                void statusMsg
                  .edit(`Restoring transcripts... ${p.current}/${p.total}`)
                  .catch(() => {});
            }
          });

          await statusMsg
            .edit(`✅ Restore complete. tickets=${r.tickets} transcripts=${r.transcripts}`)
            .catch(() => {});
        } catch (e) {
          console.error("[restore] !restore failed:", e);
          await message
            .reply(`Restore failed: ${(e as Error)?.message || String(e)}`)
            .catch(() => {});
        } finally {
          restoreInProgress = false;
        }
        return;
      }

      // Owner-only prefix commands (no env, no slash commands).
      if (await handleOwnerPrefixCommand(message, client)) return;
      if (await handleSyncPrefixCommand(message, client)) return;
      // !restore is handled inline below (owner-id only).

      // Remaining logic is ticket-only and guild-only.
      if (!message.guild) return;

      const ticket = await db.getTicketByChannel(message.channel.id);
      if (!ticket || ticket.status !== "open") return;

      if (message.author.id === ticket.user_id) return;

      const isStaff =
        isSupportMessage(message) ||
        message.member?.permissions?.has(PermissionFlagsBits.ManageChannels);

      if (!isStaff) return;

      if (!message.content?.trim() && message.attachments.size === 0) return;

      const cooldownKey = `${message.channel.id}:${ticket.user_id}`;
      const last = dmCooldowns.get(cooldownKey) || 0;
      const now = Date.now();

      if (now - last < DM_COOLDOWN_MS) return;
      if (dmDisabledUsers.has(ticket.user_id)) return;

      const ticketOwner = await client.users.fetch(ticket.user_id).catch(() => null);
      if (!ticketOwner) return;

      const preview = message.content?.trim()
        ? message.content.trim().slice(0, 1200)
        : "[attachment]";

      const channelName =
        (message.channel as any).name ?? (message.channelId ?? "DM");

      try {
        await ticketOwner.send(
          `You have a new staff reply in **${message.guild!.name}** ticket **#${channelName}**.\n\n` +
            `**${message.author.tag}:** ${preview}`
        );
      } catch (e) {
        const dmDecision = shouldDisableDmForError(e);
        if (dmDecision.disable) {
          if (!dmDisabledUsers.has(ticket.user_id)) {
            dmDisabledUsers.set(ticket.user_id, { at: now, reason: dmDecision.reason });
            console.log(
              "[messageCreate] Disabling staff-reply DMs for user:",
              ticket.user_id,
              dmDecision.reason
            );
          }
        } else {
          console.warn(
            "[messageCreate] Staff reply DM failed:",
            ticket.user_id,
            (e as Error)?.message || e
          );
        }
        dmCooldowns.set(cooldownKey, now);
        return;
      }

      dmCooldowns.set(cooldownKey, now);
    } catch (err) {
      console.error("[messageCreate] error:", (err as Error)?.stack || err);
    }
  }
};

export = event;
