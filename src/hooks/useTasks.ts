import { useState, useCallback } from "react";
import type {
  Task,
  TaskRound,
  TaskStatus,
  TaskPriority,
  TaskFormValues,
  CommandLog,
  ChecklistItem,
  VerificationCommand,
  VerificationResult,
  FileGuardResult,
  FileGuardViolation,
  AiRunResult,
  TaskCompletionEvent,
  AiEngineeringWorkflow,
  CeWorkSuccess,
  CeReviewSuccess,
  CeFixWorkSuccess,
} from "../shared/types";
import { loadTaskStore, saveTaskStore, parseAndMigrateTaskStore } from "../storage/taskStorage";
import { mergeCeReadonlyWorkflow } from "../core/ceReadonlyWorkflow";
import { mergeCeWorkResult } from "../core/ceWork";
import { mergeCeReviewResult } from "../core/ceReview";
import { mergeCeFixWorkResult } from "../core/ceFixWork";
import { createTask, updateTask } from "../core/taskService";
import { createTaskRound, getNextRoundIndex } from "../core/roundService";
import { getNowIso } from "../utils/date";
import { createId } from "../utils/id";

/** tsc/test/build：失敗會讓整體驗證失敗的必要指令，匯入時轉成 checklist。 */
const VERIFICATION_CHECK_NAMES = ["tsc", "test", "build"] as const;

/** 解析 verification JSON 裡的單一 command；格式不符會丟出錯誤。 */
function parseVerificationCommand(raw: unknown): VerificationCommand {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("無效的驗證 JSON：commands 內含非物件項目");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || typeof obj.command !== "string") {
    throw new Error("無效的驗證 JSON：command 缺少 name 或 command 欄位");
  }
  return {
    name: obj.name,
    command: obj.command,
    exitCode: typeof obj.exitCode === "number" ? obj.exitCode : null,
    stdout: typeof obj.stdout === "string" ? obj.stdout : "",
    stderr: typeof obj.stderr === "string" ? obj.stderr : "",
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : 0,
    ok: typeof obj.ok === "boolean" ? obj.ok : obj.exitCode === 0,
    required: typeof obj.required === "boolean" ? obj.required : false,
  };
}

/** 只保留字串陣列裡的字串項目，其餘忽略。 */
function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/** 解析 verification JSON 裡的單一 fileGuard 違規項目。 */
function parseFileGuardViolation(raw: unknown): FileGuardViolation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("無效的驗證 JSON：fileGuard.violations 內含非物件項目");
  }
  const obj = raw as Record<string, unknown>;
  return {
    type: typeof obj.type === "string" ? obj.type : "",
    file: typeof obj.file === "string" ? obj.file : "",
  };
}

/** 解析 verification JSON 裡選擇性的 fileGuard 結果；不是物件則丟出錯誤。 */
function parseFileGuard(raw: unknown): FileGuardResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("無效的驗證 JSON：fileGuard 應為物件");
  }
  const obj = raw as Record<string, unknown>;
  return {
    ok: typeof obj.ok === "boolean" ? obj.ok : false,
    modifiedFiles: toStringArray(obj.modifiedFiles),
    targetFiles: toStringArray(obj.targetFiles),
    forbiddenFiles: toStringArray(obj.forbiddenFiles),
    violations: Array.isArray(obj.violations) ? obj.violations.map(parseFileGuardViolation) : [],
    ...(typeof obj.error === "string" ? { error: obj.error } : {}),
  };
}

/** 解析 scripts/run-verification.mjs 輸出的 JSON；格式不符會丟出錯誤。 */
function parseVerificationResult(raw: unknown): VerificationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("無效的驗證 JSON：應為包含 commands 的物件");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.commands)) {
    throw new Error("無效的驗證 JSON：找不到 commands 陣列");
  }
  return {
    ok: typeof obj.ok === "boolean" ? obj.ok : false,
    startedAt: typeof obj.startedAt === "string" ? obj.startedAt : "",
    finishedAt: typeof obj.finishedAt === "string" ? obj.finishedAt : "",
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : 0,
    commands: obj.commands.map(parseVerificationCommand),
    // fileGuard 為選擇性欄位：缺少時不帶入，存在時解析後帶入。
    ...(obj.fileGuard !== undefined ? { fileGuard: parseFileGuard(obj.fileGuard) } : {}),
  };
}

