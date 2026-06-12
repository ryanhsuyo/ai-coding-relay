export type TaskStatus = "todo" | "in_progress" | "done";

export type TaskPriority = "low" | "medium" | "high";

export type TaskReviewResult = "not_reviewed" | "passed" | "needs_fix";

/** SDD + TDD 工作流階段：spec → spec_review → red_test → green_implement → refactor → verify → review → fix → done。 */
export type WorkflowStage =
  | "spec"
  | "spec_review"
  | "red_test"
  | "green_implement"
  | "refactor"
  | "verify"
  | "review"
  | "fix"
  | "done";

export type TaskType =
  | "ui"
  | "bug"
  | "typescript"
  | "refactor"
  | "api"
  | "test"
  | "docs"
  | "other";

export type ChecklistStatus = "pending" | "passed" | "failed" | "skipped";

export type ChecklistItem = {
  id: string;
  label: string;
  status: ChecklistStatus;
  note?: string;
};

export type CommandLog = {
  id: string;
  /** 驗證指令名稱，例如 tsc / test / build / git-status / git-diff。 */
  name?: string;
  command: string;
  /** 行程結束碼；spawn 失敗等情況可能為 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 指令耗時（毫秒）。 */
  durationMs?: number;
  /** 該指令是否成功（exitCode === 0）。 */
  ok?: boolean;
  /** 是否為必要指令（失敗會讓整體驗證失敗）。 */
  required?: boolean;
  startedAt?: string;
  endedAt?: string;
};

/** scripts/run-verification.mjs 輸出的單一指令結果。 */
export type VerificationCommand = {
  name: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  ok: boolean;
  required: boolean;
};

/** File Guard 偵測到的單一違規：在某檔案上發生的某種違規類型。 */
export type FileGuardViolation = {
  /** 違規類型，例如 forbidden（改到禁止檔案）/ out-of-scope（改到非目標檔案）。 */
  type: string;
  file: string;
};

/** scripts/check-file-guard.mjs 輸出、由 run-verification.mjs 帶入的檔案範圍檢查結果。 */
export type FileGuardResult = {
  /** 檔案範圍檢查是否通過（無違規且無錯誤）。 */
  ok: boolean;
  modifiedFiles: string[];
  targetFiles: string[];
  forbiddenFiles: string[];
  violations: FileGuardViolation[];
  /** 執行 file guard 過程的錯誤訊息（例如 guard-rules.json 讀取失敗）。 */
  error?: string;
};

/** auto-round 可用的 mode（對應 TDD 階段）。 */
export type AutoRoundMode = "test" | "implement" | "refactor" | "fix";

/** scripts/auto-round.mjs 輸出中，AI CLI 一次執行的結果。 */
export type AiRunResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/** scripts/run-verification.mjs 輸出的整體驗證結果。 */
export type VerificationResult = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  commands: VerificationCommand[];
  /** 選擇性的檔案範圍檢查結果；僅在專案有 guard-rules.json 時存在。 */
  fileGuard?: FileGuardResult;
};

/**
 * 一筆「套用完成狀態」事件（Phase 65）。
 * 由 useTasks.applyCompletion 寫入，記錄套用當下保存了哪些狀態與是否保存了摘要。
 * 註：與 task / rounds / summary 一樣，目前只存在 ai-coding-relay 的瀏覽器 localStorage，
 * 不寫入 harness、也不寫入 .ai-coding-relay artifact folder；跨機保存需走 export/import。
 */
export type TaskCompletionEvent = {
  id: string;
  type: "completion_applied";
  createdAt: string;
  /** 套用當下是否一併保存了非空白的摘要。 */
  summarySaved: boolean;
  /** 觸發完成時最新一筆回合的 id（取不到時省略）。 */
  sourceRoundId?: string;
  status: "done";
  reviewResult: "passed";
  workflowStage: "done";
  message: string;
};

/** Brainstorm 階段狀態（Phase 66 AI Engineering Workflow）。 */
export type BrainstormStatus = "not_started" | "drafted" | "reviewed";

