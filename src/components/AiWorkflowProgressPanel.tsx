import type { Task } from "../shared/types";
import type { AiWorkflowStepState } from "../core/aiWorkflowProgress";
import { deriveAiWorkflowProgress } from "../core/aiWorkflowProgress";

/**
 * Phase 69：AI Workflow 階段總覽。
 * 純顯示元件：由傳入的 task（呼叫端可帶最新 draft 組成的 effective task）推導進度，
 * 不保存、不修改任何資料。
 */

const STATE_ICON: Record<AiWorkflowStepState, string> = {
  completed:   "✅",
  in_progress: "⏳",
  blocked:     "⚠️",
  not_started: "○",
};

type Props = {
  /** 推導來源；呼叫端應傳入含最新 draft 的 effective task，讓總覽即時反映未保存內容。 */
  task: Task;
};

export function AiWorkflowProgressPanel({ task }: Props) {
  const progress = deriveAiWorkflowProgress(task);

  return (
    <div className="aiwf-progress-panel" data-testid="aiwf-progress">
      <div className="aiwf-progress-title">AI Workflow 進度</div>
      <div className="aiwf-progress-steps">
        {progress.steps.map((step) => (
          <div
            key={step.key}
            className={`aiwf-progress-step ${step.state.replace("_", "-")}`}
            data-testid={`aiwf-step-${step.key}`}
            data-state={step.state}
          >
            <span className="aiwf-progress-step-head">
              {STATE_ICON[step.state]} {step.label}
            </span>
            <span className="aiwf-progress-step-detail">{step.detail}</span>
          </div>
        ))}
      </div>
      <div className="aiwf-next-action" data-testid="aiwf-next-action">
        {progress.nextAction}
      </div>
      <div
        className={`aiwf-work-readiness${progress.canStartWork ? " ready" : ""}`}
        data-testid="aiwf-work-readiness"
      >
        {progress.canStartWork ? "可進入 Work 階段" : "尚不建議進入 Work"}
      </div>
      <div className="aiwf-audit-count" data-testid="aiwf-audit-count">
        Audit checklist：{progress.auditChecklistCompletedCount}/{progress.auditChecklistTotalCount}
      </div>
    </div>
  );
}
