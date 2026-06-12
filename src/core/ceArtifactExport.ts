import type {
  CeArtifactExportResult,
  CeArtifactExportStoppedReason,
  CeArtifactExportedFile,
  CeArtifactFile,
  PlanAuditChecklist,
  Task,
  TaskCompletionEvent,
} from "../shared/types";

/**
 * Phase 75：OpenSpec-like Artifact Export 的內容產生器（純函式）。
 * 把 task 內既有資料整理成可寫入 target project 的 markdown + metadata.json。
 *
 * 全為純函式：不碰 fs、不依賴 React、不讀寫 localStorage、不呼叫 runner、不呼叫 Claude CLI、
 * 不執行 shell、不 throw。runner（scripts/local-runner.mjs）以等價的 JS 邏輯實際寫檔。
 * 解析 runner 回傳時一律經 type guard，不信任 runner 一定正確。
 */

/** 固定輸出檔名（順序固定）；runner 只允許寫這些檔名。 */
export const ARTIFACT_FILE_NAMES = [
  "requirement.md",
  "brainstorm.md",
  "plan.md",
  "audit.md",
  "work-result.md",
  "review.md",
  "completion.md",
  "compound.md",
  "metadata.json",
] as const;

const MAX_SLUG_LENGTH = 80;

const STOPPED_REASONS: readonly CeArtifactExportStoppedReason[] = [
  "project_path_invalid",
  "path_escape_detected",
  "write_failed",
  "runner_error",
];

const CHECKLIST_ITEMS: { key: keyof PlanAuditChecklist; label: string }[] = [
  { key: "coreAssumptionsReviewed", label: "核心假設已審查" },
  { key: "riskReviewed", label: "風險已審查" },
  { key: "scopeReviewed", label: "修改範圍已審查" },
  { key: "acceptanceCriteriaReviewed", label: "驗收標準已審查" },
  { key: "minimalChangeReviewed", label: "是否符合最小修改原則" },
];

