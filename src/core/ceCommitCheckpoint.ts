import type {
  AiEngineeringWorkflow,
  AiWorkflowWorkReview,
  CeCommitCheckpointResult,
  CeCommitCheckpointStoppedReason,
  CeCommitCheckpointSuccess,
  Task,
} from "../shared/types";
import { isCeReviewPassed } from "./ceCompletion";

/**
 * Phase 77F：CE Commit checkpoint 的純函式層。
 * commit message 產生、runner 回傳解析（type guard）、合併進 aiWorkflow、smoke checkpoint。
 * 不依賴 React、不讀寫 localStorage、不呼叫 runner、不執行 git、不 throw。
 * 真正的 git commit 只在使用者按「確認並 Commit」後由 runner 執行。
 */

/** 「只記錄 smoke checkpoint（未真正 commit）」時寫入的 commitHash 標記。 */
export const SMOKE_CHECKPOINT_HASH = "not committed - smoke test only";

/** conventional commit 第一行長度上限。 */
const COMMIT_SUBJECT_MAX = 72;

const STOPPED_REASONS: readonly CeCommitCheckpointStoppedReason[] = [
  "nothing_to_commit",
  "verification_failed",
  "git_commit_failed",
  "invalid_commit_message",
  "git_status_failed",
  "project_path_invalid",
  "runner_error",
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

/**
 * 是否顯示 CE Commit checkpoint 區塊：CE Review 為 passed，或已有 commit 紀錄（顯示完成狀態）。
 */
export function shouldShowCeCommitCheckpoint(task: Task): boolean {
  const hasCommit = (task.aiWorkflow?.workReview?.commitHash ?? "").trim().length > 0;
  return isCeReviewPassed(task) || hasCommit;
}

/** 檔案是否屬於 docs（.md 或 docs/ 底下）。 */
function isDocsFile(file: string): boolean {
  return file.endsWith(".md") || file.startsWith("docs/");
}

/** 檔案是否屬於測試（test/tests/e2e/__tests__ 目錄，或 *.test.* / *.spec.*）。 */
function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|e2e|__tests__)\//.test(file) || /\.(test|spec)\.[a-z]+$/.test(file);
}

/** 字串是否「足以當英文 commit subject」：含英文字母且非 ASCII 字元占比低。 */
function isMostlyAscii(text: string): boolean {
  if (!/[a-zA-Z]/.test(text)) return false;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 126) nonAscii += 1;
  }
  return nonAscii / text.length < 0.2;
}

/** 取檔案路徑的 basename（去目錄）。 */
function basename(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx >= 0 ? file.slice(idx + 1) : file;
}

/**
 * 從 task / requirement / work result / changed files 產生建議 commit message（單行、可編輯）。
 * 規則：
 * - type：changedFiles 全為 docs → docs；全為測試 → test；標題/需求/測試結果含 fix/bug/修復/修正/錯誤 → fix；否則 feat。
 * - subject：標題以英文為主時直接使用（去尾句點、小寫開頭）；否則由 changedFiles 推導
 *   （單檔 → update <basename>；多檔 → update N files）；皆無 → update project files。
 * - 第一行不超過 72 字元（超過時截斷 subject）。不產生 body。
 */
export function generateCeCommitMessage(task: Task): string {
  const wr = task.aiWorkflow?.workReview;
  const files = (wr?.changedFiles ?? []).filter((f) => f.trim().length > 0);
  const contextText = `${task.title ?? ""} ${task.originalRequirement ?? ""} ${wr?.testResults ?? ""}`;

  const docsOnly = files.length > 0 && files.every(isDocsFile);
  const testsOnly = files.length > 0 && files.every(isTestFile);
  const looksLikeFix = /\b(fix|bug)\b|修復|修正|錯誤/i.test(contextText);
  const type = docsOnly ? "docs" : testsOnly ? "test" : looksLikeFix ? "fix" : "feat";

  const title = (task.title ?? "").trim().replace(/\.+$/, "");
  let subject: string;
  if (title && isMostlyAscii(title)) {
    subject = title.charAt(0).toLowerCase() + title.slice(1);
  } else if (files.length === 1) {
    subject = `update ${basename(files[0])}`;
  } else if (files.length > 1) {
    subject = `update ${files.length} files`;
  } else {
    subject = "update project files";
  }

  const prefix = `${type}: `;
  const maxSubject = COMMIT_SUBJECT_MAX - prefix.length;
  if (subject.length > maxSubject) subject = subject.slice(0, maxSubject).trimEnd();
  return `${prefix}${subject}`;
}

