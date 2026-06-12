import { useState } from "react";
import type { TaskFormValues, TaskType } from "../shared/types";
import { loadPreferences } from "../storage/preferenceStorage";
import { quickFillTaskFields } from "../core/quickFillTask";

const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: "bug",        label: "Bug 修正" },
  { value: "ui",         label: "UI 修改" },
  { value: "typescript", label: "TypeScript 錯誤" },
  { value: "refactor",   label: "重構" },
  { value: "api",        label: "API 串接" },
  { value: "test",       label: "Test 補強" },
  { value: "docs",       label: "文件" },
  { value: "other",      label: "其他" },
];

type TemplateKey = "none" | "general" | "claude_review" | "bug_fix" | "docs_auto_round";

const GENERAL_TEMPLATE = `原始需求：

允許修改檔案：

禁止修改範圍：

限制條件：
1. 不要使用 any。

驗收條件：
1. TypeScript 檢查通過。`;

const CLAUDE_REVIEW_TEMPLATE = `請幫我審查這次 Claude Code 的修改是否符合需求。

原始需求：

允許修改檔案：

禁止修改範圍：

限制條件：

Claude 回覆：

請檢查：
1. 是否符合原始需求。
2. 是否超出允許修改範圍。
3. 是否違反限制條件。
4. 是否有型別、安全性、資料流或維護性問題。
5. 是否需要補測試或補驗收。`;

const BUG_FIX_TEMPLATE = `問題描述：

重現步驟：
1.

預期結果：

實際結果：

可能相關檔案：

限制條件：
1. 盡量最小修改。
2. 不要使用 any。

驗收條件：
1. 問題已修正。
2. 沒有破壞既有功能。
3. TypeScript 檢查通過。`;

// 「文件小改 auto-round」模板：低風險文件任務的預設欄位，搭配 Preflight 與 auto-round 使用。
// 只補欄位，不覆蓋 title / originalRequirement / projectPath。
const DOCS_TARGET_FILES = "docs/harness-architecture.md";

const DOCS_FORBIDDEN_FILES = [
  "src/",
  "tests/",
  "scripts/",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
].join("\n");

const DOCS_CONSTRAINTS = [
  "只修改文件檔案。",
  "不要修改 src。",
  "不要修改 tests。",
  "不要修改 scripts。",
  "不要修改 package.json / lockfile / tsconfig。",
  "不要新增套件。",
  "不要使用 any。",
  "若文件內容涉及現有程式行為，必須符合目前程式碼現況。",
].join("\n");

const DOCS_ACCEPTANCE = [
  "指定文件已完成補充或修改。",
  "文件內容符合原始需求。",
  "不修改 src。",
  "不修改 tests。",
  "不修改 scripts。",
  "不修改 package.json / lockfile / tsconfig。",
  "npm run verify:local 通過。",
].join("\n");

/** 「文件小改 auto-round」要套用的欄位（刻意不含 title / originalRequirement / projectPath / project）。 */
const DOCS_AUTO_ROUND_FIELDS: Partial<TaskFormValues> = {
  type: "docs",
  workflowStage: "green_implement",
  targetFilesText: DOCS_TARGET_FILES,
  forbiddenFilesText: DOCS_FORBIDDEN_FILES,
  constraintsText: DOCS_CONSTRAINTS,
  acceptanceCriteriaText: DOCS_ACCEPTANCE,
};

const DOCS_AUTO_ROUND_HINT =
  "此模板適合文件小改，會預設 green_implement，可直接搭配 Preflight 與 auto-round 使用。";

/**
 * 內建任務模板。
 * - requirement：套用時帶入表單的 originalRequirement（會觸發覆蓋確認）。
 * - fields：套用時帶入其他表單欄位（不含 title / originalRequirement / projectPath）。
 * - hint：選擇後顯示的一行說明。
 */
const TEMPLATES: {
  key: TemplateKey;
  label: string;
  requirement?: string;
  fields?: Partial<TaskFormValues>;
  hint?: string;
}[] = [
  { key: "none",            label: "（不使用模板）",        requirement: "" },
  { key: "general",         label: "一般開發任務",          requirement: GENERAL_TEMPLATE },
  { key: "claude_review",   label: "Claude Code 審查任務",  requirement: CLAUDE_REVIEW_TEMPLATE },
  { key: "bug_fix",         label: "Bug 修正任務",          requirement: BUG_FIX_TEMPLATE },
  { key: "docs_auto_round", label: "文件小改 auto-round",   fields: DOCS_AUTO_ROUND_FIELDS, hint: DOCS_AUTO_ROUND_HINT },
];

