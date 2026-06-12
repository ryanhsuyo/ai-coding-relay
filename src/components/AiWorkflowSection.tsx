import { useState, useEffect } from "react";
import type {
  AiEngineeringWorkflow,
  AiWorkflowWorkReview,
  BrainstormStatus,
  CeArtifactExportedFile,
  CeCommitCheckpointSuccess,
  CeFixWorkSuccess,
  CeReviewSuccess,
  CeWorkSuccess,
  PlanAuditChecklist,
  PlanStatus,
  Task,
} from "../shared/types";
import {
  buildAuditPrompt,
  buildBrainstormPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildWorkPrompt,
} from "../core/aiWorkflowPrompts";
import { parseCeReadonlyWorkflowResult } from "../core/ceReadonlyWorkflow";
import { evaluateCeWorkGate, mergeCeWorkResult, parseCeWorkResult } from "../core/ceWork";
import { evaluateCeReviewGate, mergeCeReviewResult, parseCeReviewResult } from "../core/ceReview";
import { evaluateCeFixWorkGate, mergeCeFixWorkResult, parseCeFixWorkResult } from "../core/ceFixWork";
import { isCeReviewNeedsFix, isTaskFullyCompleted } from "../core/ceCompletion";
import {
  generateCeCommitMessage,
  mergeCeCommitCheckpointResult,
  mergeCeCommitSmokeCheckpoint,
  parseCeCommitCheckpointResult,
  shouldShowCeCommitCheckpoint,
} from "../core/ceCommitCheckpoint";
import { buildCeCompoundDraft } from "../core/ceCompound";
import { parseCeArtifactExportResult } from "../core/ceArtifactExport";
import { AiWorkflowProgressPanel } from "./AiWorkflowProgressPanel";

/**
 * Phase 67：AI Engineering Workflow（Hack22 / Compound Engineering）欄位編輯區塊。
 * 只做欄位編輯與保存（單一總保存按鈕），不含 prompt copy buttons（Phase 68）。
 * 所有欄位皆選擇性；全部空白時保存為 undefined，舊 task 沒有 aiWorkflow 也能正常顯示。
 */

const BRAINSTORM_STATUS_OPTIONS: { value: BrainstormStatus; label: string }[] = [
  { value: "not_started", label: "未開始 not_started" },
  { value: "drafted",     label: "已草擬 drafted" },
  { value: "reviewed",    label: "已審閱 reviewed" },
];

const PLAN_STATUS_OPTIONS: { value: PlanStatus; label: string }[] = [
  { value: "not_started", label: "未開始 not_started" },
  { value: "planned",     label: "已規劃 planned" },
  { value: "audited",     label: "已審計 audited" },
  { value: "approved",    label: "已核准 approved" },
  { value: "rejected",    label: "已退回 rejected" },
];

const CHECKLIST_ITEMS: { key: keyof PlanAuditChecklist; label: string }[] = [
  { key: "coreAssumptionsReviewed",    label: "核心假設已審查" },
  { key: "riskReviewed",               label: "風險已審查" },
  { key: "scopeReviewed",              label: "修改範圍已審查" },
  { key: "acceptanceCriteriaReviewed", label: "驗收標準已審查" },
  { key: "minimalChangeReviewed",      label: "是否符合最小修改原則" },
];

const EMPTY_CHECKLIST: PlanAuditChecklist = {
  coreAssumptionsReviewed: false,
  riskReviewed: false,
  scopeReviewed: false,
  acceptanceCriteriaReviewed: false,
  minimalChangeReviewed: false,
};

/** 多行 textarea → string[]：逐行 trim、移除空行、保留順序。 */
export function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** string[] → 多行 textarea 內容；undefined 視為空字串。 */
export function arrayToLines(items?: string[]): string {
  return items ? items.join("\n") : "";
}

/** 編輯中的草稿：全部以 string / boolean 表示，保存時再轉回 AiEngineeringWorkflow。 */
type Draft = {
  brainstormPath: string;
  brainstormSummary: string;
  brainstormStatus: "" | BrainstormStatus;
  planPath: string;
  planSummary: string;
  planStatus: "" | PlanStatus;
  auditNotes: string;
  auditCoreAssumptions: string;
  auditRiskNotes: string;
  auditAcceptanceCriteria: string;
  checklist: PlanAuditChecklist;
  changedFiles: string;
  testCommands: string;
  testResults: string;
  codeReviewNotes: string;
  commitHash: string;
  commitMessage: string;
  // Phase 77F：CE Commit checkpoint 寫入的補充欄位（非編輯欄位，但需隨保存保留）。
  committedAt: string;
  committedFiles: string;
  reusablePrompt: string;
  lessonLearned: string;
  compoundNotes: string;
};

function taskToDraft(task: Task): Draft {
  const wf = task.aiWorkflow;
  return {
    brainstormPath: wf?.brainstorm?.path ?? "",
    brainstormSummary: wf?.brainstorm?.summary ?? "",
    brainstormStatus: wf?.brainstorm?.status ?? "",
    planPath: wf?.plan?.path ?? "",
    planSummary: wf?.plan?.summary ?? "",
    planStatus: wf?.plan?.status ?? "",
    auditNotes: wf?.audit?.notes ?? "",
    auditCoreAssumptions: arrayToLines(wf?.audit?.coreAssumptions),
    auditRiskNotes: arrayToLines(wf?.audit?.riskNotes),
    auditAcceptanceCriteria: arrayToLines(wf?.audit?.acceptanceCriteria),
    checklist: { ...EMPTY_CHECKLIST, ...(wf?.audit?.checklist ?? {}) },
    changedFiles: arrayToLines(wf?.workReview?.changedFiles),
    testCommands: arrayToLines(wf?.workReview?.testCommands),
    testResults: wf?.workReview?.testResults ?? "",
    codeReviewNotes: wf?.workReview?.codeReviewNotes ?? "",
    commitHash: wf?.workReview?.commitHash ?? "",
    commitMessage: wf?.workReview?.commitMessage ?? "",
    committedAt: wf?.workReview?.committedAt ?? "",
    committedFiles: arrayToLines(wf?.workReview?.committedFiles),
    reusablePrompt: wf?.compound?.reusablePrompt ?? "",
    lessonLearned: wf?.compound?.lessonLearned ?? "",
    compoundNotes: wf?.compound?.compoundNotes ?? "",
  };
}

/**
 * Phase 70：把 CE Readonly Workflow 回填的 brainstorm / plan / audit 套進編輯草稿。
 * 只覆寫這三段對應的 draft 欄位（讓輸入框與進度總覽即時反映回填結果），
 * 不動 work/review/compound 對應欄位。
 */
function applyWorkflowToDraft(prev: Draft, wf: AiEngineeringWorkflow): Draft {
  return {
    ...prev,
    brainstormPath: wf.brainstorm?.path ?? "",
    brainstormSummary: wf.brainstorm?.summary ?? "",
    brainstormStatus: wf.brainstorm?.status ?? "",
    planPath: wf.plan?.path ?? "",
    planSummary: wf.plan?.summary ?? "",
    planStatus: wf.plan?.status ?? "",
    auditNotes: wf.audit?.notes ?? "",
    auditCoreAssumptions: arrayToLines(wf.audit?.coreAssumptions),
    auditRiskNotes: arrayToLines(wf.audit?.riskNotes),
    auditAcceptanceCriteria: arrayToLines(wf.audit?.acceptanceCriteria),
    checklist: { ...EMPTY_CHECKLIST, ...(wf.audit?.checklist ?? {}) },
  };
}

