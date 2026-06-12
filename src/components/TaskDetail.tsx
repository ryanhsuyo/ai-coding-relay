import { useState, useEffect, useCallback, useRef } from "react";
import type { Task, TaskRound, TaskStatus, TaskPriority, TaskReviewResult, FileGuardResult, WorkflowStage, AiEngineeringWorkflow, CeWorkSuccess, CeReviewSuccess, CeFixWorkSuccess } from "../shared/types";
import { normalizeTags } from "../core/taskService";
import { shouldShowCeCompletionGate, shouldShowCeReviewNeedsFix } from "../core/ceCompletion";
import { buildAutoSummaryDraft } from "../hooks/useTasks";
import { formatDateTime } from "../utils/date";
import { PromptPanel } from "./PromptPanel";
import { RoundTimeline } from "./RoundTimeline";
import { AiWorkflowSection } from "./AiWorkflowSection";

type RoundPatch = Partial<Omit<TaskRound, "id" | "taskId" | "roundIndex" | "createdAt">>;

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: "todo",        label: "待處理" },
  { value: "in_progress", label: "進行中" },
  { value: "done",        label: "已完成" },
];

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: "high",   label: "⬆ 高" },
  { value: "medium", label: "➡ 中" },
  { value: "low",    label: "⬇ 低" },
];

const REVIEW_OPTIONS: { value: TaskReviewResult; label: string }[] = [
  { value: "not_reviewed", label: "未驗收" },
  { value: "passed",       label: "通過" },
  { value: "needs_fix",    label: "需修改" },
];

const WORKFLOW_STAGE_NAME: Record<WorkflowStage, string> = {
  spec:            "規格撰寫",
  spec_review:     "規格審查",
  red_test:        "紅燈測試",
  green_implement: "綠燈實作",
  refactor:        "重構",
  verify:          "本機驗證",
  review:          "審查",
  fix:             "修正",
  done:            "完成",
};

const WORKFLOW_STAGE_OPTIONS: { value: WorkflowStage; label: string }[] = [
  { value: "spec",            label: "規格撰寫 spec" },
  { value: "spec_review",     label: "規格審查 spec_review" },
  { value: "red_test",        label: "紅燈測試 red_test" },
  { value: "green_implement", label: "綠燈實作 green_implement" },
  { value: "refactor",        label: "重構 refactor" },
  { value: "verify",          label: "本機驗證 verify" },
  { value: "review",          label: "審查 review" },
  { value: "fix",             label: "修正 fix" },
  { value: "done",            label: "完成 done" },
];

/** 各 workflowStage 的操作提示：告訴使用者此階段該做什麼、建議按哪個 Prompt。 */
const WORKFLOW_STAGE_HINT: Record<WorkflowStage, string> = {
  spec:            "撰寫或產生 specDraft。建議使用「複製 Spec Prompt」。",
  spec_review:     "檢查 specDraft 是否完整可測試。建議使用「複製 Spec Review Prompt」。",
  red_test:        "根據 specDraft 產生會先失敗的測試。建議使用「複製測試 Prompt」。",
  green_implement: "根據 specDraft 與測試做最小實作。建議使用「複製實作 Prompt」。",
  refactor:        "在測試通過後做不改變行為的小範圍重構。建議使用「複製重構 Prompt」。",
  verify:          "執行 File Guard 設定指令與 pnpm verify:copy，並匯入驗證結果。",
  review:          "根據驗證結果審查修改。建議使用「複製審查 Prompt」。",
  fix:             "根據審查結果與 nextActions 修正。建議使用「複製修正 Prompt」。",
  done:            "任務已完成，可填 summary 並封存。",
};

/** workflowStage 的「下一階段」推進對照表；done 維持 done（不再推進）。 */
const NEXT_WORKFLOW_STAGE: Record<WorkflowStage, WorkflowStage> = {
  spec:            "spec_review",
  spec_review:     "red_test",
  red_test:        "green_implement",
  green_implement: "refactor",
  refactor:        "verify",
  verify:          "review",
  review:          "done",
  fix:             "green_implement",
  done:            "done",
};

const TYPE_LABEL: Record<string, string> = {
  ui: "UI 修改",
  bug: "Bug 修正",
  typescript: "TypeScript 錯誤",
  refactor: "重構",
  api: "API 串接",
  test: "Test 補強",
  docs: "文件",
  other: "其他",
};

type Props = {
  task: Task | null;
  rounds: TaskRound[];
  onAddRound: (prompt: string, claudeResponse: string) => void;
  onEditRound: (roundId: string, patch: RoundPatch) => void;
  onSetTaskStatus: (status: TaskStatus) => void;
  onSetTaskPriority: (priority: TaskPriority) => void;
  onSetDueDate: (dueDate: string | undefined) => void;
  onSetReviewResult: (result: TaskReviewResult) => void;
  onSetWorkflowStage: (stage: WorkflowStage) => void;
  /**
   * 一鍵套用完成狀態：保存目前摘要 + status=done、reviewResult=passed、workflowStage=done
   * + completedAt + completionHistory（不封存）。傳入的字串為目前摘要 textarea 的最新內容。
   */
  onApplyCompletion: (summaryText: string) => void;
  onSaveTitle: (title: string) => void;
  onSaveRequirement: (req: string) => void;
  onSaveSummary: (summary: string) => void;
  onSaveTags: (tagsText: string) => void;
  onSaveProject: (project: string) => void;
  onSaveClaudeResponse: (value: string) => void;
  onSaveNextActions: (value: string) => void;
  onSaveSpecDraft: (value: string) => void;
  /** 保存 AI Engineering Workflow 欄位（Phase 67）；undefined 代表全部空白、清空 aiWorkflow。 */
  onSaveAiWorkflow: (aiWorkflow: AiEngineeringWorkflow | undefined) => void;
  /** 套用 CE Readonly Workflow 回填的 brainstorm / plan / audit（Phase 70）；保留 work/review/compound。 */
  onApplyCeReadonlyWorkflow: (aiWorkflow: AiEngineeringWorkflow) => void;
  /** 套用 CE Work 結果（Phase 71）：更新 workReview，保留 brainstorm/plan/audit/compound。 */
  onApplyCeWorkResult: (result: CeWorkSuccess) => void;
  /** 套用 CE Review 結果（Phase 72）：更新 codeReviewNotes，保留其他段。 */
  onApplyCeReviewResult: (result: CeReviewSuccess) => void;
  /** 套用 CE Fix Work 結果（Phase 73B）：合併 workReview，codeReviewNotes 設為「待 Review」。 */
  onApplyCeFixWorkResult: (result: CeFixWorkSuccess) => void;
  /** 匯入本機驗證 JSON；格式錯誤時會丟出錯誤，由本元件 alert 顯示。 */
  onImportVerification: (jsonText: string) => void;
  onArchiveTask: () => void;
  onRestoreTask: () => void;
  onEditTask: () => void;
  onDuplicateTask: () => void;
  onDeleteTask: () => void;
  /** 為 true 時，進入此任務後自動執行一次 auto-round（「建立並執行 auto-round」用）。 */
  autoRunOnMount?: boolean;
  /** auto-round 自動觸發後立即呼叫，讓上層清除 pending 標記，避免重複執行。 */
  onAutoRunConsumed?: () => void;
};

