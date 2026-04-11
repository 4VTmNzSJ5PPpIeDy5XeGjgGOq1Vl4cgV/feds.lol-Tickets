import { Pool } from "pg";

const rawUrl = process.env.DATABASE_URL?.trim();
if (!rawUrl) {
  throw new Error("[database] Missing DATABASE_URL in .env");
}

// Render and other hosts use full hostnames like xxx.oregon-postgres.render.com
// A host like "dpg-xxx-a" with no dot often means the Internal URL was used (only works on Render).
try {
  const url = new URL(rawUrl.replace(/^postgres:\/\//, "https://"));
  const host = url.hostname;
  if (host && !host.includes(".")) {
    console.warn(
      "[database] DATABASE_URL host has no domain (e.g. '" +
        host +
        "'). Use the full External URL from Render (host like xxx.oregon-postgres.render.com)."
    );
  }
} catch {
  // ignore parse errors; pg will fail with its own error
}

const pool = new Pool({
  connectionString: rawUrl,
  ssl: { rejectUnauthorized: false }
});

pool.on("error", (err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error("[database] Unexpected pool error:", message);
});

export async function init(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NULL,
      channel_id TEXT NULL,
      ticket_id INT NULL,
      ticket_user_id TEXT NULL,
      ticket_category_key TEXT NULL,
      ticket_brief_description TEXT NULL,
      ticket_feds_url TEXT NULL,
      closed_by_id TEXT NULL,
      channel_name TEXT NOT NULL,
      closed_by TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Backfill/migrations for existing deployments.
  // Safe on fresh installs (columns already exist).
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS guild_id TEXT NULL`);
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS channel_id TEXT NULL`);
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ticket_id INT NULL`);
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ticket_user_id TEXT NULL`);
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ticket_category_key TEXT NULL`);
  await pool.query(
    `ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ticket_brief_description TEXT NULL`
  );
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS ticket_feds_url TEXT NULL`);
  await pool.query(`ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS closed_by_id TEXT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      category_key TEXT NOT NULL,
      brief_description TEXT NOT NULL,
      feds_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      closed_at TIMESTAMP NULL
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tickets_guild_user_status
    ON tickets (guild_id, user_id, status)
  `);
}

export interface TranscriptRow {
  id: number;
  guild_id?: string | null;
  channel_id?: string | null;
  ticket_id?: number | null;
  ticket_user_id?: string | null;
  ticket_category_key?: string | null;
  ticket_brief_description?: string | null;
  ticket_feds_url?: string | null;
  closed_by_id?: string | null;
  channel_name: string;
  closed_by: string;
  content: string;
  created_at: Date;
}

export interface TicketRow {
  id: number;
  guild_id: string;
  channel_id: string;
  user_id: string;
  username: string;
  category_key: string;
  brief_description: string;
  feds_url: string;
  status: string;
  created_at: Date;
  closed_at: Date | null;
}

export async function saveTranscript(
  channelName: string,
  closedBy: string,
  content: string,
  meta?: {
    guildId?: string;
    channelId?: string;
    ticketId?: number;
    ticketUserId?: string;
    ticketCategoryKey?: string;
    ticketBriefDescription?: string;
    ticketFedsUrl?: string;
    closedById?: string;
  }
): Promise<Omit<TranscriptRow, "content">> {
  const result = await pool.query<TranscriptRow>(
    `INSERT INTO transcripts (
       channel_name,
       closed_by,
       content,
       guild_id,
       channel_id,
       ticket_id,
       ticket_user_id,
       ticket_category_key,
       ticket_brief_description,
       ticket_feds_url,
       closed_by_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, channel_name, closed_by, created_at`,
    [
      channelName,
      closedBy,
      content,
      meta?.guildId ?? null,
      meta?.channelId ?? null,
      meta?.ticketId ?? null,
      meta?.ticketUserId ?? null,
      meta?.ticketCategoryKey ?? null,
      meta?.ticketBriefDescription ?? null,
      meta?.ticketFedsUrl ?? null,
      meta?.closedById ?? null
    ]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    channel_name: row.channel_name,
    closed_by: row.closed_by,
    created_at: row.created_at
  };
}

export async function getTranscript(channelName: string): Promise<TranscriptRow | null> {
  const result = await pool.query<TranscriptRow>(
    "SELECT * FROM transcripts WHERE channel_name = $1 ORDER BY created_at DESC LIMIT 1",
    [channelName]
  );
  return result.rows[0] ?? null;
}

