import { describe, it, expect } from "vitest";
import {
  buildAuditPrompt,
  buildBrainstormPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildWorkPrompt,
  formatBulletList,
  getWorkflowPath,
  slugifyForPath,
} from "../core/aiWorkflowPrompts";
import type { AiEngineeringWorkflow, Task } from "../shared/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "登入表單驗證",
    type: "bug",
    status: "todo",
    priority: "medium",
    originalRequirement: "修正登入表單在 email 為空時仍可送出的問題",
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

describe("buildBrainstormPrompt", () => {
  it("包含 ce-brainstorm、唯讀分析、原始需求與輸出格式", () => {
    const out = buildBrainstormPrompt(makeTask());
    expect(out).toContain("/compound-engineering:ce-brainstorm");
    expect(out).toContain("修正登入表單在 email 為空時仍可送出的問題");
    expect(out).toContain("唯讀分析");
    expect(out).toContain("不要修改任何檔案");
    expect(out).toContain("docs/brainstorms/");
    expect(out).toContain("問題定義");
    expect(out).toContain("驗收標準");
  });

  it("有 projectPath 時提示目標專案路徑", () => {
    const out = buildBrainstormPrompt(makeTask({ projectPath: "/Users/me/code/app" }));
    expect(out).toContain("目標專案路徑");
    expect(out).toContain("/Users/me/code/app");
  });

  it("欄位空白也不 throw", () => {
    expect(() =>
      buildBrainstormPrompt(makeTask({ title: "", originalRequirement: "" }))
    ).not.toThrow();
  });
});

describe("buildPlanPrompt", () => {
  it("有 brainstorm.path 時輸出 ce-plan path", () => {
    const out = buildPlanPrompt(
      withWorkflow({ brainstorm: { path: "docs/brainstorms/login.md" } })
    );
    expect(out).toContain("/compound-engineering:ce-plan docs/brainstorms/login.md");
  });

  it("沒有 brainstorm.path 但有 plan.path 時使用 plan.path", () => {
    const out = buildPlanPrompt(withWorkflow({ plan: { path: "docs/plans/login.md" } }));
    expect(out).toContain("/compound-engineering:ce-plan docs/plans/login.md");
  });

  it("沒有任何 path 時不 throw 並提醒先填 path", () => {
    const task = makeTask();
    expect(() => buildPlanPrompt(task)).not.toThrow();
    const out = buildPlanPrompt(task);
    expect(out).toContain("brainstormPath");
    expect(out).toContain("planPath");
  });
});

describe("buildAuditPrompt", () => {
  it("包含核心假設、過度設計、最小修改原則與驗收標準是否可被測試", () => {
    const out = buildAuditPrompt(
      withWorkflow({
        plan: { path: "docs/plans/login.md", summary: "修正驗證" },
        audit: { acceptanceCriteria: ["email 空白時不可送出"] },
      })
    );
    expect(out).toContain("核心假設");
    expect(out).toContain("過度設計");
    expect(out).toContain("最小修改原則");
    expect(out).toContain("驗收標準是否可以被測試");
    expect(out).toContain("docs/plans/login.md");
    expect(out).toContain("email 空白時不可送出");
  });

  it("沒有 plan 資料也不 throw", () => {
    expect(() => buildAuditPrompt(makeTask())).not.toThrow();
  });
});

describe("buildWorkPrompt", () => {
  it("包含實作指示、只修改列出的檔案與不要重構", () => {
    const out = buildWorkPrompt(
      withWorkflow({
        plan: { path: "docs/plans/login.md" },
        audit: {
          checklist: {
            coreAssumptionsReviewed: true,
            riskReviewed: false,
            scopeReviewed: true,
            acceptanceCriteriaReviewed: true,
            minimalChangeReviewed: false,
          },
        },
        workReview: { changedFiles: ["src/Login.tsx"] },
      })
    );
    expect(out).toContain("請依照已審核通過的 plan 實作");
    expect(out).toContain("只修改 plan 中列出的檔案");
    expect(out).toContain("不要額外重構");
    expect(out).toContain("src/Login.tsx");
  });
});

describe("buildReviewPrompt", () => {
  it("包含不要再改檔案、是否符合原 plan、型別風險與測試缺口", () => {
    const out = buildReviewPrompt(
      withWorkflow({
        workReview: {
          changedFiles: ["src/Login.tsx"],
          testCommands: ["pnpm test:run"],
          testResults: "all passed",
          commitHash: "abc123",
        },
      })
    );
    expect(out).toContain("不要再改檔案");
    expect(out).toContain("是否符合原 plan");
    expect(out).toContain("型別風險");
    expect(out).toContain("測試缺口");
    expect(out).toContain("src/Login.tsx");
    expect(out).toContain("pnpm test:run");
  });
});

describe("slugifyForPath", () => {
  it("英文轉小寫並以連字號連接", () => {
    expect(slugifyForPath("Login Form Bug")).toBe("login-form-bug");
  });

  it("中文不 crash 且保留中文字元", () => {
    expect(() => slugifyForPath("登入表單驗證")).not.toThrow();
    expect(slugifyForPath("登入表單驗證")).toContain("登入表單驗證");
  });

  it("空字串不 crash 並回傳 fallback", () => {
    expect(slugifyForPath("")).toBe("task");
    expect(slugifyForPath("   ")).toBe("task");
    expect(slugifyForPath("!!!")).toBe("task");
  });
});

describe("formatBulletList / getWorkflowPath", () => {
  it("formatBulletList 對 undefined / 空陣列回傳空字串", () => {
    expect(formatBulletList()).toBe("");
    expect(formatBulletList([])).toBe("");
  });

  it("formatBulletList 過濾空白並編號", () => {
    expect(formatBulletList(["a", "  ", "b"])).toBe("1. a\n2. b");
  });

  it("getWorkflowPath 優先回傳 brainstorm.path", () => {
    const task = withWorkflow({
      brainstorm: { path: "b.md" },
      plan: { path: "p.md" },
    });
    expect(getWorkflowPath(task)).toBe("b.md");
  });

  it("getWorkflowPath 無 brainstorm.path 時回退 plan.path", () => {
    expect(getWorkflowPath(withWorkflow({ plan: { path: "p.md" } }))).toBe("p.md");
  });

  it("getWorkflowPath 皆無時回傳 undefined", () => {
    expect(getWorkflowPath(makeTask())).toBeUndefined();
  });
});