/** Plan 階段狀態（Phase 66 AI Engineering Workflow）。 */
export type PlanStatus =
  | "not_started"
  | "planned"
  | "audited"
  | "approved"
  | "rejected";

/** 審計 plan 時的核對清單；缺欄位在 migration 時補 false。 */
export type PlanAuditChecklist = {
  coreAssumptionsReviewed: boolean;
  riskReviewed: boolean;
  scopeReviewed: boolean;
  acceptanceCriteriaReviewed: boolean;
  minimalChangeReviewed: boolean;
};

export type AiWorkflowBrainstorm = {
  path?: string;
  summary?: string;
  status?: BrainstormStatus;
};

export type AiWorkflowPlan = {
  path?: string;
  summary?: string;
  status?: PlanStatus;
};

export type AiWorkflowAudit = {
  notes?: string;
  coreAssumptions?: string[];
  riskNotes?: string[];
  acceptanceCriteria?: string[];
  checklist?: PlanAuditChecklist;
};

export type AiWorkflowWorkReview = {
  changedFiles?: string[];
  testCommands?: string[];
  testResults?: string;
  codeReviewNotes?: string;
  commitHash?: string;
  commitMessage?: string;
  // Phase 77F：CE Commit checkpoint 寫入的補充欄位（commit 當下時間與實際 commit 的檔案）。
  committedAt?: string;
  committedFiles?: string[];
};

export type AiWorkflowCompound = {
  reusablePrompt?: string;
  lessonLearned?: string;
  compoundNotes?: string;
};

/**
 * Hack22 / Compound Engineering workflow 的結構化欄位（Phase 66）。
 * 所有子欄位皆為選擇性，舊 task 不需補完整資料；只保留型別與資料，本階段不含 UI。
 */
export type AiEngineeringWorkflow = {
  brainstorm?: AiWorkflowBrainstorm;
  plan?: AiWorkflowPlan;
  audit?: AiWorkflowAudit;
  workReview?: AiWorkflowWorkReview;
  compound?: AiWorkflowCompound;
};

/**
 * Phase 70：CE Readonly Workflow runner（scripts/local-runner.mjs 的 /ce-readonly-workflow）回傳的結果。
 * runner 只呼叫 Claude CLI 跑唯讀的 Brainstorm / Plan / Audit，不修改 target project。
 */
export type CeReadonlyWorkflowStoppedReason =
  | "ai_failed"
  | "invalid_json"
  | "runner_error"
  | "project_path_invalid"
  // Phase 77A：執行前後 target project working tree 發生變化（readonly 邊界被破壞）。
  | "readonly_violation";

/**
 * Phase 77A：CE Readonly Workflow 執行前/後的 target project working tree 快照。
 * 用來硬性偵測 readonly 邊界是否被破壞（即使 Claude 忽略 prompt 或 aiCommand 帶 acceptEdits）。
 */
export type CeReadonlyWorkflowSnapshot = {
  statusShort: string;
  diffStat: string;
  nameStatus: string;
};

/** 成功：回填用的 workflow（只含 brainstorm / plan / audit）與是否可進入 Work。 */
export type CeReadonlyWorkflowSuccess = {
  ok: true;
  workflow: AiEngineeringWorkflow;
  canStartWork: boolean;
  recommendedNextAction: string;
  rawNotes: string;
  ai: {
    command: string;
    exitCode: number | null;
  };
};

/** 失敗：合法 JSON error，不把壞 JSON 原樣回給 UI。 */
export type CeReadonlyWorkflowFailure = {
  ok: false;
  stoppedReason: CeReadonlyWorkflowStoppedReason;
  message: string;
  stdoutPreview?: string;
  stdoutTail?: string;
  stderrPreview?: string;
  stderrTail?: string;
  // Phase 77A：readonly_violation 時附上執行前/後快照供 UI 顯示與人工比對。
  before?: CeReadonlyWorkflowSnapshot;
  after?: CeReadonlyWorkflowSnapshot;
  // Phase 77B：invalid_json 時的安全 debug 摘要。
  // rawOutputPreview：Claude stdout 前段預覽（runner 端已截斷，前端再保險截到 2000 字）。
  rawOutputPreview?: string;
  // parseAttempts：多階段 JSON 解析各步驟的簡短結果字串，例如 "whole_stdout_failed"。
  parseAttempts?: string[];
};

