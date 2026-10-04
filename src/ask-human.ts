import type { PluginContext } from "@paperclipai/plugin-sdk";
import { checkToolCompany } from "./access.js";
import { ASK_HUMAN_TOOL_DECLARATION, STATE_KEYS, TOOL_NAMES, stateScope } from "./constants.js";
import { formatQuestion, formatQuestionResolved } from "./formatters.js";
import { humanOrigin, type HumanOriginDeps } from "./human-origin.js";
import { errString } from "./redact.js";
import { updateIndex } from "./state-index.js";
import type {
  InboundMessage,
  InboundReaction,
  InboundAction,
  PendingQuestion,
  SlackGateway,
  SlackSocketConfig,
} from "./types.js";

export interface AskHumanDeps extends HumanOriginDeps {
  ctx: PluginContext;
  gateway: SlackGateway;
  getConfig: () => Promise<SlackSocketConfig>;
}

export interface AskHuman {
  registerTool(): void;
  /** Returns true when the message was an answer to a pending question (callers must stop routing it). */
  tryHandleAnswer(msg: InboundMessage): Promise<boolean>;
  handleReaction(reaction: InboundReaction): Promise<void>;
  handleAction(action: InboundAction): Promise<void>;
}

export function createAskHuman(deps: AskHumanDeps): AskHuman {
  const { ctx, gateway, getConfig } = deps;
  const gatewayFor = (pending: PendingQuestion) =>
    pending.bot ? deps.gatewayForBot?.(pending.bot) : gateway;
  const isExpired = (pending: PendingQuestion) =>
    Date.now() >= Date.parse(pending.askedAt) + pending.timeoutMinutes * 60_000;
  async function isPermitted(userId: string): Promise<boolean> {
    return (await getConfig()).humanDecisionSlackUserIds.includes(userId);
  }
  // Same-process claim guard against the double-resolution race: two
  // near-simultaneous events for the same pending question (e.g. a reaction
  // and a thread reply, or two overlapping reactions) can both pass the
  // "pending exists" read before either has written its resolution. Callers
  // must check-and-add this set synchronously (no await in between) right
  // after confirming the event matches a pending question, so only the
  // first in-flight resolution for a given key proceeds.
  const claimed = new Set<string>();

  async function resolvePending(
    key: string,
    pending: PendingQuestion,
    response: string,
    responderName: string,
  ): Promise<void> {
    const body = `Slack response from ${responderName} to: "${pending.question}"\n\n${response}`;
    await ctx.issues.createComment(pending.issueId, body, pending.companyId);
    try {
      await ctx.issues.requestWakeup(pending.issueId, pending.companyId, {
        reason: "slack_ask_human_response",
        contextSource: "slack-socket.ask-human",
      });
    } catch (err) {
      ctx.logger.warn("Wakeup after Slack answer failed", { err: errString(err), issueId: pending.issueId });
    }
    const questionGateway = gatewayFor(pending);
    if (!questionGateway) throw new Error("Question bot is not connected");
    await questionGateway.updateMessage({
      channel: pending.channel,
      ts: pending.questionTs ?? pending.ts,
      ...formatQuestionResolved(pending.question, response, responderName),
    });
    await ctx.state.delete(stateScope(key));
    await updateIndex(ctx, STATE_KEYS.questionIndex, (current) => current.filter((k) => k !== key));
    await ctx.metrics.write("slack.questions.answered", 1, { mode: pending.mode });
  }

  return {
    registerTool() {
      ctx.tools.register(
        TOOL_NAMES.askHuman,
        {
          displayName: ASK_HUMAN_TOOL_DECLARATION.displayName,
          description: ASK_HUMAN_TOOL_DECLARATION.description,
          parametersSchema: ASK_HUMAN_TOOL_DECLARATION.parametersSchema,
        },
        async (params, runCtx) => {
          const p = (params ?? {}) as Record<string, unknown>;
          const question = typeof p.question === "string" ? p.question.trim() : "";
          const target = typeof p.target === "string" ? p.target.trim() : "";
          const mode = p.mode === "reaction" || p.mode === "answer" ? p.mode : null;
          const issueId = typeof p.issueId === "string" ? p.issueId : "";
          const timeoutMinutes =
            typeof p.timeoutMinutes === "number" && p.timeoutMinutes > 0 ? p.timeoutMinutes : 1440;
          if (!question || !target || !mode || !issueId) {
            return { error: "question, target, mode and issueId are required" };
          }

          // getConfig() carries no non-throwing guarantee (it's a plain
          // Promise-returning function on AskHumanDeps), so a rejection here
          // must not propagate out of the tool handler — tool handlers never
          // throw. Wrapped exactly like post-message.ts does it.
          let config: SlackSocketConfig;
          try {
            config = await getConfig();
          } catch (err) {
            return { error: `Failed to load Slack configuration: ${errString(err)}` };
          }

          // Cross-tenant guard. This runs BEFORE anything is posted or
          // stored, because the damage here is not just an unauthorized
          // Slack message: `pending.companyId` below is taken from
          // `runCtx.companyId`, so a foreign run's question would harvest a
          // human answer out of the bound company's workspace and write it
          // onto the *foreign* company's issue.
          const companyDecision = checkToolCompany(
            config.companyId,
            runCtx.companyId,
            "Asking a human via Slack",
          );
          if (!companyDecision.allowed) {
            ctx.logger.warn("ask_human: refusing a call whose company does not match the bound config", {
              agentId: runCtx.agentId,
              runId: runCtx.runId,
            });
            try {
              await ctx.metrics.write("slack.questions.refused", 1, { mode });
            } catch (err) {
              ctx.logger.warn("Failed to write ask_human metrics", { err: errString(err) });
            }
            return { error: companyDecision.reason };
          }

          const options = Array.isArray(p.options)
            ? p.options
              .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              .map((value) => value.trim())
            : [];
          if (options.length > 5) return { error: "At most five choices may be supplied." };
          if (options.some((label) => label.length > 75)) {
            return { error: "Choice labels must be at most 75 characters." };
          }

          let origin = null;
          try {
            origin = deps.gatewayForBot
              ? await humanOrigin(ctx, runCtx.companyId, issueId, deps, runCtx.agentId)
              : null;
          } catch (err) {
            ctx.logger.warn("ask_human: task-origin validation failed", { err: errString(err), issueId });
            return { error: "The task origin could not be validated; no Slack question was posted." };
          }
          if (deps.gatewayForBot && !origin && (!config.approvalsChannelId || target !== config.approvalsChannelId)) {
            return { error: "Use the verified task origin or the configured management/approvals channel." };
          }

          let posted: { channel: string; ts: string };
          const postGateway = origin?.gateway ?? gateway;
          try {
            // "U" is a regular user id; Enterprise Grid's cross-workspace
            // "connected" users get a "W" id instead. Both DM.
            const channel = origin?.channel ??
              (target.startsWith("U") || target.startsWith("W") ? await postGateway.openDm(target) : target);
            const threadTs = origin?.threadTs;
            if (threadTs && await ctx.state.get(stateScope(STATE_KEYS.question(channel, threadTs)))) {
              return { error: "A question is already pending in this task thread; wait for its answer." };
            }
            const content = formatQuestion(question, mode);
            if (options.length) {
              content.blocks.push({
                type: "actions",
                elements: options.map((label, index) => ({
                  type: "button",
                  action_id: `question_answer_${index}`,
                  text: { type: "plain_text", text: label },
                  value: JSON.stringify({ issueId, index }),
                })),
              });
            }
            posted = await postGateway.postMessage({ channel, threadTs, ...content });
          } catch (err) {
            return { error: `Failed to post question to Slack: ${errString(err)}` };
          }

          const key = STATE_KEYS.question(posted.channel, origin?.threadTs ?? posted.ts);
          try {
            const pending: PendingQuestion = {
              channel: posted.channel,
              ts: origin?.threadTs ?? posted.ts,
              questionTs: posted.ts,
              bot: origin?.bot,
              options,
              issueId,
              companyId: runCtx.companyId,
              mode,
              question,
              askedAt: new Date().toISOString(),
              timeoutMinutes,
            };
            await ctx.state.set(stateScope(key), pending);
            await updateIndex(ctx, STATE_KEYS.questionIndex, (current) => [...current, key]);
          } catch (err) {
            // The question is now a live, unanswerable message in Slack: it
            // posted successfully but we failed to record enough state to
            // resolve it later. Log loudly, warn in the thread best-effort,
            // and tell the caller the truth instead of the misleading
            // "failed to post" message.
            ctx.logger.error("Failed to track ask_human question after posting to Slack", {
              err: errString(err),
              channel: posted.channel,
              ts: posted.ts,
              issueId,
            });
            await postGateway
              .updateMessage({
                channel: posted.channel,
                ts: posted.ts,
                text: ":warning: This question could not be tracked — please ask again.",
              })
              .catch((updateErr) => {
                ctx.logger.error("Failed to mark untracked ask_human question in Slack", {
                  err: String(updateErr),
                  channel: posted.channel,
                  ts: posted.ts,
                });
              });
            return { error: "Question was posted to Slack but could not be tracked; ask again." };
          }

          try {
            await ctx.metrics.write("slack.questions.asked", 1, { mode });
          } catch (err) {
            ctx.logger.warn("Failed to write ask_human metrics", { err: errString(err) });
          }
          return {
            content: `Question posted to Slack channel ${posted.channel}. The response will be recorded as a comment on issue ${issueId}.`,
            data: { channel: posted.channel, ts: posted.ts },
          };
        },
      );
    },

    async tryHandleAnswer(msg) {
      if (!msg.threadTs || msg.threadTs === msg.ts) return false;
      const key = STATE_KEYS.question(msg.channel, msg.threadTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "answer") return false;
      if (!(await isPermitted(msg.user)) || isExpired(pending)) return true;
      // An attachment-only message (Slack's file_share subtype, passed
      // through to routing so a captioned upload isn't swallowed — see
      // bolt-gateway.ts) can carry `text: ""`. That is not an answer: it
      // must not claim the key, delete the pending state, post a comment, or
      // wake the agent. Checked before the claim guard below so a blank
      // message never reaches it; falls through to chat routing, which
      // already no-ops on empty text (src/chat.ts).
      if (!msg.text.trim()) return false;
      // This message IS an answer to a pending question — claim it before
      // any further await so a concurrent resolution for the same key
      // can't also record it. If another in-flight call already holds the
      // claim, this is still an answer (caller must not fall through to
      // chat routing), so return true without re-resolving.
      if (claimed.has(key)) return true;
      claimed.add(key);
      try {
        const name = await gateway.getUserDisplayName(msg.user);
        await resolvePending(key, pending, msg.text, name);
      } finally {
        claimed.delete(key);
      }
      return true;
    },

    async handleAction(action) {
      if (!(await isPermitted(action.user))) return;
      let choice: { issueId: string; index: number };
      try {
        choice = JSON.parse(action.value) as { issueId: string; index: number };
      } catch {
        return;
      }
      if (typeof choice.issueId !== "string" || !Number.isInteger(choice.index)) return;
      const keys = (await ctx.state.get(stateScope(STATE_KEYS.questionIndex))) as string[] | null;
      for (const key of keys ?? []) {
        const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
        if (
          !pending ||
          pending.issueId !== choice.issueId ||
          pending.channel !== action.channel ||
          (pending.questionTs ?? pending.ts) !== action.messageTs ||
          isExpired(pending)
        ) continue;
        const answer = pending.options?.[choice.index];
        if (!answer || claimed.has(key)) return;
        claimed.add(key);
        try {
          await resolvePending(key, pending, answer, action.userName);
        } finally {
          claimed.delete(key);
        }
        return;
      }
    },

    async handleReaction(reaction) {
      const key = STATE_KEYS.question(reaction.channel, reaction.messageTs);
      const pending = (await ctx.state.get(stateScope(key))) as PendingQuestion | null;
      if (!pending || pending.mode !== "reaction") return;
      if (!(await isPermitted(reaction.user)) || isExpired(pending)) return;
      if (claimed.has(key)) return;
      claimed.add(key);
      try {
        const name = await gateway.getUserDisplayName(reaction.user);
        await resolvePending(key, pending, `:${reaction.reaction}:`, name);
      } finally {
        claimed.delete(key);
      }
    },
  };
}
