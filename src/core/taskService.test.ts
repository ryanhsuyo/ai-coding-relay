import { describe, it, expect, vi } from "vitest";
import { normalizeTags, normalizeTextList, createTask, updateTask } from "./taskService";
import type { TaskFormValues } from "../shared/types";

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