export interface CreateTicketInput {
  guildId: string;
  channelId: string;
  userId: string;
  username: string;
  categoryKey: string;
  briefDescription: string;
  fedsUrl: string;
}

export async function createTicket(input: CreateTicketInput): Promise<TicketRow> {
  const result = await pool.query<TicketRow>(
    `INSERT INTO tickets (
      guild_id, channel_id, user_id, username, category_key, brief_description, feds_url
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      input.guildId,
      input.channelId,
      input.userId,
      input.username,
      input.categoryKey,
      input.briefDescription,
      input.fedsUrl
    ]
  );

  return result.rows[0];
}

export async function getOpenTicketByUser(
  guildId: string,
  userId: string
): Promise<TicketRow | null> {
  const result = await pool.query<TicketRow>(
    `SELECT *
     FROM tickets
     WHERE guild_id = $1
       AND user_id = $2
       AND status = 'open'
     ORDER BY created_at DESC
     LIMIT 1`,
    [guildId, userId]
  );

  return result.rows[0] ?? null;
}

export async function getTicketByChannel(channelId: string): Promise<TicketRow | null> {
  const result = await pool.query<TicketRow>(
    "SELECT * FROM tickets WHERE channel_id = $1 LIMIT 1",
    [channelId]
  );

  return result.rows[0] ?? null;
}

export async function closeTicketByChannel(channelId: string): Promise<TicketRow | null> {
  const result = await pool.query<TicketRow>(
    `UPDATE tickets
     SET status = 'closed',
         closed_at = NOW()
     WHERE channel_id = $1
       AND status = 'open'
     RETURNING *`,
    [channelId]
  );

  return result.rows[0] ?? null;
}

export async function updateTicketCategoryByChannel(
  channelId: string,
  categoryKey: string
): Promise<TicketRow | null> {
  const result = await pool.query<TicketRow>(
    `UPDATE tickets
     SET category_key = $2
     WHERE channel_id = $1
     RETURNING *`,
    [channelId, categoryKey]
  );

  return result.rows[0] ?? null;
}

/** Recently closed tickets — used on boot to delete channels if a prior run crashed before the timer fired. */
export async function listClosedTicketsChannelsForCleanup(
  maxAgeHours = 48,
  limit = 60
): Promise<{ guild_id: string; channel_id: string }[]> {
  const safeHours = Math.max(1, Math.min(Number(maxAgeHours) || 48, 168));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 60, 200));

  const result = await pool.query<{ guild_id: string; channel_id: string }>(
    `SELECT guild_id, channel_id
     FROM tickets
     WHERE status = 'closed'
       AND closed_at IS NOT NULL
       AND closed_at > NOW() - ($1::int * INTERVAL '1 hour')
     ORDER BY closed_at DESC
     LIMIT $2`,
    [safeHours, safeLimit]
  );

  return result.rows;
}

export async function listTranscripts(limit = 100): Promise<TranscriptRow[]> {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));

  const result = await pool.query<TranscriptRow>(
    `SELECT
       id,
       channel_name,
       closed_by,
       created_at,
       guild_id,
       channel_id,
       ticket_id,
       ticket_user_id,
       ticket_category_key,
       ticket_brief_description,
       ticket_feds_url,
       closed_by_id
     FROM transcripts
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows;
}

export async function getTranscriptById(id: number): Promise<TranscriptRow | null> {
  const result = await pool.query<TranscriptRow>(
    `SELECT
       id,
       channel_name,
       closed_by,
       content,
       created_at,
       guild_id,
       channel_id,
       ticket_id,
       ticket_user_id,
       ticket_category_key,
       ticket_brief_description,
       ticket_feds_url,
       closed_by_id
     FROM transcripts
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  return result.rows[0] || null;
}

/** Full logical export used by gist backups (JSON). */
export async function exportTicketsForBackup(): Promise<TicketRow[]> {
  const result = await pool.query<TicketRow>(
    `SELECT *
     FROM tickets
     ORDER BY id ASC`
  );
  return result.rows;
}

/** Full logical export used by gist backups (JSON). */
export async function exportTranscriptsForBackup(): Promise<TranscriptRow[]> {
  const result = await pool.query<TranscriptRow>(
    `SELECT *
     FROM transcripts
     ORDER BY id ASC`
  );
  return result.rows;
}
