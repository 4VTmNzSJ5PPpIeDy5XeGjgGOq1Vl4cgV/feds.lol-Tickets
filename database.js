const { Pool } = require("pg");

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
  throw new Error("[database] Missing DATABASE_URL");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("[database] Unexpected pool error:", err?.stack || err);
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id SERIAL PRIMARY KEY,
      channel_name TEXT NOT NULL,
      closed_by TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

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

async function saveTranscript(channelName, closedBy, content) {
  await pool.query(
    "INSERT INTO transcripts (channel_name, closed_by, content) VALUES ($1, $2, $3)",
    [channelName, closedBy, content]
  );
}

async function getTranscript(channelName) {
  const result = await pool.query(
    "SELECT * FROM transcripts WHERE channel_name = $1 ORDER BY created_at DESC LIMIT 1",
    [channelName]
  );
  return result.rows[0] ?? null;
}

async function createTicket({
  guildId,
  channelId,
  userId,
  username,
  categoryKey,
  briefDescription,
  fedsUrl,
}) {
  const result = await pool.query(
    `INSERT INTO tickets (
      guild_id, channel_id, user_id, username, category_key, brief_description, feds_url
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [guildId, channelId, userId, username, categoryKey, briefDescription, fedsUrl]
  );

  return result.rows[0];
}

async function getOpenTicketByUser(guildId, userId) {
  const result = await pool.query(
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

async function getTicketByChannel(channelId) {
  const result = await pool.query(
    "SELECT * FROM tickets WHERE channel_id = $1 LIMIT 1",
    [channelId]
  );

  return result.rows[0] ?? null;
}

async function closeTicketByChannel(channelId) {
  const result = await pool.query(
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
async function listTranscripts(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));

  const result = await pool.query(
    `SELECT id, channel_name, closed_by, created_at
     FROM transcripts
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows;
}

async function getTranscriptById(id) {
  const result = await pool.query(
    `SELECT id, channel_name, closed_by, content, created_at
     FROM transcripts
     WHERE id = $1
     LIMIT 1`,
    [id]
  );

  return result.rows[0] || null;
}

module.exports = {
  init,
  saveTranscript,
  getTranscript,
  createTicket,
  getOpenTicketByUser,
  getTicketByChannel,
  closeTicketByChannel,
  listTranscripts,
  getTranscriptById,
};
