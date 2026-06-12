import type {
  AiEngineeringWorkflow,
  CeReadonlyWorkflowResult,
  CeReadonlyWorkflowSnapshot,
  CeReadonlyWorkflowStoppedReason,
} from "../shared/types";
import { normalizeAiWorkflow } from "../storage/taskStorage";

/**
 * Phase 70：CE Readonly Workflow 的前端解析與合併（純函式）。
 * 不依賴 React、不讀寫 localStorage、不呼叫 runner、不 throw。
 * runner 回傳不被信任：一律經過 type guard 與既有 normalizeAiWorkflow 安全檢查。
 */

/** Phase 77B：rawOutputPreview 前端再保險的最大字數（runner 端已截，但不信任 runner）。 */
const READONLY_RAW_PREVIEW_MAX = 2000;

const STOPPED_REASONS: readonly CeReadonlyWorkflowStoppedReason[] = [
  "ai_failed",
  "invalid_json",
  "runner_error",
  "project_path_invalid",
  "readonly_violation",
];

/** 是否為非 null、非陣列的物件。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把 runner 回傳的 snapshot 安全解析成 CeReadonlyWorkflowSnapshot；非物件 / 缺欄位補空字串。 */
function parseSnapshot(value: unknown): CeReadonlyWorkflowSnapshot {
  const obj = isRecord(value) ? value : {};
  return {
    statusShort: asString(obj.statusShort),
    diffStat: asString(obj.diffStat),
    nameStatus: asString(obj.nameStatus),
  };
}

/** 取非空字串，否則回傳預設值。 */
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** stoppedReason 只允許白名單值；其餘（含未知字串）一律視為 runner_error。 */
function normalizeStoppedReason(value: unknown): CeReadonlyWorkflowStoppedReason {
  return STOPPED_REASONS.includes(value as CeReadonlyWorkflowStoppedReason)
    ? (value as CeReadonlyWorkflowStoppedReason)
    : "runner_error";
}

/**
 * 把 runner（/ce-readonly-workflow）的回傳安全解析成 CeReadonlyWorkflowResult。
 * - 非物件 / ok 不是 true → 一律視為失敗，並盡量保留 stoppedReason / message / 診斷片段。
 * - 成功時 workflow 經過 normalizeAiWorkflow，缺欄位 / 髒資料不會 crash。
 * 永不 throw，方便呼叫端直接 render。
 */
export function parseCeReadonlyWorkflowResult(raw: unknown): CeReadonlyWorkflowResult {
  if (!isRecord(raw)) {
    return { ok: false, stoppedReason: "runner_error", message: "runner 回傳格式無效（非物件）" };
  }

  if (raw.ok !== true) {
    const failure: CeReadonlyWorkflowResult = {
      ok: false,
      stoppedReason: normalizeStoppedReason(raw.stoppedReason),
      message: asString(raw.message) || "CE Readonly Workflow 執行失敗",
    };
    // 保留 runner 附帶的診斷片段（若有），方便 debug。
    if (typeof raw.stdoutPreview === "string") failure.stdoutPreview = raw.stdoutPreview;
    if (typeof raw.stdoutTail === "string") failure.stdoutTail = raw.stdoutTail;
    if (typeof raw.stderrPreview === "string") failure.stderrPreview = raw.stderrPreview;
    if (typeof raw.stderrTail === "string") failure.stderrTail = raw.stderrTail;
    // Phase 77A：readonly_violation 時保留執行前/後快照供 UI 顯示。
    if (raw.before !== undefined) failure.before = parseSnapshot(raw.before);
    if (raw.after !== undefined) failure.after = parseSnapshot(raw.after);
    // Phase 77B：invalid_json 的安全 debug 摘要（rawOutputPreview 再保險截到 2000 字、parseAttempts 只收字串）。
    if (typeof raw.rawOutputPreview === "string") {
      failure.rawOutputPreview = raw.rawOutputPreview.slice(0, READONLY_RAW_PREVIEW_MAX);
    }
    if (Array.isArray(raw.parseAttempts)) {
      failure.parseAttempts = raw.parseAttempts.filter(
        (v): v is string => typeof v === "string"
      );
    }
    return failure;
  }

  // ok === true：workflow 一律經過既有 normalize（容忍缺欄位 / 髒資料）。
  const workflow = normalizeAiWorkflow(raw.workflow) ?? {};
  const ai = isRecord(raw.ai) ? raw.ai : {};

  return {
    ok: true,
    workflow,
    canStartWork: raw.canStartWork === true,
    recommendedNextAction: asString(raw.recommendedNextAction),
    rawNotes: asString(raw.rawNotes),
    ai: {
      command: asString(ai.command),
      exitCode: typeof ai.exitCode === "number" ? ai.exitCode : null,
    },
  };
}

/**
 * 把 CE Readonly Workflow 結果合併進目前 task 的 aiWorkflow（Phase 70）。
 * 合併規則（只動 readonly planning 三段）：
 * - 更新 brainstorm / plan / audit（本次 readonly workflow 的結果，可覆蓋）。
 * - 保留既有 workReview / compound（Work / Review / Compound 不被清掉）。
 * incoming 已是 normalize 過的 workflow；只取其 brainstorm / plan / audit。
 */
export function mergeCeReadonlyWorkflow(
  current: AiEngineeringWorkflow | undefined,
  incoming: AiEngineeringWorkflow
): AiEngineeringWorkflow {
  const merged: AiEngineeringWorkflow = {};

  // brainstorm / plan / audit：以 incoming 為準；incoming 沒有時保留既有。
  const brainstorm = incoming.brainstorm ?? current?.brainstorm;
  const plan = incoming.plan ?? current?.plan;
  const audit = incoming.audit ?? current?.audit;
  if (brainstorm !== undefined) merged.brainstorm = brainstorm;
  if (plan !== undefined) merged.plan = plan;
  if (audit !== undefined) merged.audit = audit;

  // workReview / compound：永遠保留既有（不被本次 readonly workflow 動到）。
  if (current?.workReview !== undefined) merged.workReview = current.workReview;
  if (current?.compound !== undefined) merged.compound = current.compound;

  return merged;
}
