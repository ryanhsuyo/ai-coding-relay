import type { Task } from "../shared/types";

/**
 * Phase 73A：CE Review Passed Completion Gate 的判斷（純函式）。
 * 不依賴 React、不讀寫 localStorage、不呼叫 runner、不 throw。
 *
 * 判斷來源：aiWorkflow.workReview.codeReviewNotes（Phase 72 buildCeReviewNotes 產生的格式）。
 * 為避免誤判一般文字，只比對精確標記字串，不用模糊的 "passed" 字樣。
 */

const PASSED_MARKER = "Review result: passed";
const NEEDS_FIX_MARKER = "Review result: needs_fix";

/** 取 codeReviewNotes；沒有時回傳空字串。 */
function codeReviewNotes(task: Task): string {
  return task.aiWorkflow?.workReview?.codeReviewNotes ?? "";
}

/**
 * CE Review 是否為 passed：codeReviewNotes 精確包含 "Review result: passed"。
 * needs_fix（含 "Review result: needs_fix"）不包含此字串，故回 false；無 notes → false。
 */
export function isCeReviewPassed(task: Task): boolean {
  return codeReviewNotes(task).includes(PASSED_MARKER);
}

/** CE Review 是否為 needs_fix：codeReviewNotes 精確包含 "Review result: needs_fix"。 */
export function isCeReviewNeedsFix(task: Task): boolean {
  return codeReviewNotes(task).includes(NEEDS_FIX_MARKER);
}

/** 任務是否已是完成狀態（done + passed + done）；用來避免在已完成任務重複顯示 gate。 */
export function isTaskFullyCompleted(task: Task): boolean {
  return (
    task.status === "done" &&
    task.reviewResult === "passed" &&
    task.workflowStage === "done"
  );
}

/**
 * 是否顯示 CE Completion Gate（建議套用完成狀態）：
 * CE Review 為 passed，且任務尚未完成。
 */
export function shouldShowCeCompletionGate(task: Task): boolean {
  return isCeReviewPassed(task) && !isTaskFullyCompleted(task);
}

/**
 * 是否顯示 CE Review needs_fix 提示（不提供完成按鈕）：
 * CE Review 為 needs_fix、非 passed，且任務尚未完成。
 */
export function shouldShowCeReviewNeedsFix(task: Task): boolean {
  return isCeReviewNeedsFix(task) && !isCeReviewPassed(task) && !isTaskFullyCompleted(task);
}
