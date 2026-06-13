import type {
  AiEngineeringWorkflow,
  CeWorkSuccess,
  PlanAuditChecklist,
} from "../shared/types";
import { parseGitStatusShort } from "./ceWork";

/**
 * Phase 78：CE Pipeline 的純函式層（狀態定義、確認摘要、無關變更偵測）。
 * Orchestration 在前端 AiWorkflowSection 的 CePipelineRunner 內以既有 endpoint 串接；
 * 本檔不依賴 React、不呼叫 runner、不 throw。
 * 安全規則：Work 前與 Commit 前必須人工確認；needs_fix / verification failed / cancel 後不自動續跑。
 */

export type CePipelineStatus =
  | "idle"
  | "running_readonly"
  | "waiting_work_confirmation"
  | "running_work"
  | "running_review"
  | "waiting_commit_confirmation"
  | "committing"
  | "generating_compound"
  | "saving_workflow"
  | "exporting_artifacts"
  | "completed"
  | "failed"
  | "needs_fix"
  | "cancelled";

export const CE_PIPELINE_STATUS_TEXT: Record<CePipelineStatus, string> = {
  idle: "",
  running_readonly: "正在執行 CE Readonly Workflow（Brainstorm / Plan / Audit）…",
  waiting_work_confirmation: "Readonly 完成，等待確認後才會開始 Work（會修改目標專案檔案）。",
  running_work: "正在執行 CE Work（實作 + verification）…",
  running_review: "Work 完成，正在自動執行 CE Review（唯讀）…",
  waiting_commit_confirmation: "Review 通過，等待確認後才會執行 git commit。",
  committing: "正在執行 commit checkpoint（verification → git add → git commit）…",
  generating_compound: "正在產生 Compound Notes…",
  saving_workflow: "正在保存 AI Workflow…",
  exporting_artifacts: "正在匯出 CE Artifacts…",
  completed: "CE Pipeline 已完成。",
  failed: "CE Pipeline 已停止（失敗）。",
  needs_fix: "Review 需要修正（needs_fix），Pipeline 已停止；請使用 CE Fix Work 後再重跑。",
  cancelled: "CE Pipeline 已取消，不會再自動執行後續步驟。",
};

/** 自動執行中的狀態（顯示 spinner / 禁止重複啟動）。 */
const AUTO_STEP_STATUSES: readonly CePipelineStatus[] = [
  "running_readonly",
  "running_work",
  "running_review",
  "committing",
  "generating_compound",
  "saving_workflow",
  "exporting_artifacts",
];

/** 等待人工確認的狀態（顯示確認按鈕）。 */
const WAITING_STATUSES: readonly CePipelineStatus[] = [
  "waiting_work_confirmation",
  "waiting_commit_confirmation",
];

export function isPipelineAutoStep(status: CePipelineStatus): boolean {
  return AUTO_STEP_STATUSES.includes(status);
}

export function isPipelineWaiting(status: CePipelineStatus): boolean {
  return WAITING_STATUSES.includes(status);
}

/** Pipeline 是否進行中（自動步驟或等待確認）；此時不可重複啟動。 */
export function isPipelineActive(status: CePipelineStatus): boolean {
  return isPipelineAutoStep(status) || isPipelineWaiting(status);
}

/**
 * Review passed 標記（與 src/core/ceCompletion.ts 的 PASSED_MARKER 一致）。
 * 由 buildCeReviewNotes 產生的 codeReviewNotes 開頭格式為 "Review result: <result>"。
 */
const REVIEW_PASSED_MARKER = "Review result: passed";

/**
 * Phase 79B：判斷整個 CE Workflow 是否已完成（避免已完成 workflow 再跑 Pipeline 跑到 nothing_to_commit）。
 * 完成定義（三者皆需成立）：
 *   1. Commit 已有 commitHash（已 commit 或已記錄 smoke checkpoint）。
 *   2. CE Review 為 passed（codeReviewNotes 含 "Review result: passed"）。
 *   3. Compound 已有任一內容（lessonLearned / compoundNotes / reusablePrompt）。
 */
export function isCeWorkflowCompleted(wf: AiEngineeringWorkflow | undefined): boolean {
  const wr = wf?.workReview;
  const hasCommit = (wr?.commitHash ?? "").trim().length > 0;
  const reviewPassed = (wr?.codeReviewNotes ?? "").includes(REVIEW_PASSED_MARKER);
  const compound = wf?.compound;
  const hasCompound =
    (compound?.lessonLearned ?? "").trim().length > 0 ||
    (compound?.compoundNotes ?? "").trim().length > 0 ||
    (compound?.reusablePrompt ?? "").trim().length > 0;
  return hasCommit && reviewPassed && hasCompound;
}

const CHECKLIST_KEYS: readonly (keyof PlanAuditChecklist)[] = [
  "coreAssumptionsReviewed",
  "riskReviewed",
  "scopeReviewed",
  "acceptanceCriteriaReviewed",
  "minimalChangeReviewed",
];

export type CeWorkConfirmationSummary = {
  planSummary: string;
  planStatus: string;
  auditNotes: string;
  checklistDone: number;
  checklistTotal: number;
  acceptanceCriteria: string[];
};

/**
 * 「即將開始 Work」確認區的摘要：plan 摘要 / 狀態、audit notes、checklist 完成數、驗收標準。
 */
export function buildWorkConfirmationSummary(wf: AiEngineeringWorkflow | undefined): CeWorkConfirmationSummary {
  const checklist = wf?.audit?.checklist;
  const checklistDone = checklist ? CHECKLIST_KEYS.filter((key) => checklist[key] === true).length : 0;
  return {
    planSummary: wf?.plan?.summary?.trim() ?? "",
    planStatus: wf?.plan?.status ?? "",
    auditNotes: wf?.audit?.notes?.trim() ?? "",
    checklistDone,
    checklistTotal: CHECKLIST_KEYS.length,
    acceptanceCriteria: (wf?.audit?.acceptanceCriteria ?? []).filter((item) => item.trim().length > 0),
  };
}

export type CeCommitConfirmationSummary = {
  changedFiles: string[];
  diffStat: string;
  verificationSummary: string;
};

/**
 * 「確認並 Commit」確認區的摘要：changed files、diff stat 與 verification 摘要（由 Work 結果推導）。
 */
export function buildCommitConfirmationSummary(work: CeWorkSuccess): CeCommitConfirmationSummary {
  const commands = work.verification.commands;
  const head = work.verification.ok
    ? `verification 通過（${commands.length} 項指令）`
    : "verification 未通過";
  const lines = commands.map((c) => `- ${c.name || c.command || "(指令)"}: ${c.ok ? "通過" : "未通過"}`);
  return {
    changedFiles: work.work.changedFiles.length > 0 ? work.work.changedFiles : parseGitStatusShort(work.git.statusShort),
    diffStat: work.git.diffStat.trim(),
    verificationSummary: [head, ...lines].join("\n"),
  };
}

/**
 * 從 Work 結果的 git status 找出「不在本次 changedFiles 內」的既有變更（pipeline 顯示警告用）。
 * changedFiles 為空時無從比對，回空陣列（不誤報）。
 */
export function findUnrelatedChanges(statusShort: string, changedFiles: string[]): string[] {
  if (changedFiles.length === 0) return [];
  const expected = new Set(changedFiles);
  return parseGitStatusShort(statusShort).filter((file) => !expected.has(file));
}
