import type { PlanAuditChecklist, Task } from "../shared/types";

/**
 * Phase 66：Hack22 / Compound Engineering AI Engineering Workflow 的 prompt 產生器。
 * 全為純函式：不依賴 React、不讀寫 localStorage、不呼叫 runner、不 throw。
 * 回傳字串可直接複製給 Claude Code 使用。
 */

/**
 * 將任意輸入轉成適合放進路徑的 slug。
 * 保留英數字與中日韓字元，其餘轉成連字號；空字串／全符號時回傳 "task"，永不 throw。
 */
export function slugifyForPath(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "task";
}

/** 將字串陣列轉成有序清單文字；空白或未提供時回傳空字串。 */
export function formatBulletList(items?: string[]): string {
  if (!items || items.length === 0) return "";
  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
}

/**
 * 取得目前 workflow 最相關的文件路徑：
 * 優先 brainstorm.path，其次 plan.path，皆無回傳 undefined。
 */
export function getWorkflowPath(task: Task): string | undefined {
  const brainstormPath = task.aiWorkflow?.brainstorm?.path?.trim();
  if (brainstormPath) return brainstormPath;
  const planPath = task.aiWorkflow?.plan?.path?.trim();
  if (planPath) return planPath;
  return undefined;
}

/** 取出非空白字串，否則 undefined。 */
function trimmed(value?: string): string | undefined {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
}

/** 將 checklist 的布林狀態轉成可讀清單；未提供時回傳空字串。 */
function formatChecklist(checklist?: PlanAuditChecklist): string {
  if (!checklist) return "";
  const mark = (done: boolean) => (done ? "[x]" : "[ ]");
  return [
    `${mark(checklist.coreAssumptionsReviewed)} 核心假設已審查`,
    `${mark(checklist.riskReviewed)} 風險已審查`,
    `${mark(checklist.scopeReviewed)} 範圍已審查`,
    `${mark(checklist.acceptanceCriteriaReviewed)} 驗收標準已審查`,
    `${mark(checklist.minimalChangeReviewed)} 最小修改原則已審查`,
  ].join("\n");
}

/** 將段落陣列以空行串接，過濾掉空白段落。 */
function joinSections(sections: Array<string | undefined>): string {
  return sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section && section.length > 0))
    .join("\n\n");
}

/**
 * 1. Brainstorm / requirements analysis prompt。
 * 產生唯讀分析的 ce-brainstorm prompt，不修改任何檔案。
 */
export function buildBrainstormPrompt(task: Task): string {
  const title = trimmed(task.title);
  const requirement = trimmed(task.originalRequirement);
  const project = trimmed(task.project);
  const projectPath = trimmed(task.projectPath);
  const slug = slugifyForPath(title ?? requirement ?? "task");

  return joinSections([
    "/compound-engineering:ce-brainstorm",
    "請以唯讀分析的方式進行 brainstorm 與需求分析，不要修改任何檔案。",
    title ? `任務標題：\n${title}` : undefined,
    requirement ? `原始需求：\n${requirement}` : undefined,
    project ? `專案分類：\n${project}` : undefined,
    projectPath ? `目標專案路徑：\n${projectPath}` : undefined,
    [
      "請輸出以下內容：",
      "1. 問題定義",
      "2. 相關檔案",
      "3. 現況資料流",
      "4. 風險",
      "5. 建議方案",
      "6. 驗收標準",
    ].join("\n"),
    `完成後建議將結果保存成 docs/brainstorms/${slug}.md。`,
  ]);
}

/**
 * 2. ce-plan / implementation plan prompt。
 * 優先使用 brainstorm.path，其次 plan.path；皆無時仍回傳可用 prompt 並提醒先填路徑。
 */