export function TaskDetail({ task, rounds, onAddRound, onEditRound, onSetTaskStatus, onSetTaskPriority, onSetDueDate, onSetReviewResult, onSetWorkflowStage, onApplyCompletion, onSaveTitle, onSaveRequirement, onSaveSummary, onSaveTags, onSaveProject, onSaveClaudeResponse, onSaveNextActions, onSaveSpecDraft, onSaveAiWorkflow, onApplyCeReadonlyWorkflow, onApplyCeWorkResult, onApplyCeReviewResult, onApplyCeFixWorkResult, onImportVerification, onArchiveTask, onRestoreTask, onEditTask, onDuplicateTask, onDeleteTask, autoRunOnMount = false, onAutoRunConsumed }: Props) {
  const [titleDraft, setTitleDraft] = useState(task?.title ?? "");
  // 摘要 textarea 內容提升到 TaskDetail，讓「保存摘要」與「套用完成狀態」共用同一份最新草稿。
  const [summaryDraft, setSummaryDraft] = useState(task?.summary ?? "");
  // 全域 AI Command 設定（localStorage 持久化），供 auto-spec / auto-round / auto-loop 共用。
  const [aiCommand, setAiCommand] = useAiCommand();
  // 共用的 Preflight 控制器：Preflight 區塊與 auto-round / auto-loop 自動前置檢查共用同一份狀態。
  const preflight = usePreflight(task?.projectPath ?? "");

  useEffect(() => {
    setTitleDraft(task?.title ?? "");
  }, [task?.id]);

  // 切換任務、或外部更新 summary（匯入自動產生、保存摘要、套用完成）時，同步回 textarea。
  useEffect(() => {
    setSummaryDraft(task?.summary ?? "");
  }, [task?.id, task?.summary]);

  if (!task) {
    return (
      <div className="task-detail-empty">
        <span>← 從左側選取一個任務</span>
      </div>
    );
  }

  function handleTitleBlur() {
    if (!task) return;
    const trimmed = titleDraft.trim();
    if (!trimmed) { setTitleDraft(task.title); return; }
    if (trimmed !== task.title) onSaveTitle(trimmed);
  }

  return (
    <div className="task-detail-wrap">
      <div className="task-detail-title-row">
        <input
          className="task-detail-title-input"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
        <div className="task-detail-actions">
          <div className="task-detail-action-group" aria-label="Prompt 工具">
            <CopySpecPromptButton task={task} />
            <CopySpecReviewPromptButton task={task} />
            <CopyTestPromptButton task={task} />
            <CopyPromptButton task={task} />
            <CopyRefactorPromptButton task={task} rounds={rounds} />
            <CopyReviewPromptButton task={task} rounds={rounds} />
            <CopyFixPromptButton task={task} rounds={rounds} />
          </div>
          <div className="task-detail-action-group" aria-label="任務操作">
            <button className="btn" onClick={onEditTask}>
              編輯
            </button>
            <button className="btn" onClick={onDuplicateTask}>
              複製
            </button>
            {task.archived ? (
              <button className="btn btn-restore" onClick={onRestoreTask}>
                還原
              </button>
            ) : (
              <button className="btn btn-archive" onClick={onArchiveTask}>
                封存
              </button>
            )}
            <button
              className="btn btn-danger"
              onClick={() => {
                if (window.confirm(`確定要刪除「${task.title}」？此操作無法復原。`)) {
                  onDeleteTask();
                }
              }}
            >
              刪除
            </button>
          </div>
        </div>
      </div>

      <div className="task-detail-meta">
        <span className={`badge type-${task.type}`}>
          {TYPE_LABEL[task.type] ?? task.type}
        </span>
        <select
          className="status-select"
          data-status={task.status}
          value={task.status}
          onChange={(e) => onSetTaskStatus(e.target.value as TaskStatus)}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          className="priority-select"
          data-priority={task.priority}
          value={task.priority}
          onChange={(e) => onSetTaskPriority(e.target.value as TaskPriority)}
        >
          {PRIORITY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          className="review-select"
          data-review={task.reviewResult ?? "not_reviewed"}
          value={task.reviewResult ?? "not_reviewed"}
          onChange={(e) => onSetReviewResult(e.target.value as TaskReviewResult)}
        >
          {REVIEW_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <select
          className="workflow-stage-select"
          data-stage={task.workflowStage ?? "spec"}
          value={task.workflowStage ?? "spec"}
          onChange={(e) => onSetWorkflowStage(e.target.value as WorkflowStage)}
        >
          {WORKFLOW_STAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {(() => {
          const current = task.workflowStage ?? "spec";
          const next = NEXT_WORKFLOW_STAGE[current];
          const isDone = current === "done";
          return (
            <button
              className="btn workflow-next-btn"
              disabled={isDone}
              onClick={() => { if (!isDone) onSetWorkflowStage(next); }}
            >
              {isDone ? "已完成" : `下一階段：${WORKFLOW_STAGE_NAME[next]}`}
            </button>
          );
        })()}
        <span className="due-date-field">
          <label className="due-date-label">截止日</label>
          <input
            type="date"
            className="due-date-input"
            value={task.dueDate ?? ""}
            onChange={(e) => onSetDueDate(e.target.value || undefined)}
          />
        </span>
        {task.projectPath && (
          <span style={{ fontSize: "12px", color: "#888" }}>
            📁 {task.projectPath}
          </span>
        )}
      </div>

      <div className="workflow-stage-hint">
        <span className="workflow-stage-hint-label">
          {WORKFLOW_STAGE_NAME[task.workflowStage ?? "spec"]}
        </span>
        <span className="workflow-stage-hint-text">
          {WORKFLOW_STAGE_HINT[task.workflowStage ?? "spec"]}
        </span>
      </div>

      <ProjectSection task={task} onSave={onSaveProject} />
      <TagsSection task={task} onSave={onSaveTags} />

      <EditableSection label="原始需求" value={task.originalRequirement} taskId={task.id} onSave={onSaveRequirement} />
      <AiWorkflowSection task={task} onSave={onSaveAiWorkflow} aiCommand={aiCommand} onApplyCeReadonlyWorkflow={onApplyCeReadonlyWorkflow} onApplyCeWorkResult={onApplyCeWorkResult} onApplyCeReviewResult={onApplyCeReviewResult} onApplyCeFixWorkResult={onApplyCeFixWorkResult} />
      <AiCommandSection aiCommand={aiCommand} onChange={setAiCommand} />
      <RunnerStatusSection />
      <PreflightSection preflight={preflight} />
      <SpecDraftSection task={task} onSave={onSaveSpecDraft} aiCommand={aiCommand} />
      <ListSection label="目標檔案" items={task.targetFiles} />
      <ListSection label="禁止修改範圍" items={task.forbiddenFiles} />
      <ListSection label="限制條件" items={task.constraints} />
      <ListSection label="驗收條件" items={task.acceptanceCriteria} />

      <ClaudeResponseSection
        claudeResponse={task.claudeResponse}
        taskId={task.id}
        onSave={onSaveClaudeResponse}
      />

      <NextActionsSection
        nextActions={task.nextActions}
        taskId={task.id}
        onSave={onSaveNextActions}
      />

      <SummarySection
        draft={summaryDraft}
        onDraftChange={setSummaryDraft}
        summary={task.summary}
        onSave={onSaveSummary}
        task={task}
        rounds={rounds}
      />

      <PromptPanel task={task} onAddRound={onAddRound} />
      <VerificationImportSection task={task} onImport={onImportVerification} aiCommand={aiCommand} runPreflight={preflight.runPreflight} autoRunOnMount={autoRunOnMount} onAutoRunConsumed={onAutoRunConsumed} />
      <CompletionSuggestionSection task={task} rounds={rounds} onApply={() => onApplyCompletion(summaryDraft)} />
      <CeCompletionGateSection task={task} onApply={() => onApplyCompletion(summaryDraft)} />
      <CompletionHistorySection task={task} />
      <RoundTimeline rounds={rounds} task={task} onEditRound={onEditRound} />
    </div>
  );
}

/** 實作 prompt 共用的回覆格式要求。 */
const IMPL_REPLY_FORMAT = `回覆請包含：
- 修改檔案清單（含路徑）。
- 實作摘要。
- 這次實作對應哪些測試或驗收條件。
- 是否有未完成事項。
- 建議我執行的驗證指令（例如 pnpm verify:copy）。`;

/** specDraft 存在時的實作要求：TDD green phase，以最小實作讓測試通過。 */
const IMPL_INSTRUCTIONS_WITH_SPEC = `實作要求（這是 TDD 的 green phase）：
- 請根據規格草稿（specDraft）與既有測試實作這個任務。
- 只做「讓測試通過」所需的最小實作，不要在 green phase 做額外的重構或美化。
- 請優先讓既有測試通過；若尚未有測試，請先提醒我建立測試，或至少列出應補上的測試。
- 不要擴大需求範圍，只實作 specDraft 描述的內容。
- 不要修改「禁止修改範圍」內的檔案。
- 只修改「允許修改檔案」內的檔案；若需要修改其他檔案，必須先回報原因再動手。
- 實作完成後，請建議我執行 pnpm verify:copy 進行本機驗證。

${IMPL_REPLY_FORMAT}`;

/** specDraft 不存在時的實作要求：維持原本資訊，補上護欄與待確認提醒。 */
const IMPL_INSTRUCTIONS_NO_SPEC = `實作要求：
- 若需求不明確，請先提出待確認問題，不要自行假設。
- 不要擴大需求範圍。
- 不要修改「禁止修改範圍」內的檔案。
- 只修改「允許修改檔案」內的檔案；若需要修改其他檔案，必須先回報原因再動手。
- 實作完成後，請建議我執行 pnpm verify:copy 進行本機驗證。

${IMPL_REPLY_FORMAT}`;

/** 依任務內容組出給 Claude 的實作 prompt，空欄位會略過；specDraft 存在時以 Spec + Test 為核心。 */
function buildClaudePrompt(task: Task): string {
  const hasSpec = Boolean(task.specDraft && task.specDraft.trim());
  const sections: string[] = [
    hasSpec
      ? "請根據以下規格草稿（specDraft）與既有測試實作這個任務。"
      : "請實作以下任務。",
  ];

  if (task.title.trim()) {
    sections.push(`任務標題：\n${task.title.trim()}`);
  }
  if (task.project && task.project.trim()) {
    sections.push(`專案分類：\n${task.project.trim()}`);
  }
  if (task.projectPath && task.projectPath.trim()) {
    sections.push(`專案路徑：\n${task.projectPath.trim()}`);
  }
  if (task.tags.length > 0) {
    sections.push(`Tags：\n${task.tags.join(", ")}`);
  }
  if (task.originalRequirement.trim()) {
    sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  }
  if (hasSpec) {
    sections.push(`規格草稿：\n${task.specDraft!.trim()}`);
  }
  if (task.targetFiles.length > 0) {
    sections.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.forbiddenFiles.length > 0) {
    sections.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.constraints.length > 0) {
    sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (task.acceptanceCriteria.length > 0) {
    sections.push(
      `驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    );
  }

  sections.push(hasSpec ? IMPL_INSTRUCTIONS_WITH_SPEC : IMPL_INSTRUCTIONS_NO_SPEC);

  return sections.join("\n\n");
}

const SPEC_PROMPT_INSTRUCTIONS = `請依上述資訊，產生一份結構化規格草稿（specDraft），格式如下：

## 功能範圍

## 規則

## API / UI 設計

## Given-When-Then 場景

Scenario:
Given
When
Then

## 不在範圍

注意事項：
- 不要實作程式碼，只產生規格草稿（specDraft）。
- 不要擴大需求範圍，只根據上述資訊撰寫。
- 不確定的地方請另外列出「待確認問題」，不要自行假設。`;

/** 依任務內容組出「請 Claude 產生 specDraft」的純文字 prompt，空欄位會略過。 */
function buildSpecPrompt(task: Task): string {
  const sections: string[] = ["請幫我把以下任務的粗需求，整理成一份可驗證的結構化規格草稿。"];

  if (task.title.trim()) {
    sections.push(`任務標題：\n${task.title.trim()}`);
  }
  if (task.originalRequirement.trim()) {
    sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  }
  if (task.specDraft && task.specDraft.trim()) {
    sections.push(`目前規格草稿：\n${task.specDraft.trim()}`);
  }
  if (task.targetFiles.length > 0) {
    sections.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.forbiddenFiles.length > 0) {
    sections.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.constraints.length > 0) {
    sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (task.acceptanceCriteria.length > 0) {
    sections.push(
      `驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    );
  }

  sections.push(SPEC_PROMPT_INSTRUCTIONS);

  return sections.join("\n\n");
}

function CopySpecPromptButton({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildSpecPrompt(task));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ 已複製" : "複製 Spec Prompt"}
    </button>
  );
}

const SPEC_REVIEW_INSTRUCTIONS = `請檢查上述規格草稿（specDraft）是否足夠清楚、完整、可測試，檢查重點：

- 功能範圍是否清楚。
- 規則是否明確。
- API / UI 設計是否足夠。
- Given-When-Then 場景是否足夠。
- 不在範圍是否有寫清楚。
- 是否有遺漏的邊界條件。
- 是否足以據此產生測試。
- 是否有需求不明確之處。

請依下列格式回覆：
- 結論：可進入測試產生 / 需要補規格（請擇一）。
- 缺口列表：列出目前規格不足或不清楚的地方。
- 建議補充的 Given-When-Then 場景。
- 建議補充的不在範圍。
- 待確認問題：需要我進一步確認才能定案的問題。`;

/** 沒有 specDraft 時，要求先補規格、不要直接進入測試的提醒。 */
const SPEC_REVIEW_NO_SPEC = `目前這個任務還沒有規格草稿（specDraft）。

請先根據以上原始需求協助我產生或補上一份結構化規格草稿（specDraft），格式包含：功能範圍、規則、API / UI 設計、Given-When-Then 場景、不在範圍。
在規格草稿補齊之前，請不要直接進入測試產生。若有需求不明確之處，請列出待確認問題。`;

/** 依任務內容組出「請 Claude 檢查 specDraft 完整性」的純文字 prompt，空欄位會略過。 */
function buildSpecReviewPrompt(task: Task): string {
  const hasSpec = Boolean(task.specDraft && task.specDraft.trim());
  const sections: string[] = [
    "請幫我檢查以下任務的規格草稿是否足夠清楚、完整、可作為測試與實作的依據。",
  ];

  if (task.title.trim()) {
    sections.push(`任務標題：\n${task.title.trim()}`);
  }
  if (task.originalRequirement.trim()) {
    sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  }
  if (hasSpec) {
    sections.push(`規格草稿：\n${task.specDraft!.trim()}`);
  }
  if (task.targetFiles.length > 0) {
    sections.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.forbiddenFiles.length > 0) {
    sections.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.constraints.length > 0) {
    sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (task.acceptanceCriteria.length > 0) {
    sections.push(
      `驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    );
  }

  sections.push(hasSpec ? SPEC_REVIEW_INSTRUCTIONS : SPEC_REVIEW_NO_SPEC);

  return sections.join("\n\n");
}

function CopySpecReviewPromptButton({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildSpecReviewPrompt(task));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ 已複製" : "複製 Spec Review Prompt"}
    </button>
  );
}

const TEST_PROMPT_INSTRUCTIONS = `請依上述資訊，先根據規格草稿（specDraft）產生測試，進入 TDD 的 red phase，要求如下：

- 這個階段「只新增或修改測試」，先不要實作功能。
- 測試框架優先使用 Vitest。
- 測試案例應對應 specDraft 的 Given-When-Then 場景，每個場景至少對應一個測試。
- 測試應能在目前功能尚未完成時失敗（red phase）；也就是這些測試在還沒實作功能前應該是失敗的。
- 若某些測試無法先失敗（例如功能其實已存在、或無法在實作前被觸發），請明確說明原因。
- 不要修改 production code（功能程式碼），除非是為了暴露可測試的 API；若確實需要，請先說明理由再動手。
- 不要擴大需求範圍，只針對 specDraft 描述的內容寫測試。
- 不要修改「禁止修改範圍」內的檔案。
- 若不確定測試檔該放哪，先提出建議，不要自行假設。

回覆請包含：
- 新增或修改的測試檔案（含路徑）。
- 測試案例摘要（對應到哪些 Given-When-Then 場景）。
- 如何執行測試。
- 預期哪些測試會先失敗（red），以及為什麼。
- 若有測試無法先失敗，請說明原因。
- 是否有無法測試或需要確認的地方。`;

/** 依任務內容組出「請 Claude 根據 specDraft 產生測試」的純文字 prompt，空欄位會略過。 */
function buildTestPrompt(task: Task): string {
  const sections: string[] = ["請幫我根據以下任務的規格草稿，產生對應的測試。"];

  if (task.title.trim()) {
    sections.push(`任務標題：\n${task.title.trim()}`);
  }
  if (task.originalRequirement.trim()) {
    sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  }
  if (task.specDraft && task.specDraft.trim()) {
    sections.push(`規格草稿：\n${task.specDraft.trim()}`);
  }
  if (task.targetFiles.length > 0) {
    sections.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.forbiddenFiles.length > 0) {
    sections.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.constraints.length > 0) {
    sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (task.acceptanceCriteria.length > 0) {
    sections.push(
      `驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    );
  }

  sections.push(TEST_PROMPT_INSTRUCTIONS);

  return sections.join("\n\n");
}

function CopyTestPromptButton({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildTestPrompt(task));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ 已複製" : "複製測試 Prompt"}
    </button>
  );
}

function CopyPromptButton({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildClaudePrompt(task));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ 已複製" : "複製實作 Prompt"}
    </button>
  );
}

const REFACTOR_INSTRUCTIONS = `重構要求（這是 TDD 的 refactor phase）：
- 只有在測試已經通過的前提下才進行這次重構；若測試尚未全綠，請先停下來告訴我。
- 不要改變既有行為，重構前後對外行為與輸出必須一致。
- 不要新增功能，也不要擴大需求範圍。
- 過程中請保持所有測試持續通過。
- 不要修改「禁止修改範圍」內的檔案。
- 只修改「允許修改檔案」內的檔案；若需要修改其他檔案，必須先回報原因再動手。
- 重構完成後，請建議我執行 pnpm verify:copy 重新驗證。

回覆請包含：
- 重構檔案清單（含路徑）。
- 重構摘要。
- 為什麼這次重構不影響既有行為。
- 需要重新跑的驗證指令（例如 pnpm verify:copy）。
- 是否有風險或待確認事項。`;

/** 依任務內容組出「請 Claude 做 refactor phase 重構」的純文字 prompt，空欄位會略過。 */
function buildRefactorPrompt(task: Task, rounds: TaskRound[]): string {
  const sections: string[] = ["請幫我針對這個任務做小範圍重構，前提是測試已經通過。"];

  if (task.title.trim()) {
    sections.push(`任務標題：\n${task.title.trim()}`);
  }
  if (task.originalRequirement.trim()) {
    sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  }
  if (task.specDraft && task.specDraft.trim()) {
    sections.push(`規格草稿：\n${task.specDraft.trim()}`);
  }

  // 自動帶入最新一筆驗證回合的結果（含 fileGuard，若有）
  const verificationRound = findLatestVerificationRound(rounds);
  if (verificationRound) {
    const verificationSection = buildVerificationSection(verificationRound);
    if (verificationSection) sections.push(verificationSection);
  }

  if (task.targetFiles.length > 0) {
    sections.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.forbiddenFiles.length > 0) {
    sections.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.constraints.length > 0) {
    sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (task.acceptanceCriteria.length > 0) {
    sections.push(
      `驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    );
  }

  sections.push(REFACTOR_INSTRUCTIONS);

  return sections.join("\n\n");
}

function CopyRefactorPromptButton({ task, rounds }: { task: Task; rounds: TaskRound[] }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildRefactorPrompt(task, rounds));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ 已複製" : "複製重構 Prompt"}
    </button>
  );
}

const REVIEW_TEXT: Record<TaskReviewResult, string> = {
  not_reviewed: "未驗收",
  passed:       "通過",
  needs_fix:    "需修改",
};

/** 依任務內容組出「繼續修正任務」的純文字 prompt，空欄位會略過。 */
function buildFixPrompt(task: Task, rounds: TaskRound[]): string {
  const sections: string[] = ["請根據以下驗收結果，繼續修正這個任務。"];

  if (task.title.trim()) {
    sections.push(`任務標題：\n${task.title.trim()}`);
  }
  if (task.project && task.project.trim()) {
    sections.push(`專案分類：\n${task.project.trim()}`);
  }
  if (task.projectPath && task.projectPath.trim()) {
    sections.push(`專案路徑：\n${task.projectPath.trim()}`);
  }
  if (task.originalRequirement.trim()) {
    sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  }
  if (task.specDraft && task.specDraft.trim()) {
    sections.push(`規格草稿：\n${task.specDraft.trim()}`);
  }
  if (task.claudeResponse && task.claudeResponse.trim()) {
    sections.push(`Claude 回覆：\n${task.claudeResponse.trim()}`);
  }
  sections.push(`驗收結果：\n${REVIEW_TEXT[task.reviewResult ?? "not_reviewed"]}`);

  // 自動帶入最新一筆驗證回合的結果（若有），放在「驗收結果」之後、「下一步」之前
  const verificationRound = findLatestVerificationRound(rounds);
  if (verificationRound) {
    const verificationSection = buildVerificationSection(verificationRound);
    if (verificationSection) sections.push(verificationSection);
  }

  if (task.nextActions && task.nextActions.trim()) {
    sections.push(`下一步：\n${task.nextActions.trim()}`);
  }
  if (task.constraints.length > 0) {
    sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (task.acceptanceCriteria.length > 0) {
    sections.push(
      `驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    );
  }

  return sections.join("\n\n");
}

function CopyFixPromptButton({ task, rounds }: { task: Task; rounds: TaskRound[] }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildFixPrompt(task, rounds));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ 已複製" : "複製修正 Prompt"}
    </button>
  );
}

const REVIEW_CHECKLIST = `請檢查：
1. 是否符合原始需求。
2. 是否超出允許修改範圍。
3. 是否違反限制條件。
4. 是否有型別、安全性、資料流或維護性問題。
5. 是否需要補測試或補驗收。`;

/**
 * 找出該任務最新一筆「驗證回合」：有 verificationOk 或有 commandLogs 的 round。
 * rounds 依 roundIndex 由大到小取第一筆，沒有則回傳 null。
 */
function findLatestVerificationRound(rounds: TaskRound[]): TaskRound | null {
  const candidates = rounds.filter(
    (r) => r.verificationOk !== undefined || (r.commandLogs?.length ?? 0) > 0
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, r) => (r.roundIndex > latest.roundIndex ? r : latest));
}