/**
 * Phase 71：把 CE Work 合併後的 workReview 套進編輯草稿，讓 Work / Review 欄位與進度總覽即時反映。
 * 只覆寫 work/review 對應欄位，不動 brainstorm / plan / audit / compound 對應欄位。
 */
function applyWorkReviewToDraft(prev: Draft, workReview: AiWorkflowWorkReview | undefined): Draft {
  return {
    ...prev,
    changedFiles: arrayToLines(workReview?.changedFiles),
    testCommands: arrayToLines(workReview?.testCommands),
    testResults: workReview?.testResults ?? "",
    codeReviewNotes: workReview?.codeReviewNotes ?? "",
    commitHash: workReview?.commitHash ?? "",
    commitMessage: workReview?.commitMessage ?? "",
    committedAt: workReview?.committedAt ?? "",
    committedFiles: arrayToLines(workReview?.committedFiles),
  };
}

/** trim 後非空字串才保留，否則 undefined。 */
function toOptionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 多行文字轉 string[]；空結果轉 undefined。 */
function toOptionalArray(text: string): string[] | undefined {
  const items = linesToArray(text);
  return items.length > 0 ? items : undefined;
}

/** 物件中所有值皆為 undefined 時回傳 undefined，否則回傳物件本身。 */
function dropIfEmpty<T extends Record<string, unknown>>(obj: T): T | undefined {
  return Object.values(obj).some((v) => v !== undefined) ? obj : undefined;
}

/**
 * 把草稿轉回 AiEngineeringWorkflow；所有段落空白時回傳 undefined（清空 aiWorkflow）。
 * checklist 只在任一項勾選時保存；全部未勾視同未填（UI 顯示 false 預設）。
 */
function draftToWorkflow(draft: Draft): AiEngineeringWorkflow | undefined {
  const checklist = Object.values(draft.checklist).some(Boolean) ? draft.checklist : undefined;

  const workflow: AiEngineeringWorkflow = {
    brainstorm: dropIfEmpty({
      path: toOptionalString(draft.brainstormPath),
      summary: toOptionalString(draft.brainstormSummary),
      status: draft.brainstormStatus || undefined,
    }),
    plan: dropIfEmpty({
      path: toOptionalString(draft.planPath),
      summary: toOptionalString(draft.planSummary),
      status: draft.planStatus || undefined,
    }),
    audit: dropIfEmpty({
      notes: toOptionalString(draft.auditNotes),
      coreAssumptions: toOptionalArray(draft.auditCoreAssumptions),
      riskNotes: toOptionalArray(draft.auditRiskNotes),
      acceptanceCriteria: toOptionalArray(draft.auditAcceptanceCriteria),
      checklist,
    }),
    workReview: dropIfEmpty({
      changedFiles: toOptionalArray(draft.changedFiles),
      testCommands: toOptionalArray(draft.testCommands),
      testResults: toOptionalString(draft.testResults),
      codeReviewNotes: toOptionalString(draft.codeReviewNotes),
      commitHash: toOptionalString(draft.commitHash),
      commitMessage: toOptionalString(draft.commitMessage),
      committedAt: toOptionalString(draft.committedAt),
      committedFiles: toOptionalArray(draft.committedFiles),
    }),
    compound: dropIfEmpty({
      reusablePrompt: toOptionalString(draft.reusablePrompt),
      lessonLearned: toOptionalString(draft.lessonLearned),
      compoundNotes: toOptionalString(draft.compoundNotes),
    }),
  };

  return dropIfEmpty(workflow);
}

/**
 * Phase 70：CE Readonly Workflow runner endpoint。
 * 與既有 auto-round / auto-loop 一致走本機 local runner（pnpm runner:local）。
 */
const CE_READONLY_WORKFLOW_URL = "http://localhost:4318/ce-readonly-workflow";

/**
 * Phase 70：CE Readonly Workflow 一鍵執行的階段。
 * - idle：未執行（不顯示狀態）
 * - running：已送出，等待 Claude Brainstorm / Plan / Audit
 * - applying：收到結果，正在回填 AI Workflow
 * - completed：已回填完成
 * - failed：runner 未連線 / AI 失敗 / JSON 解析失敗等
 */
type CeReadonlyPhase = "idle" | "running" | "applying" | "completed" | "failed";

const CE_READONLY_PHASE_TEXT: Record<CeReadonlyPhase, string> = {
  idle: "",
  running: "正在執行 CE Readonly Workflow，正在等待 Claude Brainstorm / Plan / Audit...",
  applying: "正在回填 AI Workflow...",
  completed: "已完成 CE Readonly Workflow，請確認 Audit 後再進入 Work。",
  failed: "CE Readonly Workflow 失敗",
};

/**
 * Phase 70：CE Readonly Workflow 一鍵執行區塊。
 * 按一顆按鈕即呼叫 local runner /ce-readonly-workflow，跑 Brainstorm → Plan → Audit，
 * 成功後把結果合併進 task.aiWorkflow（保留 Work / Review / Compound），停在 Work 前。
 * 不自動進入 Work、不自動 auto-round、不自動 commit、不自動封存。
 */