/** 由 VerificationResult 算出 TaskRound 的驗證相關欄位（給驗證匯入與 auto-round 匯入共用）。 */
type VerificationRoundFields = Pick<
  TaskRound,
  "gitStatus" | "gitDiff" | "commandLogs" | "checklist" | "verificationOk" | "fileGuard"
>;

function verificationRoundFields(result: VerificationResult): VerificationRoundFields {
  const commandLogs: CommandLog[] = result.commands.map((cmd) => ({
    id: createId("cmdlog"),
    name: cmd.name,
    command: cmd.command,
    exitCode: cmd.exitCode,
    stdout: cmd.stdout,
    stderr: cmd.stderr,
    durationMs: cmd.durationMs,
    ok: cmd.ok,
    required: cmd.required,
  }));

  const findStdout = (name: string): string | undefined =>
    result.commands.find((c) => c.name === name)?.stdout || undefined;

  const checklist: ChecklistItem[] = VERIFICATION_CHECK_NAMES.flatMap((name) => {
    const cmd = result.commands.find((c) => c.name === name);
    if (!cmd) return [];
    const item: ChecklistItem = {
      id: createId("check"),
      label: name,
      status: cmd.ok ? "passed" : "failed",
    };
    return [item];
  });

  return {
    gitStatus: findStdout("git-status"),
    gitDiff: findStdout("git-diff"),
    commandLogs,
    checklist,
    verificationOk: result.ok,
    // 只有 verification JSON 帶 fileGuard 時才存到回合，舊回合不受影響。
    ...(result.fileGuard !== undefined ? { fileGuard: result.fileGuard } : {}),
  };
}

/** 把解析後的驗證結果組成一筆新的 TaskRound（含 commandLogs / gitStatus / gitDiff / checklist）。 */
function buildVerificationRound(
  taskId: string,
  roundIndex: number,
  result: VerificationResult
): TaskRound {
  const base = createTaskRound({
    taskId,
    roundIndex,
    promptToClaude: "（本機驗證結果匯入）",
  });

  return { ...base, ...verificationRoundFields(result) };
}

/** scripts/auto-round.mjs 輸出的整體結果（部分欄位可能為 null）。 */
type AutoRoundResult = {
  ok: boolean;
  mode: string;
  ai: AiRunResult | null;
  verification: VerificationResult | null;
  stoppedReason?: string;
};

/** 解析 auto-round JSON 裡的 ai 物件；不是物件則回傳 null。 */
function parseAiResult(raw: unknown): AiRunResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return {
    command: typeof obj.command === "string" ? obj.command : "",
    exitCode: typeof obj.exitCode === "number" ? obj.exitCode : null,
    stdout: typeof obj.stdout === "string" ? obj.stdout : "",
    stderr: typeof obj.stderr === "string" ? obj.stderr : "",
    durationMs: typeof obj.durationMs === "number" ? obj.durationMs : 0,
  };
}

/** 解析 scripts/auto-round.mjs 輸出的 JSON；格式不符會丟出錯誤。 */
function parseAutoRoundResult(raw: unknown): AutoRoundResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("無效的 auto-round JSON：應為物件");
  }
  const obj = raw as Record<string, unknown>;
  // verification 為選擇性：存在且為含 commands 的物件時才解析，否則視為 null。
  const hasVerification =
    typeof obj.verification === "object" &&
    obj.verification !== null &&
    !Array.isArray(obj.verification) &&
    Array.isArray((obj.verification as Record<string, unknown>).commands);
  return {
    ok: typeof obj.ok === "boolean" ? obj.ok : false,
    mode: typeof obj.mode === "string" ? obj.mode : "",
    ai: parseAiResult(obj.ai),
    verification: hasVerification ? parseVerificationResult(obj.verification) : null,
    ...(typeof obj.stoppedReason === "string" ? { stoppedReason: obj.stoppedReason } : {}),
  };
}

/** 把解析後的 auto-round 結果組成一筆新的 TaskRound。 */
function buildAutoRoundRound(
  taskId: string,
  roundIndex: number,
  result: AutoRoundResult
): TaskRound {
  const base = createTaskRound({
    taskId,
    roundIndex,
    promptToClaude: `（auto-round 結果匯入：${result.mode || "—"}）`,
  });

  return {
    ...base,
    // 有 verification 時帶入完整的驗證 / fileGuard 欄位；沒有時 checklist 維持空陣列。
    ...(result.verification ? verificationRoundFields(result.verification) : {}),
    autoRoundMode: result.mode,
    autoRoundOk: result.ok,
    ...(result.ai ? { aiResult: result.ai } : {}),
    ...(result.stoppedReason ? { stoppedReason: result.stoppedReason } : {}),
  };
}

