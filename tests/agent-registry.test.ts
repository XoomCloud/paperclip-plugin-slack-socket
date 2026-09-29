import { describe, expect, it, vi } from "vitest";
import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";
import {
  buildAgentRegistry,
  discoverAgentRegistry,
  formatResolutionError,
  normalizeEmployeeAlias,
  resolveSlackBot,
} from "../src/agent-registry.js";

function agent(id: string, name: string, status: Agent["status"] = "active", title: string | null = null): Agent {
  return {
    id, companyId: "co-1", name, urlKey: name.toLowerCase().replace(/\s+/g, "-"), role: "general", title,
    icon: null, status, reportsTo: null, capabilities: null, adapterType: "codex_local", adapterConfig: {},
    runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0, pauseReason: null, pausedAt: null,
    permissions: { canCreateAgents: false }, lastHeartbeatAt: null, metadata: null,
    createdAt: new Date(0), updatedAt: new Date(0),
  };
}

const identity = (username: string) => ({ userId: "U-BOT", username });

describe("dynamic Paperclip employee registry", () => {
  it.each([
    ["XoomAI-Sales", "sales"],
    ["xoomai_marketing_agent", "marketing"],
    ["Finance Bot", "finance"],
    ["HR Coordinator", "hr-coordinator"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeEmployeeAlias(input)).toBe(expected);
  });

  it("routes a branded Slack bot to the matching active Paperclip employee", () => {
    const registry = buildAgentRegistry([agent("a-sales", "Sales"), agent("a-finance", "Finance")]);
    expect(resolveSlackBot(registry, identity("XoomAI-Sales"))).toMatchObject({
      status: "resolved", agent: { id: "a-sales" },
    });
  });

  it("does not route paused, pending, or terminated employees", () => {
    const registry = buildAgentRegistry([
      agent("paused", "Sales", "paused"),
      agent("pending", "Finance", "pending_approval"),
      agent("gone", "Marketing", "terminated"),
    ]);
    expect(resolveSlackBot(registry, identity("XoomAI-Sales")).status).toBe("missing");
    expect(registry.agents).toHaveLength(0);
  });

  it("fails closed on ambiguous aliases", () => {
    const registry = buildAgentRegistry([
      agent("one", "Revenue", "active", "Sales"),
      agent("two", "Sales"),
    ]);
    const resolution = resolveSlackBot(registry, identity("XoomAI-Sales"));
    expect(resolution).toMatchObject({ status: "ambiguous" });
    if (resolution.status !== "resolved") {
      expect(formatResolutionError(identity("XoomAI-Sales"), resolution)).toContain("matches multiple");
    }
  });

  it("lists available employees when a Slack identity is unresolved", () => {
    const registry = buildAgentRegistry([agent("sales", "Sales"), agent("finance", "Finance")]);
    const resolution = resolveSlackBot(registry, identity("XoomAI-Payroll"));
    expect(resolution.status).toBe("missing");
    if (resolution.status !== "resolved") {
      const text = formatResolutionError(identity("XoomAI-Payroll"), resolution);
      expect(text).toContain("Available employees: Finance, Sales");
      expect(text).not.toContain("default");
    }
  });

  it("paginates discovery", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([agent("sales", "Sales"), agent("finance", "Finance")])
      .mockResolvedValueOnce([agent("marketing", "Marketing")]);
    const ctx = { agents: { list } } as unknown as PluginContext;
    const registry = await discoverAgentRegistry(ctx, "co-1", 2);
    expect(list).toHaveBeenNthCalledWith(1, { companyId: "co-1", limit: 2, offset: 0 });
    expect(list).toHaveBeenNthCalledWith(2, { companyId: "co-1", limit: 2, offset: 2 });
    expect(registry.agents.map((entry) => entry.name)).toEqual(["Sales", "Finance", "Marketing"]);
  });
});
