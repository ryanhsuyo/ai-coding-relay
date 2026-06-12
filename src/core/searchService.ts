import type { Task, TaskRound } from "../shared/types";

function includes(text: string | undefined, query: string): boolean {
  return !!text && text.toLowerCase().includes(query);
}

export function searchTasks(tasks: Task[], rounds: TaskRound[], query: string): Task[] {
  const q = query.toLowerCase().trim();
  if (!q) return tasks;

  return tasks.filter((task) => {
    if (includes(task.title, q)) return true;
    if (includes(task.originalRequirement, q)) return true;
    if (includes(task.specDraft, q)) return true;
    if (includes(task.summary, q)) return true;
    if (includes(task.project, q)) return true;
    if (includes(task.claudeResponse, q)) return true;
    if (includes(task.nextActions, q)) return true;
    if (task.targetFiles.some((f) => includes(f, q))) return true;
    if (task.forbiddenFiles.some((f) => includes(f, q))) return true;
    if (task.constraints.some((c) => includes(c, q))) return true;
    if (task.acceptanceCriteria.some((a) => includes(a, q))) return true;
    if (task.tags.some((t) => includes(t, q))) return true;

    return rounds
      .filter((r) => r.taskId === task.id)
      .some(
        (r) =>
          includes(r.claudeResponse, q) ||
          includes(r.gptReview, q) ||
          includes(r.nextPrompt, q)
      );
  });
}
