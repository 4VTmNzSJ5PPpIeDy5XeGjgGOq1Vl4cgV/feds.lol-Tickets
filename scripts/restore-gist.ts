import "dotenv/config";

import { restoreFromGist } from "../lib/restoreGist";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[restore] Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const gistIdOrUrl = process.argv[2] || process.env.GITHUB_GIST_ID || "";
  if (!gistIdOrUrl) {
    throw new Error("[restore] Provide a gist id/url as argv[2] or set GITHUB_GIST_ID in env.");
  }

  const r = await restoreFromGist({
    databaseUrl,
    gistIdOrUrl,
    onProgress: (p) => {
      if (p.stage === "fetch_gist") console.log(`[restore] Fetching gist ${p.gistId}...`);
      if (p.stage === "download_backup") console.log("[restore] Downloading backup content...");
      if (p.stage === "parse_backup")
        console.log(
          `[restore] Backup created_at=${p.createdAt} tickets=${p.tickets} transcripts=${p.transcripts}`
        );
      if (p.stage === "restore_tickets" && p.current === 0)
        console.log("[restore] Restoring tickets...");
      if (p.stage === "restore_transcripts" && p.current === 0)
        console.log("[restore] Restoring transcripts...");
    }
  });

  console.log(`[restore] ✅ Restore complete. tickets=${r.tickets} transcripts=${r.transcripts}`);
}

main().catch((e) => {
  console.error("[restore] failed:", (e as Error)?.stack || e);
  process.exitCode = 1;
});

