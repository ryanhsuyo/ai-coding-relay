import type { Task, TaskFormValues } from "../shared/types";
import { createId } from "../utils/id";
import { getNowIso } from "../utils/date";

/** 將多行文字（每行一個項目）轉成字串陣列，過濾空行。 */
export function normalizeTextList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 將逗號分隔文字轉成 tag 陣列：trim、過濾空字串、去除重複（保留順序）。 */
export function normalizeTags(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim();
    if (tag.length === 0) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function createTask(values: TaskFormValues): Task {
  const now = getNowIso();
  return {
    id: createId("task"),
    title: values.title.trim(),
    type: values.type,
    status: "todo",
    priority: "medium",
    workflowStage: values.workflowStage ?? "spec",
    originalRequirement: values.originalRequirement.trim(),
    targetFiles: normalizeTextList(values.targetFilesText),
    forbiddenFiles: normalizeTextList(values.forbiddenFilesText),
    constraints: normalizeTextList(values.constraintsText),
    acceptanceCriteria: normalizeTextList(values.acceptanceCriteriaText),
    tags: normalizeTags(values.tagsText ?? ""),
    reviewResult: values.reviewResult ?? "not_reviewed",
    project: values.project?.trim() || undefined,
    projectPath: values.projectPath?.trim() || undefined,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** 將 Task 轉回表單初始值，用於編輯模式預填。 */
export function taskToFormValues(task: Task): TaskFormValues {
  return {
    title: task.title,
    type: task.type,
    originalRequirement: task.originalRequirement,
    targetFilesText: task.targetFiles.join("\n"),
    forbiddenFilesText: task.forbiddenFiles.join("\n"),
    constraintsText: task.constraints.join("\n"),
    acceptanceCriteriaText: task.acceptanceCriteria.join("\n"),
    tagsText: task.tags.join(", "),
    reviewResult: task.reviewResult ?? "not_reviewed",
    workflowStage: task.workflowStage ?? "spec",
    project: task.project ?? "",
    projectPath: task.projectPath ?? "",
  };
}

/**
 * 以 Partial<TaskFormValues> 更新一個任務，回傳新物件。
 * 只更新有傳入的欄位，updatedAt 永遠刷新。
 */
export function updateTask(task: Task, values: Partial<TaskFormValues>): Task {
  return {
    ...task,
    ...(values.title !== undefined && { title: values.title.trim() }),
    ...(values.type !== undefined && { type: values.type }),
    ...(values.originalRequirement !== undefined && {
      originalRequirement: values.originalRequirement.trim(),
    }),
    ...(values.targetFilesText !== undefined && {
      targetFiles: normalizeTextList(values.targetFilesText),
    }),
    ...(values.forbiddenFilesText !== undefined && {
      forbiddenFiles: normalizeTextList(values.forbiddenFilesText),
    }),
    ...(values.constraintsText !== undefined && {
      constraints: normalizeTextList(values.constraintsText),
    }),
    ...(values.acceptanceCriteriaText !== undefined && {
      acceptanceCriteria: normalizeTextList(values.acceptanceCriteriaText),
    }),
    ...(values.tagsText !== undefined && {
      tags: normalizeTags(values.tagsText),
    }),
    ...(values.reviewResult !== undefined && {
      reviewResult: values.reviewResult,
    }),
    ...(values.workflowStage !== undefined && {
      workflowStage: values.workflowStage,
    }),
    ...(values.project !== undefined && {
      project: values.project.trim() || undefined,
    }),
    ...(values.projectPath !== undefined && {
      projectPath: values.projectPath.trim() || undefined,
    }),
    updatedAt: getNowIso(),
  };
}
