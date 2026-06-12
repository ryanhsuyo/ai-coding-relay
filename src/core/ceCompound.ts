import type { AiWorkflowCompound, Task, TaskCompletionEvent } from "../shared/types";
import { formatBulletList } from "./aiWorkflowPrompts";

/**
 * Phase 74：CE Compound Notes Generator（本機 deterministic 純函式）。
 * 把本次任務的既有資料沉澱成可重用知識（lessonLearned / reusablePrompt / compoundNotes）。
 *
 * 全為純函式：不依賴 React、不讀寫 localStorage、不呼叫 runner、不呼叫 Claude CLI、
 * 不讀 target project、不執行 shell、不 throw。缺資料時也產生合理草稿並提醒補強。
 */

const INSUFFICIENT_DATA_HINT =
  "資料不足，建議補充 Work / Review 結果後再沉澱。";

/** 取非空白字串，否則 undefined。 */
function trimmed(value?: string): string | undefined {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
}

/** 過濾掉空白項並 trim 的字串陣列；沒有內容時回傳空陣列。 */
function cleanArray(items?: string[]): string[] {
  if (!items) return [];
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

/** 取 review 結論文字（不依賴 ceCompletion 的精確標記，僅做可讀摘要）。 */
function reviewVerdictText(notes?: string): string {
  const text = trimmed(notes);
  if (!text) return "尚未進行 Review";
  if (text.includes("Review result: passed")) return "Review 通過（passed）";
  if (text.includes("Review result: needs_fix")) return "Review 需要修正（needs_fix）";
  return "已有 Review 筆記（未標記 passed / needs_fix）";
}

/** 把 completionHistory 整理成可讀清單；沒有時回傳空字串。 */
function formatCompletionHistory(history?: TaskCompletionEvent[]): string {
  if (!history || history.length === 0) return "";
  return history
    .map((event, index) => `${index + 1}. ${event.createdAt} — ${event.message}`)
    .join("\n");
}

/**
 * 是否缺乏 Work / Review 結果（用來決定要不要在草稿中提醒補強）。
 * 只要 changedFiles / testCommands / testResults / codeReviewNotes 全空即視為資料不足。
 */
function isWorkReviewInsufficient(task: Task): boolean {
  const wr = task.aiWorkflow?.workReview;
  const hasChangedFiles = cleanArray(wr?.changedFiles).length > 0;
  const hasTestCommands = cleanArray(wr?.testCommands).length > 0;
  const hasTestResults = Boolean(trimmed(wr?.testResults));
  const hasReview = Boolean(trimmed(wr?.codeReviewNotes));
  return !hasChangedFiles && !hasTestCommands && !hasTestResults && !hasReview;
}

/** 1. lessonLearned：可讀的經驗摘要。 */
function buildLessonLearned(task: Task): string {
  const wf = task.aiWorkflow;
  const requirement = trimmed(task.originalRequirement) ?? "（未提供原始需求）";
  const risks = cleanArray(wf?.audit?.riskNotes);
  const riskText = risks.length > 0 ? risks.join("；") : "（未紀錄核心風險）";
  const minimalStrategy =
    trimmed(wf?.audit?.notes) ?? trimmed(wf?.plan?.summary) ?? "（未紀錄最小修改策略）";
  const testCommands = cleanArray(wf?.workReview?.testCommands);
  const verifyText =
    testCommands.length > 0 ? testCommands.join("、") : "（未紀錄驗證指令）";
  const reviewText = reviewVerdictText(wf?.workReview?.codeReviewNotes);

  const overview = [
    "本次任務重點：",
    `- 原始需求：${requirement}`,
    `- 核心風險：${riskText}`,
    `- 最小修改策略：${minimalStrategy}`,
    `- 驗證重點：${verifyText}`,
    `- Review 結論：${reviewText}`,
  ].join("\n");

  const experiences: string[] = [];
  if (risks.length > 0) {
    experiences.push(`處理類似需求時，先確認這些風險：${risks.join("；")}`);
  }
  const changedFiles = cleanArray(wf?.workReview?.changedFiles);
  if (changedFiles.length > 0) {
    experiences.push(`主要改動集中在：${changedFiles.join("、")}`);
  }
  const coreAssumptions = cleanArray(wf?.audit?.coreAssumptions);
  if (coreAssumptions.length > 0) {
    experiences.push(`核心假設：${coreAssumptions.join("；")}`);
  }
  if (testCommands.length > 0) {
    experiences.push(`完成後務必執行驗證：${testCommands.join("、")}`);
  }

  const insufficient = isWorkReviewInsufficient(task);
  if (insufficient) {
    experiences.push(INSUFFICIENT_DATA_HINT);
  }

  const experienceBlock = [
    "適合記住的經驗：",
    ...experiences.map((item) => `- ${item}`),
  ].join("\n");

  return `${overview}\n\n${experienceBlock}`;
}

/** 2. reusablePrompt：下次可重用的 prompt 模板。 */
function buildReusablePrompt(task: Task): string {
  const title = trimmed(task.title) ?? "這類需求";
  const testCommands = cleanArray(task.aiWorkflow?.workReview?.testCommands);
  const testCommandsBlock =
    testCommands.length > 0
      ? testCommands.map((cmd) => `      - ${cmd}`).join("\n")
      : "      - （請補上測試指令）";
  const risks = cleanArray(task.aiWorkflow?.audit?.riskNotes);
  const riskBlock =
    risks.length > 0
      ? risks.map((risk) => `      - ${risk}`).join("\n")
      : "      - （請補上風險檢查項目）";
  const reviewSummary = trimmed(task.aiWorkflow?.workReview?.codeReviewNotes);
  const reviewBlock = reviewSummary
    ? reviewSummary
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 5)
        .map((line) => `      - ${line}`)
        .join("\n")
    : "      - （請補上上次 Review 的重點）";

  return [
    `當我處理類似「${title}」的需求時，請先做以下檢查：`,
    "",
    "1. 先確認原始需求與邊界。",
    "2. 檢查相關檔案與資料流。",
    "3. 找出核心假設。",
    "4. 確認最小修改方案。",
    "5. 補上可驗證的 acceptance criteria。",
    "6. 實作後必須跑以下測試：",
    testCommandsBlock,
    "7. Review 時請特別檢查：",
    riskBlock,
    reviewBlock,
    "",
    "限制：",
    "- 不要過度重構。",
    "- 不要修改 unrelated files。",
    "- 需要保留 rollback / error path / transaction consistency 等風險檢查，如果 task 內容相關。",
  ].join("\n");
}

