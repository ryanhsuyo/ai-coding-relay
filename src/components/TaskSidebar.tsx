import { useState, useRef } from "react";
import type { Task, TaskRound, TaskStatus, TaskPriority, TaskReviewResult, WorkflowStage } from "../shared/types";
import { searchTasks } from "../core/searchService";
import {
  loadPreferences,
  updatePreferences,
  clearPreferences,
  type SortKey,
} from "../storage/preferenceStorage";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待處理",
  in_progress: "進行中",
  done: "已完成",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high:   "⬆ 高",
  medium: "➡ 中",
  low:    "⬇ 低",
};

const REVIEW_LABEL: Record<TaskReviewResult, string> = {
  not_reviewed: "未驗收",
  passed:       "通過",
  needs_fix:    "需修改",
};

const WORKFLOW_STAGE_LABEL: Record<WorkflowStage, string> = {
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

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
const STATUS_ORDER: Record<TaskStatus, number> = { todo: 0, in_progress: 1, done: 2 };

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "priority",  label: "優先級" },
  { key: "dueDate",   label: "截止日" },
  { key: "status",    label: "狀態" },
  { key: "createdAt", label: "建立時間" },
];

function applySort(tasks: Task[], sort: SortKey): Task[] {
  return [...tasks].sort((a, b) => {
    switch (sort) {
      case "priority":
        return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      case "dueDate":
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      case "status":
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      case "createdAt":
        return b.createdAt.localeCompare(a.createdAt);
    }
  });
}

function getTodayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type DueDateInfo = { display: string; variant: "overdue" | "today" | "normal" };

function getDueDateInfo(task: Task): DueDateInfo | null {
  if (!task.dueDate) return null;
  const [, month, day] = task.dueDate.split("-");
  const display = `${parseInt(month)}月${parseInt(day)}日`;
  if (task.status === "done") return { display, variant: "normal" };
  const today = getTodayStr();
  if (task.dueDate < today) return { display, variant: "overdue" };
  if (task.dueDate === today) return { display, variant: "today" };
  return { display, variant: "normal" };
}

const TYPE_SHORT: Record<string, string> = {
  ui: "UI", bug: "Bug", typescript: "TS", refactor: "重構",
  api: "API", test: "Test", docs: "Docs", other: "其他",
};

type FilterKey = "all" | "todo" | "in_progress" | "done";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all",         label: "全部" },
  { key: "todo",        label: "待處理" },
  { key: "in_progress", label: "進行中" },
  { key: "done",        label: "已完成" },
];

function applyFilter(tasks: Task[], filter: FilterKey): Task[] {
  if (filter === "all") return tasks;
  return tasks.filter((t) => t.status === filter);
}

type DueDateFilter = "all" | "overdue" | "today" | "has_due" | "no_due";

const DUE_DATE_FILTERS: { key: DueDateFilter; label: string }[] = [
  { key: "all",     label: "全部" },
  { key: "overdue", label: "逾期" },
  { key: "today",   label: "今天到期" },
  { key: "has_due", label: "有截止日" },
  { key: "no_due",  label: "未設定" },
];

function applyDueDateFilter(tasks: Task[], filter: DueDateFilter): Task[] {
  if (filter === "all") return tasks;
  return tasks.filter((t) => {
    const info = getDueDateInfo(t);
    if (filter === "no_due")  return !t.dueDate;
    if (filter === "has_due") return !!t.dueDate;
    if (filter === "overdue") return info?.variant === "overdue";
    if (filter === "today")   return info?.variant === "today";
    return false;
  });
}

function applyTagFilter(tasks: Task[], tag: string): Task[] {
  if (tag === "all") return tasks;
  return tasks.filter((t) => t.tags.includes(tag));
}

