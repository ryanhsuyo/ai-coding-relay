import { describe, it, expect } from "vitest";
import { deriveAiWorkflowProgress } from "../core/aiWorkflowProgress";
import type { AiEngineeringWorkflow, Task } from "../shared/types";
import type { AiWorkflowStep, AiWorkflowStepKey } from "../core/aiWorkflowProgress";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "進度測試任務",
    type: "bug",
    status: "todo",
    priority: "medium",
    originalRequirement: "修正登入問題",
    targetFiles: [],
    forbiddenFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function withWorkflow(workflow: AiEngineeringWorkflow, overrides: Partial<Task> = {}): Task {
  return makeTask({ aiWorkflow: workflow, ...overrides });
}

function stepOf(task: Task, key: AiWorkflowStepKey): AiWorkflowStep {
  const step = deriveAiWorkflowProgress(task).steps.find((s) => s.key === key);
  if (!step) throw new Error(`step not found: ${key}`);
  return step;
}

describe("deriveAiWorkflowProgress", () => {
  it("回傳固定順序的 8 個階段", () => {
    const progress = deriveAiWorkflowProgress(makeTask());
    expect(progress.steps.map((s) => s.key)).toEqual([
      "define", "brainstorm", "plan", "audit", "work", "review", "commit", "compound",
    ]);
  });

  it("沒 originalRequirement → define not_started、currentStep=define", () => {
    const progress = deriveAiWorkflowProgress(makeTask({ originalRequirement: "" }));
    expect(progress.steps[0].state).toBe("not_started");
    expect(progress.steps[0].detail).toBe("尚未填寫原始需求");
    expect(progress.currentStep).toBe("define");
    expect(progress.nextAction).toBe("先補上 originalRequirement。");
  });

  it("有 originalRequirement 但無 brainstorm → define completed、nextAction 指向 Brainstorm", () => {
    const progress = deriveAiWorkflowProgress(makeTask());
    expect(progress.steps[0].state).toBe("completed");
    expect(progress.currentStep).toBe("brainstorm");
    expect(progress.nextAction).toContain("Brainstorm Prompt");
  });

  it("brainstorm reviewed + plan planned → brainstorm completed、plan in_progress、currentStep=plan", () => {
    const task = withWorkflow({
      brainstorm: { status: "reviewed" },
      plan: { status: "planned" },
    });
    expect(stepOf(task, "brainstorm").state).toBe("completed");
    expect(stepOf(task, "brainstorm").detail).toBe("Brainstorm 已審查");
    expect(stepOf(task, "plan").state).toBe("in_progress");
    expect(stepOf(task, "plan").detail).toBe("Plan 已產生，待審計");
    expect(deriveAiWorkflowProgress(task).currentStep).toBe("plan");
  });

  it("brainstorm path+summary（無 status）也視為 completed", () => {
    const task = withWorkflow({ brainstorm: { path: "b.md", summary: "摘要" } });
    expect(stepOf(task, "brainstorm").state).toBe("completed");
    expect(stepOf(task, "brainstorm").detail).toBe("已有 brainstorm 文件");
  });

  it("plan rejected → plan blocked、canStartWork=false、nextAction 提示修正 plan", () => {
    const task = withWorkflow({
      brainstorm: { status: "reviewed" },
      plan: { status: "rejected", path: "p.md", summary: "摘要" },
    });
    const progress = deriveAiWorkflowProgress(task);
    expect(stepOf(task, "plan").state).toBe("blocked");
    expect(stepOf(task, "plan").detail).toBe("Plan 已退回");
    expect(progress.canStartWork).toBe(false);
    expect(progress.nextAction).toBe("Plan 已退回，請先修正 plan。");
  });

  it("audit checklist 5/5 → audit completed、計數正確", () => {
    const task = withWorkflow({
      audit: {
        checklist: {
          coreAssumptionsReviewed: true,
          riskReviewed: true,
          scopeReviewed: true,
          acceptanceCriteriaReviewed: true,
          minimalChangeReviewed: true,
        },
      },
    });
    const progress = deriveAiWorkflowProgress(task);
    expect(stepOf(task, "audit").state).toBe("completed");
    expect(progress.auditChecklistCompletedCount).toBe(5);
    expect(progress.auditChecklistTotalCount).toBe(5);
  });

  it("audit notes + checklist 3/5 → completed；只勾 2 項 → in_progress 並顯示 2/5", () => {
    const checklist3 = {
      coreAssumptionsReviewed: true,
      riskReviewed: true,
      scopeReviewed: true,
      acceptanceCriteriaReviewed: false,
      minimalChangeReviewed: false,
    };
    const done = withWorkflow({ audit: { notes: "已審計", checklist: checklist3 } });
    expect(stepOf(done, "audit").state).toBe("completed");

    const partial = withWorkflow({
      audit: { checklist: { ...checklist3, scopeReviewed: false } },
    });
    expect(stepOf(partial, "audit").state).toBe("in_progress");
    expect(stepOf(partial, "audit").detail).toBe("Audit 進行中：2/5");
  });

  it("plan approved → audit 也視為 completed", () => {
    const task = withWorkflow({ plan: { status: "approved" } });
    expect(stepOf(task, "audit").state).toBe("completed");
  });

  it("changedFiles + testResults → work completed；只有 testCommands → in_progress", () => {
    const done = withWorkflow({
      workReview: { changedFiles: ["src/App.tsx"], testResults: "all passed" },
    });
    expect(stepOf(done, "work").state).toBe("completed");
    expect(stepOf(done, "work").detail).toBe("已記錄修改檔案與測試結果");

    const partial = withWorkflow({ workReview: { testCommands: ["pnpm test:run"] } });
    expect(stepOf(partial, "work").state).toBe("in_progress");
  });

  it("codeReviewNotes → review completed", () => {
    const task = withWorkflow({ workReview: { codeReviewNotes: "LGTM" } });
    expect(stepOf(task, "review").state).toBe("completed");
    expect(stepOf(task, "review").detail).toBe("已有 Code Review notes");
  });

  it("commitHash → commit completed；只有 commitMessage → in_progress", () => {
    const done = withWorkflow({ workReview: { commitHash: "abc123" } });
    expect(stepOf(done, "commit").state).toBe("completed");

    const partial = withWorkflow({ workReview: { commitMessage: "feat: x" } });
    expect(stepOf(partial, "commit").state).toBe("in_progress");
    expect(stepOf(partial, "commit").detail).toBe("已有 commit message，尚未記錄 hash");
  });

  it("lessonLearned → compound completed", () => {
    const task = withWorkflow({ compound: { lessonLearned: "學到了" } });
    expect(stepOf(task, "compound").state).toBe("completed");
  });

  it("canStartWork：define + brainstorm(in_progress 可) + plan + audit 完成時為 true", () => {
    const task = withWorkflow({
      brainstorm: { status: "drafted" },
      plan: { status: "approved" },
    });
    const progress = deriveAiWorkflowProgress(task);
    expect(progress.canStartWork).toBe(true);
  });

  it("全部完成 → currentStep=compound、nextAction 顯示已完成", () => {
    const task = withWorkflow({
      brainstorm: { status: "reviewed" },
      plan: { status: "approved" },
      audit: {
        checklist: {
          coreAssumptionsReviewed: true,
          riskReviewed: true,
          scopeReviewed: true,
          acceptanceCriteriaReviewed: true,
          minimalChangeReviewed: true,
        },
      },
      workReview: {
        changedFiles: ["src/App.tsx"],
        testResults: "passed",
        codeReviewNotes: "ok",
        commitHash: "abc123",
      },
      compound: { lessonLearned: "經驗" },
    });
    const progress = deriveAiWorkflowProgress(task);
    expect(progress.steps.every((s) => s.state === "completed")).toBe(true);
    expect(progress.currentStep).toBe("compound");
    expect(progress.nextAction).toBe("AI Workflow 已完成，可視情況封存或匯出紀錄。");
  });

  it("沒有 aiWorkflow 的舊 task 不會 crash", () => {
    expect(() => deriveAiWorkflowProgress(makeTask())).not.toThrow();
  });
});
