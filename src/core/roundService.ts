import type { TaskRound } from "../shared/types";
import { createId } from "../utils/id";
import { getNowIso } from "../utils/date";

type CreateTaskRoundParams = {
  taskId: string;
  roundIndex: number;
  promptToClaude: string;
};

export function createTaskRound(params: CreateTaskRoundParams): TaskRound {
  const now = getNowIso();
  return {
    id: createId("round"),
    taskId: params.taskId,
    roundIndex: params.roundIndex,
    promptToClaude: params.promptToClaude,
    checklist: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 回傳下一輪的 roundIndex。
 * 找出該 taskId 底下最大的 roundIndex，加 1；沒有任何 round 時從 1 開始。
 */
export function getNextRoundIndex(rounds: TaskRound[], taskId: string): number {
  const taskRounds = rounds.filter((r) => r.taskId === taskId);
  if (taskRounds.length === 0) return 1;
  return Math.max(...taskRounds.map((r) => r.roundIndex)) + 1;
}