/** 是否為非 null、非陣列的物件。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取字串，否則回傳預設值。 */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** trim 後的字串；非字串回空字串。 */
function str(value?: string): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 字串陣列 → markdown bullet 清單（過濾空白）；無內容回空字串。 */
function bullets(items?: string[]): string {
  const clean = (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  return clean.length > 0 ? clean.map((item) => `- ${item}`).join("\n") : "";
}

/** 只把 ASCII 英數字保留成 slug；其餘轉連字號，限制長度。中文等非 ASCII 會被移除。 */
function slugifyAscii(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * 由 task 推導安全的 artifact slug。
 * 優先 title，其次 id；皆無可用 ASCII 字元（例如純中文 title）時回退到 "task"。
 * 結果只含 [a-z0-9-]，不可能包含路徑分隔字元或 ".."。
 */
export function slugifyTaskForArtifact(task: Task): string {
  const fromTitle = slugifyAscii(task.title ?? "");
  if (fromTitle) return fromTitle;
  const fromId = slugifyAscii(task.id ?? "");
  if (fromId) return fromId;
  return "task";
}

/** artifact 目錄（相對於 projectPath）。 */
export function artifactRelativeDir(task: Task): string {
  return `docs/ai-workflows/${slugifyTaskForArtifact(task)}`;
}

/** 1. requirement.md：任務基本資訊與原始需求。 */
export function buildRequirementMarkdown(task: Task): string {
  const tags = (task.tags ?? []).filter((t) => t.trim().length > 0);
  return [
    "# Requirement",
    "",
    `- Title: ${str(task.title) || "(未命名)"}`,
    `- Project: ${str(task.project) || "(未設定)"}`,
    `- Project Path: ${str(task.projectPath) || "(未設定)"}`,
    `- Priority: ${str(task.priority) || "(未設定)"}`,
    `- Due Date: ${str(task.dueDate) || "(未設定)"}`,
    `- Tags: ${tags.length > 0 ? tags.join(", ") : "(無)"}`,
    `- Created At: ${str(task.createdAt) || "(未知)"}`,
    `- Updated At: ${str(task.updatedAt) || "(未知)"}`,
    "",
    "## Original Requirement",
    "",
    str(task.originalRequirement) || "(未提供原始需求)",
    "",
  ].join("\n");
}

/** 2. brainstorm.md。 */
export function buildBrainstormMarkdown(task: Task): string {
  const b = task.aiWorkflow?.brainstorm;
  const status = str(b?.status);
  const path = str(b?.path);
  const summary = str(b?.summary);
  if (!status && !path && !summary) {
    return ["# Brainstorm", "", "尚未產生 Brainstorm 紀錄。", ""].join("\n");
  }
  return [
    "# Brainstorm",
    "",
    `- Status: ${status || "(未設定)"}`,
    `- Path: ${path || "(未設定)"}`,
    "",
    "## Summary",
    "",
    summary || "(無摘要)",
    "",
  ].join("\n");
}

/** 3. plan.md。 */
export function buildPlanMarkdown(task: Task): string {
  const p = task.aiWorkflow?.plan;
  const status = str(p?.status);
  const path = str(p?.path);
  const summary = str(p?.summary);
  if (!status && !path && !summary) {
    return ["# Plan", "", "尚未產生 Plan 紀錄。", ""].join("\n");
  }
  return [
    "# Plan",
    "",
    `- Status: ${status || "(未設定)"}`,
    `- Path: ${path || "(未設定)"}`,
    "",
    "## Summary",
    "",
    summary || "(無摘要)",
    "",
  ].join("\n");
}

/** 把 checklist 五項轉成 markdown 勾選清單（缺項視為未勾）。 */
function checklistMarkdown(checklist?: PlanAuditChecklist): string {
  return CHECKLIST_ITEMS.map(
    (item) => `- [${checklist && checklist[item.key] ? "x" : " "}] ${item.label}`
  ).join("\n");
}

/** 4. audit.md：審計筆記、核心假設、風險、驗收標準、checklist。 */
export function buildAuditMarkdown(task: Task): string {
  const a = task.aiWorkflow?.audit;
  const notes = str(a?.notes);
  const coreAssumptions = bullets(a?.coreAssumptions);
  const riskNotes = bullets(a?.riskNotes);
  const acceptanceCriteria = bullets(a?.acceptanceCriteria);
  const hasAny =
    !!a && (!!notes || !!coreAssumptions || !!riskNotes || !!acceptanceCriteria || !!a.checklist);
  if (!hasAny) {
    return ["# Audit", "", "尚未產生 Audit 紀錄。", ""].join("\n");
  }
  return [
    "# Audit",
    "",
    "## Notes",
    "",
    notes || "(無筆記)",
    "",
    "## Core Assumptions",
    "",
    coreAssumptions || "(無)",
    "",
    "## Risk Notes",
    "",
    riskNotes || "(無)",
    "",
    "## Acceptance Criteria",
    "",
    acceptanceCriteria || "(無)",
    "",
    "## Checklist",
    "",
    checklistMarkdown(a?.checklist),
    "",
  ].join("\n");
}

/** 5. work-result.md：changedFiles / testCommands / testResults / commit。 */
export function buildWorkResultMarkdown(task: Task): string {
  const wr = task.aiWorkflow?.workReview;
  const changedFiles = bullets(wr?.changedFiles);
  const testCommands = bullets(wr?.testCommands);
  const testResults = str(wr?.testResults);
  const commitHash = str(wr?.commitHash);
  const commitMessage = str(wr?.commitMessage);
  const hasAny =
    !!wr && (!!changedFiles || !!testCommands || !!testResults || !!commitHash || !!commitMessage);
  if (!hasAny) {
    return ["# Work Result", "", "尚未產生 Work 紀錄。", ""].join("\n");
  }
  return [
    "# Work Result",
    "",
    "## Changed Files",
    "",
    changedFiles || "(無)",
    "",
    "## Test Commands",
    "",
    testCommands || "(無)",
    "",
    "## Test Results",
    "",
    testResults || "(無)",
    "",
    "## Commit",
    "",
    `- Hash: ${commitHash || "(未提供)"}`,
    `- Message: ${commitMessage || "(未提供)"}`,
    "",
  ].join("\n");
}

/** 6. review.md：codeReviewNotes。 */
export function buildReviewMarkdown(task: Task): string {
  const notes = str(task.aiWorkflow?.workReview?.codeReviewNotes);
  if (!notes) {
    return ["# Review", "", "尚未產生 Review 紀錄。", ""].join("\n");
  }
  return ["# Review", "", "## Code Review Notes", "", notes, ""].join("\n");
}

/** 把 completionHistory 轉成 markdown 清單；無資料回空字串。 */
function completionHistoryMarkdown(history?: TaskCompletionEvent[]): string {
  if (!history || history.length === 0) return "";
  return history
    .map((event, index) => `${index + 1}. ${event.createdAt} — ${event.message}`)
    .join("\n");
}

/** 7. completion.md：完成狀態與 completionHistory。 */
export function buildCompletionMarkdown(task: Task): string {
  const completedAt = str(task.completedAt);
  const history = task.completionHistory ?? [];
  const historyMd = completionHistoryMarkdown(history);
  const summary = str(task.summary);

  const lines = [
    "# Completion",
    "",
    `- Status: ${str(task.status) || "(未設定)"}`,
    `- Review Result: ${str(task.reviewResult) || "(未設定)"}`,
    `- Workflow Stage: ${str(task.workflowStage) || "(未設定)"}`,
    `- Completed At: ${completedAt || "(尚未完成)"}`,
    "",
    "## Summary",
    "",
    summary || "(無摘要)",
    "",
    "## Completion History",
    "",
    historyMd || "(無)",
    "",
  ];

  if (!completedAt && history.length === 0) {
    lines.push("尚未套用完成狀態。", "");
  }
  return lines.join("\n");
}

/** 8. compound.md：lessonLearned / reusablePrompt / compoundNotes。 */
export function buildCompoundMarkdown(task: Task): string {
  const c = task.aiWorkflow?.compound;
  const lessonLearned = str(c?.lessonLearned);
  const reusablePrompt = str(c?.reusablePrompt);
  const compoundNotes = str(c?.compoundNotes);
  if (!lessonLearned && !reusablePrompt && !compoundNotes) {
    return ["# Compound", "", "尚未產生 Compound Notes。", ""].join("\n");
  }
  return [
    "# Compound",
    "",
    "## Lesson Learned",
    "",
    lessonLearned || "(無)",
    "",
    "## Reusable Prompt",
    "",
    reusablePrompt || "(無)",
    "",
    "## Compound Notes",
    "",
    compoundNotes || "(無)",
    "",
  ].join("\n");
}

/** 9. metadata.json：schema / task 摘要 / artifact 檔案清單。 */
export function buildMetadataJson(task: Task, relativeDir: string): string {
  const metadata = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: "ai-coding-relay",
    task: {
      id: str(task.id),
      title: str(task.title),
      project: str(task.project),
      projectPath: str(task.projectPath),
      status: str(task.status),
      reviewResult: str(task.reviewResult),
      workflowStage: str(task.workflowStage),
      createdAt: str(task.createdAt),
      updatedAt: str(task.updatedAt),
      completedAt: str(task.completedAt),
    },
    artifact: {
      relativeDir,
      files: [...ARTIFACT_FILE_NAMES],
    },
  };
  return JSON.stringify(metadata, null, 2);
}

/**
 * 產生全部 artifact 檔案（name + 內容）；不碰 fs。順序與 ARTIFACT_FILE_NAMES 一致。
 * runner 負責把這些內容寫入 target project（或以等價 JS 邏輯重建後寫入）。
 */
export function buildCeArtifactFiles(task: Task): CeArtifactFile[] {
  const relativeDir = artifactRelativeDir(task);
  return [
    { name: "requirement.md", content: buildRequirementMarkdown(task) },
    { name: "brainstorm.md", content: buildBrainstormMarkdown(task) },
    { name: "plan.md", content: buildPlanMarkdown(task) },
    { name: "audit.md", content: buildAuditMarkdown(task) },
    { name: "work-result.md", content: buildWorkResultMarkdown(task) },
    { name: "review.md", content: buildReviewMarkdown(task) },
    { name: "completion.md", content: buildCompletionMarkdown(task) },
    { name: "compound.md", content: buildCompoundMarkdown(task) },
    { name: "metadata.json", content: buildMetadataJson(task, relativeDir) },
  ];
}

/** stoppedReason 白名單檢查；未知值一律視為 runner_error。 */
function normalizeStoppedReason(value: unknown): CeArtifactExportStoppedReason {
  return STOPPED_REASONS.includes(value as CeArtifactExportStoppedReason)
    ? (value as CeArtifactExportStoppedReason)
    : "runner_error";
}

/**
 * 安全解析 /export-ce-artifacts 的回傳成 CeArtifactExportResult。
 * - 非物件 / ok 不是 true → 失敗，保留 stoppedReason / message。
 * - 成功時欄位皆經型別檢查，缺欄位補預設，永不 throw。
 */
export function parseCeArtifactExportResult(raw: unknown): CeArtifactExportResult {
  if (!isRecord(raw)) {
    return { ok: false, stoppedReason: "runner_error", message: "runner 回傳格式無效（非物件）" };
  }
  if (raw.ok !== true) {
    return {
      ok: false,
      stoppedReason: normalizeStoppedReason(raw.stoppedReason),
      message: asString(raw.message) || "CE Artifacts 匯出失敗",
    };
  }
  const artifact = isRecord(raw.artifact) ? raw.artifact : {};
  const files: CeArtifactExportedFile[] = Array.isArray(artifact.files)
    ? artifact.files
        .map((f): CeArtifactExportedFile | null =>
          isRecord(f) ? { name: asString(f.name), relativePath: asString(f.relativePath) } : null
        )
        .filter((f): f is CeArtifactExportedFile => f !== null && f.name.length > 0)
    : [];
  return {
    ok: true,
    artifact: {
      relativeDir: asString(artifact.relativeDir),
      absoluteDir: asString(artifact.absoluteDir),
      files,
    },
  };
}