const EMPTY: TaskFormValues = {
  title: "",
  type: "bug",
  originalRequirement: "",
  targetFilesText: "",
  forbiddenFilesText: "",
  constraintsText: "",
  acceptanceCriteriaText: "",
  project: "",
  projectPath: "",
  tagsText: "",
};

type Props = {
  onSubmit: (values: TaskFormValues) => void;
  onCancel: () => void;
  initialValues?: TaskFormValues;
  mode?: "create" | "edit";
  /**
   * 「建立並執行 auto-round」：建立任務後由上層選中該任務並自動觸發 auto-round（僅新增模式）。
   * 未提供時不顯示此按鈕。
   */
  onCreateAndRun?: (values: TaskFormValues) => void;
};

/** 新增任務時的初始值：以 EMPTY 為底，帶入上次新增任務使用的 project 與 tagsText。 */
function createInitialValues(): TaskFormValues {
  const prefs = loadPreferences();
  return { ...EMPTY, project: prefs.lastProject, tagsText: prefs.lastTagsText };
}

export function TaskForm({ onSubmit, onCancel, initialValues, mode = "create", onCreateAndRun }: Props) {
  // 編輯模式沿用傳入的 initialValues；新增模式則帶入上次使用的偏好設定。
  const [values, setValues] = useState<TaskFormValues>(
    () => initialValues ?? (mode === "create" ? createInitialValues() : EMPTY)
  );
  const [templateKey, setTemplateKey] = useState<TemplateKey>("none");
  // 「自動填入欄位」成功後顯示一行提示（成功不 alert；錯誤才 alert）。
  const [quickFillDone, setQuickFillDone] = useState(false);
  // 「建立並執行 auto-round」按下後的暫態（建立中），避免重複點擊。
  const [creating, setCreating] = useState(false);
  const selectedTemplate = TEMPLATES.find((t) => t.key === templateKey);

  /** 依目前模板與表單值算出要套用的快速填入欄位。 */
  function computeQuickFill(): Partial<TaskFormValues> {
    return quickFillTaskFields({
      originalRequirement: values.originalRequirement,
      projectPath: values.projectPath,
      currentTitle: values.title,
      template: templateKey === "docs_auto_round" ? "docs_auto_round" : "other",
    });
  }

  function set<K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleTemplateChange(nextKey: TemplateKey) {
    const next = TEMPLATES.find((t) => t.key === nextKey);
    if (!next) return;
    // 只有「會帶入 originalRequirement」的模板，才需要確認是否覆蓋使用者已輸入的原始需求。
    if (next.requirement !== undefined) {
      const current = values.originalRequirement;
      const currentTemplate = TEMPLATES.find((t) => t.key === templateKey);
      const isUserEdited =
        current.trim() !== "" && current !== (currentTemplate?.requirement ?? "");
      if (isUserEdited) {
        const ok = window.confirm("「原始需求」已有內容，套用模板會覆蓋目前內容，確定要繼續嗎？");
        if (!ok) return;
      }
    }
    setTemplateKey(nextKey);
    setValues((prev) => {
      const updated: TaskFormValues = { ...prev };
      // requirement 模板帶入 originalRequirement；fields 模板帶入其他欄位（保留 title / originalRequirement / projectPath）。
      if (next.requirement !== undefined) updated.originalRequirement = next.requirement;
      if (next.fields) Object.assign(updated, next.fields);
      return updated;
    });
  }

  /**
   * 快速建立：依目前 originalRequirement / projectPath / 模板用 deterministic rules 自動填入欄位。
   * 不送出任務、不呼叫 AI / runner，使用者仍可手動修改後再建立。
   */
  function handleAutoFill() {
    if (!values.originalRequirement.trim()) {
      window.alert("請先填寫「原始需求」，才能自動填入欄位。");
      return;
    }
    setValues((prev) => ({ ...prev, ...computeQuickFill() }));
    setQuickFillDone(true);
  }

  /**
   * 建立並執行 auto-round：先自動填入欄位、建立任務，再通知上層選中並自動觸發 auto-round。
   * originalRequirement / projectPath 任一空白都不建立任務（auto-round 需要 projectPath）。
   */
  function handleCreateAndRun() {
    if (!onCreateAndRun) return;
    if (!values.originalRequirement.trim()) {
      window.alert("請先填寫「原始需求」，才能建立並執行 auto-round。");
      return;
    }
    if (!values.projectPath?.trim()) {
      window.alert("請先填寫「專案路徑」，auto-round 需要 projectPath 才能執行。");
      return;
    }
    // setValues 是非同步的，這裡同步算出合併後的值直接交給上層，確保建立的任務帶到自動填入欄位。
    const merged: TaskFormValues = { ...values, ...computeQuickFill() };
    setValues(merged);
    setCreating(true);
    onCreateAndRun(merged);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!values.title.trim()) return;
    onSubmit(values);
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{mode === "edit" ? "編輯任務" : "新增任務"}</div>

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label className="form-label">任務標題 *</label>
            <input
              type="text"
              value={values.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="例：DM 表單新增當年新收案"
              autoFocus
              required
            />
          </div>

          <div className="form-field">
            <label className="form-label">任務類型</label>
            <select
              value={values.type}
              onChange={(e) => set("type", e.target.value as TaskType)}
            >
              {TASK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {mode === "create" && (
            <div className="form-field">
              <label className="form-label">任務模板</label>
              <span className="form-hint">選擇模板會帶入預設內容（原始需求或其他欄位）</span>
              <select
                value={templateKey}
                onChange={(e) => handleTemplateChange(e.target.value as TemplateKey)}
              >
                {TEMPLATES.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
              {selectedTemplate?.hint && (
                <span className="form-hint form-hint-template">{selectedTemplate.hint}</span>
              )}
            </div>
          )}

          {mode === "create" && (
            <div className="form-field quick-fill-block">
              <label className="form-label">快速建立</label>
              <span className="form-hint">
                依「原始需求 / 專案路徑 / 模板」自動推導並填入 title / targetFiles / constraints /
                acceptanceCriteria（不會送出任務、不呼叫 AI，可再手動調整）
              </span>
              <button type="button" className="btn btn-quick-fill" onClick={handleAutoFill}>
                自動填入欄位
              </button>
              {quickFillDone && (
                <span className="form-hint quick-fill-hint">
                  已自動填入 targetFiles / constraints / acceptanceCriteria，請確認後建立任務。
                </span>
              )}
            </div>
          )}

          <div className="form-field">
            <label className="form-label">原始需求</label>
            <textarea
              value={values.originalRequirement}
              onChange={(e) => set("originalRequirement", e.target.value)}
              placeholder="描述這個任務要完成什麼..."
              rows={4}
            />
          </div>

          <div className="form-field">
            <label className="form-label">目標檔案</label>
            <span className="form-hint">每行一個檔案路徑</span>
            <textarea
              value={values.targetFilesText}
              onChange={(e) => set("targetFilesText", e.target.value)}
              placeholder={"src/DmForm.tsx\nsrc/index.tsx"}
              rows={3}
            />
          </div>

          <div className="form-field">
            <label className="form-label">禁止修改範圍</label>
            <span className="form-hint">每行一條規則</span>
            <textarea
              value={values.forbiddenFilesText}
              onChange={(e) => set("forbiddenFilesText", e.target.value)}
              placeholder={"src/CkdForm.tsx\n不要重構無關元件"}
              rows={3}
            />
          </div>

          <div className="form-field">
            <label className="form-label">限制條件</label>
            <span className="form-hint">每行一條</span>
            <textarea
              value={values.constraintsText}
              onChange={(e) => set("constraintsText", e.target.value)}
              placeholder={"不要改 CKD / DKD\n不要重構無關元件"}
              rows={3}
            />
          </div>

          <div className="form-field">
            <label className="form-label">驗收條件</label>
            <span className="form-hint">每行一條</span>
            <textarea
              value={values.acceptanceCriteriaText}
              onChange={(e) => set("acceptanceCriteriaText", e.target.value)}
              placeholder={"送出後欄位清空\n資料正確存入"}
              rows={3}
            />
          </div>

          <div className="form-field">
            <label className="form-label">標籤（選填）</label>
            <span className="form-hint">以逗號分隔，例如：frontend, bug, urgent</span>
            <input
              type="text"
              value={values.tagsText ?? ""}
              onChange={(e) => set("tagsText", e.target.value)}
              placeholder="frontend, bug, urgent"
            />
          </div>

          <div className="form-field">
            <label className="form-label">專案分類（選填）</label>
            <span className="form-hint">用來分類任務的專案名稱，例如：my-app</span>
            <input
              type="text"
              value={values.project ?? ""}
              onChange={(e) => set("project", e.target.value)}
              placeholder="my-app"
            />
          </div>

          <div className="form-field">
            <label className="form-label">專案路徑（選填）</label>
            <input
              type="text"
              value={values.projectPath ?? ""}
              onChange={(e) => set("projectPath", e.target.value)}
              placeholder="/Users/ryan/projects/my-app"
            />
          </div>

          <div className="form-actions">
            <button type="button" className="btn" onClick={onCancel}>取消</button>
            <button type="submit" className="btn btn-primary">
              {mode === "edit" ? "儲存變更" : "建立任務"}
            </button>
            {mode === "create" && onCreateAndRun && (
              <button
                type="button"
                className="btn btn-primary btn-create-run"
                onClick={handleCreateAndRun}
                disabled={creating}
              >
                {creating ? "建立中..." : "建立並執行 auto-round"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
