import { describe, it, expect } from "vitest";
import {
  isCeReviewPassed,
  isCeReviewNeedsFix,
  isTaskFullyCompleted,
  shouldShowCeCompletionGate,
  shouldShowCeReviewNeedsFix,
} from "../core/ceCompletion";
import type { Task, TaskReviewResult, TaskStatus, WorkflowStage } from "../shared/types";

/**
 * Phase 73A：CE Review Passed Completion Gate 的判斷測試。
 */

function makeTask(opts?: {
  codeReviewNotes?: string;
  status?: TaskStatus;
  reviewResult?: TaskReviewResult;
  workflowStage?: WorkflowStage;
}): Task {
  return {
    id: "t1",
    title: "t",
    type: "bug",
    status: opts?.status ?? "todo",
    priority: "medium",
    workflowStage: opts?.workflowStage ?? "spec",
    originalRequirement: "r",
    targetFiles: [],
    forbiddenFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    tags: [],
    reviewResult: opts?.reviewResult ?? "not_reviewed",
    aiWorkflow:
      opts?.codeReviewNotes !== undefined
        ? { workReview: { codeReviewNotes: opts.codeReviewNotes } }
        : undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("isCeReviewPassed", () => {
  it("codeReviewNotes 含 'Review result: passed' → true", () => {
    expect(isCeReviewPassed(makeTask({ codeReviewNotes: "Review result: passed\n\nNotes:\n看起來不錯" }))).toBe(true);
  });

  it("codeReviewNotes 含 'Review result: needs_fix' → false", () => {
    expect(isCeReviewPassed(makeTask({ codeReviewNotes: "Review result: needs_fix\n\nIssues:\n- x" }))).toBe(false);
  });

  it("無 codeReviewNotes → false", () => {
    expect(isCeReviewPassed(makeTask())).toBe(false);
    expect(isCeReviewPassed(makeTask({ codeReviewNotes: "" }))).toBe(false);
  });

  it("含一般 passed 字樣但不是精確標記 → false（避免誤判）", () => {
    expect(isCeReviewPassed(makeTask({ codeReviewNotes: "all tests passed and looks good" }))).toBe(false);
    expect(isCeReviewPassed(makeTask({ codeReviewNotes: "review passed manually" }))).toBe(false);
  });
});

describe("isCeReviewNeedsFix", () => {
  it("含 'Review result: needs_fix' → true", () => {
    expect(isCeReviewNeedsFix(makeTask({ codeReviewNotes: "Review result: needs_fix" }))).toBe(true);
  });
  it("passed / 無 notes → false", () => {
    expect(isCeReviewNeedsFix(makeTask({ codeReviewNotes: "Review result: passed" }))).toBe(false);
    expect(isCeReviewNeedsFix(makeTask())).toBe(false);
  });
});

describe("isTaskFullyCompleted", () => {
  it("done + passed + done → true", () => {
    expect(isTaskFullyCompleted(makeTask({ status: "done", reviewResult: "passed", workflowStage: "done" }))).toBe(true);
  });
  it("缺任一條件 → false", () => {
    expect(isTaskFullyCompleted(makeTask({ status: "done", reviewResult: "passed", workflowStage: "review" }))).toBe(false);
    expect(isTaskFullyCompleted(makeTask({ status: "in_progress", reviewResult: "passed", workflowStage: "done" }))).toBe(false);
  });
});

describe("shouldShowCeCompletionGate", () => {
  it("CE Review passed 且未完成 → true", () => {
    expect(shouldShowCeCompletionGate(makeTask({ codeReviewNotes: "Review result: passed" }))).toBe(true);
  });

  it("CE Review needs_fix → false", () => {
    expect(shouldShowCeCompletionGate(makeTask({ codeReviewNotes: "Review result: needs_fix" }))).toBe(false);
  });

  it("無 CE Review → false", () => {
    expect(shouldShowCeCompletionGate(makeTask())).toBe(false);
  });

  it("已完成（done/passed/done）→ false（不重複顯示）", () => {
    expect(
      shouldShowCeCompletionGate(
        makeTask({ codeReviewNotes: "Review result: passed", status: "done", reviewResult: "passed", workflowStage: "done" })
      )
    ).toBe(false);
  });
});

describe("shouldShowCeReviewNeedsFix", () => {
  it("needs_fix 且未完成 → true", () => {
    expect(shouldShowCeReviewNeedsFix(makeTask({ codeReviewNotes: "Review result: needs_fix" }))).toBe(true);
  });

  it("passed → false", () => {
    expect(shouldShowCeReviewNeedsFix(makeTask({ codeReviewNotes: "Review result: passed" }))).toBe(false);
  });

  it("已完成 → false", () => {
    expect(
      shouldShowCeReviewNeedsFix(
        makeTask({ codeReviewNotes: "Review result: needs_fix", status: "done", reviewResult: "passed", workflowStage: "done" })
      )
    ).toBe(false);
  });
});