export type CeReadonlyWorkflowResult =
  | CeReadonlyWorkflowSuccess
  | CeReadonlyWorkflowFailure;

/**
 * Phase 71：CE Work runner（scripts/local-runner.mjs 的 /ce-work）回傳的結果。
 * 通過 Audit gate 後呼叫 Claude 依已審核 plan 實作（允許改檔）→ verification → 收集 git，不 commit / push。
 */
export type CeWorkStoppedReason =
  | "work_gate_failed"
  | "ai_failed"
  | "invalid_json"
  | "verification_failed"
  | "runner_error"
  | "project_path_invalid"
  | "work_blocked";

/** verification 內單一指令的精簡形狀（runner 回傳，前端只取 name/command/ok）。 */
export type CeWorkVerificationCommand = {
  name: string;
  command: string;
  ok: boolean;
};

export type CeWorkVerification = {
  ok: boolean;
  commands: CeWorkVerificationCommand[];
};

/** Claude 實作結果（runner 整理後）。 */
export type CeWorkDetail = {
  changedFiles: string[];
  testCommands: string[];
  testResults: string;
  implementationSummary: string;
  notes: string;
  recommendedNextAction: string;
};

export type CeWorkSuccess = {
  ok: true;
  work: CeWorkDetail;
  verification: CeWorkVerification;
  git: {
    statusShort: string;
    diffStat: string;
  };
  ai: {
    command: string;
    exitCode: number | null;
  };
};

export type CeWorkFailure = {
  ok: false;
  stoppedReason: CeWorkStoppedReason;
  message: string;
  stdoutPreview?: string;
  stdoutTail?: string;
  stderrPreview?: string;
  stderrTail?: string;
  // Phase 77C：verification_failed 時的安全 debug 摘要（rawOutputPreview ≤ 2000 字、parseAttempts 簡短字串）。
  rawOutputPreview?: string;
  parseAttempts?: string[];
  // Phase 77E：verification 完整 stdout 的字數（只是 number；完整 stdout 不會傳到 UI）。
  stdoutLength?: number;
};

export type CeWorkResult = CeWorkSuccess | CeWorkFailure;

/**
 * Phase 72：CE Review runner（scripts/local-runner.mjs 的 /ce-review）回傳的結果。
 * Work 完成後呼叫 Claude 做唯讀 review：不改檔 / 不 commit / 不 push / 不自動修正，回填 codeReviewNotes。
 */
export type CeReviewStoppedReason =
  | "review_gate_failed"
  | "review_blocked"
  | "ai_failed"
  | "invalid_json"
  | "runner_error"
  | "project_path_invalid";

/** Review 判定結果。 */
export type CeReviewVerdict = "passed" | "needs_fix";

/** Claude review 結果（runner 整理後）。 */
export type CeReviewDetail = {
  result: CeReviewVerdict;
  notes: string;
  issues: string[];
  testGaps: string[];
  riskNotes: string[];
  recommendedFixes: string[];
  recommendedNextAction: string;
};

export type CeReviewSuccess = {
  ok: true;
  review: CeReviewDetail;
  git: {
    statusShort: string;
    diffStat: string;
  };
  ai: {
    command: string;
    exitCode: number | null;
  };
};

export type CeReviewFailure = {
  ok: false;
  stoppedReason: CeReviewStoppedReason;
  message: string;
  stdoutPreview?: string;
  stdoutTail?: string;
  stderrPreview?: string;
  stderrTail?: string;
};

export type CeReviewResult = CeReviewSuccess | CeReviewFailure;

/**
 * Phase 73B：CE Fix Work runner（scripts/local-runner.mjs 的 /ce-fix-work）回傳的結果。
 * CE Review needs_fix 時呼叫 Claude 只修 recommended fixes（允許改檔）→ verification → 收集 git，不 commit / push。
 */
