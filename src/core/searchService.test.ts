import { describe, it, expect } from "vitest";
import { searchTasks } from "./searchService";
import type { Task, TaskRound } from "../shared/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "標題",
    type: "bug",
    status: "todo",
    priority: "medium",
    originalRequirement: "",
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

function makeRound(overrides: Partial<TaskRound> = {}): TaskRound {
  return {
    id: "round_1",
    taskId: "task_1",
    roundIndex: 1,
    promptToClaude: "",
    checklist: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("searchTasks", () => {
  it("空查詢字串回傳全部任務", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    expect(searchTasks(tasks, [], "")).toBe(tasks);
  });

  it("只有空白的查詢字串也回傳全部任務", () => {
    const tasks = [makeTask({ id: "a" })];
    expect(searchTasks(tasks, [], "   ")).toBe(tasks);
  });

  it("空任務陣列回傳空陣列", () => {
    expect(searchTasks([], [], "anything")).toEqual([]);
  });

  it("比對標題且不分大小寫", () => {
    const tasks = [
      makeTask({ id: "a", title: "Login BUG" }),
      makeTask({ id: "b", title: "其他任務" }),
    ];
    const result = searchTasks(tasks, [], "login bug");
    expect(result.map((t) => t.id)).toEqual(["a"]);
  });

  it("比對 originalRequirement、tags、targetFiles 等欄位", () => {
    const tasks = [
      makeTask({ id: "req", originalRequirement: "修正表單送出問題" }),
      makeTask({ id: "tag", tags: ["frontend", "urgent"] }),
      makeTask({ id: "file", targetFiles: ["src/DmForm.tsx"] }),
    ];
    expect(searchTasks(tasks, [], "送出").map((t) => t.id)).toEqual(["req"]);
    expect(searchTasks(tasks, [], "urgent").map((t) => t.id)).toEqual(["tag"]);
    expect(searchTasks(tasks, [], "dmform").map((t) => t.id)).toEqual(["file"]);
  });

  it("可透過所屬回合的 claudeResponse / gptReview / nextPrompt 比對", () => {
    const tasks = [makeTask({ id: "task_1", title: "無關標題" })];
    const rounds = [
      makeRound({ id: "r1", taskId: "task_1", claudeResponse: "已修正 abc 問題" }),
    ];
    expect(searchTasks(tasks, rounds, "abc").map((t) => t.id)).toEqual(["task_1"]);
  });

  it("其他任務的回合內容不會造成誤判", () => {
    const tasks = [makeTask({ id: "task_1", title: "無關標題" })];
    const rounds = [
      makeRound({ id: "r1", taskId: "task_2", claudeResponse: "xyz 關鍵字" }),
    ];
    expect(searchTasks(tasks, rounds, "xyz")).toEqual([]);
  });

  it("完全沒有命中時回傳空陣列", () => {
    const tasks = [makeTask({ id: "a", title: "標題" })];
    expect(searchTasks(tasks, [], "找不到的字")).toEqual([]);
  });
});
