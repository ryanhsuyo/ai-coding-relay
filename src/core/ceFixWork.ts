import type {
  AiEngineeringWorkflow,
  AiWorkflowWorkReview,
  CeFixWorkResult,
  CeFixWorkStoppedReason,
  CeFixWorkSuccess,
  CeWorkVerification,
  CeWorkVerificationCommand,
  Task,
} from "../shared/types";
import { parseGitStatusShort } from "./ceWork";
import { isCeReviewNeedsFix } from "./ceCompletion";

/**
 * Phase 73B：CE Fix Work gate 判斷、runner 回傳解析（type guard）與合併（純函式）。
 * 不依賴 React、不讀寫 localStorage、不呼叫 runner、不 throw。runner 回傳不被信任。
 */

const STOPPED_REASONS: readonly CeFixWorkStoppedReason[] = [
  "fix_gate_failed",
  "fix_blocked",
  "ai_failed",
  "invalid_json",
  "verification_failed",
  "runner_error",
  "project_path_invalid",
];

/** Fix 後固定的 codeReviewNotes：讓使用者知道需再次 Review。 */
export const FIX_PENDING_REVIEW_NOTE = "待 Review";

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

export type CeFixWorkGateResult = {
  canFix: boolean;
  reason: string;
};

/**
 * CE Fix Work gate（與 scripts/local-runner.mjs 的 evaluateCeFixWorkGateJs 一致）。
 * 必須 CE Review 為 needs_fix，且已有 Work 結果（changedFiles 有值，或 testResults 有非空字串）。
 */
export function evaluateCeFixWorkGate(task: Task): CeFixWorkGateResult {
  const wr = task.aiWorkflow?.workReview;
  if (!wr) return { canFix: false, reason: "尚未有 Work 結果，不建議執行 Fix Work。" };
  if (!isCeReviewNeedsFix(task)) {
    return { canFix: false, reason: "CE Review 尚未標記為 needs_fix，不建議執行 Fix Work。" };
  }
  if (hasItems(wr.changedFiles) || hasText(wr.testResults)) {
    return { canFix: true, reason: "" };
  }
  return { canFix: false, reason: "尚未有 Work 結果，不建議執行 Fix Work。" };
}

/** stoppedReason 白名單檢查；未知值一律視為 runner_error。 */
function normalizeStoppedReason(value: unknown): CeFixWorkStoppedReason {
  return STOPPED_REASONS.includes(value as CeFixWorkStoppedReason)
    ? (value as CeFixWorkStoppedReason)
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
 * 安全解析 /ce-fix-work 的回傳成 CeFixWorkResult。
 * - 非物件 / ok 不是 true → 失敗，保留 stoppedReason / message / 診斷片段。
 * - 成功時欄位皆經型別檢查，缺欄位補預設，永不 throw。
 */
export function parseCeFixWorkResult(raw: unknown): CeFixWorkResult {
  if (!isRecord(raw)) {
    return { ok: false, stoppedReason: "runner_error", message: "runner 回傳格式無效（非物件）" };
  }

  if (raw.ok !== true) {
    const failure: CeFixWorkResult = {
      ok: false,
      stoppedReason: normalizeStoppedReason(raw.stoppedReason),
      message: asString(raw.message) || "CE Fix Work 執行失敗",
    };
    if (typeof raw.stdoutPreview === "string") failure.stdoutPreview = raw.stdoutPreview;
    if (typeof raw.stdoutTail === "string") failure.stdoutTail = raw.stdoutTail;
    if (typeof raw.stderrPreview === "string") failure.stderrPreview = raw.stderrPreview;
    if (typeof raw.stderrTail === "string") failure.stderrTail = raw.stderrTail;
    return failure;
  }

  const fix = isRecord(raw.fix) ? raw.fix : {};
  const git = isRecord(raw.git) ? raw.git : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};

  return {
    ok: true,
    fix: {
      changedFiles: asStringArray(fix.changedFiles),
      testCommands: asStringArray(fix.testCommands),
      fixSummary: asString(fix.fixSummary),
      notes: asString(fix.notes),
      recommendedNextAction: asString(fix.recommendedNextAction),
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

/** 合併多個字串來源並去重（保留出現順序、過濾空白）。 */
function mergeUnique(...sources: string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources) {
    for (const item of source) {
      const trimmed = typeof item === "string" ? item.trim() : "";
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

/** 由 CE Fix Work 成功結果組出要 append 的 testResults 區段（fix 摘要 + 驗證結果 + git diff stat）。 */
function buildFixResultsText(result: CeFixWorkSuccess): string {
  const parts: string[] = [];
  if (hasText(result.fix.fixSummary)) parts.push(`Fix 摘要：\n${result.fix.fixSummary.trim()}`);

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
 * 把 CE Fix Work 成功結果合併進目前 task 的 aiWorkflow（Phase 73B）。
 * 合併規則：
 * - 保留 brainstorm / plan / audit / compound。
 * - 更新 workReview：
 *   - changedFiles：既有 + fix.changedFiles + git status 推導，去重。
 *   - testCommands：既有 + fix.testCommands + verification.commands，去重。
 *   - testResults：在既有後面 append（Fix 摘要 + 驗證結果 + git diff stat）。
 *   - codeReviewNotes：設為 "待 Review"（清掉 needs_fix 標記，停在 Review 前）。
 *   - commitHash / commitMessage：保留。
 */
export function mergeCeFixWorkResult(
  current: AiEngineeringWorkflow | undefined,
  result: CeFixWorkSuccess
): AiEngineeringWorkflow {
  const existingWR = current?.workReview;

  const changedFiles = mergeUnique(
    existingWR?.changedFiles ?? [],
    result.fix.changedFiles,
    parseGitStatusShort(result.git.statusShort)
  );
  const testCommands = mergeUnique(
    existingWR?.testCommands ?? [],
    result.fix.testCommands,
    result.verification.commands.map((c) => c.command || c.name)
  );

  const fixText = buildFixResultsText(result);
  const prevResults = existingWR?.testResults?.trim() ?? "";
  const testResults = prevResults ? `${prevResults}\n\n--- CE Fix Work ---\n${fixText}` : fixText;

  const workReview: AiWorkflowWorkReview = {
    ...existingWR,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(testCommands.length > 0 ? { testCommands } : {}),
    ...(hasText(testResults) ? { testResults } : {}),
    codeReviewNotes: FIX_PENDING_REVIEW_NOTE,
  };

  const merged: AiEngineeringWorkflow = { workReview };
  if (current?.brainstorm !== undefined) merged.brainstorm = current.brainstorm;
  if (current?.plan !== undefined) merged.plan = current.plan;
  if (current?.audit !== undefined) merged.audit = current.audit;
  if (current?.compound !== undefined) merged.compound = current.compound;
  return merged;
}
