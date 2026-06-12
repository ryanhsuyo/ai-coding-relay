import type {
  AiEngineeringWorkflow,
  AiWorkflowWorkReview,
  CeWorkResult,
  CeWorkStoppedReason,
  CeWorkSuccess,
  CeWorkVerification,
  CeWorkVerificationCommand,
  PlanAuditChecklist,
  Task,
} from "../shared/types";

/**
 * Phase 71：CE Work gate 判斷、runner 回傳解析（type guard）與合併（純函式）。
 * 不依賴 React、不讀寫 localStorage、不呼叫 runner、不 throw。
 * runner 回傳不被信任：一律經 type guard 與白名單檢查。
 */

/** Phase 77C：rawOutputPreview 前端再保險的最大字數（runner 端已截，但不信任 runner）。 */
const CE_WORK_RAW_PREVIEW_MAX = 2000;

const STOPPED_REASONS: readonly CeWorkStoppedReason[] = [
  "work_gate_failed",
  "ai_failed",
  "invalid_json",
  "verification_failed",
  "runner_error",
  "project_path_invalid",
  "work_blocked",
];

const CHECKLIST_KEYS: readonly (keyof PlanAuditChecklist)[] = [
  "coreAssumptionsReviewed",
  "riskReviewed",
  "scopeReviewed",
  "acceptanceCriteriaReviewed",
  "minimalChangeReviewed",
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

export type CeWorkGateResult = {
  canWork: boolean;
  reason: string;
};

/**
 * CE Work gate（與 scripts/local-runner.mjs 的 evaluateCeWorkGateJs 一致）。
 * 策略：
 * - plan.status === "rejected" → 不可。
 * - plan.status 必須為 "approved" 或 "audited"，否則不可。
 * - audit.checklist 必須存在（缺 audit → 不可）。
 * - plan.status === "approved" → 可（Phase 70 approved 即視為通過審核）。
 * - plan.status === "audited" → 需 checklist 五項全 true 才可。
 */
export function evaluateCeWorkGate(task: Task): CeWorkGateResult {
  const plan = task.aiWorkflow?.plan;
  const audit = task.aiWorkflow?.audit;
  const planStatus = plan?.status;

  if (planStatus === "rejected") {
    return { canWork: false, reason: "Plan 已退回（rejected），不可進入 Work。" };
  }
  if (planStatus !== "approved" && planStatus !== "audited") {
    return { canWork: false, reason: "Plan 尚未 approved / audited，不建議進入 Work。" };
  }
  const checklist = audit?.checklist;
  if (!checklist) {
    return { canWork: false, reason: "Audit 尚未完成（缺 checklist），不建議進入 Work。" };
  }
  if (planStatus === "approved") {
    return { canWork: true, reason: "" };
  }
  const allPassed = CHECKLIST_KEYS.every((key) => checklist[key] === true);
  if (allPassed) {
    return { canWork: true, reason: "" };
  }
  return { canWork: false, reason: "Audit checklist 尚未全部通過，不建議進入 Work。" };
}

/** stoppedReason 白名單檢查；未知值一律視為 runner_error。 */
function normalizeStoppedReason(value: unknown): CeWorkStoppedReason {
  return STOPPED_REASONS.includes(value as CeWorkStoppedReason)
    ? (value as CeWorkStoppedReason)
    : "runner_error";
}

/** 解析單一 verification command（只取 name/command/ok）。 */
function parseVerificationCommand(raw: unknown): CeWorkVerificationCommand {
  const obj = isRecord(raw) ? raw : {};
  return {
    name: asString(obj.name),
    command: asString(obj.command),
    ok: obj.ok === true,
  };
}

function parseVerification(raw: unknown): CeWorkVerification {
  const obj = isRecord(raw) ? raw : {};
  return {
    ok: obj.ok === true,
    commands: Array.isArray(obj.commands) ? obj.commands.map(parseVerificationCommand) : [],
  };
}

/**
 * 安全解析 /ce-work 的回傳成 CeWorkResult。
 * - 非物件 / ok 不是 true → 失敗，保留 stoppedReason / message / 診斷片段。
 * - 成功時欄位皆經型別檢查，缺欄位補預設，永不 throw。
 */
export function parseCeWorkResult(raw: unknown): CeWorkResult {
  if (!isRecord(raw)) {
    return { ok: false, stoppedReason: "runner_error", message: "runner 回傳格式無效（非物件）" };
  }

  if (raw.ok !== true) {
    const failure: CeWorkResult = {
      ok: false,
      stoppedReason: normalizeStoppedReason(raw.stoppedReason),
      message: asString(raw.message) || "CE Work 執行失敗",
    };
    if (typeof raw.stdoutPreview === "string") failure.stdoutPreview = raw.stdoutPreview;
    if (typeof raw.stdoutTail === "string") failure.stdoutTail = raw.stdoutTail;
    if (typeof raw.stderrPreview === "string") failure.stderrPreview = raw.stderrPreview;
    if (typeof raw.stderrTail === "string") failure.stderrTail = raw.stderrTail;
    // Phase 77C：verification_failed 的安全 debug 摘要（rawOutputPreview 再保險截 2000 字、parseAttempts 只收字串）。
    if (typeof raw.rawOutputPreview === "string") {
      failure.rawOutputPreview = raw.rawOutputPreview.slice(0, CE_WORK_RAW_PREVIEW_MAX);
    }
    if (Array.isArray(raw.parseAttempts)) {
      failure.parseAttempts = raw.parseAttempts.filter(
        (v): v is string => typeof v === "string"
      );
    }
    // Phase 77E：verification 完整 stdout 的字數；只收有限數字，非 number 一律丟棄。
    if (typeof raw.stdoutLength === "number" && Number.isFinite(raw.stdoutLength)) {
      failure.stdoutLength = raw.stdoutLength;
    }
    return failure;
  }

  const work = isRecord(raw.work) ? raw.work : {};
  const git = isRecord(raw.git) ? raw.git : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};

  return {
    ok: true,
    work: {
      changedFiles: asStringArray(work.changedFiles),
      testCommands: asStringArray(work.testCommands),
      testResults: asString(work.testResults),
      implementationSummary: asString(work.implementationSummary),
      notes: asString(work.notes),
      recommendedNextAction: asString(work.recommendedNextAction),
    },
    verification: parseVerification(raw.verification),
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

/** 從 `git status --short` 的 stdout 推導被修改的檔案路徑。 */
export function parseGitStatusShort(statusShort: string): string[] {
  const files: string[] = [];
  for (const line of statusShort.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^[ MADRCU?!]{1,2}\s+(.+)$/);
    if (m) {
      // rename "old -> new"：取箭頭後的新路徑。
      const path = m[1].includes(" -> ") ? m[1].split(" -> ").pop()! : m[1];
      files.push(path.trim());
    }
  }
  return [...new Set(files)];
}

/** 由 CE Work 成功結果組出 workReview.testResults 文字（實作摘要 + 驗證結果 + git diff stat）。 */
function buildWorkTestResults(result: CeWorkSuccess): string {
  const parts: string[] = [];
  if (hasText(result.work.testResults)) parts.push(result.work.testResults.trim());
  if (hasText(result.work.implementationSummary)) parts.push(`實作摘要：\n${result.work.implementationSummary.trim()}`);

  const verLine = result.verification.ok ? "本機驗證：通過" : "本機驗證：未通過";
  const cmdLines = result.verification.commands.map((c) => {
    const name = c.name || c.command || "(指令)";
    return `- ${name}: ${c.ok ? "通過" : "未通過"}`;
  });
  parts.push([verLine, ...cmdLines].join("\n"));

  if (hasText(result.git.diffStat)) parts.push(`git diff --stat:\n${result.git.diffStat.trim()}`);
  return parts.join("\n\n");
}

/**
 * 把 CE Work 成功結果合併進目前 task 的 aiWorkflow（Phase 71）。
 * 合併規則：
 * - 保留 brainstorm / plan / audit / compound 不動。
 * - 更新 workReview：
 *   - changedFiles：優先 work.changedFiles，否則由 git status 推導。
 *   - testCommands：優先 work.testCommands，否則由 verification.commands 推導。
 *   - testResults：實作摘要 + 驗證結果 + git diff stat。
 *   - codeReviewNotes：保留既有；沒有時填 "待 Review"（不自動產生正式 review）。
 *   - commitHash / commitMessage：保留既有。
 */
export function mergeCeWorkResult(
  current: AiEngineeringWorkflow | undefined,
  result: CeWorkSuccess
): AiEngineeringWorkflow {
  const existingWR = current?.workReview;

  const changedFiles =
    result.work.changedFiles.length > 0 ? result.work.changedFiles : parseGitStatusShort(result.git.statusShort);
  const testCommands =
    result.work.testCommands.length > 0
      ? result.work.testCommands
      : result.verification.commands.map((c) => c.command || c.name).filter((c) => c.length > 0);
  const testResults = buildWorkTestResults(result);

  const workReview: AiWorkflowWorkReview = {
    ...existingWR,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(testCommands.length > 0 ? { testCommands } : {}),
    ...(hasText(testResults) ? { testResults } : {}),
    codeReviewNotes: hasText(existingWR?.codeReviewNotes) ? existingWR!.codeReviewNotes : "待 Review",
  };

  const merged: AiEngineeringWorkflow = { workReview };
  if (current?.brainstorm !== undefined) merged.brainstorm = current.brainstorm;
  if (current?.plan !== undefined) merged.plan = current.plan;
  if (current?.audit !== undefined) merged.audit = current.audit;
  if (current?.compound !== undefined) merged.compound = current.compound;
  return merged;
}
