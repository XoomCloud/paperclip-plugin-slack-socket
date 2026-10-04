import type { PluginContext } from "@paperclipai/plugin-sdk";
import { stateScope } from "./constants.js";
import type { SessionEntry, SlackGateway } from "./types.js";

const ORIGIN_PREFIX = "XoomAI conversation: ";
const ORIGIN_PATTERN = /^XoomAI conversation: (bot:([^:\s]+):session:([^:\s]+):([^\s]+))$/m;

export interface HumanOriginDeps {
  gatewayForBot?: (bot: string) => SlackGateway | undefined;
  agentIdForBot?: (bot: string) => string | undefined;
}

export interface ParsedTaskOrigin {
  key: string;
  bot: string;
  channel: string;
  threadTs: string;
}

/** Parse only the exact marker written by the XoomAI task-origin relay. */
export function parseTaskOrigin(description: string): ParsedTaskOrigin | null {
  const match = description.match(ORIGIN_PATTERN);
  if (!match) return null;
  return { key: match[1]!, bot: match[2]!, channel: match[3]!, threadTs: match[4]! };
}

/** Build the marker without allowing free-form user text into its grammar. */
export function formatTaskOrigin(origin: ParsedTaskOrigin): string {
  return `${ORIGIN_PREFIX}${origin.key}`;
}

/**
 * Resolve an issue back to a live, company-bound Slack employee thread.
 * Every hop is checked: issue company, responsible employee, stored session,
 * channel, bot-to-employee binding, and currently connected bot gateway.
 */
export async function humanOrigin(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  deps: HumanOriginDeps,
  expectedAgentId?: string,
) {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || issue.companyId !== companyId) return null;
  const parsed = parseTaskOrigin(issue.description ?? "");
  if (!parsed) return null;

  const responsibleAgentId = issue.assigneeAgentId ?? issue.createdByAgentId;
  if (!responsibleAgentId || (expectedAgentId && responsibleAgentId !== expectedAgentId)) return null;
  if (deps.agentIdForBot?.(parsed.bot) !== responsibleAgentId) return null;

  const session = (await ctx.state.get(stateScope(parsed.key))) as SessionEntry | null;
  if (
    !session ||
    session.channel !== parsed.channel ||
    session.threadTs !== parsed.threadTs ||
    session.agentId !== responsibleAgentId
  ) return null;

  const gateway = deps.gatewayForBot?.(parsed.bot);
  return gateway ? { ...parsed, agentId: responsibleAgentId, gateway } : null;
}