/** scripts/auto-loop.mjs 輸出的整體結果（只取建立回合所需欄位）。 */
type AutoLoopResult = {
  totalRounds: number;
  stoppedReason: string;
  rounds: AutoRoundResult[];
};

/** 解析 scripts/auto-loop.mjs 輸出的 JSON；缺少 rounds 陣列會丟出錯誤。 */
function parseAutoLoopResult(raw: unknown): AutoLoopResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("無效的 auto-loop JSON：應為物件");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.rounds)) {
    throw new Error("無效的 auto-loop JSON：找不到 rounds 陣列");
  }
  return {
    totalRounds: typeof obj.totalRounds === "number" ? obj.totalRounds : obj.rounds.length,
    stoppedReason: typeof obj.stoppedReason === "string" ? obj.stoppedReason : "",
    rounds: obj.rounds.map(parseAutoRoundResult),
  };
}

/** 把解析後的 auto-loop 結果組成多筆 TaskRound（每個 loop round 一筆，帶 loop metadata）。 */
function buildAutoLoopRounds(
  taskId: string,
  startRoundIndex: number,
  loop: AutoLoopResult
): TaskRound[] {
  const total = loop.totalRounds || loop.rounds.length;
  return loop.rounds.map((r, i) => ({
    ...buildAutoRoundRound(taskId, startRoundIndex + i, r),
    loopRoundIndex: i + 1,
    loopTotalRounds: total,
    ...(loop.stoppedReason ? { loopStoppedReason: loop.stoppedReason } : {}),
  }));
}

// --- auto-round / auto-loop 完成後的任務摘要草稿（純文字產生，不呼叫 AI / shell / runner） ---

/** 以逗號分隔的 stoppedReason 拆成 token 陣列（trim、過濾空字串）。 */
function splitReasons(value?: string): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 從 git diff --stat / git status --short 的 stdout 推導被修改的檔案路徑。 */
function extractChangedFiles(gitDiff?: string, gitStatus?: string): string[] {
  const files = new Set<string>();
  if (gitDiff) {
    for (const line of gitDiff.split("\n")) {
      // git diff --stat： " src/App.tsx | 12 +++---"（取 | 前的檔名）
      const m = line.match(/^\s*(.+?)\s+\|\s+\d+/);
      if (m) files.add(m[1].trim());
    }
  }
  if (gitStatus) {
    for (const line of gitStatus.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // git status --short： "M  src/App.tsx" / "?? new.ts"（取狀態碼後的路徑）
      const m = trimmed.match(/^[ MADRCU?!]{1,2}\s+(.+)$/);
      if (m) files.add(m[1].trim());
    }
  }
  return [...files];
}