export function buildPlanPrompt(task: Task): string {
  const path = getWorkflowPath(task);
  const title = trimmed(task.title);
  const requirement = trimmed(task.originalRequirement);

  if (path) {
    return joinSections([
      `/compound-engineering:ce-plan ${path}`,
      title ? `任務標題：\n${title}` : undefined,
      requirement ? `原始需求：\n${requirement}` : undefined,
      "請根據上述文件產生 implementation plan，列出要修改的檔案、步驟與驗收標準。",
    ]);
  }

  return joinSections([
    "/compound-engineering:ce-plan",
    "提醒：尚未填寫 brainstormPath 或 planPath，請先補上 brainstorm.path 或 plan.path 再執行，以便指向對應文件。",
    title ? `任務標題：\n${title}` : undefined,
    requirement ? `原始需求：\n${requirement}` : undefined,
    "請根據上述需求產生 implementation plan，列出要修改的檔案、步驟與驗收標準。",
  ]);
}

/**
 * 3. Audit plan / 審計核心假設與風險 prompt。
 */
export function buildAuditPrompt(task: Task): string {
  const planPath = trimmed(task.aiWorkflow?.plan?.path) ?? getWorkflowPath(task);
  const planSummary = trimmed(task.aiWorkflow?.plan?.summary);
  const acceptanceCriteria = formatBulletList(task.aiWorkflow?.audit?.acceptanceCriteria);

  return joinSections([
    "請審計這份 plan，不要修改檔案。請回答：",
    [
      "- 核心假設是什麼？",
      "- 如果假設錯了會怎樣？",
      "- 是否有過度設計？",
      "- 是否符合最小修改原則？",
      "- 是否可能影響其他模組？",
      "- 驗收標準是否可以被測試？",
      "- 建議第一個最小 commit 是什麼？",
    ].join("\n"),
    planPath ? `Plan 路徑：\n${planPath}` : undefined,
    planSummary ? `Plan 摘要：\n${planSummary}` : undefined,
    acceptanceCriteria ? `驗收標準：\n${acceptanceCriteria}` : undefined,
  ]);
}

/**
 * 4. Work / 實作 prompt。
 */
export function buildWorkPrompt(task: Task): string {
  const planPath = trimmed(task.aiWorkflow?.plan?.path) ?? getWorkflowPath(task);
  const planSummary = trimmed(task.aiWorkflow?.plan?.summary);
  const checklist = formatChecklist(task.aiWorkflow?.audit?.checklist);
  const acceptanceCriteria = formatBulletList(task.aiWorkflow?.audit?.acceptanceCriteria);
  const changedFiles = formatBulletList(task.aiWorkflow?.workReview?.changedFiles);

  return joinSections([
    "請依照已審核通過的 plan 實作。只修改 plan 中列出的檔案。每完成一個步驟請回報。不要額外重構。",
    planPath ? `Plan 路徑：\n${planPath}` : undefined,
    planSummary ? `Plan 摘要：\n${planSummary}` : undefined,
    checklist ? `審計核對清單：\n${checklist}` : undefined,
    acceptanceCriteria ? `驗收標準：\n${acceptanceCriteria}` : undefined,
    changedFiles ? `預期變更的檔案：\n${changedFiles}` : undefined,
  ]);
}

/**
 * 5. Code review / 審查 prompt。
 */
export function buildReviewPrompt(task: Task): string {
  const changedFiles = formatBulletList(task.aiWorkflow?.workReview?.changedFiles);
  const testCommands = formatBulletList(task.aiWorkflow?.workReview?.testCommands);
  const testResults = trimmed(task.aiWorkflow?.workReview?.testResults);
  const commitHash = trimmed(task.aiWorkflow?.workReview?.commitHash);
  const commitMessage = trimmed(task.aiWorkflow?.workReview?.commitMessage);

  return joinSections([
    "請 review 這次修改，不要再改檔案。請檢查：",
    [
      "- 是否符合原 plan",
      "- 是否有過度修改",
      "- 是否有型別風險",
      "- 是否有測試缺口",
      "- 是否有可以拆分 commit 的地方",
    ].join("\n"),
    changedFiles ? `變更的檔案：\n${changedFiles}` : undefined,
    testCommands ? `測試指令：\n${testCommands}` : undefined,
    testResults ? `測試結果：\n${testResults}` : undefined,
    commitHash ? `Commit hash：\n${commitHash}` : undefined,
    commitMessage ? `Commit message：\n${commitMessage}` : undefined,
  ]);
}