/** 3. compoundNotes：完整紀錄。 */
function buildCompoundNotes(task: Task): string {
  const wf = task.aiWorkflow;
  const sections: string[] = [];

  sections.push("# Compound Notes");

  sections.push(
    [
      "## Context",
      `- Task: ${trimmed(task.title) ?? "（未命名）"}`,
      `- Project: ${trimmed(task.project) ?? "（未設定）"}${
        trimmed(task.projectPath) ? `（${task.projectPath?.trim()}）` : ""
      }`,
      `- Requirement: ${trimmed(task.originalRequirement) ?? "（未提供）"}`,
    ].join("\n")
  );

  sections.push(
    ["## Brainstorm", trimmed(wf?.brainstorm?.summary) ?? "（無 brainstorm 摘要）"].join("\n")
  );

  sections.push(["## Plan", trimmed(wf?.plan?.summary) ?? "（無 plan 摘要）"].join("\n"));

  const auditParts: string[] = ["## Audit"];
  const auditNotes = trimmed(wf?.audit?.notes);
  if (auditNotes) auditParts.push(auditNotes);
  const coreAssumptions = formatBulletList(wf?.audit?.coreAssumptions);
  if (coreAssumptions) auditParts.push(`核心假設：\n${coreAssumptions}`);
  const riskNotes = formatBulletList(wf?.audit?.riskNotes);
  if (riskNotes) auditParts.push(`風險：\n${riskNotes}`);
  const acceptanceCriteria = formatBulletList(wf?.audit?.acceptanceCriteria);
  if (acceptanceCriteria) auditParts.push(`驗收標準：\n${acceptanceCriteria}`);
  if (auditParts.length === 1) auditParts.push("（無審計資料）");
  sections.push(auditParts.join("\n\n"));

  const changedFiles = formatBulletList(wf?.workReview?.changedFiles);
  const testCommands = formatBulletList(wf?.workReview?.testCommands);
  const testResults = trimmed(wf?.workReview?.testResults);
  sections.push(
    [
      "## Work",
      `Changed files:\n${changedFiles || "（無）"}`,
      `Test commands:\n${testCommands || "（無）"}`,
      `Test results:\n${testResults ?? "（無）"}`,
    ].join("\n\n")
  );

  sections.push(
    [
      "## Review",
      `${reviewVerdictText(wf?.workReview?.codeReviewNotes)}`,
      trimmed(wf?.workReview?.codeReviewNotes) ?? "（無 Review 筆記）",
    ].join("\n\n")
  );

  const completionHistory = formatCompletionHistory(task.completionHistory);
  sections.push(
    [
      "## Completion",
      `completedAt: ${trimmed(task.completedAt) ?? "（未完成）"}`,
      `completionHistory:\n${completionHistory || "（無）"}`,
    ].join("\n")
  );

  const reusableParts: string[] = ["## Reusable Knowledge"];
  if (isWorkReviewInsufficient(task)) {
    reusableParts.push(INSUFFICIENT_DATA_HINT);
  }
  reusableParts.push(buildReusablePrompt(task));
  sections.push(reusableParts.join("\n\n"));

  return sections.join("\n\n");
}

/**
 * Phase 74：依 task 目前資料產生 Compound 草稿。
 * 回傳 lessonLearned / reusablePrompt / compoundNotes 三段；缺資料時仍產生合理草稿。
 * 不 throw、不使用 any、不修改傳入的 task。
 */
export function buildCeCompoundDraft(task: Task): AiWorkflowCompound {
  return {
    lessonLearned: buildLessonLearned(task),
    reusablePrompt: buildReusablePrompt(task),
    compoundNotes: buildCompoundNotes(task),
  };
}
