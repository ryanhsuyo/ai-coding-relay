import type { PlanAuditChecklist, Task } from "../shared/types";

/**
 * Phase 69：AI Workflow 階段總覽的推導邏輯。
 * 純函式：根據 task / task.aiWorkflow 現有欄位推導各階段狀態，
 * 不新增資料欄位、不讀寫 localStorage、不保存任何東西。
 */

export type AiWorkflowStepKey =
  | "define"
  | "brainstorm"
  | "plan"
  | "audit"
  | "work"
  | "review"
  | "commit"
  | "compound";

export type AiWorkflowStepState =
  | "not_started"
  | "in_progress"
  | "completed"
  | "blocked";

export type AiWorkflowStep = {
  key: AiWorkflowStepKey;
  label: string;
  state: AiWorkflowStepState;
  detail: string;
};

export type AiWorkflowProgress = {
  steps: AiWorkflowStep[];
  currentStep: AiWorkflowStepKey;
  nextAction: string;
  canStartWork: boolean;
  auditChecklistCompletedCount: number;
  auditChecklistTotalCount: number;
};

const AUDIT_CHECKLIST_KEYS: readonly (keyof PlanAuditChecklist)[] = [
  "coreAssumptionsReviewed",
  "riskReviewed",
  "scopeReviewed",
  "acceptanceCriteriaReviewed",
  "minimalChangeReviewed",
];

const NEXT_ACTION_BY_STEP: Record<AiWorkflowStepKey, string> = {
  define:     "先補上 originalRequirement。",
  brainstorm: "下一步：複製 Brainstorm Prompt，做唯讀需求分析。",
  plan:       "下一步：填入 brainstormPath 後複製 ce-plan Prompt。",
  audit:      "下一步：複製 Audit Prompt，審計核心假設與風險。",
  work:       "下一步：Audit 通過後，複製 Work Prompt 或開始 /ce-work。",
  review:     "下一步：複製 Review Prompt，審查本次修改。",
  commit:     "下一步：記錄 commit message / commit hash。",
  compound:   "下一步：整理 lesson learned / reusable prompt。",
};

const ALL_COMPLETED_ACTION = "AI Workflow 已完成，可視情況封存或匯出紀錄。";
const PLAN_REJECTED_ACTION = "Plan 已退回，請先修正 plan。";