function CeReadonlyWorkflowRunner({
  task,
  aiCommand,
  onApply,
}: {
  task: Task;
  aiCommand: string;
  onApply: (workflow: AiEngineeringWorkflow) => void;
}) {
  const [phase, setPhase] = useState<CeReadonlyPhase>("idle");
  const [message, setMessage] = useState("");
  const [canStartWork, setCanStartWork] = useState<boolean | null>(null);
  const [readinessText, setReadinessText] = useState("");
  // Phase 77A：readonly_violation 時的變更摘要（after snapshot）；非 violation 時為空。
  const [violationSummary, setViolationSummary] = useState("");
  // Phase 77B：invalid_json 時 Claude 的 stdout 預覽；非 invalid_json 時為空。
  const [rawOutputPreview, setRawOutputPreview] = useState("");
  const running = phase === "running" || phase === "applying";

  // 切換任務時重置狀態，避免把上一個任務的結果帶過來。
  useEffect(() => {
    setPhase("idle");
    setMessage("");
    setCanStartWork(null);
    setReadinessText("");
    setViolationSummary("");
    setRawOutputPreview("");
  }, [task.id]);

  async function handleRun() {
    setPhase("running");
    setMessage("");
    setCanStartWork(null);
    setReadinessText("");
    setViolationSummary("");
    setRawOutputPreview("");
    try {
      const res = await fetch(CE_READONLY_WORKFLOW_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, aiCommand }),
      });
      const raw: unknown = await res.json().catch(() => null);
      const result = parseCeReadonlyWorkflowResult(raw);
      if (!result.ok) {
        setPhase("failed");
        // Phase 77A：readonly 邊界被破壞時，給清楚訊息並附上 after 變更摘要；不回填 workflow。
        if (result.stoppedReason === "readonly_violation") {
          setMessage("CE Readonly Workflow 修改了目標專案檔案，已中止。請先檢查或還原變更後再繼續。");
          const after = result.after;
          const summary = after ? (after.statusShort.trim() || after.diffStat.trim()) : "";
          setViolationSummary(summary);
        } else {
          setMessage(`失敗（${result.stoppedReason}）：${result.message}`);
          // Phase 77B：invalid_json 等情況附上 Claude 輸出預覽（已截斷），方便排查；不回填 workflow。
          if (typeof result.rawOutputPreview === "string" && result.rawOutputPreview.trim()) {
            setRawOutputPreview(result.rawOutputPreview);
          }
        }
        return;
      }
      // 回填：只覆蓋 Brainstorm / Plan / Audit，保留 Work / Review / Compound。
      setPhase("applying");
      onApply(result.workflow);
      setCanStartWork(result.canStartWork);
      setReadinessText(
        result.canStartWork
          ? "Audit 通過，可進入 Work 階段"
          : `尚不建議進入 Work：${result.recommendedNextAction || "請先補強 Plan / Audit"}`
      );
      setPhase("completed");
    } catch (e) {
      setPhase("failed");
      setMessage(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local`
      );
    }
  }

  return (
    <div className="ce-readonly-runner" data-testid="ce-readonly-runner">
      <div className="aiwf-actions">
        <button
          className="btn btn-primary"
          data-testid="ce-readonly-run"
          onClick={() => void handleRun()}
          disabled={running}
        >
          {running ? "CE Readonly Workflow 執行中…" : "開始 CE Readonly Workflow"}
        </button>
      </div>
      {phase !== "idle" && (
        <div
          className={`ce-readonly-status ce-readonly-${phase}`}
          data-testid="ce-readonly-status"
          data-phase={phase}
        >
          <div className="ce-readonly-status-text">
            {phase === "failed" ? message || CE_READONLY_PHASE_TEXT.failed : CE_READONLY_PHASE_TEXT[phase]}
          </div>
          {phase === "failed" && violationSummary && (
            <pre className="ce-readonly-violation" data-testid="ce-readonly-violation">
              {violationSummary}
            </pre>
          )}
          {phase === "failed" && rawOutputPreview && (
            <div className="ce-readonly-raw-preview" data-testid="ce-readonly-raw-preview">
              <div className="ce-readonly-raw-preview-label">Claude 輸出預覽（截斷）</div>
              <pre className="ce-readonly-raw-preview-body">{rawOutputPreview}</pre>
            </div>
          )}
          {phase === "completed" && canStartWork !== null && (
            <div
              className={`ce-readonly-readiness${canStartWork ? " ready" : ""}`}
              data-testid="ce-readonly-readiness"
              data-can-start-work={canStartWork}
            >
              {readinessText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Phase 71：CE Work runner endpoint。 */
const CE_WORK_URL = "http://localhost:4318/ce-work";

/**
 * Phase 71：CE Work 一鍵執行的階段。
 * - idle：未執行（不顯示狀態）
 * - running：已 confirm 並送出，等待 Claude 實作與 verification
 * - applying：收到結果，正在回填 Work / Review
 * - completed：已回填完成
 * - failed：gate 未過 / runner 未連線 / AI 失敗 / verification 失敗等
 */
type CeWorkPhase = "idle" | "running" | "applying" | "completed" | "failed";

const CE_WORK_PHASE_TEXT: Record<CeWorkPhase, string> = {
  idle: "",
  running: "正在執行 CE Work，正在等待 Claude 實作與 verification...",
  applying: "正在回填 Work / Review...",
  completed: "已完成 CE Work，請進行 Review（尚未自動 commit / 封存）。",
  failed: "CE Work 失敗",
};

const CE_WORK_CONFIRM = "CE Work 會允許 Claude 修改目標專案檔案。確定要依已審核 plan 開始實作嗎？";

/**
 * Phase 71：CE Work 一鍵執行區塊（含 Audit gate + 二次 confirm）。
 * gate 不通過時按鈕 disabled 並顯示原因；通過時按下需先 confirm，才呼叫 local runner /ce-work。
 * 成功後把實作結果合併進 task.aiWorkflow.workReview（保留 brainstorm/plan/audit/compound），停在 Review 前。
 * 不自動進入 Review、不自動 commit、不自動封存、不自動套用完成狀態。
 */
function CeWorkRunner({
  task,
  aiCommand,
  onApply,
}: {
  task: Task;
  aiCommand: string;
  onApply: (result: CeWorkSuccess) => void;
}) {
  const [phase, setPhase] = useState<CeWorkPhase>("idle");
  const [message, setMessage] = useState("");
  const [nextActionText, setNextActionText] = useState("");
  // Phase 77C：verification_failed 時 verification 的 stdout 預覽；其他情況為空。
  const [rawOutputPreview, setRawOutputPreview] = useState("");
  // Phase 77E：verification 完整 stdout 的字數（runner 只回 number，不回完整 stdout）；null 表示沒有。
  const [stdoutLength, setStdoutLength] = useState<number | null>(null);
  const running = phase === "running" || phase === "applying";
  const gate = evaluateCeWorkGate(task);

  // 切換任務時重置狀態。
  useEffect(() => {
    setPhase("idle");
    setMessage("");
    setNextActionText("");
    setRawOutputPreview("");
    setStdoutLength(null);
  }, [task.id]);

  async function handleRun() {
    // 二次確認：明確告知會修改目標專案檔案。
    if (!window.confirm(CE_WORK_CONFIRM)) return;

    setPhase("running");
    setMessage("");
    setNextActionText("");
    setRawOutputPreview("");
    setStdoutLength(null);
    try {
      const res = await fetch(CE_WORK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, aiCommand }),
      });
      const raw: unknown = await res.json().catch(() => null);
      const result = parseCeWorkResult(raw);
      if (!result.ok) {
        setPhase("failed");
        setMessage(`失敗（${result.stoppedReason}）：${result.message}`);
        // Phase 77C：verification_failed 等帶 rawOutputPreview 時附上 verification 輸出預覽；不回填 Work result。
        if (typeof result.rawOutputPreview === "string" && result.rawOutputPreview.trim()) {
          setRawOutputPreview(result.rawOutputPreview);
        }
        // Phase 77E：顯示 verification 完整 stdout 的字數（協助判斷 preview 是否被截斷）。
        if (typeof result.stdoutLength === "number") {
          setStdoutLength(result.stdoutLength);
        }
        return;
      }
      // 回填：只更新 workReview，保留 brainstorm/plan/audit/compound。
      setPhase("applying");
      onApply(result);
      setNextActionText(result.work.recommendedNextAction || "請進行 code review");
      setPhase("completed");
    } catch (e) {
      setPhase("failed");
      setMessage(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local`
      );
    }
  }

  return (
    <div className="ce-work-runner" data-testid="ce-work-runner">
      <div className="aiwf-actions">
        <button
          className="btn btn-primary"
          data-testid="ce-work-run"
          onClick={() => void handleRun()}
          disabled={running || !gate.canWork}
        >
          {running ? "CE Work 執行中…" : "開始 CE Work"}
        </button>
      </div>
      {!gate.canWork && (
        <div className="ce-work-gate-hint" data-testid="ce-work-gate-hint">
          尚不建議進入 Work：{gate.reason}
        </div>
      )}
      {phase !== "idle" && (
        <div
          className={`ce-work-status ce-work-${phase}`}
          data-testid="ce-work-status"
          data-phase={phase}
        >
          <div className="ce-work-status-text">
            {phase === "failed" ? message || CE_WORK_PHASE_TEXT.failed : CE_WORK_PHASE_TEXT[phase]}
          </div>
          {phase === "failed" && stdoutLength !== null && (
            <div className="ce-work-stdout-length" data-testid="ce-work-stdout-length">
              Verification stdout length: {stdoutLength}
            </div>
          )}
          {phase === "failed" && rawOutputPreview && (
            <div className="ce-work-raw-preview" data-testid="ce-work-raw-preview">
              <div className="ce-work-raw-preview-label">Verification 輸出預覽（截斷）</div>
              <pre className="ce-work-raw-preview-body">{rawOutputPreview}</pre>
            </div>
          )}
          {phase === "completed" && nextActionText && (
            <div className="ce-work-next-action" data-testid="ce-work-next-action">
              下一步：{nextActionText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Phase 72：CE Review runner endpoint。 */
const CE_REVIEW_URL = "http://localhost:4318/ce-review";

/**
 * Phase 72：CE Review 一鍵執行的階段。
 * - idle：未執行（不顯示狀態）
 * - running：已 confirm 並送出，等待 Claude 唯讀 review
 * - applying：收到結果，正在回填 Review 結果
 * - completed：已回填完成
 * - failed：gate 未過 / runner 未連線 / AI 失敗 / review_blocked 等
 */
type CeReviewPhase = "idle" | "running" | "applying" | "completed" | "failed";

const CE_REVIEW_PHASE_TEXT: Record<CeReviewPhase, string> = {
  idle: "",
  running: "正在執行 CE Review，正在等待 Claude Review...",
  applying: "正在回填 Review 結果...",
  completed: "已完成 CE Review（唯讀；未自動修正 / commit / 封存 / 完成）。",
  failed: "CE Review 失敗",
};

const CE_REVIEW_CONFIRM = "CE Review 只會讀取目標專案與 git diff，不會修改檔案。確定開始 Review 嗎？";

/**
 * Phase 72：CE Review 一鍵執行區塊（含 Work gate + 二次 confirm）。
 * Work 沒有結果時按鈕 disabled；有結果時按下需先 confirm，才呼叫 local runner /ce-review（唯讀）。
 * 成功後把 review 整理成 codeReviewNotes 合併進 task.aiWorkflow.workReview，保留其他段。
 * 不自動修正、不自動進入下一輪 Work、不自動 commit / push / 封存 / 套用完成狀態。
 */
function CeReviewRunner({
  task,
  aiCommand,
  onApply,
}: {
  task: Task;
  aiCommand: string;
  onApply: (result: CeReviewSuccess) => void;
}) {
  const [phase, setPhase] = useState<CeReviewPhase>("idle");
  const [message, setMessage] = useState("");
  const [verdict, setVerdict] = useState<CeReviewSuccess["review"]["result"] | null>(null);
  const running = phase === "running" || phase === "applying";
  const gate = evaluateCeReviewGate(task);

  // 切換任務時重置狀態。
  useEffect(() => {
    setPhase("idle");
    setMessage("");
    setVerdict(null);
  }, [task.id]);

  async function handleRun() {
    if (!window.confirm(CE_REVIEW_CONFIRM)) return;

    setPhase("running");
    setMessage("");
    setVerdict(null);
    try {
      const res = await fetch(CE_REVIEW_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, aiCommand }),
      });
      const raw: unknown = await res.json().catch(() => null);
      const result = parseCeReviewResult(raw);
      if (!result.ok) {
        setPhase("failed");
        setMessage(`失敗（${result.stoppedReason}）：${result.message}`);
        return;
      }
      // 回填：只更新 codeReviewNotes，保留其他段。
      setPhase("applying");
      onApply(result);
      setVerdict(result.review.result);
      setPhase("completed");
    } catch (e) {
      setPhase("failed");
      setMessage(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local`
      );
    }
  }

  return (
    <div className="ce-review-runner" data-testid="ce-review-runner">
      <div className="aiwf-actions">
        <button
          className="btn btn-primary"
          data-testid="ce-review-run"
          onClick={() => void handleRun()}
          disabled={running || !gate.canReview}
        >
          {running ? "CE Review 執行中…" : "開始 CE Review"}
        </button>
      </div>
      {!gate.canReview && (
        <div className="ce-review-gate-hint" data-testid="ce-review-gate-hint">
          尚未有 Work 結果，不建議進行 Review。
        </div>
      )}
      {phase !== "idle" && (
        <div
          className={`ce-review-status ce-review-${phase}`}
          data-testid="ce-review-status"
          data-phase={phase}
        >
          <div className="ce-review-status-text">
            {phase === "failed" ? message || CE_REVIEW_PHASE_TEXT.failed : CE_REVIEW_PHASE_TEXT[phase]}
          </div>
          {phase === "completed" && verdict && (
            <div
              className={`ce-review-verdict${verdict === "passed" ? " passed" : " needs-fix"}`}
              data-testid="ce-review-verdict"
              data-verdict={verdict}
            >
              {verdict === "passed" ? "Review 通過（passed）" : "Review 需要修正（needs_fix）"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Phase 73B：CE Fix Work runner endpoint。 */
const CE_FIX_WORK_URL = "http://localhost:4318/ce-fix-work";

/**
 * Phase 73B：CE Fix Work 一鍵執行的階段。
 * - idle：未執行（不顯示狀態）
 * - running：已 confirm 並送出，等待 Claude 修正 recommended fixes 與 verification
 * - applying：收到結果，正在回填 Fix 結果
 * - completed：已回填完成（停在 Review 前）
 * - failed：gate 未過 / runner 未連線 / AI 失敗 / verification 失敗 / fix_blocked 等
 */
type CeFixWorkPhase = "idle" | "running" | "applying" | "completed" | "failed";

const CE_FIX_WORK_PHASE_TEXT: Record<CeFixWorkPhase, string> = {
  idle: "",
  running: "正在執行 CE Fix Work，正在等待 Claude 修正 recommended fixes 與 verification...",
  applying: "正在回填 Fix 結果...",
  completed: "Fix Work 已完成，請再次執行 CE Review。",
  failed: "CE Fix Work 失敗",
};

const CE_FIX_WORK_CONFIRM =
  "CE Fix Work 會允許 Claude 修改目標專案檔案，但只應修正 Review 提出的 recommended fixes。確定開始修正嗎？";

/**
 * Phase 73B：CE Fix Work 一鍵執行區塊（CE Review needs_fix 時出現，含 fix gate + 二次 confirm）。
 * 成功後把修正合併進 workReview（去重 / append），codeReviewNotes 設為「待 Review」，停在 Review 前。
 * 不自動重跑 CE Review、不自動 commit / push、不自動封存、不自動套用完成狀態。
 */
function CeFixWorkRunner({
  task,
  aiCommand,
  onApply,
}: {
  task: Task;
  aiCommand: string;
  onApply: (result: CeFixWorkSuccess) => void;
}) {
  const [phase, setPhase] = useState<CeFixWorkPhase>("idle");
  const [message, setMessage] = useState("");
  const running = phase === "running" || phase === "applying";
  const gate = evaluateCeFixWorkGate(task);
  const needsFix = isCeReviewNeedsFix(task) && !isTaskFullyCompleted(task);

  // 切換任務時重置狀態。
  useEffect(() => {
    setPhase("idle");
    setMessage("");
  }, [task.id]);

  // 只在 needs_fix（未完成）時顯示；一旦執行過（phase 非 idle）保留狀態，
  // 讓「已完成，請再次 Review」訊息不會因 codeReviewNotes 變「待 Review」而立刻消失。
  if (!needsFix && phase === "idle") return null;

  async function handleRun() {
    if (!window.confirm(CE_FIX_WORK_CONFIRM)) return;

    setPhase("running");
    setMessage("");
    try {
      const res = await fetch(CE_FIX_WORK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, aiCommand }),
      });
      const raw: unknown = await res.json().catch(() => null);
      const result = parseCeFixWorkResult(raw);
      if (!result.ok) {
        setPhase("failed");
        setMessage(`失敗（${result.stoppedReason}）：${result.message}`);
        return;
      }
      // 回填：合併 workReview，codeReviewNotes 設為「待 Review」。
      setPhase("applying");
      onApply(result);
      setPhase("completed");
    } catch (e) {
      setPhase("failed");
      setMessage(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local`
      );
    }
  }

  return (
    <div className="ce-fix-work-runner" data-testid="ce-fix-work-runner">
      <div className="ce-fix-work-hint" data-testid="ce-fix-work-hint">
        CE Review 需要修正，可只針對 recommended fixes 進行最小修正。
      </div>
      <div className="aiwf-actions">
        <button
          className="btn btn-primary"
          data-testid="ce-fix-work-run"
          onClick={() => void handleRun()}
          disabled={running || !gate.canFix}
        >
          {running ? "CE Fix Work 執行中…" : "開始 CE Fix Work"}
        </button>
      </div>
      {phase !== "idle" && (
        <div
          className={`ce-fix-work-status ce-fix-work-${phase}`}
          data-testid="ce-fix-work-status"
          data-phase={phase}
        >
          <div className="ce-fix-work-status-text">
            {phase === "failed" ? message || CE_FIX_WORK_PHASE_TEXT.failed : CE_FIX_WORK_PHASE_TEXT[phase]}
          </div>
        </div>
      )}
    </div>
  );
}

/** Phase 77F：CE Commit checkpoint runner endpoint。 */
const CE_COMMIT_URL = "http://localhost:4318/ce-commit-checkpoint";

type CeCommitPhase = "idle" | "running" | "failed";

/**
 * Phase 77F：CE Commit checkpoint 區塊（CE Review passed 後出現）。
 * 自動產生建議 commit message（可編輯）；使用者按「確認並 Commit」後才呼叫
 * local runner /ce-commit-checkpoint（runner 先跑 verification，通過才 git add tracked files → git commit，不 push）。
 * 成功後把 commitMessage / commitHash / committedAt / committedFiles 寫回 aiWorkflow.workReview，
 * Commit checkpoint ✅，下一步進 Compound。
 * 「只記錄 smoke checkpoint」則不執行 git commit，只寫入固定標記 hash。
 */
function CeCommitCheckpointSection({
  task,
  onApply,
  onApplySmoke,
}: {
  task: Task;
  onApply: (result: CeCommitCheckpointSuccess) => void;
  onApplySmoke: (commitMessage: string) => void;
}) {
  const wr = task.aiWorkflow?.workReview;
  const visible = shouldShowCeCommitCheckpoint(task);
  const committed = (wr?.commitHash ?? "").trim().length > 0;
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<CeCommitPhase>("idle");
  const [failText, setFailText] = useState("");
  const [failPreviews, setFailPreviews] = useState<{ label: string; text: string }[]>([]);
  const [untrackedWarning, setUntrackedWarning] = useState<string[]>([]);
  const running = phase === "running";

  // 任務切換 / Review 剛 passed 時：重置狀態並自動產生建議 commit message（已有 commitMessage 沿用）。
  useEffect(() => {
    setPhase("idle");
    setFailText("");
    setFailPreviews([]);
    setUntrackedWarning([]);
    if (visible) {
      setMessage((task.aiWorkflow?.workReview?.commitMessage ?? "").trim() || generateCeCommitMessage(task));
    } else {
      setMessage("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, visible]);

  if (!visible) return null;

  async function handleCommit() {
    setPhase("running");
    setFailText("");
    setFailPreviews([]);
    setUntrackedWarning([]);
    try {
      const res = await fetch(CE_COMMIT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: task.projectPath ?? "",
          commitMessage: message,
          changedFiles: wr?.changedFiles ?? [],
        }),
      });
      const raw: unknown = await res.json().catch(() => null);
      const result = parseCeCommitCheckpointResult(raw);
      if (!result.ok) {
        setPhase("failed");
        setFailText(`失敗（${result.stoppedReason}）：${result.message}`);
        const previews: { label: string; text: string }[] = [];
        if (result.verificationPreview?.trim()) previews.push({ label: "Verification 輸出預覽", text: result.verificationPreview });
        if (result.stdoutPreview?.trim()) previews.push({ label: "stdout", text: result.stdoutPreview });
        if (result.stderrPreview?.trim()) previews.push({ label: "stderr", text: result.stderrPreview });
        setFailPreviews(previews);
        setUntrackedWarning(result.untrackedFiles ?? []);
        return;
      }
      // 回填 commit 紀錄（commitMessage / commitHash / committedAt / committedFiles），保留其他段。
      setUntrackedWarning(result.untrackedFiles);
      onApply(result);
      setPhase("idle");
    } catch (e) {
      setPhase("failed");
      setFailText(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local`
      );
    }
  }

  function handleSmoke() {
    onApplySmoke(message);
    setPhase("idle");
    setFailText("");
    setFailPreviews([]);
  }

  // 已 commit（或已記錄 smoke checkpoint）→ 顯示完成卡片。
  if (committed) {
    return (
      <div className="ce-commit-checkpoint completed" data-testid="ce-commit-checkpoint" data-committed="true">
        <div className="ce-commit-title">✅ Commit checkpoint</div>
        <div className="ce-commit-done-row" data-testid="ce-commit-done-message">Commit message：{wr?.commitMessage ?? ""}</div>
        <div className="ce-commit-done-row" data-testid="ce-commit-done-hash">Commit hash：{wr?.commitHash ?? ""}</div>
        {wr?.committedAt && (
          <div className="ce-commit-done-row" data-testid="ce-commit-done-at">Committed at：{wr.committedAt}</div>
        )}
        {(wr?.committedFiles?.length ?? 0) > 0 && (
          <ul className="ce-commit-files" data-testid="ce-commit-done-files">
            {wr?.committedFiles?.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}
        {untrackedWarning.length > 0 && (
          <div className="ce-commit-untracked" data-testid="ce-commit-untracked">
            有 {untrackedWarning.length} 個 untracked file 未加入 commit：{untrackedWarning.join("、")}
          </div>
        )}
        <div className="ce-commit-next" data-testid="ce-commit-next">下一步：Compound</div>
      </div>
    );
  }

  return (
    <div className="ce-commit-checkpoint" data-testid="ce-commit-checkpoint" data-committed="false">
      <div className="ce-commit-title">Commit checkpoint</div>
      <label className="aiwf-field">
        <span className="aiwf-field-label">建議 Commit message（可編輯）</span>
        <textarea
          className="aiwf-textarea"
          data-testid="ce-commit-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
        />
      </label>
      {(wr?.changedFiles?.length ?? 0) > 0 && (
        <div className="ce-commit-files-preview" data-testid="ce-commit-files">
          <div className="ce-commit-files-label">本次將 commit 的檔案（tracked 變更）：</div>
          <ul className="ce-commit-files">
            {wr?.changedFiles?.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}
      <div className="aiwf-actions">
        <button
          className="btn btn-primary"
          data-testid="ce-commit-run"
          onClick={() => void handleCommit()}
          disabled={running || message.trim().length === 0}
        >
          {running ? "Commit 執行中…" : "確認並 Commit"}
        </button>
        <button
          className="btn"
          data-testid="ce-commit-smoke"
          onClick={handleSmoke}
          disabled={running}
        >
          只記錄 smoke checkpoint（不 commit）
        </button>
      </div>
      {phase === "failed" && (
        <div className="ce-commit-status failed" data-testid="ce-commit-status" data-phase="failed">
          <div className="ce-commit-status-text">{failText}</div>
          {untrackedWarning.length > 0 && (
            <div className="ce-commit-untracked" data-testid="ce-commit-untracked">
              有 {untrackedWarning.length} 個 untracked file 未加入 commit：{untrackedWarning.join("、")}
            </div>
          )}
          {failPreviews.map((p) => (
            <div className="ce-commit-preview" key={p.label}>
              <div className="ce-commit-preview-label">{p.label}（截斷）</div>
              <pre className="ce-commit-preview-body">{p.text}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Phase 75：CE Artifact Export runner endpoint。 */
const CE_EXPORT_URL = "http://localhost:4318/export-ce-artifacts";

/**
 * Phase 75：CE Artifact Export 一鍵匯出的階段。
 * - idle：未執行（不顯示狀態）
 * - running：已送出，runner 正在寫檔
 * - completed：已匯出，顯示輸出目錄與檔案清單
 * - failed：runner 未連線 / projectPath 無效 / 寫檔失敗等
 */
type CeExportPhase = "idle" | "running" | "completed" | "failed";

/**
 * Phase 75：CE Artifact Export 一鍵匯出區塊（OpenSpec-like）。
 * 呼叫 local runner /export-ce-artifacts，把任務的 CE workflow 紀錄寫成
 * docs/ai-workflows/<task-slug>/ 下的固定 markdown + metadata.json。
 *
 * 重要：使用「已保存的 task」資料（非畫面未保存 draft），所以剛產生但未保存的 Compound Notes
 * 不會被偷偷匯出。runner 不 commit / push / 封存、不改完成狀態、不呼叫 AI、不執行任意 shell。
 */
function CeArtifactExportRunner({ task }: { task: Task }) {
  const [phase, setPhase] = useState<CeExportPhase>("idle");
  const [message, setMessage] = useState("");
  const [relativeDir, setRelativeDir] = useState("");
  const [files, setFiles] = useState<CeArtifactExportedFile[]>([]);
  const running = phase === "running";

  // 切換任務時重置狀態。
  useEffect(() => {
    setPhase("idle");
    setMessage("");
    setRelativeDir("");
    setFiles([]);
  }, [task.id]);

  async function handleRun() {
    setPhase("running");
    setMessage("");
    setRelativeDir("");
    setFiles([]);
    try {
      const res = await fetch(CE_EXPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const raw: unknown = await res.json().catch(() => null);
      const result = parseCeArtifactExportResult(raw);
      if (!result.ok) {
        setPhase("failed");
        setMessage(`失敗（${result.stoppedReason}）：${result.message}`);
        return;
      }
      setRelativeDir(result.artifact.relativeDir);
      setFiles(result.artifact.files);
      setPhase("completed");
    } catch (e) {
      setPhase("failed");
      setMessage(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local`
      );
    }
  }

  return (
    <div className="ce-export-runner" data-testid="ce-export-runner">
      <div className="ce-export-hint" data-testid="ce-export-hint">
        匯出使用「已保存」的 AI Workflow 資料；若剛修改或產生 Compound Notes，請先按「保存 AI Workflow」再匯出。
      </div>
      <div className="aiwf-actions">
        <button
          className="btn btn-primary"
          data-testid="ce-export-run"
          onClick={() => void handleRun()}
          disabled={running}
        >
          {running ? "正在匯出 CE Artifacts…" : "匯出 CE Artifacts"}
        </button>
      </div>
      {phase !== "idle" && (
        <div
          className={`ce-export-status ce-export-${phase}`}
          data-testid="ce-export-status"
          data-phase={phase}
        >
          <div className="ce-export-status-text">
            {phase === "running" && "正在匯出 CE Artifacts..."}
            {phase === "failed" && (message || "CE Artifacts 匯出失敗")}
            {phase === "completed" && "已匯出 CE Artifacts"}
          </div>
          {phase === "completed" && (
            <>
              <div className="ce-export-dir" data-testid="ce-export-dir">
                輸出目錄：{relativeDir}
              </div>
              <ul className="ce-export-files" data-testid="ce-export-files">
                {files.map((f) => (
                  <li key={f.name} data-testid="ce-export-file">
                    {f.relativePath}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type Props = {
  task: Task;
  onSave: (aiWorkflow: AiEngineeringWorkflow | undefined) => void;
  /** Phase 70：CE Readonly Workflow 用的 AI Command（沿用全域 AI Command 設定）。 */
  aiCommand: string;
  /** Phase 70：套用 runner 回填的 brainstorm / plan / audit（保留 work/review/compound）。 */
  onApplyCeReadonlyWorkflow: (workflow: AiEngineeringWorkflow) => void;
  /** Phase 71：套用 CE Work 結果（更新 workReview，保留 brainstorm/plan/audit/compound）。 */
  onApplyCeWorkResult: (result: CeWorkSuccess) => void;
  /** Phase 72：套用 CE Review 結果（更新 codeReviewNotes，保留其他段）。 */
  onApplyCeReviewResult: (result: CeReviewSuccess) => void;
  /** Phase 73B：套用 CE Fix Work 結果（合併 workReview，codeReviewNotes 設為「待 Review」）。 */
  onApplyCeFixWorkResult: (result: CeFixWorkSuccess) => void;
};

/**
 * Phase 68：各階段 copy prompt 按鈕。
 * getText 在點擊當下才產生 prompt（使用最新 draft），只寫剪貼簿、不保存 draft。
 * 失敗時沿用專案既有 copy button 風格以 alert 提示。
 */
function AiwfCopyButton({
  label,
  copiedLabel,
  testId,
  getText,
}: {
  label: string;
  copiedLabel: string;
  testId: string;
  getText: () => string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗，請手動複製：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy aiwf-copy-button${copied ? " copied" : ""}`}
      data-testid={testId}
      onClick={() => void handleCopy()}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

export function AiWorkflowSection({ task, onSave, aiCommand, onApplyCeReadonlyWorkflow, onApplyCeWorkResult, onApplyCeReviewResult, onApplyCeFixWorkResult }: Props) {
  const [draft, setDraft] = useState<Draft>(() => taskToDraft(task));
  const [saved, setSaved] = useState(false);
  // Phase 74：是否已產生 Compound Notes 草稿（提示使用者仍需保存）。
  const [compoundGenerated, setCompoundGenerated] = useState(false);

  // 切換任務時重置草稿（同一任務內的其他欄位更新不會清掉編輯中內容）。
  useEffect(() => {
    setDraft(taskToDraft(task));
    setSaved(false);
    setCompoundGenerated(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  function patch(values: Partial<Draft>) {
    setDraft((prev) => ({ ...prev, ...values }));
  }

  function toggleChecklist(key: keyof PlanAuditChecklist) {
    setDraft((prev) => ({
      ...prev,
      checklist: { ...prev.checklist, [key]: !prev.checklist[key] },
    }));
  }

  function handleSave() {
    onSave(draftToWorkflow(draft));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  /**
   * 以目前畫面最新 draft 組出 task-like object 給 prompt builder 使用，
   * 讓使用者不需先按「保存 AI Workflow」就能複製含最新欄位的 prompt。只讀取、不保存。
   */
  function effectiveTask(): Task {
    return { ...task, aiWorkflow: draftToWorkflow(draft) };
  }

  /**
   * Phase 70：CE Readonly Workflow 成功回傳後的回填處理。
   * 1. 持久化合併（保留 Work/Review/Compound）。2. 同步更新本機 draft，讓輸入框與進度總覽即時反映。
   */
  function handleApplyCeReadonly(workflow: AiEngineeringWorkflow) {
    onApplyCeReadonlyWorkflow(workflow);
    setDraft((prev) => applyWorkflowToDraft(prev, workflow));
  }

  /**
   * Phase 71：CE Work 成功回傳後的回填處理。
   * 1. 持久化合併（保留 brainstorm/plan/audit/compound）。2. 同步更新本機 draft 的 work/review 欄位。
   */
  function handleApplyCeWork(result: CeWorkSuccess) {
    onApplyCeWorkResult(result);
    const mergedWf = mergeCeWorkResult(effectiveTask().aiWorkflow, result);
    setDraft((prev) => applyWorkReviewToDraft(prev, mergedWf.workReview));
  }

  /**
   * Phase 72：CE Review 成功回傳後的回填處理。
   * 1. 持久化合併（只更新 codeReviewNotes，保留其他段）。2. 同步更新本機 draft 的 codeReviewNotes。
   */
  function handleApplyCeReview(result: CeReviewSuccess) {
    onApplyCeReviewResult(result);
    const mergedWf = mergeCeReviewResult(effectiveTask().aiWorkflow, result);
    setDraft((prev) => ({ ...prev, codeReviewNotes: mergedWf.workReview?.codeReviewNotes ?? "" }));
  }

  /**
   * Phase 73B：CE Fix Work 成功回傳後的回填處理。
   * 1. 持久化合併（workReview 去重 / append，codeReviewNotes 設「待 Review」）。2. 同步更新本機 draft。
   */
  function handleApplyCeFixWork(result: CeFixWorkSuccess) {
    onApplyCeFixWorkResult(result);
    const mergedWf = mergeCeFixWorkResult(effectiveTask().aiWorkflow, result);
    setDraft((prev) => applyWorkReviewToDraft(prev, mergedWf.workReview));
  }

  /**
   * Phase 77F：CE Commit checkpoint 成功回傳後的回填處理。
   * 1. 合併 commitMessage / commitHash / committedAt / committedFiles 進 workReview 並持久化（onSave）。
   * 2. 同步更新本機 draft，讓 Commit 進度 ✅ 與欄位即時反映。
   */
  function handleApplyCeCommit(result: CeCommitCheckpointSuccess) {
    const mergedWf = mergeCeCommitCheckpointResult(effectiveTask().aiWorkflow, result);
    onSave(mergedWf);
    setDraft((prev) => applyWorkReviewToDraft(prev, mergedWf.workReview));
  }

  /**
   * Phase 77F：「只記錄 smoke checkpoint」：不執行 git commit，
   * commitHash 寫入固定標記字串，讓 Commit checkpoint 可標記完成。
   */
  function handleApplyCeCommitSmoke(commitMessage: string) {
    const mergedWf = mergeCeCommitSmokeCheckpoint(effectiveTask().aiWorkflow, commitMessage, new Date().toISOString());
    onSave(mergedWf);
    setDraft((prev) => applyWorkReviewToDraft(prev, mergedWf.workReview));
  }

  /**
   * Phase 74：以目前畫面最新 draft 產生 Compound Notes 草稿。
   * 只回填 local draft 的 compound 三欄，不呼叫 onSave、不呼叫 runner、不修改 target project。
   * 使用者仍需按「保存 AI Workflow」才寫入 localStorage。
   */
  function handleGenerateCompound() {
    const compound = buildCeCompoundDraft(effectiveTask());
    setDraft((prev) => ({
      ...prev,
      reusablePrompt: compound.reusablePrompt ?? "",
      lessonLearned: compound.lessonLearned ?? "",
      compoundNotes: compound.compoundNotes ?? "",
    }));
    setCompoundGenerated(true);
  }

  return (
    <div className="detail-section ai-workflow-section" data-testid="ai-workflow">
      <div className="detail-label">AI Workflow</div>
      <div className="detail-empty-text" style={{ marginBottom: 6 }}>
        Hack22 / Compound Engineering 工作流欄位：brainstorm → plan → audit → work/review →
        compound。所有欄位皆可留白。
      </div>

      {/* Phase 69：以最新 draft 即時推導階段總覽（只讀取、不保存）。 */}
      <AiWorkflowProgressPanel task={effectiveTask()} />

      {/* Phase 70：CE Readonly Workflow 一鍵執行（Brainstorm → Plan → Audit → 回填，停在 Work 前）。 */}
      <CeReadonlyWorkflowRunner
        task={task}
        aiCommand={aiCommand}
        onApply={handleApplyCeReadonly}
      />

      {/* Phase 71：CE Work 一鍵執行（Audit gate + confirm → 依已審核 plan 實作 → 回填 workReview，停在 Review 前）。 */}
      <CeWorkRunner
        task={effectiveTask()}
        aiCommand={aiCommand}
        onApply={handleApplyCeWork}
      />

      {/* Phase 72：CE Review 一鍵執行（Work gate + confirm → 唯讀 review → 回填 codeReviewNotes）。 */}
      <CeReviewRunner
        task={effectiveTask()}
        aiCommand={aiCommand}
        onApply={handleApplyCeReview}
      />

      {/* Phase 73B：CE Fix Work（needs_fix 時出現，confirm → 只修 recommended fixes → 回填，停在 Review 前）。 */}
      <CeFixWorkRunner
        task={effectiveTask()}
        aiCommand={aiCommand}
        onApply={handleApplyCeFixWork}
      />

      {/* Phase 77F：CE Commit checkpoint（Review passed 後出現；使用者按確認才 commit；不 push）。 */}
      <CeCommitCheckpointSection
        task={effectiveTask()}
        onApply={handleApplyCeCommit}
        onApplySmoke={handleApplyCeCommitSmoke}
      />

      <details className="aiwf-details">
        <summary className="aiwf-summary" data-testid="aiwf-toggle-brainstorm">
          A. Brainstorm
        </summary>
        <div className="aiwf-fields">
          <label className="aiwf-field">
            <span className="aiwf-field-label">Brainstorm 文件路徑</span>
            <input
              className="aiwf-input"
              data-testid="aiwf-brainstorm-path"
              value={draft.brainstormPath}
              onChange={(e) => patch({ brainstormPath: e.target.value })}
              placeholder="docs/brainstorms/xxx.md"
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Brainstorm 摘要</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-brainstorm-summary"
              value={draft.brainstormSummary}
              onChange={(e) => patch({ brainstormSummary: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Brainstorm 狀態</span>
            <select
              className="aiwf-select"
              data-testid="aiwf-brainstorm-status"
              value={draft.brainstormStatus}
              onChange={(e) => patch({ brainstormStatus: e.target.value as Draft["brainstormStatus"] })}
            >
              <option value="">（未設定）</option>
              {BRAINSTORM_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <div className="aiwf-actions">
            <AiwfCopyButton
              label="複製 Brainstorm Prompt"
              copiedLabel="✓ 已複製 Brainstorm Prompt"
              testId="aiwf-copy-brainstorm"
              getText={() => buildBrainstormPrompt(effectiveTask())}
            />
          </div>
        </div>
      </details>

      <details className="aiwf-details">
        <summary className="aiwf-summary" data-testid="aiwf-toggle-plan">
          B. Plan
        </summary>
        <div className="aiwf-fields">
          <label className="aiwf-field">
            <span className="aiwf-field-label">Plan 文件路徑</span>
            <input
              className="aiwf-input"
              data-testid="aiwf-plan-path"
              value={draft.planPath}
              onChange={(e) => patch({ planPath: e.target.value })}
              placeholder="docs/plans/xxx.md"
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Plan 摘要</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-plan-summary"
              value={draft.planSummary}
              onChange={(e) => patch({ planSummary: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Plan 狀態</span>
            <select
              className="aiwf-select"
              data-testid="aiwf-plan-status"
              value={draft.planStatus}
              onChange={(e) => patch({ planStatus: e.target.value as Draft["planStatus"] })}
            >
              <option value="">（未設定）</option>
              {PLAN_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <div className="aiwf-actions">
            <AiwfCopyButton
              label="複製 ce-plan Prompt"
              copiedLabel="✓ 已複製 ce-plan Prompt"
              testId="aiwf-copy-plan"
              getText={() => buildPlanPrompt(effectiveTask())}
            />
          </div>
        </div>
      </details>

      <details className="aiwf-details">
        <summary className="aiwf-summary" data-testid="aiwf-toggle-audit">
          C. Audit
        </summary>
        <div className="aiwf-fields">
          <label className="aiwf-field">
            <span className="aiwf-field-label">審計筆記</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-audit-notes"
              value={draft.auditNotes}
              onChange={(e) => patch({ auditNotes: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">核心假設（每行一項）</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-audit-core-assumptions"
              value={draft.auditCoreAssumptions}
              onChange={(e) => patch({ auditCoreAssumptions: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">風險（每行一項）</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-audit-risk-notes"
              value={draft.auditRiskNotes}
              onChange={(e) => patch({ auditRiskNotes: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">驗收標準（每行一項）</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-audit-acceptance-criteria"
              value={draft.auditAcceptanceCriteria}
              onChange={(e) => patch({ auditAcceptanceCriteria: e.target.value })}
              rows={3}
            />
          </label>
          <div className="aiwf-checklist">
            {CHECKLIST_ITEMS.map((item) => (
              <label key={item.key} className="aiwf-checkbox-label">
                <input
                  type="checkbox"
                  data-testid={`aiwf-check-${item.key}`}
                  checked={draft.checklist[item.key]}
                  onChange={() => toggleChecklist(item.key)}
                />
                {item.label}
              </label>
            ))}
          </div>
          <div className="aiwf-actions">
            <AiwfCopyButton
              label="複製 Audit Prompt"
              copiedLabel="✓ 已複製 Audit Prompt"
              testId="aiwf-copy-audit"
              getText={() => buildAuditPrompt(effectiveTask())}
            />
          </div>
        </div>
      </details>

      <details className="aiwf-details">
        <summary className="aiwf-summary" data-testid="aiwf-toggle-work-review">
          D. Work / Review
        </summary>
        <div className="aiwf-fields">
          <label className="aiwf-field">
            <span className="aiwf-field-label">修改的檔案（每行一項）</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-changed-files"
              value={draft.changedFiles}
              onChange={(e) => patch({ changedFiles: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">測試指令（每行一項）</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-test-commands"
              value={draft.testCommands}
              onChange={(e) => patch({ testCommands: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">測試結果</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-test-results"
              value={draft.testResults}
              onChange={(e) => patch({ testResults: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Code review 筆記</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-code-review-notes"
              value={draft.codeReviewNotes}
              onChange={(e) => patch({ codeReviewNotes: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Commit hash</span>
            <input
              className="aiwf-input"
              data-testid="aiwf-commit-hash"
              value={draft.commitHash}
              onChange={(e) => patch({ commitHash: e.target.value })}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Commit message</span>
            <input
              className="aiwf-input"
              data-testid="aiwf-commit-message"
              value={draft.commitMessage}
              onChange={(e) => patch({ commitMessage: e.target.value })}
            />
          </label>
          <div className="aiwf-actions">
            <AiwfCopyButton
              label="複製 Work Prompt"
              copiedLabel="✓ 已複製 Work Prompt"
              testId="aiwf-copy-work"
              getText={() => buildWorkPrompt(effectiveTask())}
            />
            <AiwfCopyButton
              label="複製 Review Prompt"
              copiedLabel="✓ 已複製 Review Prompt"
              testId="aiwf-copy-review"
              getText={() => buildReviewPrompt(effectiveTask())}
            />
          </div>
        </div>
      </details>

      <details className="aiwf-details">
        <summary className="aiwf-summary" data-testid="aiwf-toggle-compound">
          E. Compound
        </summary>
        <div className="aiwf-fields">
          {/* Phase 74：以目前 draft 產生 Compound Notes 草稿（不自動保存）。 */}
          <div className="aiwf-actions">
            <button
              className="btn btn-primary"
              data-testid="aiwf-generate-compound"
              onClick={handleGenerateCompound}
            >
              產生 Compound Notes
            </button>
          </div>
          {compoundGenerated && (
            <div className="aiwf-compound-hint" data-testid="aiwf-compound-hint">
              已產生 Compound Notes 草稿，請確認後保存 AI Workflow。
            </div>
          )}
          <label className="aiwf-field">
            <span className="aiwf-field-label">可重用 prompt</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-reusable-prompt"
              value={draft.reusablePrompt}
              onChange={(e) => patch({ reusablePrompt: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">學到的事</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-lesson-learned"
              value={draft.lessonLearned}
              onChange={(e) => patch({ lessonLearned: e.target.value })}
              rows={3}
            />
          </label>
          <label className="aiwf-field">
            <span className="aiwf-field-label">Compound 筆記</span>
            <textarea
              className="aiwf-textarea"
              data-testid="aiwf-compound-notes"
              value={draft.compoundNotes}
              onChange={(e) => patch({ compoundNotes: e.target.value })}
              rows={3}
            />
          </label>

          {/* Phase 75：CE Artifact Export（使用已保存 task 資料寫入 target project，不含未保存 draft）。 */}
          <CeArtifactExportRunner task={task} />
        </div>
      </details>

      <div className="aiwf-actions">
        <button
          className={`btn btn-primary${saved ? " copied" : ""}`}
          data-testid="aiwf-save"
          onClick={handleSave}
        >
          {saved ? "✓ 已保存 AI Workflow" : "保存 AI Workflow"}
        </button>
      </div>
    </div>
  );
}