export type CeFixWorkStoppedReason =
  | "fix_gate_failed"
  | "fix_blocked"
  | "ai_failed"
  | "invalid_json"
  | "verification_failed"
  | "runner_error"
  | "project_path_invalid";

/** Claude 修正結果（runner 整理後）。 */
export type CeFixWorkDetail = {
  changedFiles: string[];
  testCommands: string[];
  fixSummary: string;
  notes: string;
  recommendedNextAction: string;
};

export type CeFixWorkSuccess = {
  ok: true;
  fix: CeFixWorkDetail;
  verification: CeWorkVerification;
  git: {
    statusShort: string;
    diffStat: string;
  };
  ai: {
    command: string;
    exitCode: number | null;
  };
};

export type CeFixWorkFailure = {
  ok: false;
  stoppedReason: CeFixWorkStoppedReason;
  message: string;
  stdoutPreview?: string;
  stdoutTail?: string;
  stderrPreview?: string;
  stderrTail?: string;
  // Phase 77C：verification_failed 時的安全 debug 摘要（與 CeWorkFailure 一致）。
  rawOutputPreview?: string;
  parseAttempts?: string[];
};

export type CeFixWorkResult = CeFixWorkSuccess | CeFixWorkFailure;

/**
 * Phase 77F：CE Commit checkpoint runner（scripts/local-runner.mjs 的 /ce-commit-checkpoint）回傳的結果。
 * CE Review passed 後由「使用者按確認按鈕」觸發：runner 先跑 verification，通過才
 * git add（只加 tracked modified/deleted，排除 .env / node_modules / build artifacts）→ git commit → 回傳 short hash。
 * 永不 push、不動 remote、不自動觸發。
 */
export type CeCommitCheckpointStoppedReason =
  | "nothing_to_commit"
  | "verification_failed"
  | "git_commit_failed"
  | "invalid_commit_message"
  | "git_status_failed"
  | "project_path_invalid"
  | "runner_error";

export type CeCommitCheckpointSuccess = {
  ok: true;
  commitMessage: string;
  commitHash: string;
  committedAt: string;
  committedFiles: string[];
  /** commit 當下仍存在的 untracked files（不會被自動加入 commit，僅供 UI 顯示警告）。 */
  untrackedFiles: string[];
  verification: CeWorkVerification;
  statusBefore: string;
  diffStatBefore: string;
};

export type CeCommitCheckpointFailure = {
  ok: false;
  stoppedReason: CeCommitCheckpointStoppedReason;
  message: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  verificationPreview?: string;
  untrackedFiles?: string[];
};

export type CeCommitCheckpointResult = CeCommitCheckpointSuccess | CeCommitCheckpointFailure;

/**
 * Phase 75：OpenSpec-like Artifact Export（scripts/local-runner.mjs 的 /export-ce-artifacts）。
 * 把 task 的 CE workflow 紀錄寫成 docs/ai-workflows/<task-slug>/ 下的 markdown + metadata.json，
 * 只寫固定檔名、限制在 projectPath 底下，不 commit / push / 封存 / 改完成狀態、不呼叫 AI、不執行任意 shell。
 */
export type CeArtifactExportStoppedReason =
  | "project_path_invalid"
  | "path_escape_detected"
  | "write_failed"
  | "runner_error";

/** core helper 產生的單一輸出檔（檔名 + 內容）；runner 負責寫入。 */
export type CeArtifactFile = {
  name: string;
  content: string;
};

/** runner 寫檔後回報的單一檔案（檔名 + 相對於 projectPath 的路徑）。 */
export type CeArtifactExportedFile = {
  name: string;
  relativePath: string;
};

export type CeArtifactExportSuccess = {
  ok: true;
  artifact: {
    relativeDir: string;
    absoluteDir: string;
    files: CeArtifactExportedFile[];
  };
};

export type CeArtifactExportFailure = {
  ok: false;
  stoppedReason: CeArtifactExportStoppedReason;
  message: string;
};

export type CeArtifactExportResult = CeArtifactExportSuccess | CeArtifactExportFailure;

