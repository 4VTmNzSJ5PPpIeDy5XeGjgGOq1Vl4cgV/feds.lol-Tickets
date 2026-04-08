import { Pool } from "pg";

export type BackupPayload = {
  version: 1;
  created_at: string;
  service: "feds-agent";
  tickets: any[];
  transcripts: any[];
};

export type RestoreProgress =
  | { stage: "fetch_gist"; gistId: string }
  | { stage: "download_backup"; rawUrl: string }
  | { stage: "parse_backup"; createdAt: string; tickets: number; transcripts: number }
  | { stage: "begin_db" }
  | { stage: "restore_tickets"; current: number; total: number }
  | { stage: "restore_transcripts"; current: number; total: number }
  | { stage: "fix_sequences" }
  | { stage: "done"; tickets: number; transcripts: number };

function parseGistId(input: string): string {
  const v = String(input || "").trim();
  if (!v) return "";
  const m = v.match(/[a-f0-9]{32}/i);
  return m ? m[0] : v;
}

function looksLikeGistRevision(seg: string): boolean {
  const s = String(seg || "").trim();
  return /^[a-f0-9]{40}$/i.test(s);
}

function parseGistUrlDetails(input: string): { revision: string | null; filename: string | null } {
  const raw = String(input || "").trim();
  if (!raw) return { revision: null, filename: null };

  // Example:
  // https://gist.github.com/<user>/<gistId>/<revision>/<filename>
  // https://gist.github.com/<user>/<gistId>/<filename>
  const m = raw.match(/gist\.github\.com\/[^/]+\/([a-f0-9]{32})(?:\/([^/?#]+))?(?:\/([^/?#]+))?/i);
  if (!m) return { revision: null, filename: null };

  const seg2 = m[2] ? decodeURIComponent(m[2]) : "";
  const seg3 = m[3] ? decodeURIComponent(m[3]) : "";

  if (seg2 && looksLikeGistRevision(seg2)) {
    return { revision: seg2, filename: seg3 || null };
  }
  // If seg2 exists and isn't a revision, it's likely the filename.
  return { revision: null, filename: seg2 || null };
}

async function fetchJson(url: string): Promise<any> {
  const token = (process.env.GITHUB_GIST_TOKEN || "").trim();
  const res = await fetch(url, {
    headers: {
      "User-Agent": "feds-agent-restore",
      ...(token ? { Authorization: `token ${token}` } : {})
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`[restore] fetch failed: ${res.status} ${res.statusText} ${txt}`);
  }
  return await res.json();
}

async function fetchText(url: string): Promise<string> {
  const token = (process.env.GITHUB_GIST_TOKEN || "").trim();
  const res = await fetch(url, {
    headers: {
      "User-Agent": "feds-agent-restore",
      ...(token ? { Authorization: `token ${token}` } : {})
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`[restore] fetch failed: ${res.status} ${res.statusText} ${txt}`);
  }
  return await res.text();
}

export async function restoreFromGist(opts: {
  databaseUrl: string;
  gistIdOrUrl: string;
  onProgress?: (p: RestoreProgress) => void;
}): Promise<{ tickets: number; transcripts: number; createdAt: string }> {
  const gistId = parseGistId(opts.gistIdOrUrl);
  if (!gistId) throw new Error("[restore] Missing gist id/url");
  const urlDetails = parseGistUrlDetails(opts.gistIdOrUrl);
  const preferredFilename = urlDetails.filename;

  opts.onProgress?.({ stage: "fetch_gist", gistId });
  const gist = urlDetails.revision
    ? await fetchJson(`https://api.github.com/gists/${gistId}/${urlDetails.revision}`)
    : await fetchJson(`https://api.github.com/gists/${gistId}`);
  const files = gist?.files || {};
  const file =
    (preferredFilename ? files?.[preferredFilename] : null) ||
    files?.["backup.json"] ||
    Object.values(files)?.[0];
  const rawUrl = file?.raw_url as string | undefined;
  if (!rawUrl) throw new Error("[restore] Could not find backup file raw_url in gist.");

  opts.onProgress?.({ stage: "download_backup", rawUrl });
  const text = await fetchText(rawUrl);
  const payload = JSON.parse(text) as BackupPayload;

  if (payload?.version !== 1 || payload?.service !== "feds-agent") {
    throw new Error("[restore] backup.json is not a supported feds-agent backup payload.");
  }

  const tickets = Array.isArray(payload.tickets) ? payload.tickets : [];
  const transcripts = Array.isArray(payload.transcripts) ? payload.transcripts : [];

  opts.onProgress?.({
    stage: "parse_backup",
    createdAt: payload.created_at,
    tickets: tickets.length,
    transcripts: transcripts.length
  });

  const pool = new Pool({
    connectionString: opts.databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    opts.onProgress?.({ stage: "begin_db" });
    await client.query("BEGIN");

    // Ensure schema exists.
    await client.query(`
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

    await client.query(`
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

    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (i % 50 === 0) {
        opts.onProgress?.({ stage: "restore_tickets", current: i, total: tickets.length });
      }
      await client.query(
        `INSERT INTO tickets (
           id, guild_id, channel_id, user_id, username, category_key, brief_description, feds_url, status, created_at, closed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (channel_id) DO UPDATE SET
           id = EXCLUDED.id,
           guild_id = EXCLUDED.guild_id,
           user_id = EXCLUDED.user_id,
           username = EXCLUDED.username,
           category_key = EXCLUDED.category_key,
           brief_description = EXCLUDED.brief_description,
           feds_url = EXCLUDED.feds_url,
           status = EXCLUDED.status,
           created_at = EXCLUDED.created_at,
           closed_at = EXCLUDED.closed_at`,
        [
          Number(t.id),
          String(t.guild_id),
          String(t.channel_id),
          String(t.user_id),
          String(t.username),
          String(t.category_key),
          String(t.brief_description),
          String(t.feds_url),
          String(t.status || "open"),
          t.created_at ? new Date(t.created_at) : new Date(),
          t.closed_at ? new Date(t.closed_at) : null
        ]
      );
    }
    opts.onProgress?.({ stage: "restore_tickets", current: tickets.length, total: tickets.length });

    for (let i = 0; i < transcripts.length; i++) {
      const tr = transcripts[i];
      if (i % 10 === 0) {
        opts.onProgress?.({
          stage: "restore_transcripts",
          current: i,
          total: transcripts.length
        });
      }
      await client.query(
        `INSERT INTO transcripts (
           id,
           guild_id,
           channel_id,
           ticket_id,
           ticket_user_id,
           ticket_category_key,
           ticket_brief_description,
           ticket_feds_url,
           closed_by_id,
           channel_name,
           closed_by,
           content,
           created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET
           guild_id = EXCLUDED.guild_id,
           channel_id = EXCLUDED.channel_id,
           ticket_id = EXCLUDED.ticket_id,
           ticket_user_id = EXCLUDED.ticket_user_id,
           ticket_category_key = EXCLUDED.ticket_category_key,
           ticket_brief_description = EXCLUDED.ticket_brief_description,
           ticket_feds_url = EXCLUDED.ticket_feds_url,
           closed_by_id = EXCLUDED.closed_by_id,
           channel_name = EXCLUDED.channel_name,
           closed_by = EXCLUDED.closed_by,
           content = EXCLUDED.content,
           created_at = EXCLUDED.created_at`,
        [
          Number(tr.id),
          tr.guild_id ?? null,
          tr.channel_id ?? null,
          tr.ticket_id ?? null,
          tr.ticket_user_id ?? null,
          tr.ticket_category_key ?? null,
          tr.ticket_brief_description ?? null,
          tr.ticket_feds_url ?? null,
          tr.closed_by_id ?? null,
          String(tr.channel_name),
          String(tr.closed_by),
          String(tr.content),
          tr.created_at ? new Date(tr.created_at) : new Date()
        ]
      );
    }
    opts.onProgress?.({
      stage: "restore_transcripts",
      current: transcripts.length,
      total: transcripts.length
    });

    opts.onProgress?.({ stage: "fix_sequences" });
    await client.query(
      `SELECT setval(pg_get_serial_sequence('tickets','id'), COALESCE((SELECT MAX(id) FROM tickets), 1), true)`
    );
    await client.query(
      `SELECT setval(pg_get_serial_sequence('transcripts','id'), COALESCE((SELECT MAX(id) FROM transcripts), 1), true)`
    );

    await client.query("COMMIT");
    opts.onProgress?.({ stage: "done", tickets: tickets.length, transcripts: transcripts.length });
    return { tickets: tickets.length, transcripts: transcripts.length, createdAt: payload.created_at };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

