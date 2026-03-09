const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id SERIAL PRIMARY KEY,
      channel_name TEXT,
      closed_by TEXT,
      content TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
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

module.exports = { init, saveTranscript, getTranscript };