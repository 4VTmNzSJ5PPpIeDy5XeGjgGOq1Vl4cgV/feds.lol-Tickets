import fs from "fs";
import path from "path";

const FILE_NAME = "dm_recipients.json";

function getFilePath(): string {
  return path.join(process.cwd(), FILE_NAME);
}

/** User IDs we've sent ticket-related DMs to (e.g. staff reply notifications). */
export function getRecipientIds(): string[] {
  try {
    const raw = fs.readFileSync(getFilePath(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? [...new Set(arr)] : [];
  } catch {
    return [];
  }
}

export function addRecipient(userId: string): void {
  const ids = getRecipientIds();
  if (ids.includes(userId)) return;
  ids.push(userId);
  try {
    fs.writeFileSync(getFilePath(), JSON.stringify(ids, null, 0), "utf8");
  } catch (e) {
    console.warn("[dmRecipients] Failed to save:", (e as Error)?.message);
  }
}