/** 把 AI stdout 壓成一段短摘要（合併空白、截斷），避免任務摘要過長。 */
function summarizeAiStdout(stdout: string, maxLen = 240): string {
  const collapsed = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join(" ");
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen).trimEnd()}…`;
}

/**
 * 依一筆代表性的回合（auto-round 的單一回合，或 auto-loop 的最後一輪）產生任務摘要草稿。
 * 純文字組裝，不呼叫 AI / shell / runner，也不改任務狀態。
 */
export function buildAutoSummaryDraft(task: Task, round: TaskRound): string {
  const isLoop = typeof round.loopTotalRounds === "number";
  const flow = isLoop ? "auto-loop" : "auto-round";

  // 合併 per-round 與 loop 層級的停止原因並去重。
  const reasons = [...new Set([...splitReasons(round.stoppedReason), ...splitReasons(round.loopStoppedReason)])];

  // 任務目標
  const title = task.title.trim() || "（未命名任務）";
  const goal = isLoop
    ? `${title}\n本輪透過 ${flow} 執行（共 ${round.loopTotalRounds} 輪）`
    : `${title}\n本輪透過 ${flow} 執行`;

  // 修改檔案
  const files = extractChangedFiles(round.gitDiff, round.gitStatus);
  const changed = files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "待人工確認";

  // 遇到問題
  const problems: string[] = [];
  if (reasons.length > 0) problems.push(`停止原因：${reasons.join(", ")}`);
  const exitCode = round.aiResult?.exitCode;
  if (round.aiResult && exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    problems.push(`AI 執行失敗（exitCode=${exitCode}）`);
  }
  if (round.verificationOk === false) problems.push("本機驗證未通過（verification_failed）");
  if (round.fileGuard && round.fileGuard.ok === false) problems.push("檔案範圍檢查未通過（file_guard_failed）");
  const problemsText = problems.length > 0 ? problems.map((p) => `- ${p}`).join("\n") : "無明顯阻擋問題";

  // 最後解法
  const aiStdout = round.aiResult?.stdout?.trim();
  const solution = aiStdout ? summarizeAiStdout(aiStdout) : `依 ${flow} 結果完成`;

  // 驗收結果
  const verLine =
    round.verificationOk === true ? "本機驗證：通過"
    : round.verificationOk === false ? "本機驗證：未通過"
    : "本機驗證：未知";
  const cmdLines = (round.commandLogs ?? []).map((c) => {
    const name = c.name ?? c.command;
    const ok = c.ok ?? c.exitCode === 0;
    return `- ${name}: ${ok ? "通過" : "未通過"}`;
  });
  const fgLines = round.fileGuard
    ? [`- 檔案範圍檢查：${round.fileGuard.ok ? "通過" : "未通過"}（violations ${round.fileGuard.violations.length}）`]
    : [];
  const acceptance = [verLine, ...cmdLines, ...fgLines].join("\n");

  // 下次注意
  const notes: string[] = [];
  if (reasons.includes("verification_unavailable")) notes.push("請檢查 target project 的 scripts/run-verification.mjs 是否能輸出可解析 JSON。");
  if (reasons.includes("ai_failed")) notes.push("請檢查 AI Command 設定（aiCommand）。");
  if (reasons.includes("file_guard_failed")) notes.push("請檢查 targetFiles / forbiddenFiles 範圍。");
  if (notes.length === 0) {
    notes.push(problems.length > 0
      ? `請參考上方「遇到問題」修正後重跑 ${flow}。`
      : "可沿用此流程；如有 warning，先看 Preflight 建議。");
  }
  const nextText = notes.map((n) => `- ${n}`).join("\n");

  return [
    `任務目標：\n${goal}`,
    `修改檔案：\n${changed}`,
    `遇到問題：\n${problemsText}`,
    `最後解法：\n${solution}`,
    `驗收結果：\n${acceptance}`,
    `下次注意：\n${nextText}`,
  ].join("\n\n");
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => loadTaskStore().tasks);
  const [rounds, setRounds] = useState<TaskRound[]>(() => loadTaskStore().rounds);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  const selectedTaskRounds = rounds
    .filter((r) => r.taskId === selectedTaskId)
    .sort((a, b) => a.roundIndex - b.roundIndex);

  // 每次 state 有變動後，呼叫此函式把最新資料存到 localStorage
  const persist = useCallback((nextTasks: Task[], nextRounds: TaskRound[]) => {
    saveTaskStore({ tasks: nextTasks, rounds: nextRounds });
  }, []);

  // --- Task CRUD ---

  const addTask = useCallback(
    (values: TaskFormValues): Task => {
      const task = createTask(values);
      setTasks((prev) => {
        const next = [...prev, task];
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
      return task;
    },
    [persist]
  );

  const editTask = useCallback(
    (taskId: string, values: Partial<TaskFormValues>): void => {
      setTasks((prev) => {
        const target = prev.find((t) => t.id === taskId);
        if (!target) return prev;
        const updated = updateTask(target, values);
        const next = prev.map((t) => (t.id === taskId ? updated : t));
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  // 複製一筆任務：保留內容欄位，重新產生 id / status / archived / createdAt
  const duplicateTask = useCallback(
    (taskId: string): Task | null => {
      const src = tasks.find((t) => t.id === taskId);
      if (!src) return null;
      const now = getNowIso();
      const copy: Task = {
        ...src,
        id: createId("task"),
        title: `${src.title} 副本`,
        status: "todo",
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      setTasks((prev) => {
        const next = [...prev, copy];
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
      return copy;
    },
    [tasks, persist]
  );

  const deleteTask = useCallback(
    (taskId: string): void => {
      setTasks((prev) => {
        const deletedTask = prev.find((t) => t.id === taskId);
        const wasArchived = deletedTask?.archived === true;
        const next = prev.filter((t) => t.id !== taskId);
        setRounds((prevRounds) => {
          const nextRounds = prevRounds.filter((r) => r.taskId !== taskId);
          persist(next, nextRounds);
          return nextRounds;
        });
        setSelectedTaskId((prevSelected) => {
          if (prevSelected !== taskId) return prevSelected;
          const pool = prev.filter((t) => (t.archived === true) === wasArchived);
          const nextPool = next.filter((t) => (t.archived === true) === wasArchived);
          const idx = pool.findIndex((t) => t.id === taskId);
          return (nextPool[idx] ?? nextPool[idx - 1] ?? null)?.id ?? null;
        });
        return next;
      });
    },
    [persist]
  );

  const archiveTask = useCallback(
    (taskId: string): void => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, archived: true, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => { persist(next, prevRounds); return prevRounds; });
        return next;
      });
      setSelectedTaskId((prev) => (prev === taskId ? null : prev));
    },
    [persist]
  );

  const restoreTask = useCallback(
    (taskId: string): void => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, archived: false, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => { persist(next, prevRounds); return prevRounds; });
        return next;
      });
    },
    [persist]
  );

  const setTaskStatus = useCallback(
    (taskId: string, status: TaskStatus): void => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, status, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  const setTaskPriority = useCallback(
    (taskId: string, priority: TaskPriority): void => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, priority, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  const setDueDate = useCallback(
    (taskId: string, dueDate: string | undefined): void => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, dueDate, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  const saveSummary = useCallback(
    (taskId: string, summary: string): void => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, summary, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  /**
   * 套用完成狀態（Phase 65）：同時保存目前摘要、設定 done/passed/done、寫 completedAt，
   * 並 append 一筆 completion_applied 事件。不封存、不 commit/push、不呼叫 runner/shell。
   * - summaryText 非空白：保存到 task.summary，event.summarySaved=true。
   * - summaryText 空白：不覆蓋既有 summary，event.summarySaved=false（仍可完成）。
   * - completedAt：每次套用都更新為當下時間。
   */
  const applyCompletion = useCallback(
    (taskId: string, summaryText: string): void => {
      // 取最新一筆回合 id 作為完成來源（取不到就省略）。
      const taskRounds = rounds.filter((r) => r.taskId === taskId);
      const latestRound =
        taskRounds.length > 0
          ? taskRounds.reduce((a, b) => (b.roundIndex > a.roundIndex ? b : a))
          : null;
      const sourceRoundId = latestRound?.id;

      setTasks((prev) => {
        const target = prev.find((t) => t.id === taskId);
        if (!target) return prev;

        const now = getNowIso();
        const summarySaved = summaryText.trim().length > 0;
        const event: TaskCompletionEvent = {
          id: createId("completion"),
          type: "completion_applied",
          createdAt: now,
          summarySaved,
          ...(sourceRoundId ? { sourceRoundId } : {}),
          status: "done",
          reviewResult: "passed",
          workflowStage: "done",
          message: summarySaved ? "套用完成狀態並保存摘要" : "套用完成狀態，摘要為空",
        };
        const updated: Task = {
          ...target,
          status: "done",
          reviewResult: "passed",
          workflowStage: "done",
          // 摘要有內容才保存，空白時不覆蓋既有摘要。
          ...(summarySaved ? { summary: summaryText } : {}),
          completedAt: now,
          completionHistory: [...(target.completionHistory ?? []), event],
          updatedAt: now,
        };
        const next = prev.map((t) => (t.id === taskId ? updated : t));
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [rounds, persist]
  );

  /**
   * 保存 AI Engineering Workflow 欄位（Phase 67）。
   * 整份覆蓋 task.aiWorkflow；傳入 undefined 代表清空（所有欄位皆空白時）。
   */
  const saveAiWorkflow = useCallback(
    (taskId: string, aiWorkflow: AiEngineeringWorkflow | undefined): void => {
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, aiWorkflow, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  /**
   * 套用 CE Readonly Workflow 結果（Phase 70）：把 runner 回填的 brainstorm / plan / audit
   * 合併進 task.aiWorkflow，保留既有 workReview / compound；不動 summary / completionHistory /
   * rounds / status / reviewResult / workflowStage / completedAt。不自動進入 Work、不 commit、不封存。
   */
  const applyCeReadonlyWorkflow = useCallback(
    (taskId: string, workflow: AiEngineeringWorkflow): void => {
      setTasks((prev) => {
        const target = prev.find((t) => t.id === taskId);
        if (!target) return prev;
        const merged = mergeCeReadonlyWorkflow(target.aiWorkflow, workflow);
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, aiWorkflow: merged, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  /**
   * 套用 CE Work 結果（Phase 71）：把 runner 回傳的實作 / verification / git 合併進 task.aiWorkflow.workReview，
   * 保留 brainstorm / plan / audit / compound；不動 summary / completionHistory / rounds / status /
   * reviewResult / workflowStage / completedAt。不自動進入 Review、不 commit、不封存、不套用完成狀態。
   */
  const applyCeWorkResult = useCallback(
    (taskId: string, result: CeWorkSuccess): void => {
      setTasks((prev) => {
        const target = prev.find((t) => t.id === taskId);
        if (!target) return prev;
        const merged = mergeCeWorkResult(target.aiWorkflow, result);
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, aiWorkflow: merged, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  /**
   * 套用 CE Review 結果（Phase 72）：把 runner 回傳的 review 整理成 codeReviewNotes 合併進
   * task.aiWorkflow.workReview，保留 changedFiles / testCommands / testResults / commitHash / commitMessage
   * 與 brainstorm / plan / audit / compound；不動 summary / completionHistory / completedAt /
   * status / reviewResult / workflowStage。不自動 commit / push / 封存 / 套用完成狀態。
   */
  const applyCeReviewResult = useCallback(
    (taskId: string, result: CeReviewSuccess): void => {
      setTasks((prev) => {
        const target = prev.find((t) => t.id === taskId);
        if (!target) return prev;
        const merged = mergeCeReviewResult(target.aiWorkflow, result);
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, aiWorkflow: merged, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  /**
   * 套用 CE Fix Work 結果（Phase 73B）：把修正後的 changedFiles / testCommands / testResults 合併進
   * task.aiWorkflow.workReview（去重 / append），codeReviewNotes 設為 "待 Review"，保留 brainstorm /
   * plan / audit / compound；不動 summary / completionHistory / completedAt / status / reviewResult /
   * workflowStage。不自動重跑 Review、不 commit / push、不封存、不套用完成狀態。
   */
  const applyCeFixWorkResult = useCallback(
    (taskId: string, result: CeFixWorkSuccess): void => {
      setTasks((prev) => {
        const target = prev.find((t) => t.id === taskId);
        if (!target) return prev;
        const merged = mergeCeFixWorkResult(target.aiWorkflow, result);
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, aiWorkflow: merged, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  const saveClaudeResponse = useCallback(
    (taskId: string, value: string): void => {
      // 空白內容存成 undefined，有內容則存 trim 後的字串
      const claudeResponse = value.trim() || undefined;
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, claudeResponse, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  const saveNextActions = useCallback(
    (taskId: string, value: string): void => {
      // 空白內容存成 undefined，有內容則存 trim 後的字串
      const nextActions = value.trim() || undefined;
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, nextActions, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  const saveSpecDraft = useCallback(
    (taskId: string, value: string): void => {
      // 空白內容存成 undefined，有內容則存 trim 後的字串
      const specDraft = value.trim() || undefined;
      setTasks((prev) => {
        const next = prev.map((t) =>
          t.id === taskId ? { ...t, specDraft, updatedAt: getNowIso() } : t
        );
        setRounds((prevRounds) => {
          persist(next, prevRounds);
          return prevRounds;
        });
        return next;
      });
    },
    [persist]
  );

  // --- Round CRUD ---

  const addRound = useCallback(
    (taskId: string, promptToClaude: string): TaskRound => {
      const roundIndex = getNextRoundIndex(rounds, taskId);
      const round = createTaskRound({ taskId, roundIndex, promptToClaude });
      setRounds((prev) => {
        const next = [...prev, round];
        setTasks((prevTasks) => {
          persist(prevTasks, next);
          return prevTasks;
        });
        return next;
      });
      return round;
    },
    [rounds, persist]
  );

  const editRound = useCallback(
    (roundId: string, patch: Partial<Omit<TaskRound, "id" | "taskId" | "roundIndex" | "createdAt">>): void => {
      setRounds((prev) => {
        const next = prev.map((r) =>
          r.id === roundId ? { ...r, ...patch, updatedAt: getNowIso() } : r
        );
        setTasks((prevTasks) => {
          persist(prevTasks, next);
          return prevTasks;
        });
        return next;
      });
    },
    [persist]
  );

  // 解析貼上的 JSON，為指定任務新增回合；自動辨識三種格式：
  // - auto-loop JSON：頂層有 rounds 陣列（scripts/auto-loop.mjs 輸出）→ 逐筆新增多筆回合。
  // - 本機驗證 JSON：頂層有 commands 陣列（scripts/run-verification.mjs 輸出）→ 新增一筆。
  // - auto-round JSON：頂層有 mode / ai / verification（scripts/auto-round.mjs 輸出）→ 新增一筆。
  // JSON 格式錯誤（JSON.parse 或欄位驗證）會往上丟，由呼叫端 alert 處理。
  const importVerificationResult = useCallback(
    (taskId: string, jsonText: string): TaskRound => {
      const parsed: unknown = JSON.parse(jsonText);
      const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      const obj = isObject ? (parsed as Record<string, unknown>) : {};
      const isAutoLoop = Array.isArray(obj.rounds);
      const isVerification = !isAutoLoop && Array.isArray(obj.commands);
      const isAutoRound =
        !isAutoLoop && !isVerification && ("mode" in obj || "ai" in obj || "verification" in obj);

      const startRoundIndex = getNextRoundIndex(rounds, taskId);
      const newRounds: TaskRound[] = isAutoLoop
        ? buildAutoLoopRounds(taskId, startRoundIndex, parseAutoLoopResult(parsed))
        : isAutoRound
          ? [buildAutoRoundRound(taskId, startRoundIndex, parseAutoRoundResult(parsed))]
          : [buildVerificationRound(taskId, startRoundIndex, parseVerificationResult(parsed))];

      if (newRounds.length === 0) {
        throw new Error("auto-loop JSON 的 rounds 為空，沒有可匯入的回合");
      }

      setRounds((prev) => {
        const next = [...prev, ...newRounds];
        setTasks((prevTasks) => {
          // 匯入 auto-round / auto-loop 後，若任務摘要為空白，自動以最後一輪產生摘要草稿（不覆蓋既有摘要、不改狀態）。
          let nextTasks = prevTasks;
          if (isAutoRound || isAutoLoop) {
            const target = prevTasks.find((t) => t.id === taskId);
            if (target && !(target.summary && target.summary.trim())) {
              const draft = buildAutoSummaryDraft(target, newRounds[newRounds.length - 1]);
              nextTasks = prevTasks.map((t) =>
                t.id === taskId ? { ...t, summary: draft, updatedAt: getNowIso() } : t
              );
            }
          }
          persist(nextTasks, next);
          return nextTasks;
        });
        return next;
      });
      return newRounds[newRounds.length - 1];
    },
    [rounds, persist]
  );

  // --- Import / Export ---

  const exportTasks = useCallback((): void => {
    const json = JSON.stringify({ tasks, rounds }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tasks-backup-${today}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [tasks, rounds]);

  const importTasks = useCallback((json: string): void => {
    const parsed: unknown = JSON.parse(json);
    const store = parseAndMigrateTaskStore(parsed);
    setTasks(store.tasks);
    setRounds(store.rounds);
    setSelectedTaskId(null);
    saveTaskStore(store);
  }, []);

  // --- Selection ---

  const selectTask = useCallback((taskId: string | null): void => {
    setSelectedTaskId(taskId);
  }, []);

  return {
    // state
    tasks,
    rounds,
    selectedTaskId,
    selectedTask,
    selectedTaskRounds,
    // task actions
    addTask,
    editTask,
    duplicateTask,
    deleteTask,
    archiveTask,
    restoreTask,
    setTaskStatus,
    setTaskPriority,
    setDueDate,
    saveSummary,
    applyCompletion,
    saveAiWorkflow,
    applyCeReadonlyWorkflow,
    applyCeWorkResult,
    applyCeReviewResult,
    applyCeFixWorkResult,
    saveClaudeResponse,
    saveNextActions,
    saveSpecDraft,
    // round actions
    addRound,
    editRound,
    importVerificationResult,
    // import / export
    exportTasks,
    importTasks,
    // selection
    selectTask,
  };
}
