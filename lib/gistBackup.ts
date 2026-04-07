import crypto from "crypto";

import * as db from "../database";

type BackupPayload = {
  version: 1;
  created_at: string;
  service: "feds-agent";
  tickets: unknown[];
  transcripts: unknown[];
};

function isoNow(): string {
  return new Date().toISOString();
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[backup] Missing required env var: ${name}`);
  return v;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function updateGist(opts: {
  token: string;
  gistId: string;
  filename: string;
  content: string;
}): Promise<void> {
  const res = await fetch(`https://api.github.com/gists/${opts.gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `token ${opts.token}`,
      "Content-Type": "application/json",
      "User-Agent": "feds-agent-backup"
    },
    body: JSON.stringify({
      files: {
        [opts.filename]: { content: opts.content }
      }
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`[backup] Gist update failed: ${res.status} ${res.statusText} ${txt}`);
  }
}

export async function runGistBackupOnce(): Promise<{ bytes: number; hash: string; filename: string }> {
  const enabled = (process.env.GIST_BACKUP_ENABLED || "").trim().toLowerCase();
  if (enabled && enabled !== "true" && enabled !== "1" && enabled !== "yes") {
    throw new Error("[backup] GIST_BACKUP_ENABLED must be true/1/yes when set");
  }

  const token = requireEnv("GITHUB_GIST_TOKEN");
  const gistId = requireEnv("GITHUB_GIST_ID");

  const tickets = await db.exportTicketsForBackup();
  const transcripts = await db.exportTranscriptsForBackup();

  const payload: BackupPayload = {
    version: 1,
    created_at: isoNow(),
    service: "feds-agent",
    tickets,
    transcripts
  };

  const json = JSON.stringify(payload);
  const hash = sha256(json);
  const filename = `backup.json`; // stable name so gist always holds latest snapshot

  await updateGist({ token, gistId, filename, content: json });
  return { bytes: Buffer.byteLength(json, "utf8"), hash, filename };
}

export function startGistBackupScheduler(): void {
  const enabled = (process.env.GIST_BACKUP_ENABLED || "").trim().toLowerCase();
  if (!enabled || (enabled !== "true" && enabled !== "1" && enabled !== "yes")) {
    console.log("[backup] Gist backup disabled (set GIST_BACKUP_ENABLED=true to enable).");
    return;
  }

  const intervalMs = 12 * 60 * 60 * 1000;
  const jitterMs = Math.floor(Math.random() * 60_000);

  const run = async (reason: string) => {
    try {
      const r = await runGistBackupOnce();
      console.log(`[backup] Gist backup ok (${reason}) bytes=${r.bytes} hash=${r.hash.slice(0, 12)} file=${r.filename}`);
    } catch (e) {
      console.error("[backup] Gist backup failed:", (e as Error)?.message || e);
    }
  };

  // Run shortly after boot, then every 12h. Jitter helps avoid “all instances at once” behavior.
  setTimeout(() => void run("startup"), 30_000 + jitterMs);
  setInterval(() => void run("interval"), intervalMs);
}

