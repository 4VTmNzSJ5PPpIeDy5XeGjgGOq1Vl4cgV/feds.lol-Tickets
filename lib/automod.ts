export function autoModBlockMessage(err: unknown): string | null {
  // Discord/AutoMod errors vary by rule type. We detect the common shapes/messages.
  const anyErr = err as any;
  const code = anyErr?.code ?? anyErr?.rawError?.code;
  const rawMessage =
    anyErr?.rawError?.message ??
    anyErr?.message ??
    (typeof err === "string" ? err : "") ??
    "";
  const msg = String(rawMessage).toLowerCase();

  // Heuristics:
  // - "blocked by this server" (AutoMod/keyword block)
  // - "contains words not allowed" style rejections
  // - some deployments surface numeric codes; we treat any known "blocked content" hints
  if (msg.includes("blocked by this server")) return "AutoMod blocked the content in your message.";
  if (msg.includes("automod")) return "AutoMod blocked the content in your message.";
  if (msg.includes("cannot send") && msg.includes("blocked")) return "AutoMod blocked the content in your message.";
  if (msg.includes("contains") && msg.includes("not allowed"))
    return "AutoMod blocked the content in your message.";

  // Code-based hint (Discord occasionally uses custom codes for blocked content).
  if (code === 200000) return "AutoMod blocked the content in your message.";

  return null;
}

export function userFacingAutoModHelp(): string {
  return (
    "This action failed because the server's AutoMod blocked some words.\n" +
    "Please rephrase and try again (remove profanity/blocked keywords)."
  );
}

