import { describe, it, expect, beforeEach } from "vitest";
import {
  loadTaskStore,
  parseAndMigrateTaskStore,
  normalizeAiWorkflow,
} from "./taskStorage";
import { TASK_STORE_KEY } from "./storageKeys";

beforeEach(() => {
  localStorage.clear();
});

/** 寫入最小化的舊 task 形狀，模擬 localStorage 中的原始資料。 */
function seedRawTask(extra: Record<string, unknown> = {}): void {
  const raw = {
    tasks: [
      {
        id: "task_1",
        title: "舊任務",
        type: "bug",
        originalRequirement: "需求",
        targetFiles: [],
        forbiddenFiles: [],
        constraints: [],
        acceptanceCriteria: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...extra,
      },
    ],
    rounds: [],
  };
  localStorage.setItem(TASK_STORE_KEY, JSON.stringify(raw));
}

describe("migrateTask: aiWorkflow", () => {
  it("舊 task 沒有 aiWorkflow 可正常 migrate（為 undefined）", () => {
    seedRawTask();
    const store = loadTaskStore();
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0].aiWorkflow).toBeUndefined();
    // 既有欄位不回歸
    expect(store.tasks[0].workflowStage).toBe("spec");
    expect(store.tasks[0].reviewResult).toBe("not_reviewed");
  });

  it("aiWorkflow 非 object 時不 crash 並轉成 undefined", () => {
    seedRawTask({ aiWorkflow: "not-an-object" });
    expect(() => loadTaskStore()).not.toThrow();
    expect(loadTaskStore().tasks[0].aiWorkflow).toBeUndefined();

    seedRawTask({ aiWorkflow: 42 });
    expect(loadTaskStore().tasks[0].aiWorkflow).toBeUndefined();

    seedRawTask({ aiWorkflow: [] });
    expect(loadTaskStore().tasks[0].aiWorkflow).toBeUndefined();
  });

  it("string[] 欄位只保留 string item", () => {
    seedRawTask({
      aiWorkflow: {
        audit: { coreAssumptions: ["a", 1, null, "b", {}] },
        workReview: { changedFiles: ["src/x.ts", 5] },
      },
    });
    const wf = loadTaskStore().tasks[0].aiWorkflow;
    expect(wf?.audit?.coreAssumptions).toEqual(["a", "b"]);
    expect(wf?.workReview?.changedFiles).toEqual(["src/x.ts"]);
  });

  it("string[] 欄位不是 array 時被丟棄", () => {
    seedRawTask({ aiWorkflow: { audit: { riskNotes: "oops" } } });
    expect(loadTaskStore().tasks[0].aiWorkflow?.audit?.riskNotes).toBeUndefined();
  });

  it("checklist 缺欄位補 false", () => {
    seedRawTask({
      aiWorkflow: { audit: { checklist: { coreAssumptionsReviewed: true } } },
    });
    const checklist = loadTaskStore().tasks[0].aiWorkflow?.audit?.checklist;
    expect(checklist).toEqual({
      coreAssumptionsReviewed: true,
      riskReviewed: false,
      scopeReviewed: false,
      acceptanceCriteriaReviewed: false,
      minimalChangeReviewed: false,
    });
  });

  it("invalid status 被丟棄（轉 undefined）", () => {
    seedRawTask({
      aiWorkflow: {
        brainstorm: { status: "bogus" },
        plan: { status: "also-bogus" },
      },
    });
    const wf = loadTaskStore().tasks[0].aiWorkflow;
    expect(wf?.brainstorm?.status).toBeUndefined();
    expect(wf?.plan?.status).toBeUndefined();
  });

  it("有效 status 被保留", () => {
    seedRawTask({
      aiWorkflow: {
        brainstorm: { status: "drafted" },
        plan: { status: "approved" },
      },
    });
    const wf = loadTaskStore().tasks[0].aiWorkflow;
    expect(wf?.brainstorm?.status).toBe("drafted");
    expect(wf?.plan?.status).toBe("approved");
  });

  it("string 欄位不是 string 時丟棄", () => {
    seedRawTask({ aiWorkflow: { brainstorm: { path: 123, summary: "ok" } } });
    const brainstorm = loadTaskStore().tasks[0].aiWorkflow?.brainstorm;
    expect(brainstorm?.path).toBeUndefined();
    expect(brainstorm?.summary).toBe("ok");
  });
});

describe("normalizeAiWorkflow", () => {
  it("非物件回傳 undefined", () => {
    expect(normalizeAiWorkflow(undefined)).toBeUndefined();
    expect(normalizeAiWorkflow(null)).toBeUndefined();
    expect(normalizeAiWorkflow("x")).toBeUndefined();
    expect(normalizeAiWorkflow([])).toBeUndefined();
  });

  it("空物件回傳 undefined", () => {
    expect(normalizeAiWorkflow({})).toBeUndefined();
  });

  it("完整資料原樣保留", () => {
    const wf = normalizeAiWorkflow({
      compound: { lessonLearned: "學到的事", reusablePrompt: "可重用 prompt" },
    });
    expect(wf?.compound?.lessonLearned).toBe("學到的事");
    expect(wf?.compound?.reusablePrompt).toBe("可重用 prompt");
  });
});

describe("parseAndMigrateTaskStore: export/import 相容", () => {
  it("import 含 aiWorkflow 的資料能正規化", () => {
    const store = parseAndMigrateTaskStore({
      tasks: [
        {
          id: "t1",
          title: "t",
          type: "bug",
          originalRequirement: "",
          targetFiles: [],
          forbiddenFiles: [],
          constraints: [],
          acceptanceCriteria: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
          aiWorkflow: { plan: { status: "planned", path: "p.md" } },
        },
      ],
      rounds: [],
    });
    expect(store.tasks[0].aiWorkflow?.plan?.status).toBe("planned");
    expect(store.tasks[0].aiWorkflow?.plan?.path).toBe("p.md");
  });

  it("import 沒有 aiWorkflow 仍相容", () => {
    const store = parseAndMigrateTaskStore({
      tasks: [
        {
          id: "t1",
          title: "t",
          type: "bug",
          originalRequirement: "",
          targetFiles: [],
          forbiddenFiles: [],
          constraints: [],
          acceptanceCriteria: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      rounds: [],
    });
    expect(store.tasks[0].aiWorkflow).toBeUndefined();
  });
});
