import { describe, it, expect } from "vitest";
import { getNextRoundIndex } from "./roundService";
import type { TaskRound } from "../shared/types";

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

describe("getNextRoundIndex", () => {
  it("完全沒有回合時回傳 1", () => {
    expect(getNextRoundIndex([], "task_1")).toBe(1);
  });

  it("指定的 task 沒有任何回合時回傳 1", () => {
    const rounds = [makeRound({ id: "r1", taskId: "task_other", roundIndex: 5 })];
    expect(getNextRoundIndex(rounds, "task_1")).toBe(1);
  });

  it("回傳該 task 最大 roundIndex + 1（不受陣列順序影響）", () => {
    const rounds = [
      makeRound({ id: "r1", taskId: "task_1", roundIndex: 1 }),
      makeRound({ id: "r2", taskId: "task_1", roundIndex: 3 }),
      makeRound({ id: "r3", taskId: "task_1", roundIndex: 2 }),
    ];
    expect(getNextRoundIndex(rounds, "task_1")).toBe(4);
  });

  it("只計算指定 taskId 的回合，忽略其他 task", () => {
    const rounds = [
      makeRound({ id: "r1", taskId: "task_1", roundIndex: 2 }),
      makeRound({ id: "r2", taskId: "task_2", roundIndex: 9 }),
    ];
    expect(getNextRoundIndex(rounds, "task_1")).toBe(3);
  });
});
