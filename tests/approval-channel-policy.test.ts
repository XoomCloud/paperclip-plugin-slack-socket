import { describe, expect, it } from "vitest";
import { decisionSurfaceAllowed, isDecisionChannel } from "../src/approval-channel-policy.js";
import { TEST_CONFIG } from "./helpers.js";

const cfg = { ...TEST_CONFIG, approvalsChannelId: "CPRIVATE" };

describe("private decision channel surfaces", () => {
  it("admits only exact primary-bot decision actions, not chat or commands", () => {
    for (const action of ["approval_approve", "approval_reject", "question_answer_0", "question_answer_4"])
      expect(decisionSurfaceAllowed(cfg, "primary", "CPRIVATE", "action", action)).toBe(true);
    for (const action of ["approval_approve_extra", "question_answer_5", "other"])
      expect(decisionSurfaceAllowed(cfg, "primary", "CPRIVATE", "action", action)).toBe(false);
    expect(decisionSurfaceAllowed(cfg, "primary", "CPRIVATE", "mention")).toBe(false);
    expect(decisionSurfaceAllowed(cfg, "primary", "CPRIVATE", "command")).toBe(false);
    expect(isDecisionChannel(cfg, "CPRIVATE")).toBe(true);
  });
  it("denies every additional-bot surface in the private decision channel", () => {
    for (const surface of ["mention", "message", "action", "reaction", "command"] as const)
      expect(decisionSurfaceAllowed(cfg, "additional:UBOT2", "CPRIVATE", surface, "approval_approve")).toBe(false);
  });
  it("retains primary pending-question surfaces without granting a provider turn", () => {
    expect(decisionSurfaceAllowed(cfg, "primary", "CPRIVATE", "message")).toBe(true);
    expect(decisionSurfaceAllowed(cfg, "primary", "CPRIVATE", "reaction")).toBe(true);
  });
  it("preserves other channels and installations without a decision-channel setting", () => {
    expect(decisionSurfaceAllowed(cfg, "additional:UBOT2", "CROLE", "mention")).toBe(true);
    expect(decisionSurfaceAllowed({ ...cfg, approvalsChannelId: "" }, "primary", "CPRIVATE", "mention")).toBe(true);
  });
});
