import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";
import type { SlackBotIdentity } from "./types.js";

const ROUTABLE_STATUSES = new Set<Agent["status"]>(["active", "idle", "running", "error"]);
const BRAND_PREFIXES = ["xoomai", "xoom ai", "xoom-ai"];
const ROLE_SUFFIXES = ["agent", "employee", "bot"];

export interface AgentRegistry {
  agents: Agent[];
  aliases: Map<string, Agent[]>;
  refreshedAt: string;
}

export type AgentResolution =
  | { status: "resolved"; alias: string; agent: Agent }
  | { status: "missing"; alias: string; available: Agent[] }
  | { status: "ambiguous"; alias: string; matches: Agent[]; available: Agent[] };

/**
 * Converts both Slack app identities and Paperclip employee labels into the
 * same conservative alias. Only explicit branding and generic bot suffixes
 * are removed; job words such as "sales" or "coordinator" are preserved so
 * two similar employees cannot accidentally collapse onto one another.
 */
export function normalizeEmployeeAlias(value: string): string {
  let normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  for (const prefix of BRAND_PREFIXES) {
    if (normalized === prefix) return "";
    if (normalized.startsWith(`${prefix} `)) {
      normalized = normalized.slice(prefix.length).trim();
      break;
    }
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  while (words.length > 1 && ROLE_SUFFIXES.includes(words.at(-1)!)) words.pop();
  return words.join("-");
}

function aliasesForAgent(agent: Agent): Set<string> {
  const aliases = new Set<string>();
  for (const value of [agent.name, agent.urlKey, agent.title ?? ""]) {
    const alias = normalizeEmployeeAlias(value);
    if (alias) aliases.add(alias);
  }
  return aliases;
}

export function buildAgentRegistry(agents: Agent[], refreshedAt = new Date().toISOString()): AgentRegistry {
  const routable = agents.filter((agent) => ROUTABLE_STATUSES.has(agent.status));
  const aliases = new Map<string, Agent[]>();
  for (const agent of routable) {
    for (const alias of aliasesForAgent(agent)) {
      aliases.set(alias, [...(aliases.get(alias) ?? []), agent]);
    }
  }
  return { agents: routable, aliases, refreshedAt };
}

export function resolveSlackBot(registry: AgentRegistry, identity: SlackBotIdentity): AgentResolution {
  const alias = normalizeEmployeeAlias(identity.username);
  const matches = alias ? (registry.aliases.get(alias) ?? []) : [];
  if (matches.length === 1) return { status: "resolved", alias, agent: matches[0]! };
  if (matches.length > 1) return { status: "ambiguous", alias, matches, available: registry.agents };
  return { status: "missing", alias, available: registry.agents };
}

export function formatResolutionError(identity: SlackBotIdentity, resolution: Exclude<AgentResolution, { status: "resolved" }>): string {
  const available = resolution.available.map((agent) => agent.name).sort().join(", ") || "none";
  if (resolution.status === "ambiguous") {
    const matches = resolution.matches.map((agent) => agent.name).sort().join(", ");
    return `:warning: I cannot route this safely. Slack bot \`${identity.username}\` matches multiple Paperclip employees: ${matches}. Rename the Slack bot or the Paperclip employees so the match is unique. Available employees: ${available}.`;
  }
  return `:warning: I cannot route this safely. Slack bot \`${identity.username}\` does not match an active Paperclip employee. Name the Slack bot after the employee (for example \`XoomAI-Sales\`). Available employees: ${available}.`;
}

/** Fetches every Paperclip employee page and builds a fail-closed registry. */
export async function discoverAgentRegistry(
  ctx: PluginContext,
  companyId: string,
  pageSize = 100,
): Promise<AgentRegistry> {
  const agents: Agent[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await ctx.agents.list({ companyId, limit: pageSize, offset });
    agents.push(...page);
    if (page.length < pageSize) break;
  }
  return buildAgentRegistry(agents);
}
