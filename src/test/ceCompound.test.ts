import { describe, it, expect } from "vitest";
import { buildCeCompoundDraft } from "../core/ceCompound";
import type { AiEngineeringWorkflow, Task, TaskCompletionEvent } from "../shared/types";

/**
 * Phase 74：CE Compound Notes Generator 純函式測試。
 */

function makeTask(opts?: {
  title?: string;
  originalRequirement?: string;
  project?: string;
  projectPath?: string;
  aiWorkflow?: AiEngineeringWorkflow;
  completedAt?: string;
  completionHistory?: TaskCompletionEvent[];
}): Task {
  return {
    id: "t1",
    title: opts?.title ?? "示範任務",
    type: "bug",
    status: "todo",
    priority: "medium",
    workflowStage: "spec",
    originalRequirement: opts?.originalRequirement ?? "",
    targetFiles: [],
    forbiddenFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    tags: [],
    project: opts?.project,
    projectPath: opts?.projectPath,
    aiWorkflow: opts?.aiWorkflow,
    completedAt: opts?.completedAt,
    completionHistory: opts?.completionHistory,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildCeCompoundDraft", () => {
  it("1. 基本 task 不 throw，且回傳三段字串", () => {
    const draft = buildCeCompoundDraft(makeTask());
    expect(typeof draft.lessonLearned).toBe("string");
    expect(typeof draft.reusablePrompt).toBe("string");
    expect(typeof draft.compoundNotes).toBe("string");
  });

  it("2. 有 originalRequirement 時 lessonLearned 包含原始需求", () => {
    const draft = buildCeCompoundDraft(
      makeTask({ originalRequirement: "新增登入失敗的錯誤提示" })
    );
    expect(draft.lessonLearned).toContain("新增登入失敗的錯誤提示");
  });

  it("3. 有 riskNotes 時 reusablePrompt 包含風險檢查", () => {
    const draft = buildCeCompoundDraft(
      makeTask({ aiWorkflow: { audit: { riskNotes: ["可能影響既有 session 流程"] } } })
    );
    expect(draft.reusablePrompt).toContain("可能影響既有 session 流程");
    expect(draft.reusablePrompt).toContain("Review 時請特別檢查");
  });

  it("4. 有 changedFiles 時 compoundNotes 包含 changed files", () => {
    const draft = buildCeCompoundDraft(
      makeTask({ aiWorkflow: { workReview: { changedFiles: ["src/App.tsx", "src/App.css"] } } })
    );
    expect(draft.compoundNotes).toContain("Changed files");
    expect(draft.compoundNotes).toContain("src/App.tsx");
  });

  it("5. 有 testCommands / testResults 時 compoundNotes 包含測試資訊", () => {
    const draft = buildCeCompoundDraft(
      makeTask({
        aiWorkflow: {
          workReview: { testCommands: ["pnpm test:run"], testResults: "120 passed" },
        },
      })
    );
    expect(draft.compoundNotes).toContain("Test commands");
    expect(draft.compoundNotes).toContain("pnpm test:run");
    expect(draft.compoundNotes).toContain("Test results");
    expect(draft.compoundNotes).toContain("120 passed");
  });

  it("6. 有 codeReviewNotes passed 時 compoundNotes 包含 Review 與 passed 結論", () => {
    const draft = buildCeCompoundDraft(
      makeTask({
        aiWorkflow: {
          workReview: { codeReviewNotes: "Review result: passed\n\nNotes:\n看起來不錯" },
        },
      })
    );
    expect(draft.compoundNotes).toContain("## Review");
    expect(draft.compoundNotes).toContain("Review 通過（passed）");
    expect(draft.compoundNotes).toContain("看起來不錯");
  });

  it("7. 資料不足時 lessonLearned 與 compoundNotes 包含資料不足提示", () => {
    const draft = buildCeCompoundDraft(makeTask({ originalRequirement: "只有需求沒有 work" }));
    expect(draft.lessonLearned).toContain("資料不足");
    expect(draft.compoundNotes).toContain("資料不足");
  });

  it("有完整 Work / Review 時不顯示資料不足提示", () => {
    const draft = buildCeCompoundDraft(
      makeTask({
        aiWorkflow: {
          workReview: {
            changedFiles: ["src/App.tsx"],
            testCommands: ["pnpm test:run"],
            testResults: "ok",
            codeReviewNotes: "Review result: passed",
          },
        },
      })
    );
    expect(draft.lessonLearned).not.toContain("資料不足");
    expect(draft.compoundNotes).not.toContain("資料不足");
  });

  it("completedAt / completionHistory 會反映在 compoundNotes 的 Completion 區塊", () => {
    const draft = buildCeCompoundDraft(
      makeTask({
        completedAt: "2026-06-11T00:00:00.000Z",
        completionHistory: [
          {
            id: "c1",
            type: "completion_applied",
            createdAt: "2026-06-11T00:00:00.000Z",
            summarySaved: true,
            status: "done",
            reviewResult: "passed",
            workflowStage: "done",
            message: "已套用完成狀態",
          },
        ],
      })
    );
    expect(draft.compoundNotes).toContain("## Completion");
    expect(draft.compoundNotes).toContain("2026-06-11T00:00:00.000Z");
    expect(draft.compoundNotes).toContain("已套用完成狀態");
  });

  it("reusablePrompt 使用 task title 並包含限制段", () => {
    const draft = buildCeCompoundDraft(makeTask({ title: "重構登入流程" }));
    expect(draft.reusablePrompt).toContain("重構登入流程");
    expect(draft.reusablePrompt).toContain("不要過度重構");
    expect(draft.reusablePrompt).toContain("不要修改 unrelated files");
  });
});
