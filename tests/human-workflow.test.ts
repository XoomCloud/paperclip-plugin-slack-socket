import { describe, expect, it, vi } from "vitest";
import { createApprovals } from "../src/approvals.js";
import { createAskHuman } from "../src/ask-human.js";
import { STATE_KEYS } from "../src/constants.js";
import { parseTaskOrigin } from "../src/human-origin.js";
import { FakeGateway, makeCtx, TEST_CONFIG } from "./helpers.js";

function setup() {
  const bundle = makeCtx();
  const gateway = new FakeGateway();
  const employee = new FakeGateway();
  employee.setBotUserId("UBOT1");
  const cfg = {
    ...TEST_CONFIG,
    allowedSlackUserIds: ["UOWNER"],
    humanDecisionSlackUserIds: ["UOWNER"],
    approvalsChannelId: "CMANAGEMENT",
  };
  const origin = "bot:UBOT1:session:CEMPLOYEE:100.1";
  (bundle.ctx.issues as any).get = vi.fn().mockResolvedValue({
    id: "issue-1",
    companyId: "co-1",
    assigneeAgentId: "agent-1",
    description: `XoomAI conversation: ${origin}`,
  });
  bundle.stateStore.set(origin, {
    sessionId: "session-1",
    agentId: "agent-1",
    channel: "CEMPLOYEE",
    threadTs: "100.1",
    scope: "thread",
    lastActivityAt: new Date().toISOString(),
  });
  (bundle.ctx.http.fetch as any).mockImplementation(async (_url: string, init?: { method?: string }) => ({
    status: 200,
    json: async () => init?.method === "POST"
      ? {}
      : {
        id: "approval-1",
        companyId: "co-1",
        status: "pending",
        payload: { title: "Fixture", issueIds: ["issue-1"] },
      },
  }));
  const deps = {
    ctx: bundle.ctx,
    gateway,
    getConfig: async () => cfg,
    gatewayForBot: (bot: string) => bot === "UBOT1" ? employee : undefined,
    agentIdForBot: (bot: string) => bot === "UBOT1" ? "agent-1" : undefined,
  };
  const human = createAskHuman(deps);
  human.registerTool();
  const handler = (bundle.ctx.tools.register as any).mock.calls[0][2];
  const approvals = createApprovals({ ...deps, companyId: "co-1" });
  return { ...bundle, gateway, employee, human, handler, approvals };
}

const run = { agentId: "agent-1", runId: "run-1", companyId: "co-1", projectId: "project-1" };