/** stoppedReason 白名單檢查；未知值一律視為 runner_error。 */
function normalizeStoppedReason(value: unknown): CeCommitCheckpointStoppedReason {
  return STOPPED_REASONS.includes(value as CeCommitCheckpointStoppedReason)
    ? (value as CeCommitCheckpointStoppedReason)
    : "runner_error";
}

/**
 * 安全解析 /ce-commit-checkpoint 的回傳成 CeCommitCheckpointResult。
 * - 非物件 / ok 不是 true → 失敗，保留 stoppedReason / message / 診斷 preview。
 * - 成功時欄位皆經型別檢查，缺欄位補預設，永不 throw。
 */
export function parseCeCommitCheckpointResult(raw: unknown): CeCommitCheckpointResult {
  if (!isRecord(raw)) {
    return { ok: false, stoppedReason: "runner_error", message: "runner 回傳格式無效（非物件）" };
  }

  if (raw.ok !== true) {
    const failure: CeCommitCheckpointResult = {
      ok: false,
      stoppedReason: normalizeStoppedReason(raw.stoppedReason),
      message: asString(raw.message) || "CE Commit checkpoint 執行失敗",
    };
    if (typeof raw.stdoutPreview === "string") failure.stdoutPreview = raw.stdoutPreview;
    if (typeof raw.stderrPreview === "string") failure.stderrPreview = raw.stderrPreview;
    if (typeof raw.verificationPreview === "string") failure.verificationPreview = raw.verificationPreview;
    if (Array.isArray(raw.untrackedFiles)) failure.untrackedFiles = asStringArray(raw.untrackedFiles);
    return failure;
  }

  const verification = isRecord(raw.verification) ? raw.verification : {};
  return {
    ok: true,
    commitMessage: asString(raw.commitMessage),
    commitHash: asString(raw.commitHash),
    committedAt: asString(raw.committedAt),
    committedFiles: asStringArray(raw.committedFiles),
    untrackedFiles: asStringArray(raw.untrackedFiles),
    verification: {
      ok: verification.ok === true,
      commands: Array.isArray(verification.commands)
        ? verification.commands.map((cmd) => {
            const obj = isRecord(cmd) ? cmd : {};
            return { name: asString(obj.name), command: asString(obj.command), ok: obj.ok === true };
          })
        : [],
    },
    statusBefore: asString(raw.statusBefore),
    diffStatBefore: asString(raw.diffStatBefore),
  };
}

/**
 * 把 CE Commit checkpoint 成功結果合併進目前 task 的 aiWorkflow：
 * 只更新 workReview 的 commitMessage / commitHash / committedAt / committedFiles，
 * 保留 workReview 其他欄位與 brainstorm / plan / audit / compound。
 */
export function mergeCeCommitCheckpointResult(
  current: AiEngineeringWorkflow | undefined,
  result: CeCommitCheckpointSuccess
): AiEngineeringWorkflow {
  const workReview: AiWorkflowWorkReview = {
    ...current?.workReview,
    commitMessage: result.commitMessage,
    commitHash: result.commitHash,
    committedAt: result.committedAt,
    committedFiles: result.committedFiles,
  };
  return { ...current, workReview };
}

/**
 * 「只記錄 smoke checkpoint」：不執行 git commit，commitHash 寫入固定標記字串。
 * 用於 smoke test 不想真的 commit 時，讓 Commit checkpoint 仍可標記完成。
 */
export function mergeCeCommitSmokeCheckpoint(
  current: AiEngineeringWorkflow | undefined,
  commitMessage: string,
  committedAt: string
): AiEngineeringWorkflow {
  const workReview: AiWorkflowWorkReview = {
    ...current?.workReview,
    commitMessage,
    commitHash: SMOKE_CHECKPOINT_HASH,
    committedAt,
  };
  return { ...current, workReview };
}
