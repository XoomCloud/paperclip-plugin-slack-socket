import type { SlackSocketConfig } from "./types.js";

/** The decision channel admits only primary-bot human-decision surfaces.
 * Card identity, company, pending state and human authorisation remain the
 * responsibility of approvals/ask_human. This never grants an agent chat. */
export function decisionSurfaceAllowed(
  cfg: SlackSocketConfig, botKey: string, channel: string,
  surface: "mention" | "message" | "action" | "reaction" | "command",
  actionId = "",
): boolean {
  if (!cfg.approvalsChannelId || channel !== cfg.approvalsChannelId) return true;
  if (botKey !== "primary") return false;
  if (surface === "message" || surface === "reaction") return true;
  return surface === "action" && /^(approval_(approve|reject)|question_answer_[0-4])$/.test(actionId);
}

export function isDecisionChannel(cfg: SlackSocketConfig, channel: string): boolean {
  return Boolean(cfg.approvalsChannelId && channel === cfg.approvalsChannelId);
}