/**
 * 把一筆驗證回合組成「本機驗證結果」純文字區塊；空欄位略過，全部為空時回傳 null。
 * commandLogs 只放摘要（name/command/exitCode/ok/durationMs），不塞 stdout/stderr 全文。
 */
function buildVerificationSection(round: TaskRound): string | null {
  const parts: string[] = [];

  if (round.verificationOk !== undefined) {
    parts.push(`驗證狀態：${round.verificationOk ? "通過" : "未通過"}`);
  }

  if (round.checklist.length > 0) {
    const lines = round.checklist.map((c) => `- ${c.label} ${c.status}`).join("\n");
    parts.push(`checklist：\n${lines}`);
  }

  if (round.commandLogs && round.commandLogs.length > 0) {
    const lines = round.commandLogs
      .map((log) => {
        const name = log.name ?? log.command;
        const ok = log.ok ?? log.exitCode === 0;
        const segs = [`exit=${log.exitCode ?? "—"}`, `ok=${ok}`];
        if (typeof log.durationMs === "number") segs.push(`${log.durationMs}ms`);
        return `- ${name}：\`${log.command}\`（${segs.join(", ")}）`;
      })
      .join("\n");
    parts.push(`指令摘要：\n${lines}`);
  }

  if (round.gitStatus && round.gitStatus.trim()) {
    parts.push(`git status：\n${round.gitStatus.trim()}`);
  }
  if (round.gitDiff && round.gitDiff.trim()) {
    parts.push(`git diff：\n${round.gitDiff.trim()}`);
  }

  const fileGuardSection = buildFileGuardSection(round.fileGuard);
  if (fileGuardSection) parts.push(fileGuardSection);

  if (parts.length === 0) return null;
  return `本機驗證結果：\n${parts.join("\n\n")}`;
}

