import type {
  AiEngineeringWorkflow,
  AiWorkflowAudit,
  AiWorkflowBrainstorm,
  AiWorkflowCompound,
  AiWorkflowPlan,
  AiWorkflowWorkReview,
  BrainstormStatus,
  PlanAuditChecklist,
  PlanStatus,
  Task,
  TaskStore,
} from "../shared/types";
import { TASK_STORE_KEY } from "./storageKeys";

const EMPTY_STORE: TaskStore = { tasks: [], rounds: [] };

type RawTask = Omit<
  Task,
  | "status"
  | "priority"
  | "createdAt"
  | "archived"
  | "tags"
  | "reviewResult"
  | "workflowStage"
  | "aiWorkflow"
> & {
  status?: Task["status"];
  priority?: Task["priority"];
  createdAt?: string;
  archived?: boolean;
  tags?: string[];
  reviewResult?: Task["reviewResult"];
  workflowStage?: Task["workflowStage"];
  aiWorkflow?: unknown;
};

const BRAINSTORM_STATUSES: readonly BrainstormStatus[] = [
  "not_started",
  "drafted",
  "reviewed",
];

const PLAN_STATUSES: readonly PlanStatus[] = [
  "not_started",
  "planned",
  "audited",
  "approved",
  "rejected",
];

/** 是否為非 null、非陣列的物件。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只有在是非空白字串時回傳該字串，否則 undefined。 */
function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 只在是陣列時保留 string item；不是陣列回傳 undefined，空陣列也回傳 undefined。 */
function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

/** brainstorm.status 只允許白名單值；其餘（含 undefined）回傳 undefined。 */
function normalizeBrainstormStatus(value: unknown): BrainstormStatus | undefined {
  return BRAINSTORM_STATUSES.includes(value as BrainstormStatus)
    ? (value as BrainstormStatus)
    : undefined;
}

/** plan.status 只允許白名單值；其餘（含 undefined）回傳 undefined。 */
function normalizePlanStatus(value: unknown): PlanStatus | undefined {
  return PLAN_STATUSES.includes(value as PlanStatus) ? (value as PlanStatus) : undefined;
}

/** checklist 缺欄位補 false；非物件回傳 undefined。 */
function normalizeChecklist(value: unknown): PlanAuditChecklist | undefined {
  if (!isRecord(value)) return undefined;
  return {
    coreAssumptionsReviewed: value.coreAssumptionsReviewed === true,
    riskReviewed: value.riskReviewed === true,
    scopeReviewed: value.scopeReviewed === true,
    acceptanceCriteriaReviewed: value.acceptanceCriteriaReviewed === true,
    minimalChangeReviewed: value.minimalChangeReviewed === true,
  };
}

/** 移除物件中所有值為 undefined 的鍵；若結果為空物件回傳 undefined。 */
function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/**
 * 安全正規化 aiWorkflow（Phase 66）：
 * - 非物件 → undefined
 * - string 欄位非 string → 丟棄
 * - string[] 欄位非陣列 → 丟棄；是陣列則只保留 string item
 * - checklist 缺欄位 → 補 false
 * - status 不在白名單 → 丟棄（轉 undefined）
 * 不會 throw，確保舊／損毀的 localStorage 資料不會 crash。
 */
export function normalizeAiWorkflow(value: unknown): AiEngineeringWorkflow | undefined {
  if (!isRecord(value)) return undefined;

  let brainstorm: AiWorkflowBrainstorm | undefined;
  if (isRecord(value.brainstorm)) {
    brainstorm = compact<AiWorkflowBrainstorm>({
      path: normalizeString(value.brainstorm.path),
      summary: normalizeString(value.brainstorm.summary),
      status: normalizeBrainstormStatus(value.brainstorm.status),
    });
  }

  let plan: AiWorkflowPlan | undefined;
  if (isRecord(value.plan)) {
    plan = compact<AiWorkflowPlan>({
      path: normalizeString(value.plan.path),
      summary: normalizeString(value.plan.summary),
      status: normalizePlanStatus(value.plan.status),
    });
  }

  let audit: AiWorkflowAudit | undefined;
  if (isRecord(value.audit)) {
    audit = compact<AiWorkflowAudit>({
      notes: normalizeString(value.audit.notes),
      coreAssumptions: normalizeStringArray(value.audit.coreAssumptions),
      riskNotes: normalizeStringArray(value.audit.riskNotes),
      acceptanceCriteria: normalizeStringArray(value.audit.acceptanceCriteria),
      checklist: normalizeChecklist(value.audit.checklist),
    });
  }

  let workReview: AiWorkflowWorkReview | undefined;
  if (isRecord(value.workReview)) {
    workReview = compact<AiWorkflowWorkReview>({
      changedFiles: normalizeStringArray(value.workReview.changedFiles),
      testCommands: normalizeStringArray(value.workReview.testCommands),
      testResults: normalizeString(value.workReview.testResults),
      codeReviewNotes: normalizeString(value.workReview.codeReviewNotes),
      commitHash: normalizeString(value.workReview.commitHash),
      commitMessage: normalizeString(value.workReview.commitMessage),
    });
  }

  let compound: AiWorkflowCompound | undefined;
  if (isRecord(value.compound)) {
    compound = compact<AiWorkflowCompound>({
      reusablePrompt: normalizeString(value.compound.reusablePrompt),
      lessonLearned: normalizeString(value.compound.lessonLearned),
      compoundNotes: normalizeString(value.compound.compoundNotes),
    });
  }

  return compact<AiEngineeringWorkflow>({ brainstorm, plan, audit, workReview, compound });
}

function migrateTask(raw: RawTask): Task {
  return {
    ...raw,
    status: raw.status ?? "todo",
    priority: raw.priority ?? "medium",
    createdAt: raw.createdAt ?? new Date().toISOString(),
    archived: raw.archived ?? false,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    reviewResult: raw.reviewResult ?? "not_reviewed",
    workflowStage: raw.workflowStage ?? "spec",
    // Phase 65：completedAt / completionHistory 為選擇性。舊資料沒有時保持 undefined；
    // 若 completionHistory 不是陣列（資料損毀）則正規化為 undefined，避免讀取端 .map 出錯。
    completionHistory: Array.isArray(raw.completionHistory) ? raw.completionHistory : undefined,
    // Phase 66：aiWorkflow 安全正規化。舊 task 沒有時為 undefined，損毀資料不會 crash。
    aiWorkflow: normalizeAiWorkflow(raw.aiWorkflow),
  } as Task;
}

export function loadTaskStore(): TaskStore {
  try {
    const raw = localStorage.getItem(TASK_STORE_KEY);
    if (!raw) return { ...EMPTY_STORE, tasks: [], rounds: [] };
    const parsed = JSON.parse(raw) as Partial<{ tasks: RawTask[]; rounds: TaskStore["rounds"] }>;
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(migrateTask) : [],
      rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
    };
  } catch {
    return { tasks: [], rounds: [] };
  }
}

export function saveTaskStore(store: TaskStore): void {
  localStorage.setItem(TASK_STORE_KEY, JSON.stringify(store));
}

export function clearTaskStore(): void {
  localStorage.removeItem(TASK_STORE_KEY);
}

export function parseAndMigrateTaskStore(raw: unknown): TaskStore {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("無效的 JSON 格式：應為包含 tasks 的物件");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.tasks)) {
    throw new Error("無效的 JSON 格式：找不到 tasks 陣列");
  }
  return {
    tasks: (obj.tasks as RawTask[]).map(migrateTask),
    rounds: Array.isArray(obj.rounds) ? (obj.rounds as TaskStore["rounds"]) : [],
  };
}
