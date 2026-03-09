const { Pool } = require("pg");

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
  throw new Error("[database] Missing DATABASE_URL");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
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
}

async function saveTranscript(channelName, closedBy, content) {
  await pool.query(
    `INSERT INTO transcripts (channel_name, closed_by, content)
     VALUES ($1, $2, $3)`,
    [channelName, closedBy, content]
  );
}

async function getTranscript(channelName) {
  const result = await pool.query(
    `SELECT *
     FROM transcripts
     WHERE channel_name = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [channelName]
  );

  return result.rows[0] || null;
}

module.exports = {
  pool,
  init,
  saveTranscript,
  getTranscript
};
