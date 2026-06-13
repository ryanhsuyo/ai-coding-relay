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

/**
 * Phase 82：由「已完成」任務建立 follow-up 任務（純函式）。
 * 保留專案 / 任務定義 context，但**清空所有 AI Workflow 結果與狀態**，讓新任務可重新跑 CE Pipeline，
 * 且**不修改來源任務**（只讀 src）。
 *
 * 保留：type / priority / project / projectPath / tags / originalRequirement（末尾附簡短 reference）、
 *       targetFiles / forbiddenFiles / constraints / acceptanceCriteria（任務定義 context）。
 * 清空：aiWorkflow（brainstorm / plan / audit / workReview〔含 commitHash / commitMessage / committedFiles /
 *       committedAt〕/ compound）、summary / claudeResponse / nextActions / specDraft / reviewResult /
 *       completedAt / completionHistory；status 重設 todo、workflowStage 重設 spec、archived=false。
 * dueDate：保守選擇「清空」——完成任務的舊截止日不應沿用到新 follow-up（否則新任務可能一建立就逾期）。
 */
export function buildFollowUpTask(src: Task): Task {
  const now = getNowIso();
  const wr = src.aiWorkflow?.workReview;
  const refLines = ["Previous workflow:", `- source task: ${src.title}`];
  const commitHash = wr?.commitHash?.trim();
  if (commitHash) refLines.push(`- commit: ${commitHash}`);
  const completedAt = wr?.committedAt?.trim() || src.completedAt?.trim();
  if (completedAt) refLines.push(`- completed at: ${completedAt}`);
  const reference = refLines.join("\n");
  const base = src.originalRequirement.trim();
  const originalRequirement = base ? `${base}\n\n${reference}` : reference;

  return {
    id: createId("task"),
    title: `Follow-up: ${src.title}`,
    type: src.type,
    status: "todo",
    priority: src.priority,
    workflowStage: "spec",
    originalRequirement,
    // 保留任務定義 / 專案 context
    targetFiles: [...src.targetFiles],
    forbiddenFiles: [...src.forbiddenFiles],
    constraints: [...src.constraints],
    acceptanceCriteria: [...src.acceptanceCriteria],
    tags: [...src.tags],
    project: src.project,
    projectPath: src.projectPath,
    // 清空 AI Workflow 結果 / 狀態（不帶入舊 completed workflow）
    aiWorkflow: undefined,
    summary: undefined,
    claudeResponse: undefined,
    nextActions: undefined,
    specDraft: undefined,
    reviewResult: "not_reviewed",
    completedAt: undefined,
    completionHistory: undefined,
    dueDate: undefined,
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