describe("Slack human-decision workflow", () => {
  it("parses only a complete immutable task-origin marker", () => {
    expect(parseTaskOrigin("XoomAI conversation: bot:UBOT1:session:CEMPLOYEE:100.1")).toEqual({
      key: "bot:UBOT1:session:CEMPLOYEE:100.1",
      bot: "UBOT1",
      channel: "CEMPLOYEE",
      threadTs: "100.1",
    });
    expect(parseTaskOrigin("XoomAI conversation: bot:UBOT1:session:CEMPLOYEE")).toBeNull();
  });

  it("posts choices in the validated original thread using its employee bot", async () => {
    const fixture = setup();
    await fixture.handler({
      question: "Choose",
      target: "CEMPLOYEE",
      mode: "answer",
      issueId: "issue-1",
      options: ["A", "B"],
    }, run);
    expect(fixture.employee.posts[0]).toMatchObject({ channel: "CEMPLOYEE", threadTs: "100.1" });
    expect(fixture.gateway.posts).toHaveLength(0);
    expect(JSON.stringify(fixture.employee.posts[0]!.blocks)).toContain("question_answer_0");
  });

  it("records a choice, wakes the assignee, retires the card and ignores replay", async () => {
    const fixture = setup();
    await fixture.handler({
      question: "Choose",
      target: "CEMPLOYEE",
      mode: "answer",
      issueId: "issue-1",
      options: ["A", "B"],
    }, run);
    const action = {
      actionId: "question_answer_1",
      value: JSON.stringify({ issueId: "issue-1", index: 1 }),
      user: "UOWNER",
      userName: "Owner",
      channel: "CEMPLOYEE",
      messageTs: fixture.employee.posts[0]!.ts,
    };
    await fixture.human.handleAction(action);
    await fixture.human.handleAction(action);
    expect(fixture.ctx.issues.createComment).toHaveBeenCalledTimes(1);
    expect(fixture.ctx.issues.createComment).toHaveBeenCalledWith(
      "issue-1", expect.stringContaining("B"), "co-1",
    );
    expect(fixture.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
    expect(fixture.employee.updates).toHaveLength(1);
  });

  it("refuses unauthorized, wrong-channel and expired choice callbacks", async () => {
    const fixture = setup();
    await fixture.handler({
      question: "Choose",
      target: "CEMPLOYEE",
      mode: "answer",
      issueId: "issue-1",
      options: ["A"],
    }, run);
    const action = {
      actionId: "question_answer_0",
      value: JSON.stringify({ issueId: "issue-1", index: 0 }),
      user: "UOTHER",
      userName: "Other",
      channel: "CEMPLOYEE",
      messageTs: fixture.employee.posts[0]!.ts,
    };
    await fixture.human.handleAction(action);
    await fixture.human.handleAction({ ...action, user: "UOWNER", channel: "COTHER" });
    const pending = fixture.stateStore.get(STATE_KEYS.question("CEMPLOYEE", "100.1")) as { askedAt: string };
    pending.askedAt = "2000-01-01T00:00:00Z";
    await fixture.human.handleAction({ ...action, user: "UOWNER" });
    expect(fixture.ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("accepts a typed reply and refuses overwriting a pending thread question", async () => {
    const fixture = setup();
    const params = { question: "Question", target: "CEMPLOYEE", mode: "answer", issueId: "issue-1" };
    await fixture.handler(params, run);
    expect((await fixture.handler(params, run)).error).toContain("already pending");
    await fixture.human.tryHandleAnswer({
      channel: "CEMPLOYEE",
      channelType: "group",
      user: "UOWNER",
      text: "My answer",
      ts: "101.1",
      threadTs: "100.1",
    });
    expect(fixture.ctx.issues.createComment).toHaveBeenCalledWith(
      "issue-1", expect.stringContaining("My answer"), "co-1",
    );
  });

  it("routes a task-linked approval through the employee bot", async () => {
    const fixture = setup();
    await fixture.emitEvent("approval.created", {
      entityId: "approval-1",
      payload: { title: "Fixture", issueIds: ["issue-1"] },
    });
    expect(fixture.employee.posts[0]).toMatchObject({ channel: "CEMPLOYEE", threadTs: "100.1" });
    expect(fixture.gateway.posts).toHaveLength(0);
  });

  it("rejects unlinked or unauthorized approvals and accepts an exact pending card", async () => {
    const fixture = setup();
    const action = {
      actionId: "approval_approve",
      value: "approval-1",
      user: "UOWNER",
      userName: "Owner",
      channel: "CEMPLOYEE",
      messageTs: "123.1",
    };
    await fixture.approvals.handleAction(action);
    expect((fixture.ctx.http.fetch as any).mock.calls.filter((call: any[]) => call[1]?.method === "POST")).toHaveLength(0);
    await fixture.emitEvent("approval.created", {
      entityId: "approval-1",
      payload: { title: "Fixture", issueIds: ["issue-1"] },
    });
    const messageTs = fixture.employee.posts[0]!.ts;
    await fixture.approvals.handleAction({ ...action, user: "UOTHER", messageTs });
    expect((fixture.ctx.http.fetch as any).mock.calls.filter((call: any[]) => call[1]?.method === "POST")).toHaveLength(0);
    await fixture.approvals.handleAction({ ...action, messageTs });
    expect((fixture.ctx.http.fetch as any).mock.calls.filter((call: any[]) => call[1]?.method === "POST")).toHaveLength(1);
    expect(fixture.employee.updates[0]!.text).toContain("Approved");
  });
});