/**
 * 把 fileGuard 結果組成「檔案範圍檢查」純文字區塊；沒有 fileGuard 時回傳 null。
 * 空的檔案清單會略過以免 prompt 太長；violations 會列出 type 與 file。
 */
function buildFileGuardSection(fileGuard: FileGuardResult | undefined): string | null {
  if (!fileGuard) return null;

  // 標題行直接帶狀態，方便 prompt 一眼看出檔案範圍檢查通過與否。
  const lines: string[] = [`檔案範圍檢查：${fileGuard.ok ? "通過" : "未通過"}`];

  if (fileGuard.error && fileGuard.error.trim()) {
    lines.push(`error：${fileGuard.error.trim()}`);
  }
  if (fileGuard.violations.length > 0) {
    const violationLines = fileGuard.violations
      .map((v) => `- ${v.type}：${v.file}`)
      .join("\n");
    lines.push(`violations：\n${violationLines}`);
  }
  if (fileGuard.modifiedFiles.length > 0) {
    lines.push(`modifiedFiles：\n${fileGuard.modifiedFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (fileGuard.targetFiles.length > 0) {
    lines.push(`targetFiles：\n${fileGuard.targetFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (fileGuard.forbiddenFiles.length > 0) {
    lines.push(`forbiddenFiles：\n${fileGuard.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }

  return lines.join("\n");
}

/** 依任務內容組出給 Claude 的「審查 prompt」，空欄位會略過，固定附上請檢查區塊。 */
function buildReviewPrompt(task: Task, rounds: TaskRound[]): string {
  const sections: string[] = ["請幫我審查這次 Claude Code 的修改是否符合需求。"];

  if (task.originalRequirement.trim()) {
    sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  }
  if (task.specDraft && task.specDraft.trim()) {
    sections.push(`規格草稿：\n${task.specDraft.trim()}`);
  }
  if (task.targetFiles.length > 0) {
    sections.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.forbiddenFiles.length > 0) {
    sections.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join("\n")}`);
  }
  if (task.constraints.length > 0) {
    sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
  }
  if (task.claudeResponse && task.claudeResponse.trim()) {
    sections.push(`Claude 回覆：\n${task.claudeResponse.trim()}`);
  }

  // 自動帶入最新一筆驗證回合的結果（若有）
  const verificationRound = findLatestVerificationRound(rounds);
  if (verificationRound) {
    const verificationSection = buildVerificationSection(verificationRound);
    if (verificationSection) sections.push(verificationSection);
  }

  sections.push(REVIEW_CHECKLIST);

  return sections.join("\n\n");
}

function CopyReviewPromptButton({ task, rounds }: { task: Task; rounds: TaskRound[] }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildReviewPrompt(task, rounds));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <button
      className={`btn btn-copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ 已複製" : "複製審查 Prompt"}
    </button>
  );
}

function EditableSection({
  label,
  value,
  taskId,
  onSave,
}: {
  label: string;
  value: string;
  taskId: string;
  onSave: (val: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [taskId, value]);

  return (
    <div className="detail-section">
      <div className="detail-label">{label}</div>
      <textarea
        className="inline-edit-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onSave(draft); }}
        rows={4}
      />
    </div>
  );
}


function ProjectSection({ task, onSave }: { task: Task; onSave: (project: string) => void }) {
  const [draft, setDraft] = useState(task.project ?? "");

  useEffect(() => {
    setDraft(task.project ?? "");
  }, [task.id, task.project]);

  function handleBlur() {
    const trimmed = draft.trim();
    // 失焦時把輸入框正規化（trim）顯示
    setDraft(trimmed);
    if (trimmed !== (task.project ?? "")) {
      onSave(trimmed);
    }
  }

  return (
    <div className="detail-section">
      <div className="detail-label">專案分類</div>
      <input
        className="tags-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        placeholder="專案名稱，例如：my-app（留空表示未分類）"
      />
    </div>
  );
}

/** local runner /health 回傳的形狀（只取 UI 需要顯示的欄位）。 */
type RunnerHealth = {
  service: string;
  version: number;
  endpoints: string[];
};

type RunnerStatus = "checking" | "connected" | "disconnected";

/** local runner health check 的 URL（與 auto-* 一鍵執行同一個 runner）。 */
const RUNNER_HEALTH_URL = "http://localhost:4318/health";

/**
 * Runner 狀態區塊：初次載入時 fetch /health，顯示「檢查中 / 已連線 / 未連線」。
 * 連不上不 alert，只在 UI 顯示未連線並提示 pnpm runner:local；另提供「重新檢查」按鈕。
 */
function RunnerStatusSection() {
  const [status, setStatus] = useState<RunnerStatus>("checking");
  const [health, setHealth] = useState<RunnerHealth | null>(null);

  async function checkHealth() {
    setStatus("checking");
    try {
      const res = await fetch(RUNNER_HEALTH_URL);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as RunnerHealth;
      setHealth(data);
      setStatus("connected");
    } catch {
      // 連不上 runner 屬正常情況（使用者尚未啟動），不 alert，只在 UI 顯示未連線。
      setHealth(null);
      setStatus("disconnected");
    }
  }

  // 只在初次載入時自動檢查一次；之後靠「重新檢查」按鈕。
  useEffect(() => {
    void checkHealth();
  }, []);

  return (
    <div className="detail-section runner-status" data-testid="runner-status" data-status={status}>
      <div className="detail-label runner-status-label">
        <span>Runner 狀態</span>
        <button
          className="btn runner-recheck-btn"
          onClick={() => void checkHealth()}
          disabled={status === "checking"}
        >
          {status === "checking" ? "檢查中..." : "重新檢查"}
        </button>
      </div>

      {status === "checking" && (
        <div className="runner-status-line">● 檢查中...</div>
      )}

      {status === "disconnected" && (
        <div className="runner-status-line runner-disconnected">
          ● 未連線。請在 ai-coding-relay 專案根目錄執行：<code>pnpm runner:local</code>
        </div>
      )}

      {status === "connected" && health && (
        <div className="runner-status-line runner-connected">
          <div>● 已連線</div>
          <div>service：<code>{health.service}</code></div>
          <div>version：{health.version}</div>
          <div>endpoints：<code>{health.endpoints.join(", ")}</code></div>
        </div>
      )}
    </div>
  );
}

/** local runner /preflight 回傳的單一檢查項。 */
type PreflightCheck = {
  name: string;
  ok: boolean;
  severity: string;
  message: string;
  /** 失敗時的修復建議（選擇性）。 */
  suggestion?: string;
  /** 失敗時的可複製修復指令純文字（選擇性）；UI 只複製、不執行。 */
  fixCommand?: string;
};

/** local runner /preflight 回傳的整體結果。 */
type PreflightResult = {
  ok: boolean;
  projectPath: string;
  checks: PreflightCheck[];
  summary: { errorCount: number; warningCount: number };
};

type PreflightStatus = "idle" | "checking" | "done" | "disconnected";

/** 共用的 Preflight 控制器：狀態、最新結果，與觸發檢查的函式。 */
type PreflightController = {
  status: PreflightStatus;
  result: PreflightResult | null;
  /** 對 projectPath 跑一次 preflight；成功回傳結果，連不上 runner 回傳 null（並把狀態設為 disconnected）。 */
  runPreflight: () => Promise<PreflightResult | null>;
};

const RUNNER_PREFLIGHT_URL = "http://localhost:4318/preflight";

/**
 * Preflight 共用 hook：在 TaskDetail 呼叫一次，狀態同時給「目標專案 Preflight」區塊顯示，
 * 以及 auto-round / auto-loop 執行前的自動前置檢查使用，確保兩邊看到同一份最新結果。
 */
function usePreflight(projectPath: string): PreflightController {
  const [status, setStatus] = useState<PreflightStatus>("idle");
  const [result, setResult] = useState<PreflightResult | null>(null);

  // 切換任務（projectPath 變動）時清掉上一個任務的檢查結果。
  useEffect(() => {
    setStatus("idle");
    setResult(null);
  }, [projectPath]);

  const runPreflight = useCallback(async (): Promise<PreflightResult | null> => {
    setStatus("checking");
    try {
      const res = await fetch(RUNNER_PREFLIGHT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as PreflightResult;
      setResult(data);
      setStatus("done");
      return data;
    } catch {
      // 連不上 runner 屬正常情況（尚未啟動），不 alert，只在 UI 顯示未連線提示。
      setResult(null);
      setStatus("disconnected");
      return null;
    }
  }, [projectPath]);

  return { status, result, runPreflight };
}

/**
 * 目標專案 Preflight 區塊：顯示共用 controller 的最新結果與每個 check。
 * 手動「檢查目標專案」按鈕會觸發同一個 runPreflight；auto-round / auto-loop 自動檢查的結果也會顯示在這裡。
 * 連不上 runner 不 alert，只在 UI 顯示請先執行 pnpm runner:local。
 */
function PreflightSection({ preflight }: { preflight: PreflightController }) {
  const { status, result, runPreflight } = preflight;

  return (
    <div className="detail-section preflight" data-testid="preflight" data-status={status}>
      <div className="detail-label runner-status-label">
        <span>目標專案 Preflight</span>
        <button
          className="btn runner-recheck-btn"
          onClick={() => void runPreflight()}
          disabled={status === "checking"}
        >
          {status === "checking" ? "檢查中..." : "檢查目標專案"}
        </button>
      </div>

      <div className="detail-empty-text" style={{ marginBottom: 6 }}>
        執行 auto-round / auto-loop 前，先檢查目標專案 projectPath 是否具備前置條件（git repo、run-verification、未追蹤 node_modules 等）。
      </div>

      {status === "disconnected" && (
        <div className="runner-status-line runner-disconnected">
          ● 未連線。請在 ai-coding-relay 專案根目錄執行：<code>pnpm runner:local</code>
        </div>
      )}

      {status === "done" && result && (
        <div className="preflight-result">
          <div className={`preflight-summary ${result.ok ? "preflight-ok" : "preflight-failed"}`}>
            {result.ok ? "● Preflight 通過" : "● Preflight 未通過"}
            （error {result.summary.errorCount}／warning {result.summary.warningCount}）
          </div>
          {!result.ok && (
            <div className="runner-status-line runner-disconnected">
              建議先修正上述 error 再執行 auto-round / auto-loop（不強制阻擋，可自行決定）。
            </div>
          )}
          <ul className="preflight-checks">
            {result.checks.map((c) => {
              const state = c.ok ? "passed" : c.severity === "error" ? "error" : "warning";
              const icon = c.ok ? "✓" : c.severity === "error" ? "✕" : "⚠";
              return (
                <li key={c.name} className={`preflight-check preflight-check-${state}`} data-check={c.name} data-ok={c.ok}>
                  <div className="preflight-check-head">
                    <span className="preflight-check-icon">{icon}</span>
                    <code className="preflight-check-name">{c.name}</code>
                    {!c.ok && <span className="preflight-check-severity">[{c.severity}]</span>}
                    <span className="preflight-check-message">{c.message}</span>
                  </div>
                  {c.suggestion && (
                    <div className="preflight-check-suggestion">建議：{c.suggestion}</div>
                  )}
                  {c.fixCommand && <PreflightFixCommand checkName={c.name} fixCommand={c.fixCommand} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * 顯示單一 check 的可複製修復指令；只複製純文字到剪貼簿，不執行任何 shell。
 * 複製成功顯示「✓ 已複製」回饋（不 alert），失敗時 alert。
 */
function PreflightFixCommand({ checkName, fixCommand }: { checkName: string; fixCommand: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fixCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <div className="preflight-fix" data-fix-for={checkName}>
      <pre className="preflight-fix-cmd"><code>{fixCommand}</code></pre>
      <button className={`btn btn-copy${copied ? " copied" : ""}`} onClick={() => void handleCopy()}>
        {copied ? "✓ 已複製" : "複製修復指令"}
      </button>
    </div>
  );
}

/**
 * 全域 AI Command 設定欄：顯示目前設定值，修改即時生效並寫回 localStorage。
 * 失焦時若為空白則還原為預設值，避免送出空指令。
 */
function AiCommandSection({
  aiCommand,
  onChange,
}: {
  aiCommand: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="detail-section">
      <div className="detail-label">AI Command</div>
      <input
        className="tags-input ai-command-input"
        value={aiCommand}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => { if (!e.target.value.trim()) onChange(DEFAULT_AI_COMMAND); }}
        placeholder={DEFAULT_AI_COMMAND}
        spellCheck={false}
      />
      <div className="detail-empty-text" style={{ marginTop: 6 }}>
        此指令會被 auto-spec / auto-round / auto-loop 使用（例如 <code>claude --permission-mode acceptEdits</code>、<code>claude</code> 或 <code>codex</code>）。修改後自動保存，reload 仍保留。
      </div>
    </div>
  );
}

function ClaudeResponseSection({
  claudeResponse,
  taskId,
  onSave,
}: {
  claudeResponse: string | undefined;
  taskId: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(claudeResponse ?? "");

  useEffect(() => {
    setDraft(claudeResponse ?? "");
  }, [taskId, claudeResponse]);

  function handleBlur() {
    if (draft !== (claudeResponse ?? "")) onSave(draft);
  }

  return (
    <div className="detail-section">
      <div className="detail-label">Claude 回覆</div>
      <textarea
        className="claude-response-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        placeholder="貼上 Claude 的回覆內容..."
        rows={9}
      />
    </div>
  );
}

const SPEC_DRAFT_PLACEHOLDER = `## 功能範圍

## 規則

## API / UI 設計

## Given-When-Then 場景

Scenario:
Given
When
Then

## 不在範圍`;

function SpecDraftSection({
  task,
  onSave,
  aiCommand,
}: {
  task: Task;
  onSave: (value: string) => void;
  aiCommand: string;
}) {
  const specDraft = task.specDraft;
  const [draft, setDraft] = useState(specDraft ?? "");
  const [importDraft, setImportDraft] = useState("");
  const [cmdCopied, setCmdCopied] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setDraft(specDraft ?? "");
  }, [task.id, specDraft]);

  // 切換任務時清空匯入框，避免帶到別的任務
  useEffect(() => {
    setImportDraft("");
  }, [task.id]);

  function handleBlur() {
    if (draft !== (specDraft ?? "")) onSave(draft);
  }

  async function handleCopyAutoSpecCommand() {
    try {
      await navigator.clipboard.writeText(buildAutoSpecCommand(task, aiCommand));
      setCmdCopied(true);
      setTimeout(() => setCmdCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  // 驗證一筆 auto-spec 結果物件，成功（ok=true 且 specDraft 有內容）才寫回規格草稿。
  // 回傳是否成功；失敗時自行 alert。
  function applyAutoSpecObject(parsed: unknown): boolean {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      alert("匯入失敗：auto-spec 結果應為物件");
      return false;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.ok !== true) {
      const reason = typeof obj.stoppedReason === "string" ? `（${obj.stoppedReason}）` : "";
      alert(`auto-spec 未成功 ${reason}，不覆蓋目前規格草稿。`);
      return false;
    }
    const spec = typeof obj.specDraft === "string" ? obj.specDraft.trim() : "";
    if (!spec) {
      alert("auto-spec 的 specDraft 為空，不覆蓋目前規格草稿。");
      return false;
    }
    onSave(spec);
    setDraft(spec);
    return true;
  }

  // 解析貼上的 auto-spec JSON，成功才寫回並清空匯入框。
  function handleImportAutoSpec() {
    const text = importDraft.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      alert(`匯入失敗：JSON 解析錯誤（${e instanceof Error ? e.message : "未知錯誤"}）`);
      return;
    }
    if (applyAutoSpecObject(parsed)) setImportDraft("");
  }

  // 透過本機 local runner（pnpm runner:local）一鍵執行 auto-spec，把 specDraft 寫回任務。
  async function handleRunAutoSpec() {
    setRunning(true);
    try {
      const res = await fetch("http://localhost:4318/auto-spec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: task.title,
          projectPath: task.projectPath ?? "",
          originalRequirement: task.originalRequirement,
          targetFiles: task.targetFiles,
          forbiddenFiles: task.forbiddenFiles,
          constraints: task.constraints,
          acceptanceCriteria: task.acceptanceCriteria,
          aiCommand,
        }),
      });
      const parsed: unknown = await res.json();
      applyAutoSpecObject(parsed);
    } catch (e) {
      alert(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。\n` +
          "請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local"
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="detail-section">
      <div className="detail-label">規格草稿 Spec</div>
      <textarea
        className="spec-draft-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        placeholder={SPEC_DRAFT_PLACEHOLDER}
        rows={12}
      />

      <div className="detail-empty-text" style={{ marginTop: 8, marginBottom: 6 }}>
        想讓 AI 自動產生規格？可一鍵執行（需先在 ai-coding-relay 根目錄執行 <code>pnpm runner:local</code>），或複製指令到 terminal 執行後把輸出 JSON 貼回下方匯入。
      </div>
      <div className="verify-cmd-row">
        <button
          className="btn btn-primary"
          onClick={handleRunAutoSpec}
          disabled={running}
        >
          {running ? "執行中..." : "執行 auto-spec"}
        </button>
        <button
          className={`btn btn-copy${cmdCopied ? " copied" : ""}`}
          onClick={handleCopyAutoSpecCommand}
        >
          {cmdCopied ? "✓ 已複製" : "複製 auto-spec 指令"}
        </button>
      </div>
      <textarea
        className="inline-edit-textarea"
        value={importDraft}
        onChange={(e) => setImportDraft(e.target.value)}
        placeholder='貼上 auto-spec JSON，例如 {"ok": true, "specDraft": "...", "ai": {...}}'
        rows={5}
      />
      <div className="response-actions">
        <button
          className="btn btn-primary"
          onClick={handleImportAutoSpec}
          disabled={!importDraft.trim()}
        >
          匯入 auto-spec 結果
        </button>
      </div>
    </div>
  );
}

function NextActionsSection({
  nextActions,
  taskId,
  onSave,
}: {
  nextActions: string | undefined;
  taskId: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(nextActions ?? "");

  useEffect(() => {
    setDraft(nextActions ?? "");
  }, [taskId, nextActions]);

  function handleBlur() {
    if (draft !== (nextActions ?? "")) onSave(draft);
  }

  return (
    <div className="detail-section">
      <div className="detail-label">下一步</div>
      <textarea
        className="next-actions-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        placeholder="記錄接下來要做的事，可輸入多行..."
        rows={5}
      />
    </div>
  );
}

/**
 * 依任務的 targetFiles / forbiddenFiles 組出建立 .ai-coding-relay/guard-rules.json 的 terminal 指令。
 * 空陣列也會原樣輸出為 []。此函式只產生純文字，不執行任何 shell。
 */
function buildFileGuardCommand(task: Task): string {
  const rules = {
    targetFiles: task.targetFiles,
    forbiddenFiles: task.forbiddenFiles,
  };
  const json = JSON.stringify(rules, null, 2);
  return [
    "mkdir -p .ai-coding-relay",
    "cat > .ai-coding-relay/guard-rules.json <<'EOF'",
    json,
    "EOF",
  ].join("\n");
}

/**
 * auto-spec / auto-round / auto-loop 預設使用的 AI CLI 指令。
 * 帶 --permission-mode acceptEdits，讓 Claude 能非互動地修改允許檔案，不被寫入授權 gate 卡住。
 */
const DEFAULT_AI_COMMAND = "claude --permission-mode acceptEdits";

/** AI Command 全域設定的 localStorage key。 */
const AI_COMMAND_STORAGE_KEY = "aiCodingRelay.aiCommand";

/** 從 localStorage 讀取 AI Command；不存在 / 空白 / localStorage 不可用時回傳預設值。 */
function readAiCommand(): string {
  try {
    const stored = localStorage.getItem(AI_COMMAND_STORAGE_KEY);
    if (stored !== null && stored.trim()) return stored;
  } catch {
    // localStorage 不可用時退回預設值
  }
  return DEFAULT_AI_COMMAND;
}

/**
 * 全域 AI Command 設定 hook：初值取自 localStorage，更新時同步寫回，reload 後仍保留。
 * 回傳 [目前值, 更新函式]。
 */
function useAiCommand(): [string, (value: string) => void] {
  const [aiCommand, setAiCommand] = useState<string>(() => readAiCommand());
  const update = (value: string) => {
    setAiCommand(value);
    try {
      localStorage.setItem(AI_COMMAND_STORAGE_KEY, value);
    } catch {
      // 寫入失敗（例如隱私模式）時忽略，至少當下 session 仍套用
    }
  };
  return [aiCommand, update];
}

/** 依 workflowStage 推導 auto-round 的 mode；非 TDD 執行階段一律預設 "implement"。 */
function deriveAutoRoundMode(stage: WorkflowStage | undefined): string {
  switch (stage) {
    case "red_test":        return "test";
    case "green_implement": return "implement";
    case "refactor":        return "refactor";
    case "fix":             return "fix";
    default:                return "implement";
  }
}

/**
 * 依目前任務組出可貼到 terminal 執行的 auto-round 指令（heredoc 餵 task JSON 給 pnpm -s auto:round）。
 * 此函式只產生純文字，不執行任何 shell。
 */
function buildAutoRoundCommand(task: Task, aiCommand: string): string {
  const taskJson = {
    title: task.title,
    projectPath: task.projectPath ?? "",
    originalRequirement: task.originalRequirement,
    specDraft: task.specDraft ?? "",
    targetFiles: task.targetFiles,
    forbiddenFiles: task.forbiddenFiles,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    mode: deriveAutoRoundMode(task.workflowStage),
    aiCommand,
  };
  const json = JSON.stringify(taskJson, null, 2);
  return [
    "cat <<'EOF' | pnpm -s auto:round",
    json,
    "EOF",
  ].join("\n");
}

/** auto-loop 預設值（第一版固定）：最多 3 輪、預設不自動核准（只跑 1 輪）。 */
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_AUTO_APPROVE = false;

/**
 * 依目前任務組出可貼到 terminal 執行的 auto-loop 指令（heredoc 餵 task JSON 給 pnpm -s auto:loop）。
 * 此函式只產生純文字，不執行任何 shell。
 */
function buildAutoLoopCommand(task: Task, aiCommand: string): string {
  const taskJson = {
    title: task.title,
    projectPath: task.projectPath ?? "",
    originalRequirement: task.originalRequirement,
    specDraft: task.specDraft ?? "",
    targetFiles: task.targetFiles,
    forbiddenFiles: task.forbiddenFiles,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    workflowStage: task.workflowStage ?? "spec",
    mode: deriveAutoRoundMode(task.workflowStage),
    aiCommand,
    maxRounds: DEFAULT_MAX_ROUNDS,
    autoApprove: DEFAULT_AUTO_APPROVE,
  };
  const json = JSON.stringify(taskJson, null, 2);
  return [
    "cat <<'EOF' | pnpm -s auto:loop",
    json,
    "EOF",
  ].join("\n");
}

/**
 * 依目前任務組出可貼到 terminal 執行的 auto-spec 指令（heredoc 餵 task JSON 給 pnpm -s auto:spec）。
 * 此函式只產生純文字，不執行任何 shell。
 */
function buildAutoSpecCommand(task: Task, aiCommand: string): string {
  const taskJson = {
    title: task.title,
    projectPath: task.projectPath ?? "",
    originalRequirement: task.originalRequirement,
    targetFiles: task.targetFiles,
    forbiddenFiles: task.forbiddenFiles,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    aiCommand,
  };
  const json = JSON.stringify(taskJson, null, 2);
  return [
    "cat <<'EOF' | pnpm -s auto:spec",
    json,
    "EOF",
  ].join("\n");
}

/**
 * auto-round / auto-loop 一鍵執行的進度階段（Phase 64）。前端狀態版，不做 streaming。
 * - idle：未執行
 * - preflight_running：正在檢查目標專案 Preflight
 * - preflight_warning：Preflight 有 warning，等待使用者確認
 * - preflight_failed：Preflight 未通過（有 error）
 * - auto_round_running / auto_loop_running：正在執行，等待 Claude / verification 結果
 * - importing_result：正在匯入結果並建立回合
 * - completed：已完成
 * - failed：執行失敗（runner 未連線、fetch 失敗、使用者取消等）
 */
type ExecutionPhase =
  | "idle"
  | "preflight_running"
  | "preflight_warning"
  | "preflight_failed"
  | "auto_round_running"
  | "auto_loop_running"
  | "importing_result"
  | "completed"
  | "failed";

type ExecutionProgress = {
  phase: ExecutionPhase;
  /** 額外說明（例如「使用者取消執行」「runner 未連線或執行失敗」）；沒有時用該階段預設文字。 */
  message?: string;
};

/** 各階段的圖示與預設文字。 */
const EXECUTION_PHASE_INFO: Record<ExecutionPhase, { icon: string; text: string }> = {
  idle:               { icon: "",  text: "" },
  preflight_running:  { icon: "⏳", text: "正在檢查目標專案 Preflight" },
  preflight_warning:  { icon: "⚠", text: "Preflight 有 warning，等待確認是否繼續" },
  preflight_failed:   { icon: "✕", text: "Preflight 未通過，請先修正 error" },
  auto_round_running: { icon: "⏳", text: "正在執行 auto-round，等待 Claude 與 verification 結果" },
  auto_loop_running:  { icon: "⏳", text: "正在執行 auto-loop，等待 Claude 與 verification 結果" },
  importing_result:   { icon: "⏳", text: "正在匯入結果並建立回合紀錄" },
  completed:          { icon: "✅", text: "已完成" },
  failed:             { icon: "✕", text: "runner 未連線或執行失敗" },
};

/**
 * 執行進度區塊：顯示 auto-round / auto-loop 最近一次執行的目前階段。
 * idle 時不顯示，避免干擾既有 UI；其餘階段以圖示 + 文字呈現目前狀態，讓使用者知道不是當機。
 */
function ExecutionProgressSection({ progress }: { progress: ExecutionProgress }) {
  if (progress.phase === "idle") return null;
  const info = EXECUTION_PHASE_INFO[progress.phase];
  const text = progress.message ?? info.text;
  const isError = progress.phase === "failed" || progress.phase === "preflight_failed";
  const stateClass = isError
    ? "execution-progress-failed"
    : progress.phase === "completed"
      ? "execution-progress-done"
      : "execution-progress-active";

  return (
    <div className="execution-progress" data-testid="execution-progress" data-phase={progress.phase}>
      <div className="detail-label">執行進度</div>
      <div className={`execution-progress-line ${stateClass}`}>
        <span className="execution-progress-icon">{info.icon}</span>
        <span className="execution-progress-text">{text}</span>
      </div>
    </div>
  );
}

function VerificationImportSection({
  task,
  onImport,
  aiCommand,
  runPreflight,
  autoRunOnMount = false,
  onAutoRunConsumed,
}: {
  task: Task;
  onImport: (jsonText: string) => void;
  aiCommand: string;
  /** 執行 auto-round / auto-loop 前自動跑的共用 Preflight；結果會顯示在 Preflight 區塊。 */
  runPreflight: () => Promise<PreflightResult | null>;
  /** 為 true 時，進入此任務後自動執行一次 auto-round。 */
  autoRunOnMount?: boolean;
  /** auto-round 自動觸發後立即呼叫，避免重複執行。 */
  onAutoRunConsumed?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [autoDraft, setAutoDraft] = useState("");
  const [loopDraft, setLoopDraft] = useState("");
  const [cmdCopied, setCmdCopied] = useState(false);
  const [guardCopied, setGuardCopied] = useState(false);
  const [autoCmdCopied, setAutoCmdCopied] = useState(false);
  const [loopCmdCopied, setLoopCmdCopied] = useState(false);
  const [autoRoundRunning, setAutoRoundRunning] = useState(false);
  const [autoLoopRunning, setAutoLoopRunning] = useState(false);
  // auto-round / auto-loop 一鍵執行的進度（Phase 64）；切換任務時重置為 idle。
  const [progress, setProgress] = useState<ExecutionProgress>({ phase: "idle" });
  // 記錄已自動觸發過 auto-round 的 task id，避免 StrictMode / re-render 重複執行。
  const autoRunTriggeredRef = useRef<string | null>(null);

  // 切換任務時清空，避免把上一個任務貼的內容帶過來
  useEffect(() => {
    setDraft("");
    setAutoDraft("");
    setLoopDraft("");
    setProgress({ phase: "idle" });
  }, [task.id]);

  // 「建立並執行 auto-round」：進入此任務後自動觸發一次 auto-round。
  // 用 ref 記住已觸發的 task id，並在觸發後立即 onAutoRunConsumed，雙重防止重複執行。
  useEffect(() => {
    if (!autoRunOnMount) return;
    if (autoRunTriggeredRef.current === task.id) return;
    autoRunTriggeredRef.current = task.id;
    onAutoRunConsumed?.();
    void handleRunAutoRound();
    // 只依 autoRunOnMount / task.id 觸發；handleRunAutoRound 為宣告函式（hoisted），刻意不放進 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunOnMount, task.id]);

  function handleImport() {
    const text = draft.trim();
    if (!text) return;
    try {
      onImport(text);
      setDraft(""); // 匯入成功才清空
    } catch (e) {
      alert(`匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  // auto-round JSON 與本機驗證 JSON 共用同一個匯入入口（onImport 會自動辨識格式）。
  function handleImportAuto() {
    const text = autoDraft.trim();
    if (!text) return;
    try {
      onImport(text);
      setAutoDraft(""); // 匯入成功才清空
    } catch (e) {
      alert(`匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  // auto-loop JSON 同樣走 onImport（會自動辨識並逐筆新增多筆 TaskRound）。
  function handleImportLoop() {
    const text = loopDraft.trim();
    if (!text) return;
    try {
      onImport(text);
      setLoopDraft(""); // 匯入成功才清空
    } catch (e) {
      alert(`匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  async function handleCopyAutoRoundCommand() {
    try {
      await navigator.clipboard.writeText(buildAutoRoundCommand(task, aiCommand));
      setAutoCmdCopied(true);
      setTimeout(() => setAutoCmdCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  // 透過本機 local runner（pnpm runner:local）一鍵執行 auto-round，沿用既有匯入邏輯新增 TaskRound。
  // body 的欄位與 mode 推導規則與 buildAutoRoundCommand / deriveAutoRoundMode 一致。
  async function handleRunAutoRound() {
    setAutoRoundRunning(true);
    setProgress({ phase: "preflight_running" });
    try {
      // 執行前先自動跑 Preflight；error 不執行、warning 需確認、全通過才繼續（結果同時顯示在 Preflight 區塊）。
      const pf = await runPreflight();
      if (!pf) {
        setProgress({ phase: "failed", message: "runner 未連線或執行失敗" });
        return;
      }
      if (!pf.ok && pf.summary.errorCount > 0) {
        setProgress({ phase: "preflight_failed", message: "Preflight 未通過，請先修正 error" });
        return;
      }
      if (pf.summary.warningCount > 0) {
        setProgress({ phase: "preflight_warning" });
        // 讓 preflight_warning 先繪製，再跳同步 confirm（confirm 會阻塞 render）。
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!window.confirm("Preflight 有 warning，仍要執行 auto-round 嗎？")) {
          setProgress({ phase: "failed", message: "使用者取消執行" });
          return;
        }
      }
      setProgress({ phase: "auto_round_running" });
      const res = await fetch("http://localhost:4318/auto-round", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: task.title,
          projectPath: task.projectPath ?? "",
          originalRequirement: task.originalRequirement,
          specDraft: task.specDraft ?? "",
          targetFiles: task.targetFiles,
          forbiddenFiles: task.forbiddenFiles,
          constraints: task.constraints,
          acceptanceCriteria: task.acceptanceCriteria,
          mode: deriveAutoRoundMode(task.workflowStage),
          aiCommand,
        }),
      });
      const resultText = await res.text();
      // 沿用既有 onImport（會辨識 auto-round 格式）；ok=false 也會建立一筆 TaskRound 以保留紀錄。
      setProgress({ phase: "importing_result" });
      try {
        onImport(resultText);
        setProgress({ phase: "completed" });
      } catch (e) {
        setProgress({ phase: "failed", message: `匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}` });
        alert(`匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
      }
    } catch (e) {
      setProgress({ phase: "failed", message: "runner 未連線或執行失敗" });
      alert(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。\n` +
          "請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local"
      );
    } finally {
      setAutoRoundRunning(false);
    }
  }

  async function handleCopyAutoLoopCommand() {
    try {
      await navigator.clipboard.writeText(buildAutoLoopCommand(task, aiCommand));
      setLoopCmdCopied(true);
      setTimeout(() => setLoopCmdCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  // 透過本機 local runner（pnpm runner:local）一鍵執行 auto-loop，沿用既有匯入邏輯新增多筆 TaskRound。
  // body 的欄位與 mode / maxRounds / autoApprove 規則與 buildAutoLoopCommand 一致。
  async function handleRunAutoLoop() {
    setAutoLoopRunning(true);
    setProgress({ phase: "preflight_running" });
    try {
      // 執行前先自動跑 Preflight；error 不執行、warning 需確認、全通過才繼續（結果同時顯示在 Preflight 區塊）。
      const pf = await runPreflight();
      if (!pf) {
        setProgress({ phase: "failed", message: "runner 未連線或執行失敗" });
        return;
      }
      if (!pf.ok && pf.summary.errorCount > 0) {
        setProgress({ phase: "preflight_failed", message: "Preflight 未通過，請先修正 error" });
        return;
      }
      if (pf.summary.warningCount > 0) {
        setProgress({ phase: "preflight_warning" });
        // 讓 preflight_warning 先繪製，再跳同步 confirm（confirm 會阻塞 render）。
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!window.confirm("Preflight 有 warning，仍要執行 auto-loop 嗎？")) {
          setProgress({ phase: "failed", message: "使用者取消執行" });
          return;
        }
      }
      setProgress({ phase: "auto_loop_running" });
      const res = await fetch("http://localhost:4318/auto-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: task.title,
          projectPath: task.projectPath ?? "",
          originalRequirement: task.originalRequirement,
          specDraft: task.specDraft ?? "",
          targetFiles: task.targetFiles,
          forbiddenFiles: task.forbiddenFiles,
          constraints: task.constraints,
          acceptanceCriteria: task.acceptanceCriteria,
          workflowStage: task.workflowStage ?? "spec",
          mode: deriveAutoRoundMode(task.workflowStage),
          aiCommand,
          maxRounds: DEFAULT_MAX_ROUNDS,
          autoApprove: DEFAULT_AUTO_APPROVE,
        }),
      });
      const resultText = await res.text();
      // 沿用既有 onImport（會辨識 auto-loop 格式並逐筆新增多筆 TaskRound）；ok=false 也會保留紀錄。
      setProgress({ phase: "importing_result" });
      try {
        onImport(resultText);
        setProgress({ phase: "completed" });
      } catch (e) {
        setProgress({ phase: "failed", message: `匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}` });
        alert(`匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
      }
    } catch (e) {
      setProgress({ phase: "failed", message: "runner 未連線或執行失敗" });
      alert(
        `無法連線到 local runner（${e instanceof Error ? e.message : "未知錯誤"}）。\n` +
          "請先在 ai-coding-relay 專案根目錄執行：pnpm runner:local"
      );
    } finally {
      setAutoLoopRunning(false);
    }
  }

  async function handleCopyCommand() {
    try {
      await navigator.clipboard.writeText("pnpm verify:copy");
      setCmdCopied(true);
      setTimeout(() => setCmdCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  async function handleCopyGuardCommand() {
    try {
      await navigator.clipboard.writeText(buildFileGuardCommand(task));
      setGuardCopied(true);
      setTimeout(() => setGuardCopied(false), 2000);
    } catch (e) {
      alert(`複製失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
    }
  }

  return (
    <div className="detail-section verification-import">
      <ExecutionProgressSection progress={progress} />
      <div className="detail-label">匯入驗證結果</div>
      <div className="detail-empty-text" style={{ marginBottom: 6 }}>
        在專案目錄執行下列指令，會自動跑本機驗證並把 JSON 複製到剪貼簿，再回到這裡貼上即可。
      </div>
      <div className="verify-cmd-row">
        <code className="verify-cmd">pnpm verify:copy</code>
        <button
          className={`btn btn-copy${cmdCopied ? " copied" : ""}`}
          onClick={handleCopyCommand}
        >
          {cmdCopied ? "✓ 已複製" : "複製驗證指令"}
        </button>
      </div>
      <div className="detail-empty-text" style={{ marginTop: 10, marginBottom: 6 }}>
        想啟用 File Guard？複製下列指令到 terminal 執行，會依本任務的目標／禁止檔案建立
        <code> .ai-coding-relay/guard-rules.json</code>。
      </div>
      <div className="verify-cmd-row">
        <button
          className={`btn btn-copy${guardCopied ? " copied" : ""}`}
          onClick={handleCopyGuardCommand}
        >
          {guardCopied ? "✓ 已複製" : "複製 File Guard 設定指令"}
        </button>
      </div>
      <textarea
        className="inline-edit-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder='貼上 verification JSON，例如 {"ok": true, "commands": [...]}'
        rows={6}
      />
      <div className="response-actions">
        <button
          className="btn btn-primary"
          onClick={handleImport}
          disabled={!draft.trim()}
        >
          匯入驗證結果
        </button>
      </div>

      <div className="detail-label" style={{ marginTop: 14 }}>匯入 auto-round 結果</div>
      <div className="detail-empty-text" style={{ marginBottom: 6 }}>
        想一鍵執行？請先在 ai-coding-relay 專案根目錄執行 <code>pnpm runner:local</code>，再按「執行 auto-round」，它會跑一輪並自動建立一筆回合（失敗結果也會留紀錄）。或複製下列指令到 terminal 執行（會依目前任務與工作流階段自動帶入 mode），把輸出 JSON 貼到下方匯入。
      </div>
      <div className="verify-cmd-row">
        <button
          className="btn btn-primary"
          onClick={handleRunAutoRound}
          disabled={autoRoundRunning}
        >
          {autoRoundRunning ? "執行中..." : "執行 auto-round"}
        </button>
        <button
          className={`btn btn-copy${autoCmdCopied ? " copied" : ""}`}
          onClick={handleCopyAutoRoundCommand}
        >
          {autoCmdCopied ? "✓ 已複製" : "複製 auto-round 指令"}
        </button>
      </div>
      <textarea
        className="inline-edit-textarea"
        value={autoDraft}
        onChange={(e) => setAutoDraft(e.target.value)}
        placeholder='貼上 auto-round JSON，例如 {"ok": false, "mode": "implement", "ai": {...}, "verification": {...}}'
        rows={6}
      />
      <div className="response-actions">
        <button
          className="btn btn-primary"
          onClick={handleImportAuto}
          disabled={!autoDraft.trim()}
        >
          匯入 auto-round 結果
        </button>
      </div>

      <div className="detail-label" style={{ marginTop: 14 }}>匯入 auto-loop 結果</div>
      <div className="detail-empty-text" style={{ marginBottom: 6 }}>
        想一鍵執行？請先在 ai-coding-relay 專案根目錄執行 <code>pnpm runner:local</code>，再按「執行 auto-loop」，它會跑多輪並自動建立多筆回合（失敗結果也會留紀錄）。或複製下列指令到 terminal 執行（會依目前任務與工作流階段帶入 mode、maxRounds=3、autoApprove=false），把輸出 JSON 貼到下方匯入。
      </div>
      <div className="verify-cmd-row">
        <button
          className="btn btn-primary"
          onClick={handleRunAutoLoop}
          disabled={autoLoopRunning}
        >
          {autoLoopRunning ? "執行中..." : "執行 auto-loop"}
        </button>
        <button
          className={`btn btn-copy${loopCmdCopied ? " copied" : ""}`}
          onClick={handleCopyAutoLoopCommand}
        >
          {loopCmdCopied ? "✓ 已複製" : "複製 auto-loop 指令"}
        </button>
      </div>
      <textarea
        className="inline-edit-textarea"
        value={loopDraft}
        onChange={(e) => setLoopDraft(e.target.value)}
        placeholder='貼上 auto-loop JSON，例如 {"ok": false, "totalRounds": 3, "stoppedReason": "...", "rounds": [...]}'
        rows={6}
      />
      <div className="response-actions">
        <button
          className="btn btn-primary"
          onClick={handleImportLoop}
          disabled={!loopDraft.trim()}
        >
          匯入 auto-loop 結果
        </button>
      </div>
    </div>
  );
}

function TagsSection({ task, onSave }: { task: Task; onSave: (tagsText: string) => void }) {
  const [draft, setDraft] = useState(task.tags.join(", "));

  useEffect(() => {
    setDraft(task.tags.join(", "));
  }, [task.id, task.tags]);

  function handleBlur() {
    const normalized = normalizeTags(draft);
    // 失焦時把輸入框正規化（trim、去空、去重）顯示
    setDraft(normalized.join(", "));
    if (normalized.join(",") !== task.tags.join(",")) {
      onSave(draft);
    }
  }

  return (
    <div className="detail-section">
      <div className="detail-label">標籤</div>
      <input
        className="tags-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        placeholder="以逗號分隔，例如：frontend, bug, urgent"
      />
      {task.tags.length > 0 && (
        <div className="tags-badge-row">
          {task.tags.map((tag) => (
            <span key={tag} className="tag-badge">#{tag}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function ListSection({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="detail-section">
      <div className="detail-label">{label}</div>
      {items.length === 0 ? (
        <div className="detail-empty-text">（無）</div>
      ) : (
        <ul className="detail-list">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SUMMARY_PLACEHOLDER = `請記錄這次任務做了什麼、修改了哪些檔案、遇到什麼問題、最後怎麼解、如何驗收。

任務目標：
修改檔案：
遇到問題：
最後解法：
驗收結果：
下次注意：`;

function SummarySection({
  draft,
  onDraftChange,
  summary,
  onSave,
  task,
  rounds,
}: {
  /** 受控的摘要草稿（由 TaskDetail 提升管理，供「套用完成狀態」共用最新內容）。 */
  draft: string;
  onDraftChange: (value: string) => void;
  summary: string | undefined;
  onSave: (summary: string) => void;
  task: Task;
  rounds: TaskRound[];
}) {
  const [saved, setSaved] = useState(false);

  function handleSave() {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  // 依目前任務的「最新一筆回合」重新產生摘要草稿；目前已有內容會先 confirm。不改任務狀態、不封存。
  function handleRegenerate() {
    if (rounds.length === 0) {
      alert("目前沒有可用的回合，無法產生摘要。");
      return;
    }
    const latest = rounds.reduce((a, b) => (b.roundIndex > a.roundIndex ? b : a));
    const generated = buildAutoSummaryDraft(task, latest);
    if (draft.trim()) {
      const ok = window.confirm("目前已有摘要，要覆蓋嗎？");
      if (!ok) return;
    }
    onSave(generated);
    onDraftChange(generated);
  }

  const isDirty = draft !== (summary ?? "");

  return (
    <div className="detail-section summary-section">
      <div className="detail-label">任務摘要</div>
      <div className="detail-empty-text" style={{ marginBottom: 6 }}>
        匯入 auto-round / auto-loop 結果時，若摘要空白會自動產生草稿；也可用下方按鈕依最新回合重新產生。
      </div>
      <textarea
        className="summary-textarea"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder={SUMMARY_PLACEHOLDER}
        rows={9}
      />
      <div className="summary-actions">
        <button
          className="btn"
          onClick={handleRegenerate}
          disabled={rounds.length === 0}
        >
          根據最新回合產生摘要
        </button>
        <button
          className={`btn btn-primary${saved ? " copied" : ""}`}
          onClick={handleSave}
          disabled={!isDirty && !saved}
        >
          {saved ? "✓ 已保存" : "保存摘要"}
        </button>
      </div>
    </div>
  );
}

/** 代表「失敗」的 stoppedReason token；最新回合含任一個就不建議完成。 */
const FAILURE_STOPPED_REASONS = new Set([
  "ai_failed",
  "verification_failed",
  "verification_unavailable",
  "file_guard_failed",
  "max_rounds_reached",
]);

/** 把逗號分隔的 stoppedReason 拆成 token（trim、去空）。 */
function splitStoppedReasons(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 最新回合（含 per-round 與 loop 層級）是否帶有失敗類型的 stoppedReason。 */
function hasFailureStoppedReason(round: TaskRound): boolean {
  const tokens = [
    ...splitStoppedReasons(round.stoppedReason),
    ...splitStoppedReasons(round.loopStoppedReason),
  ];
  return tokens.some((t) => FAILURE_STOPPED_REASONS.has(t));
}

/** 完成建議的結果：reasons 為顯示給使用者的依據。 */
type CompletionSuggestion = {
  reasons: string[];
};

/**
 * 依目前 task 的「最新一筆回合」判斷是否建議套用完成狀態。
 * 回傳 null 代表不顯示建議（第一版選擇不顯示原因，避免干擾）。
 *
 * 不建議完成的情況：任務已 done/passed/done、沒有回合、最新回合
 * verification 未通過、fileGuard 失敗、auto-round/auto-loop 該輪未成功，
 * 或帶有失敗類型 stoppedReason（ai_failed / verification_failed /
 * verification_unavailable / file_guard_failed / max_rounds_reached）。
 */
function evaluateCompletionSuggestion(task: Task, rounds: TaskRound[]): CompletionSuggestion | null {
  // 已經是 done + passed + done，不再重複建議。
  if (task.status === "done" && task.reviewResult === "passed" && task.workflowStage === "done") {
    return null;
  }
  if (rounds.length === 0) return null;

  // 取最新一筆回合（roundIndex 最大）。
  const latest = rounds.reduce((a, b) => (b.roundIndex > a.roundIndex ? b : a));

  // 失敗類型 stoppedReason → 不建議。
  if (hasFailureStoppedReason(latest)) return null;
  // verification 未通過（或未知）→ 不建議。
  if (latest.verificationOk !== true) return null;
  // fileGuard 失敗 → 不建議（沒有 fileGuard 視為無違規）。
  if (latest.fileGuard && latest.fileGuard.ok === false) return null;

  const isAutoLoop = typeof latest.loopTotalRounds === "number";
  const isAutoRound = !isAutoLoop && latest.autoRoundOk !== undefined;

  // auto-round / auto-loop 該輪必須成功（autoRoundOk === true）。
  if ((isAutoRound || isAutoLoop) && latest.autoRoundOk !== true) return null;

  const reasons: string[] = ["verification 通過"];
  if (latest.fileGuard) {
    reasons.push(
      latest.fileGuard.violations.length === 0 ? "fileGuard 通過（無違規）" : "fileGuard 通過"
    );
  } else {
    reasons.push("無 fileGuard 違規");
  }
  if (isAutoLoop) {
    reasons.push(`auto-loop 第 ${latest.loopRoundIndex ?? "?"}/${latest.loopTotalRounds} 輪通過`);
  } else if (isAutoRound) {
    reasons.push("auto-round 通過");
  }

  return { reasons };
}

/**
 * 完成建議區塊：當最新自動回合看起來已通過時，顯示「建議套用完成狀態」與一鍵套用按鈕。
 * 套用會把 status=done、reviewResult=passed、workflowStage=done（不封存、不 commit、不呼叫 shell/runner）。
 * 不符合條件時不顯示（回傳 null），避免干擾。
 */
function CompletionSuggestionSection({
  task,
  rounds,
  onApply,
}: {
  task: Task;
  rounds: TaskRound[];
  onApply: () => void;
}) {
  const suggestion = evaluateCompletionSuggestion(task, rounds);
  if (!suggestion) return null;

  const summaryEmpty = !(task.summary && task.summary.trim());

  return (
    <div className="detail-section completion-suggestion" data-testid="completion-suggestion">
      <div className="detail-label">完成建議</div>
      <div className="completion-suggestion-message">
        最新自動回合已通過，建議套用完成狀態。
      </div>
      <ul className="completion-suggestion-reasons">
        {suggestion.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {summaryEmpty && (
        <div className="completion-suggestion-hint">建議先保存摘要（不影響套用）。</div>
      )}
      <div className="response-actions">
        <button
          className="btn btn-primary completion-apply-btn"
          onClick={onApply}
        >
          套用完成狀態
        </button>
      </div>
    </div>
  );
}

/**
 * CE Completion Gate（Phase 73A）：當 CE Review 結果為 passed 時，顯示「建議套用完成狀態」與一鍵按鈕。
 * 沿用 Phase 65 的 applyCompletion（透過 onApply，使用 TaskDetail 目前的 summaryDraft），
 * 不新增第二套 completion 邏輯、不自動封存、不自動 commit/push、不自動執行 Work/Fix。
 * CE Review needs_fix 時改顯示提示（無完成按鈕）；任務已完成或無 CE Review 結果時不顯示。
 */
function CeCompletionGateSection({
  task,
  onApply,
}: {
  task: Task;
  /** 沿用 Phase 65：呼叫端以目前 summaryDraft 觸發 applyCompletion。 */
  onApply: () => void;
}) {
  const showGate = shouldShowCeCompletionGate(task);
  const showNeedsFix = shouldShowCeReviewNeedsFix(task);
  if (!showGate && !showNeedsFix) return null;

  if (showNeedsFix) {
    return (
      <div className="detail-section ce-completion-needs-fix" data-testid="ce-completion-needs-fix">
        <div className="detail-label">CE Completion</div>
        <div className="ce-completion-message">CE Review 需要修正。</div>
        <div className="ce-completion-hint">請先處理 recommended fixes，再完成任務。</div>
      </div>
    );
  }

  const summaryEmpty = !(task.summary && task.summary.trim());
  return (
    <div className="detail-section ce-completion-gate" data-testid="ce-completion-gate">
      <div className="detail-label">CE Completion</div>
      <div className="ce-completion-message">CE Review 已通過，建議套用完成狀態。</div>
      <ul className="ce-completion-reasons">
        <li>Review result: passed</li>
        <li>Work result 已存在</li>
        <li>不會自動封存</li>
      </ul>
      {summaryEmpty && (
        <div className="ce-completion-hint">摘要為空，可稍後補充（不影響套用）。</div>
      )}
      <div className="response-actions">
        <button
          className="btn btn-primary ce-completion-apply-btn"
          data-testid="ce-completion-apply"
          onClick={onApply}
        >
          套用 CE 完成狀態
        </button>
      </div>
    </div>
  );
}

/**
 * 完成紀錄區塊（Phase 65）：套用完成狀態後顯示完成時間與最近一次紀錄，並給一行成功回饋。
 * 資料來自 task.completedAt / task.completionHistory（存在瀏覽器 localStorage，reload 後仍在）。
 * 套用後完成建議會消失，故成功回饋顯示在此，避免無處可顯示。
 */
function CompletionHistorySection({ task }: { task: Task }) {
  const history = task.completionHistory ?? [];
  if (!task.completedAt && history.length === 0) return null;

  const latest = history.length > 0 ? history[history.length - 1] : null;
  const feedback = latest
    ? latest.summarySaved
      ? "已保存摘要並套用完成狀態。"
      : "已套用完成狀態；摘要為空，可稍後補充。"
    : "";

  return (
    <div
      className="detail-section completion-history"
      data-testid="completion-history"
      data-completed-at={task.completedAt ?? ""}
    >
      <div className="detail-label">完成紀錄</div>
      {feedback && <div className="completion-history-feedback">{feedback}</div>}
      {task.completedAt && (
        <div className="completion-history-time">
          完成時間：{formatDateTime(task.completedAt)}
        </div>
      )}
      {latest && <div className="completion-history-message">{latest.message}</div>}
    </div>
  );
}
