import type { TaskFormValues } from "../shared/types";

/**
 * Phase 62：快速建立任務 / 自然語言自動填入欄位（deterministic rules）。
 *
 * 純函式：只依 originalRequirement / projectPath / 目前 title / 模板，推導出要寫回表單的欄位。
 * 刻意不呼叫 AI、不呼叫 runner、不執行 shell，輸出穩定可測。
 *
 * 約定：
 * - 回傳 Partial<TaskFormValues>，UI 端以 Object spread 合併寫回表單。
 * - title 已有內容時不放進結果（不覆蓋使用者輸入）。
 * - 不輸出 projectPath（保留使用者已填的值），也不把 projectPath 放進 targetFiles。
 */

/** 「文件小改 auto-round」固定的禁止修改範圍。 */
export const QUICK_FILL_FORBIDDEN_FILES: string[] = [
  "src/",
  "tests/",
  "scripts/",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
];

/** acceptanceCriteria 結尾固定附加的「不修改 / 驗證」條目。 */
const ACCEPTANCE_TAIL: string[] = [
  "不修改 src。",
  "不修改 tests。",
  "不修改 scripts。",
  "不修改 package.json / package-lock.yaml / package-lock.json / tsconfig.json。",
  "npm run verify:local 通過。",
];

/** 抓不到條列時，acceptanceCriteria 的最小集合。 */
const ACCEPTANCE_FALLBACK: string[] = [
  "指定文件已完成補充或修改。",
  "文件內容符合原始需求。",
  ...ACCEPTANCE_TAIL,
];

export type QuickFillTemplate = "docs_auto_round" | "other";

export type QuickFillInput = {
  originalRequirement: string;
  /** 使用者已填的專案路徑；只用來排除進 targetFiles，不會被輸出。 */
  projectPath?: string;
  /** 目前表單的 title；非空白時不覆蓋。 */
  currentTitle: string;
  template: QuickFillTemplate;
};

/** 從 originalRequirement 推導 title。已有 title 時請不要呼叫（由 quickFillTaskFields 控制）。 */
export function deriveTitle(originalRequirement: string): string {
  const sentences = originalRequirement
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sentence = sentences.find((s) => s.includes("補充") || s.includes("新增"));
  if (sentence) {
    const candidates = ["補充", "新增"]
      .map((k) => sentence.indexOf(k))
      .filter((i) => i >= 0);
    const start = Math.min(...candidates);
    const title = sentence
      .slice(start)
      .replace(/[「」『』"'，。、]/g, "")
      .trim()
      .slice(0, 30);
    if (title.length > 0) return title;
  }

  return "文件小改 auto-round 任務";
}

/**
 * 從 originalRequirement 抓相對的文件路徑（*.md / *.txt，含 docs/xxx.md、README.md）。
 * - 略過絕對路徑。
 * - 略過等於 / 包含於 projectPath 的字串（不要把 projectPath 填進 targetFiles）。
 * - 去除重複，保留出現順序。
 */
export function deriveTargetFiles(originalRequirement: string, projectPath?: string): string[] {
  // 允許吃進開頭的 "/"，這樣絕對路徑會以 "/" 開頭而被下方過濾掉。
  const matches = originalRequirement.match(/\/?[A-Za-z0-9_.][A-Za-z0-9_./-]*\.(?:md|txt)\b/g) ?? [];
  const projectPathTrimmed = projectPath?.trim() ?? "";
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of matches) {
    const path = raw.trim();
    if (path.length === 0) continue;
    if (path.startsWith("/")) continue; // 絕對路徑不收
    if (projectPathTrimmed && (path === projectPathTrimmed || projectPathTrimmed.includes(path))) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

/** 限制條件：第一條鎖定 targetFiles，其餘為文件任務固定條目。 */
export function deriveConstraints(targetFiles: string[]): string[] {
  const first =
    targetFiles.length > 0
      ? `只修改 ${targetFiles.join(" / ")}。`
      : "只修改 targetFiles 列出的文件。";
  return [
    first,
    "不要修改 src。",
    "不要修改 tests。",
    "不要修改 scripts。",
    "不要修改 package.json / package-lock.json / pnpm-lock.yaml / tsconfig.json。",
    "不要新增套件。",
    "不要使用 any。",
    "文件內容若涉及現有程式行為，必須符合目前程式碼現況。",
  ];
}

/** 從 originalRequirement 取出條列項目（1. / 2、 / 3) 等），去掉序號與結尾句號。 */
function parseNumberedList(originalRequirement: string): string[] {
  const items: string[] = [];
  for (const line of originalRequirement.split("\n")) {
    const m = line.match(/^\s*\d+[.、)）]\s*(.+?)\s*$/);
    if (m) {
      const text = m[1].replace(/。\s*$/, "").trim();
      if (text.length > 0) items.push(text);
    }
  }
  return items;
}

/**
 * acceptanceCriteria：
 * - 抓到條列 → 第一條鎖定目標檔案，逐條轉成「內容說明 …」，再附加固定結尾。
 * - 抓不到條列 → 回傳最小集合。
 */
export function deriveAcceptanceCriteria(originalRequirement: string, targetFiles: string[]): string[] {
  const items = parseNumberedList(originalRequirement);
  if (items.length === 0) return [...ACCEPTANCE_FALLBACK];

  const head: string[] = [];
  if (targetFiles.length > 0) head.push(`${targetFiles[0]} 已完成新增或補充。`);
  for (const item of items) head.push(`內容說明 ${item}。`);
  return [...head, ...ACCEPTANCE_TAIL];
}

/**
 * 主入口：依輸入推導要寫回表單的欄位。
 * - 只有在使用「文件小改 auto-round」模板時，才設定 type / workflowStage / reviewResult /
 *   forbiddenFiles / constraints / acceptanceCriteria；其他模板僅推導 title / targetFiles。
 */
export function quickFillTaskFields(input: QuickFillInput): Partial<TaskFormValues> {
  const { originalRequirement, projectPath, currentTitle, template } = input;
  const targetFiles = deriveTargetFiles(originalRequirement, projectPath);
  const result: Partial<TaskFormValues> = {};

  // title：已有內容不覆蓋。
  if (currentTitle.trim().length === 0) {
    result.title = deriveTitle(originalRequirement);
  }

  const isDocs = template === "docs_auto_round";

  // targetFiles：文件模板一律寫回（抓不到 → 空白，不亂猜）；其他模板僅在抓到時填。
  if (isDocs) {
    result.targetFilesText = targetFiles.join("\n");
  } else if (targetFiles.length > 0) {
    result.targetFilesText = targetFiles.join("\n");
  }

  if (isDocs) {
    result.type = "docs";
    result.workflowStage = "green_implement";
    result.reviewResult = "not_reviewed";
    result.forbiddenFilesText = QUICK_FILL_FORBIDDEN_FILES.join("\n");
    result.constraintsText = deriveConstraints(targetFiles).join("\n");
    result.acceptanceCriteriaText = deriveAcceptanceCriteria(originalRequirement, targetFiles).join("\n");
  }

  return result;
}
