import type {
  AiEngineeringWorkflow,
  AiWorkflowWorkReview,
  CeReviewDetail,
  CeReviewResult,
  CeReviewStoppedReason,
  CeReviewSuccess,
  CeReviewVerdict,
  Task,
} from "../shared/types";

/**
 * Phase 72：CE Review gate 判斷、runner 回傳解析（type guard）、codeReviewNotes 格式化與合併（純函式）。
 * 不依賴 React、不讀寫 localStorage、不呼叫 runner、不 throw。runner 回傳不被信任。
 */

const STOPPED_REASONS: readonly CeReviewStoppedReason[] = [
  "review_gate_failed",
  "review_blocked",
  "ai_failed",
  "invalid_json",
  "runner_error",
  "project_path_invalid",
];

/** 是否為非 null、非陣列的物件。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取字串，否則回傳預設值。 */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** 只保留字串陣列中的字串項目。 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** trim 後是否為非空字串。 */
function hasText(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** 是否為含至少一個非空字串的陣列。 */
function hasItems(items?: string[]): boolean {
  return Array.isArray(items) && items.some((i) => hasText(i));
}

export type CeReviewGateResult = {
  canReview: boolean;
  reason: string;
};

/**
 * CE Review gate（與 scripts/local-runner.mjs 的 evaluateCeReviewGateJs 一致）。
 * 必須已有 Work 結果才可 review：workReview.changedFiles 有值，或 workReview.testResults 有非空字串。
 */
export function evaluateCeReviewGate(task: Task): CeReviewGateResult {
  const wr = task.aiWorkflow?.workReview;
  if (!wr) return { canReview: false, reason: "尚未有 Work 結果，不建議進行 Review。" };
  if (hasItems(wr.changedFiles) || hasText(wr.testResults)) {
    return { canReview: true, reason: "" };
  }
  return { canReview: false, reason: "尚未有 Work 結果，不建議進行 Review。" };
}

/** stoppedReason 白名單檢查；未知值一律視為 runner_error。 */
function normalizeStoppedReason(value: unknown): CeReviewStoppedReason {
  return STOPPED_REASONS.includes(value as CeReviewStoppedReason)
    ? (value as CeReviewStoppedReason)
    : "runner_error";
}

/** result 只允許 passed / needs_fix；其餘一律視為 needs_fix（保守）。 */
function normalizeVerdict(value: unknown): CeReviewVerdict {
  return value === "passed" ? "passed" : "needs_fix";
}

/**
 * 安全解析 /ce-review 的回傳成 CeReviewResult。
 * - 非物件 / ok 不是 true → 失敗，保留 stoppedReason / message / 診斷片段。
 * - 成功時欄位皆經型別檢查，缺欄位補預設，永不 throw。
 */
export function parseCeReviewResult(raw: unknown): CeReviewResult {
  if (!isRecord(raw)) {
    return { ok: false, stoppedReason: "runner_error", message: "runner 回傳格式無效（非物件）" };
  }

  if (raw.ok !== true) {
    const failure: CeReviewResult = {
      ok: false,
      stoppedReason: normalizeStoppedReason(raw.stoppedReason),
      message: asString(raw.message) || "CE Review 執行失敗",
    };
    if (typeof raw.stdoutPreview === "string") failure.stdoutPreview = raw.stdoutPreview;
    if (typeof raw.stdoutTail === "string") failure.stdoutTail = raw.stdoutTail;
    if (typeof raw.stderrPreview === "string") failure.stderrPreview = raw.stderrPreview;
    if (typeof raw.stderrTail === "string") failure.stderrTail = raw.stderrTail;
    return failure;
  }

  const review = isRecord(raw.review) ? raw.review : {};
  const git = isRecord(raw.git) ? raw.git : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};

  return {
    ok: true,
    review: {
      result: normalizeVerdict(review.result),
      notes: asString(review.notes),
      issues: asStringArray(review.issues),
      testGaps: asStringArray(review.testGaps),
      riskNotes: asStringArray(review.riskNotes),
      recommendedFixes: asStringArray(review.recommendedFixes),
      recommendedNextAction: asString(review.recommendedNextAction),
    },
    git: {
      statusShort: asString(git.statusShort),
      diffStat: asString(git.diffStat),
    },
    ai: {
      command: asString(ai.command),
      exitCode: typeof ai.exitCode === "number" ? ai.exitCode : null,
    },
  };
}

/** 將清單項目以 `- ` 列出（過濾空白）；空時回傳空字串。 */
function bulletSection(title: string, items: string[]): string {
  const lines = items.filter((i) => hasText(i)).map((i) => `- ${i.trim()}`);
  return lines.length > 0 ? `${title}:\n${lines.join("\n")}` : "";
}

/**
 * 由 CE Review 結果組出 codeReviewNotes 文字。
 * 一律包含 `Review result: <result>`；其餘段落（Notes / Issues / Test gaps / Risks /
 * Recommended fixes / Recommended next action）僅在有內容時列出。
 */
export function buildCeReviewNotes(review: CeReviewDetail): string {
  const sections: string[] = [`Review result: ${review.result}`];
  if (hasText(review.notes)) sections.push(`Notes:\n${review.notes.trim()}`);
  const issues = bulletSection("Issues", review.issues);
  if (issues) sections.push(issues);
  const testGaps = bulletSection("Test gaps", review.testGaps);
  if (testGaps) sections.push(testGaps);
  const risks = bulletSection("Risks", review.riskNotes);
  if (risks) sections.push(risks);
  const fixes = bulletSection("Recommended fixes", review.recommendedFixes);
  if (fixes) sections.push(fixes);
  if (hasText(review.recommendedNextAction)) {
    sections.push(`Recommended next action:\n${review.recommendedNextAction.trim()}`);
  }
  return sections.join("\n\n");
}

/**
 * 把 CE Review 成功結果合併進目前 task 的 aiWorkflow（Phase 72）。
 * 合併規則：
 * - 只更新 workReview.codeReviewNotes（由 buildCeReviewNotes 產生）。
 * - 保留 workReview 的 changedFiles / testCommands / testResults / commitHash / commitMessage。
 * - 保留 brainstorm / plan / audit / compound 不動。
 * 不動 task 層的 summary / completionHistory / status / reviewResult / workflowStage（由呼叫端負責不動）。
 */
export function mergeCeReviewResult(
  current: AiEngineeringWorkflow | undefined,
  result: CeReviewSuccess
): AiEngineeringWorkflow {
  const existingWR = current?.workReview;
  const workReview: AiWorkflowWorkReview = {
    ...existingWR,
    codeReviewNotes: buildCeReviewNotes(result.review),
  };

  const merged: AiEngineeringWorkflow = { workReview };
  if (current?.brainstorm !== undefined) merged.brainstorm = current.brainstorm;
  if (current?.plan !== undefined) merged.plan = current.plan;
  if (current?.audit !== undefined) merged.audit = current.audit;
  if (current?.compound !== undefined) merged.compound = current.compound;
  return merged;
}