/** 收集任務集合中出現過的所有 tag，去重後依字母排序。 */
function collectTags(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    for (const tag of t.tags) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

const PROJECT_ALL = "__all__";
const PROJECT_NONE = "__none__";

function applyProjectFilter(tasks: Task[], filter: string): Task[] {
  if (filter === PROJECT_ALL) return tasks;
  if (filter === PROJECT_NONE) return tasks.filter((t) => !t.project);
  return tasks.filter((t) => t.project === filter);
}

/** 收集任務集合中出現過的所有 project，去重後依字母排序。 */
function collectProjects(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    if (t.project) set.add(t.project);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

type ReviewFilter = "all" | TaskReviewResult;

const REVIEW_FILTERS: { key: ReviewFilter; label: string }[] = [
  { key: "all",          label: "全部" },
  { key: "not_reviewed", label: "未驗收" },
  { key: "passed",       label: "通過" },
  { key: "needs_fix",    label: "需修改" },
];

function applyReviewFilter(tasks: Task[], filter: ReviewFilter): Task[] {
  if (filter === "all") return tasks;
  return tasks.filter((t) => (t.reviewResult ?? "not_reviewed") === filter);
}

type WorkflowStageFilter = "all" | WorkflowStage;

const WORKFLOW_STAGE_FILTERS: { key: WorkflowStageFilter; label: string }[] = [
  { key: "all",             label: "全部" },
  { key: "spec",            label: "規格撰寫" },
  { key: "spec_review",     label: "規格審查" },
  { key: "red_test",        label: "紅燈測試" },
  { key: "green_implement", label: "綠燈實作" },
  { key: "refactor",        label: "重構" },
  { key: "verify",          label: "本機驗證" },
  { key: "review",          label: "審查" },
  { key: "fix",             label: "修正" },
  { key: "done",            label: "完成" },
];

function applyWorkflowStageFilter(tasks: Task[], filter: WorkflowStageFilter): Task[] {
  if (filter === "all") return tasks;
  return tasks.filter((t) => (t.workflowStage ?? "spec") === filter);
}

type Stats = {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
  overdue: number;
  today: number;
  highPriority: number;
  notReviewed: number;
  reviewPassed: number;
  needsFix: number;
  stageSpec: number;
  stageRedTest: number;
  stageGreenImplement: number;
  stageFix: number;
  stageDone: number;
};

function computeStats(tasks: Task[]): Stats {
  let todo = 0, inProgress = 0, done = 0, overdue = 0, today = 0, highPriority = 0;
  let notReviewed = 0, reviewPassed = 0, needsFix = 0;
  let stageSpec = 0, stageRedTest = 0, stageGreenImplement = 0, stageFix = 0, stageDone = 0;
  for (const t of tasks) {
    if (t.status === "todo") todo++;
    else if (t.status === "in_progress") inProgress++;
    else if (t.status === "done") done++;
    const variant = getDueDateInfo(t)?.variant;
    if (variant === "overdue") overdue++;
    else if (variant === "today") today++;
    if (t.priority === "high") highPriority++;
    const review = t.reviewResult ?? "not_reviewed";
    if (review === "not_reviewed") notReviewed++;
    else if (review === "passed") reviewPassed++;
    else if (review === "needs_fix") needsFix++;
    const stage = t.workflowStage ?? "spec";
    if (stage === "spec") stageSpec++;
    else if (stage === "red_test") stageRedTest++;
    else if (stage === "green_implement") stageGreenImplement++;
    else if (stage === "fix") stageFix++;
    else if (stage === "done") stageDone++;
  }
  return {
    total: tasks.length, todo, inProgress, done, overdue, today, highPriority,
    notReviewed, reviewPassed, needsFix,
    stageSpec, stageRedTest, stageGreenImplement, stageFix, stageDone,
  };
}

type ViewMode = "active" | "archived";

type Props = {
  tasks: Task[];
  rounds: TaskRound[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onExport: () => void;
  onImport: (json: string) => void;
};

export function TaskSidebar({ tasks, rounds, selectedTaskId, onSelect, onAdd, onExport, onImport }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("active");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      const json = ev.target?.result;
      if (typeof json !== "string") return;
      if (!window.confirm(`匯入「${file.name}」會覆蓋目前所有資料，確定繼續？`)) return;
      onImport(json);
    };
    reader.readAsText(file);
  }
  const [filter, setFilter] = useState<FilterKey>("all");
  const [dueDateFilter, setDueDateFilter] = useState<DueDateFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>(PROJECT_ALL);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [workflowStageFilter, setWorkflowStageFilter] = useState<WorkflowStageFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // 排序選項記憶上次選擇，重新整理後仍維持
  const [sortKey, setSortKey] = useState<SortKey>(() => loadPreferences().sortKey);

  const viewPool = tasks.filter((t) => viewMode === "archived" ? t.archived === true : !t.archived);
  const stats = computeStats(viewPool);
  const allTags = collectTags(viewPool);
  // 若目前選的 tag 已不存在（例如被改名或清空），視為「全部」避免清單卡在空白
  const activeTagFilter = tagFilter !== "all" && !allTags.includes(tagFilter) ? "all" : tagFilter;
  const allProjects = collectProjects(viewPool);
  // 若目前選的 project 已不存在（例如被改名或清空），視為「全部」避免清單卡在空白
  const activeProjectFilter =
    projectFilter !== PROJECT_ALL &&
    projectFilter !== PROJECT_NONE &&
    !allProjects.includes(projectFilter)
      ? PROJECT_ALL
      : projectFilter;

  const filtered = applyFilter(viewPool, filter);
  const dueDateFiltered = applyDueDateFilter(filtered, dueDateFilter);
  const tagFiltered = applyTagFilter(dueDateFiltered, activeTagFilter);
  const projectFiltered = applyProjectFilter(tagFiltered, activeProjectFilter);
  const reviewFiltered = applyReviewFilter(projectFiltered, reviewFilter);
  const workflowFiltered = applyWorkflowStageFilter(reviewFiltered, workflowStageFilter);
  const searched = searchTasks(workflowFiltered, rounds, searchQuery);
  const visible = applySort(searched, sortKey);
  const isSearching = searchQuery.trim().length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">AI Coding Relay</div>
        {viewMode === "active" && (
          <button className="btn-add" onClick={onAdd}>＋ 新增任務</button>
        )}
      </div>

      <div className="sidebar-data-actions">
        <button className="btn-data-action" onClick={onExport}>↑ 匯出</button>
        <button className="btn-data-action" onClick={() => fileInputRef.current?.click()}>↓ 匯入</button>
        <button
          className="btn-data-action"
          onClick={() => {
            if (
              window.confirm(
                "確定要清除偏好設定？排序會回到預設，新增任務表單也不再帶入上次的專案與標籤。任務資料不受影響。"
              )
            ) {
              clearPreferences();
              setSortKey("priority");
            }
          }}
        >
          ✕ 清除偏好
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>

      <div className="view-mode-tabs">
        <button
          className={`view-mode-tab${viewMode === "active" ? " active" : ""}`}
          onClick={() => setViewMode("active")}
        >
          進行中
        </button>
        <button
          className={`view-mode-tab${viewMode === "archived" ? " active" : ""}`}
          onClick={() => setViewMode("archived")}
        >
          已封存
        </button>
      </div>

      <div className="sidebar-search">
        <input
          className="search-input"
          type="text"
          placeholder="搜尋任務、需求、回覆..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="filter-tabs">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-tab${filter === f.key ? " active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="filter-tabs filter-tabs-due">
        {DUE_DATE_FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-tab${dueDateFilter === f.key ? " active" : ""}`}
            onClick={() => setDueDateFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <div className="filter-tabs filter-tabs-tags">
          <button
            className={`filter-tab${activeTagFilter === "all" ? " active" : ""}`}
            onClick={() => setTagFilter("all")}
          >
            全部
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`filter-tab filter-tab-tag${activeTagFilter === tag ? " active" : ""}`}
              onClick={() => setTagFilter(tag)}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      <div className="filter-tabs filter-tabs-project">
        <button
          className={`filter-tab${activeProjectFilter === PROJECT_ALL ? " active" : ""}`}
          onClick={() => setProjectFilter(PROJECT_ALL)}
        >
          全部
        </button>
        <button
          className={`filter-tab filter-tab-project${activeProjectFilter === PROJECT_NONE ? " active" : ""}`}
          onClick={() => setProjectFilter(PROJECT_NONE)}
        >
          未分類
        </button>
        {allProjects.map((project) => (
          <button
            key={project}
            className={`filter-tab filter-tab-project${activeProjectFilter === project ? " active" : ""}`}
            onClick={() => setProjectFilter(project)}
          >
            {project}
          </button>
        ))}
      </div>

      <div className="filter-tabs filter-tabs-review">
        {REVIEW_FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-tab${reviewFilter === f.key ? " active" : ""}`}
            onClick={() => setReviewFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="filter-tabs filter-tabs-stage">
        {WORKFLOW_STAGE_FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-tab${workflowStageFilter === f.key ? " active" : ""}`}
            onClick={() => setWorkflowStageFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="sort-bar">
        <span className="sort-label">排序</span>
        <select
          className="sort-select"
          value={sortKey}
          onChange={(e) => {
            const next = e.target.value as SortKey;
            setSortKey(next);
            updatePreferences({ sortKey: next });
          }}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.key} value={opt.key}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="task-stats">
        <span className="stat-chip">
          <span className="stat-label">全部</span>
          <span className="stat-value">{stats.total}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-label">待處理</span>
          <span className="stat-value">{stats.todo}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-label">進行中</span>
          <span className="stat-value">{stats.inProgress}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-label">已完成</span>
          <span className="stat-value">{stats.done}</span>
        </span>
        <span className="stat-chip stat-chip-danger">
          <span className="stat-label">逾期</span>
          <span className="stat-value">{stats.overdue}</span>
        </span>
        <span className="stat-chip stat-chip-warning">
          <span className="stat-label">今天</span>
          <span className="stat-value">{stats.today}</span>
        </span>
        <span className="stat-chip stat-chip-high">
          <span className="stat-label">⬆高優</span>
          <span className="stat-value">{stats.highPriority}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-label">未驗收</span>
          <span className="stat-value">{stats.notReviewed}</span>
        </span>
        <span className="stat-chip stat-chip-review-pass">
          <span className="stat-label">通過</span>
          <span className="stat-value">{stats.reviewPassed}</span>
        </span>
        <span className="stat-chip stat-chip-review-fix">
          <span className="stat-label">需修改</span>
          <span className="stat-value">{stats.needsFix}</span>
        </span>
        <span className="stat-chip stat-chip-stage">
          <span className="stat-label">規格</span>
          <span className="stat-value">{stats.stageSpec}</span>
        </span>
        <span className="stat-chip stat-chip-stage">
          <span className="stat-label">紅燈</span>
          <span className="stat-value">{stats.stageRedTest}</span>
        </span>
        <span className="stat-chip stat-chip-stage">
          <span className="stat-label">綠燈</span>
          <span className="stat-value">{stats.stageGreenImplement}</span>
        </span>
        <span className="stat-chip stat-chip-stage">
          <span className="stat-label">修正</span>
          <span className="stat-value">{stats.stageFix}</span>
        </span>
        <span className="stat-chip stat-chip-stage">
          <span className="stat-label">完成</span>
          <span className="stat-value">{stats.stageDone}</span>
        </span>
      </div>

      <div className="task-list">
        {isSearching && (
          <div className="search-result-count">共 {visible.length} 筆</div>
        )}
        {visible.length === 0 ? (
          <div className="task-list-empty">
            {isSearching ? "找不到符合的任務" : "沒有任務"}
          </div>
        ) : (
          visible.map((task) => (
            <div
              key={task.id}
              className={`task-card task-card-status-${task.status}${task.id === selectedTaskId ? " selected" : ""}`}
              onClick={() => onSelect(task.id)}
            >
              <div className="task-card-title">{task.title}</div>
              <div className="task-card-meta">
                <span className={`badge type-${task.type}`}>
                  {TYPE_SHORT[task.type] ?? task.type}
                </span>
                <span className={`badge priority-${task.priority}`}>
                  {PRIORITY_LABEL[task.priority]}
                </span>
                <span className={`badge status-${task.status}`}>
                  {STATUS_LABEL[task.status]}
                </span>
                <span className={`badge review-${task.reviewResult ?? "not_reviewed"}`}>
                  {REVIEW_LABEL[task.reviewResult ?? "not_reviewed"]}
                </span>
                <span className={`badge stage-${task.workflowStage ?? "spec"}`}>
                  {WORKFLOW_STAGE_LABEL[task.workflowStage ?? "spec"]}
                </span>
              </div>
              {task.project && (
                <div className="task-card-project">
                  <span className="project-badge">📂 {task.project}</span>
                </div>
              )}
              {task.tags.length > 0 && (
                <div className="task-card-tags">
                  {task.tags.map((tag) => (
                    <span key={tag} className="tag-badge">#{tag}</span>
                  ))}
                </div>
              )}
              {(() => {
                const due = getDueDateInfo(task);
                if (!due) return null;
                return (
                  <div className="task-card-due">
                    <span className={`due-badge due-${due.variant}`}>
                      📅 {due.display}
                      {due.variant === "overdue" && " 逾期"}
                      {due.variant === "today" && " 今天到期"}
                    </span>
                  </div>
                );
              })()}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