/** trim 後是否為非空字串。 */
function hasText(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** 是否為含至少一個項目的陣列。 */
function hasItems(items?: string[]): boolean {
  return Array.isArray(items) && items.length > 0;
}

export function deriveAiWorkflowProgress(task: Task): AiWorkflowProgress {
  const wf = task.aiWorkflow;
  const brainstorm = wf?.brainstorm;
  const plan = wf?.plan;
  const audit = wf?.audit;
  const workReview = wf?.workReview;
  const compound = wf?.compound;

  // 1. Define
  const defineCompleted = hasText(task.originalRequirement);
  const defineStep: AiWorkflowStep = {
    key: "define",
    label: "Define",
    state: defineCompleted ? "completed" : "not_started",
    detail: defineCompleted ? "已有原始需求" : "尚未填寫原始需求",
  };

  // 2. Brainstorm
  const brainstormCompleted =
    brainstorm?.status === "reviewed" || (hasText(brainstorm?.path) && hasText(brainstorm?.summary));
  const brainstormInProgress =
    brainstorm?.status === "drafted" || hasText(brainstorm?.path) || hasText(brainstorm?.summary);
  const brainstormStep: AiWorkflowStep = {
    key: "brainstorm",
    label: "Brainstorm",
    state: brainstormCompleted ? "completed" : brainstormInProgress ? "in_progress" : "not_started",
    detail:
      brainstorm?.status === "reviewed" ? "Brainstorm 已審查"
      : brainstorm?.status === "drafted" ? "Brainstorm 草稿完成"
      : hasText(brainstorm?.path) ? "已有 brainstorm 文件"
      : "尚未 Brainstorm",
  };

  // 3. Plan（rejected 視為 blocked，優先於其他條件）
  const planRejected = plan?.status === "rejected";
  const planCompleted =
    plan?.status === "approved" || plan?.status === "audited" ||
    (hasText(plan?.path) && hasText(plan?.summary));
  const planInProgress = plan?.status === "planned" || hasText(plan?.path) || hasText(plan?.summary);
  const planStep: AiWorkflowStep = {
    key: "plan",
    label: "Plan",
    state: planRejected ? "blocked" : planCompleted ? "completed" : planInProgress ? "in_progress" : "not_started",
    detail:
      plan?.status === "approved" ? "Plan 已核准"
      : plan?.status === "audited" ? "Plan 已審計"
      : plan?.status === "rejected" ? "Plan 已退回"
      : plan?.status === "planned" ? "Plan 已產生，待審計"
      : hasText(plan?.path) ? "已有 plan 文件"
      : "尚未 ce-plan",
  };

  // 4. Audit
  const checklist = audit?.checklist;
  const auditChecklistTotalCount = AUDIT_CHECKLIST_KEYS.length;
  const auditChecklistCompletedCount = checklist
    ? AUDIT_CHECKLIST_KEYS.filter((key) => checklist[key] === true).length
    : 0;
  const auditCompleted =
    plan?.status === "approved" ||
    auditChecklistCompletedCount === auditChecklistTotalCount ||
    (hasText(audit?.notes) && auditChecklistCompletedCount >= 3);
  const auditInProgress =
    hasText(audit?.notes) ||
    hasItems(audit?.coreAssumptions) ||
    hasItems(audit?.riskNotes) ||
    hasItems(audit?.acceptanceCriteria) ||
    auditChecklistCompletedCount > 0;
  const auditStep: AiWorkflowStep = {
    key: "audit",
    label: "Audit",
    state: auditCompleted ? "completed" : auditInProgress ? "in_progress" : "not_started",
    detail: auditCompleted
      ? "Audit 已完成"
      : auditInProgress
        ? `Audit 進行中：${auditChecklistCompletedCount}/${auditChecklistTotalCount}`
        : "尚未 Audit",
  };

  // 5. Work
  const workCompleted = hasText(workReview?.testResults) && hasItems(workReview?.changedFiles);
  const workInProgress =
    hasItems(workReview?.changedFiles) ||
    hasItems(workReview?.testCommands) ||
    hasText(workReview?.testResults);
  const workStep: AiWorkflowStep = {
    key: "work",
    label: "Work",
    state: workCompleted ? "completed" : workInProgress ? "in_progress" : "not_started",
    detail: workCompleted
      ? "已記錄修改檔案與測試結果"
      : workInProgress
        ? "Work / test 紀錄進行中"
        : "尚未 Work",
  };

  // 6. Review（有 codeReviewNotes 即視為 completed，不再細分）
  const reviewCompleted = hasText(workReview?.codeReviewNotes);
  const reviewStep: AiWorkflowStep = {
    key: "review",
    label: "Review",
    state: reviewCompleted ? "completed" : "not_started",
    detail: reviewCompleted ? "已有 Code Review notes" : "尚未 Review",
  };

  // 7. Commit
  const commitCompleted = hasText(workReview?.commitHash);
  const commitInProgress = !commitCompleted && hasText(workReview?.commitMessage);
  const commitStep: AiWorkflowStep = {
    key: "commit",
    label: "Commit",
    state: commitCompleted ? "completed" : commitInProgress ? "in_progress" : "not_started",
    detail: commitCompleted
      ? "已有 commit hash"
      : commitInProgress
        ? "已有 commit message，尚未記錄 hash"
        : "尚未 Commit checkpoint",
  };

  // 8. Compound
  const compoundCompleted =
    hasText(compound?.lessonLearned) || hasText(compound?.compoundNotes) || hasText(compound?.reusablePrompt);
  const compoundStep: AiWorkflowStep = {
    key: "compound",
    label: "Compound",
    state: compoundCompleted ? "completed" : "not_started",
    detail: compoundCompleted ? "已有經驗沉澱" : "尚未 Compound",
  };

  const steps: AiWorkflowStep[] = [
    defineStep,
    brainstormStep,
    planStep,
    auditStep,
    workStep,
    reviewStep,
    commitStep,
    compoundStep,
  ];

  // currentStep：第一個未完成的階段；全部完成時停在 compound。
  const firstIncomplete = steps.find((step) => step.state !== "completed");
  const currentStep: AiWorkflowStepKey = firstIncomplete?.key ?? "compound";

  const nextAction = planRejected
    ? PLAN_REJECTED_ACTION
    : firstIncomplete
      ? NEXT_ACTION_BY_STEP[firstIncomplete.key]
      : ALL_COMPLETED_ACTION;

  const canStartWork =
    !planRejected &&
    defineStep.state === "completed" &&
    (brainstormStep.state === "completed" || brainstormStep.state === "in_progress") &&
    planStep.state === "completed" &&
    auditStep.state === "completed";

  return {
    steps,
    currentStep,
    nextAction,
    canStartWork,
    auditChecklistCompletedCount,
    auditChecklistTotalCount,
  };
}
