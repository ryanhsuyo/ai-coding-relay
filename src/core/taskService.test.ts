import { describe, it, expect, vi } from "vitest";
import { normalizeTags, normalizeTextList, createTask, updateTask, buildFollowUpTask } from "./taskService";
import type { AiEngineeringWorkflow, Task, TaskFormValues } from "../shared/types";

function makeFormValues(overrides: Partial<TaskFormValues> = {}): TaskFormValues {
  return {
    title: "範例任務",
    type: "bug",
    originalRequirement: "需求內容",
    targetFilesText: "",
    forbiddenFilesText: "",
    constraintsText: "",
    acceptanceCriteriaText: "",
    project: "",
    projectPath: "",
    tagsText: "",
    ...overrides,
  };
}

describe("normalizeTextList", () => {
  it("正常多行文字轉成陣列", () => {
    expect(normalizeTextList("a.ts\nb.ts\nc.ts")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("空字串回傳空陣列", () => {
    expect(normalizeTextList("")).toEqual([]);
  });

  it("過濾空白行並 trim 每一行", () => {
    expect(normalizeTextList("  a \n\n   \n b  ")).toEqual(["a", "b"]);
  });
});

describe("normalizeTags", () => {
  it("正常逗號分隔轉成陣列", () => {
    expect(normalizeTags("frontend, bug, urgent")).toEqual(["frontend", "bug", "urgent"]);
  });

  it("空字串回傳空陣列", () => {
    expect(normalizeTags("")).toEqual([]);
  });

  it("去除重複 tag 並保留首次出現順序", () => {
    expect(normalizeTags("a, b, a, c, b")).toEqual(["a", "b", "c"]);
  });

  it("過濾空白項並 trim", () => {
    expect(normalizeTags(" a , , b ,  ")).toEqual(["a", "b"]);
  });
});

describe("createTask", () => {
  it("正常資料：trim 標題、正規化清單、套用預設值", () => {
    const task = createTask(
      makeFormValues({
        title: "  我的任務  ",
        targetFilesText: "a.ts\nb.ts",
        constraintsText: "不要用 any",
        tagsText: "x, x, y",
        project: "  proj  ",
        projectPath: "  /Users/ryan/proj  ",
      })
    );
    expect(task.title).toBe("我的任務");
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("medium");
    expect(task.targetFiles).toEqual(["a.ts", "b.ts"]);
    expect(task.constraints).toEqual(["不要用 any"]);
    expect(task.tags).toEqual(["x", "y"]);
    expect(task.project).toBe("proj");
    expect(task.projectPath).toBe("/Users/ryan/proj");
    expect(task.reviewResult).toBe("not_reviewed");
    expect(task.archived).toBe(false);
    expect(task.id).toMatch(/^task_/);
    expect(task.createdAt).toBe(task.updatedAt);
  });

  it("空資料：清單為空陣列、空白 project / projectPath 轉成 undefined", () => {
    const task = createTask(makeFormValues());
    expect(task.targetFiles).toEqual([]);
    expect(task.forbiddenFiles).toEqual([]);
    expect(task.constraints).toEqual([]);
    expect(task.acceptanceCriteria).toEqual([]);
    expect(task.tags).toEqual([]);
    expect(task.project).toBeUndefined();
    expect(task.projectPath).toBeUndefined();
  });

  it("tagsText 為 undefined 時 tags 為空陣列", () => {
    const task = createTask(makeFormValues({ tagsText: undefined }));
    expect(task.tags).toEqual([]);
  });
});

describe("updateTask", () => {
  it("只更新有傳入的欄位，其餘保持不變", () => {
    const task = createTask(makeFormValues({ title: "原標題", originalRequirement: "原需求" }));
    const updated = updateTask(task, { title: "新標題" });
    expect(updated.title).toBe("新標題");
    expect(updated.originalRequirement).toBe("原需求");
    expect(updated.id).toBe(task.id);
  });

  it("空 patch 不改變任何內容欄位", () => {
    const task = createTask(makeFormValues({ title: "標題", tagsText: "a, b" }));
    const updated = updateTask(task, {});
    expect(updated.title).toBe(task.title);
    expect(updated.tags).toEqual(task.tags);
    expect(updated.originalRequirement).toBe(task.originalRequirement);
  });

  it("更新 tags 時會去除重複", () => {
    const task = createTask(makeFormValues());
    const updated = updateTask(task, { tagsText: "a, a, b" });
    expect(updated.tags).toEqual(["a", "b"]);
  });

  it("更新 project 為空白時轉成 undefined", () => {
    const task = createTask(makeFormValues({ project: "proj" }));
    const updated = updateTask(task, { project: "   " });
    expect(updated.project).toBeUndefined();
  });

  it("永遠刷新 updatedAt，但保留 createdAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const task = createTask(makeFormValues());
    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const updated = updateTask(task, { title: "新標題" });
    vi.useRealTimers();
    expect(updated.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("buildFollowUpTask", () => {
  const COMPLETED_WF: AiEngineeringWorkflow = {
    brainstorm: { summary: "b", status: "reviewed" },
    plan: { summary: "p", status: "approved" },
    audit: { notes: "a", checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: true, acceptanceCriteriaReviewed: true, minimalChangeReviewed: true } },
    workReview: {
      changedFiles: ["docs/x.md"],
      testResults: "本機驗證：通過",
      codeReviewNotes: "Review result: passed",
      commitHash: "abc1234",
      commitMessage: "docs: done",
      committedAt: "2026-06-13T00:00:00.000Z",
      committedFiles: ["docs/x.md"],
    },
    compound: { lessonLearned: "經驗" },
  };

  function makeCompletedTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-src",
      title: "登入頁需求",
      type: "ui",
      status: "done",
      priority: "high",
      workflowStage: "done",
      originalRequirement: "原始需求內容",
      specDraft: "舊 spec draft",
      targetFiles: ["src/Login.tsx"],
      forbiddenFiles: ["package.json"],
      constraints: ["最小修改"],
      acceptanceCriteria: ["可登入"],
      tags: ["auth", "ui"],
      project: "harness",
      projectPath: "/Users/ryan/Desktop/code/harness",
      summary: "完成摘要",
      claudeResponse: "claude 回覆",
      reviewResult: "passed",
      nextActions: "下一步",
      dueDate: "2026-06-01",
      completedAt: "2026-06-13T00:00:00.000Z",
      completionHistory: [],
      aiWorkflow: COMPLETED_WF,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
      ...overrides,
    };
  }

  it("保留 project / projectPath / tags / priority / type 與任務定義 context", () => {
    const f = buildFollowUpTask(makeCompletedTask());
    expect(f.project).toBe("harness");
    expect(f.projectPath).toBe("/Users/ryan/Desktop/code/harness");
    expect(f.tags).toEqual(["auth", "ui"]);
    expect(f.priority).toBe("high");
    expect(f.type).toBe("ui");
    expect(f.targetFiles).toEqual(["src/Login.tsx"]);
    expect(f.forbiddenFiles).toEqual(["package.json"]);
    expect(f.constraints).toEqual(["最小修改"]);
    expect(f.acceptanceCriteria).toEqual(["可登入"]);
  });

  it("title 帶 follow-up 標記，originalRequirement 保留並附簡短 reference", () => {
    const f = buildFollowUpTask(makeCompletedTask());
    expect(f.title).toBe("Follow-up: 登入頁需求");
    expect(f.originalRequirement).toContain("原始需求內容");
    expect(f.originalRequirement).toContain("Previous workflow:");
    expect(f.originalRequirement).toContain("- source task: 登入頁需求");
    expect(f.originalRequirement).toContain("- commit: abc1234");
    expect(f.originalRequirement).toContain("- completed at: 2026-06-13T00:00:00.000Z");
    // 不複製整段 review notes / stdout。
    expect(f.originalRequirement).not.toContain("Review result: passed");
  });

  it("清空所有 AI Workflow 結果與狀態（不帶入舊 completed workflow）", () => {
    const f = buildFollowUpTask(makeCompletedTask());
    expect(f.aiWorkflow).toBeUndefined();
    expect(f.summary).toBeUndefined();
    expect(f.claudeResponse).toBeUndefined();
    expect(f.nextActions).toBeUndefined();
    expect(f.specDraft).toBeUndefined();
    expect(f.completedAt).toBeUndefined();
    expect(f.completionHistory).toBeUndefined();
    expect(f.reviewResult).toBe("not_reviewed");
    expect(f.status).toBe("todo");
    expect(f.workflowStage).toBe("spec");
    expect(f.archived).toBe(false);
  });

  it("dueDate 保守清空（不沿用舊截止日）", () => {
    const f = buildFollowUpTask(makeCompletedTask());
    expect(f.dueDate).toBeUndefined();
  });

  it("新任務有獨立 id（不等於來源），且不修改來源任務", () => {
    const src = makeCompletedTask();
    const srcSnapshot = JSON.parse(JSON.stringify(src));
    const f = buildFollowUpTask(src);
    expect(f.id).not.toBe(src.id);
    expect(f.id.length).toBeGreaterThan(0);
    // 來源任務完全不變（仍為 completed、aiWorkflow 仍在）。
    expect(src).toEqual(srcSnapshot);
    expect(src.aiWorkflow?.workReview?.commitHash).toBe("abc1234");
    expect(src.status).toBe("done");
  });

  it("沒有 commitHash / completedAt 時 reference 只含 source task", () => {
    const f = buildFollowUpTask(makeCompletedTask({ aiWorkflow: undefined, completedAt: undefined }));
    expect(f.originalRequirement).toContain("- source task: 登入頁需求");
    expect(f.originalRequirement).not.toContain("- commit:");
    expect(f.originalRequirement).not.toContain("- completed at:");
  });
});