export type Task = {
  id: string;
  title: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;

  /**
   * 目前所處的 SDD + TDD 工作流階段。
   * createTask 預設 "spec"，舊資料讀取時由 migrateTask 補成 "spec"，
   * 因此正常流程下一定有值；型別保留選擇性以相容尚未補值的原始資料。
   */
  workflowStage?: WorkflowStage;

  originalRequirement: string;

  /** 結構化規格草稿（含 Given-When-Then 場景）；舊資料可能沒有，保持 undefined。 */
  specDraft?: string;

  targetFiles: string[];
  forbiddenFiles: string[];
  constraints: string[];
  acceptanceCriteria: string[];

  tags: string[];

  project?: string;
  projectPath?: string;
  summary?: string;
  claudeResponse?: string;
  reviewResult?: TaskReviewResult;
  nextActions?: string;
  dueDate?: string;
  archived?: boolean;

  /** 最近一次「套用完成狀態」的時間（ISO 字串）；每次套用都會更新。舊資料可能沒有。 */
  completedAt?: string;
  /** 「套用完成狀態」事件紀錄；舊資料可能沒有，讀取時以 `?? []` 視為空陣列。 */
  completionHistory?: TaskCompletionEvent[];

  /**
   * Hack22 / Compound Engineering AI Engineering Workflow 結構化資料（Phase 66）。
   * 選擇性；舊 task 沒有時保持 undefined，由 migrateTask 安全正規化。
   */
  aiWorkflow?: AiEngineeringWorkflow;

  createdAt: string;
  updatedAt: string;
};

export type TaskRound = {
  id: string;
  taskId: string;
  roundIndex: number;

  promptToClaude: string;
  claudeResponse?: string;

  gptReviewPrompt?: string;
  gptReview?: string;
  nextPrompt?: string;

  gitStatus?: string;
  gitDiff?: string;

  commandLogs?: CommandLog[];

  /** 本機驗證整體是否通過（由匯入 verification JSON 設定）。 */
  verificationOk?: boolean;

  /** 檔案範圍檢查結果（由匯入 verification JSON 的 fileGuard 設定）；舊回合可能沒有。 */
  fileGuard?: FileGuardResult;

  /** 以下為「匯入 auto-round 結果」時才會設定的欄位。 */
  /** auto-round 的 mode（test / implement / refactor / fix；錯誤輸出時可能為空字串）。 */
  autoRoundMode?: string;
  /** auto-round 呼叫 AI CLI 的執行結果。 */
  aiResult?: AiRunResult;
  /** auto-round 的整體 ok。 */
  autoRoundOk?: boolean;
  /** auto-round 停止原因，例如 ai_failed / verification_failed / file_guard_failed。 */
  stoppedReason?: string;

  /** 以下為「匯入 auto-loop 結果」時才會設定的欄位（單一 loop 內的第幾輪）。 */
  /** 此回合在 auto-loop 中的輪次（從 1 起算）。 */
  loopRoundIndex?: number;
  /** 此 auto-loop 的總輪數。 */
  loopTotalRounds?: number;
  /** 整個 auto-loop 的停止原因（例如 done / approval_required / max_rounds_reached）。 */
  loopStoppedReason?: string;

  checklist: ChecklistItem[];

  createdAt: string;
  updatedAt: string;
};

export type TaskFormValues = {
  title: string;
  type: TaskType;
  originalRequirement: string;
  targetFilesText: string;
  forbiddenFilesText: string;
  constraintsText: string;
  acceptanceCriteriaText: string;
  /** 專案分類名稱，空白會在儲存時轉成 undefined。 */
  project?: string;
  projectPath?: string;
  /** 逗號分隔的標籤文字，例如 "frontend, bug, urgent"。 */
  tagsText?: string;
  reviewResult?: TaskReviewResult;
  /** 工作流階段；新增表單不提供時，createTask 會預設為 "spec"。 */
  workflowStage?: WorkflowStage;
};

export type TaskStore = {
  tasks: Task[];
  rounds: TaskRound[];
};