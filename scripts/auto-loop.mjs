#!/usr/bin/env node
// 多輪 auto loop：依狀態機切換 mode，每輪呼叫 scripts/auto-round.mjs，直到 done / 失敗 / 達上限。
// 第一版只做 CLI，不接 UI、不自動 commit / push。
// stdout 只輸出單一合法 JSON；stderr 輸出每輪一行 NDJSON progress。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_ROUND_PATH = join(__dirname, 'auto-round.mjs');

const MODES = ['test', 'implement', 'refactor', 'fix'];

/** 成功時的 mode 轉移；refactor 成功代表整體完成（done）。 */
const SUCCESS_NEXT = {
  test: 'implement',
  implement: 'refactor',
  fix: 'refactor',
  refactor: 'done',
};

const DEFAULT_MAX_ROUNDS = 3;
const MIN_MAX_ROUNDS = 1;
const MAX_MAX_ROUNDS = 10;

/** 讀取整個 stdin 內容。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', (err) => reject(err));
  });
}

function toStr(value) {
  return typeof value === 'string' ? value : '';
}

function toStrArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string');
}

/** 依 workflowStage 推導起始 mode；非執行階段預設 implement。 */
function deriveModeFromStage(stage) {
  switch (stage) {
    case 'red_test':        return 'test';
    case 'green_implement': return 'implement';
    case 'refactor':        return 'refactor';
    case 'fix':             return 'fix';
    default:                return 'implement';
  }
}

/** 把 maxRounds 正規化：預設 3，clamp 到 1..10，取整數。 */
function normalizeMaxRounds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  const n = Math.floor(value);
  return Math.max(MIN_MAX_ROUNDS, Math.min(MAX_MAX_ROUNDS, n));
}

/** 寫一行 NDJSON progress 到 stderr。 */
function progress(event) {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/** 印出單一結果 JSON 到 stdout，永遠 exit 0（保持 stdout 乾淨可解析）。 */
function output(report) {
  // stdout 為 pipe 時 write 是非同步的；在 flush callback 內才結束 process，
  // 避免大 JSON（rounds[] 內嵌大段 verification stdout）在 buffer 排空前被 process.exit 截斷。
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => {
    process.exit(0);
  });
}

/**
 * 執行一輪 auto-round.mjs，把 perRoundTask 寫入 stdin，回傳解析後的 AutoRoundResult。
 * auto-round 永遠 exit 0 並輸出合法 JSON；若無法解析則回傳合成的失敗結果。
 * @param {Record<string, unknown>} perRoundTask
 * @returns {Promise<Record<string, unknown>>}
 */
function runAutoRound(perRoundTask) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(process.execPath, [AUTO_ROUND_PATH], { env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, mode: toStr(perRoundTask.mode), ai: null, verification: null, stoppedReason: 'auto_round_spawn_failed', error: message });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      resolve({ ok: false, mode: toStr(perRoundTask.mode), ai: null, verification: null, stoppedReason: 'auto_round_spawn_failed', error: err.message });
    });
    child.on('close', () => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        const detail = stderr.trim() ? `：${stderr.trim()}` : '';
        resolve({ ok: false, mode: toStr(perRoundTask.mode), ai: null, verification: null, stoppedReason: 'auto_round_no_output', error: `auto-round 沒有輸出${detail}` });
        return;
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({ ok: false, mode: toStr(perRoundTask.mode), ai: null, verification: null, stoppedReason: 'auto_round_parse_failed', error: message });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(perRoundTask));
    child.stdin.end();
  });
}

/** 從一筆 AutoRoundResult 判斷 AI 是否失敗。 */
function isAiFailed(round) {
  const reason = toStr(round.stoppedReason);
  if (reason.includes('ai_failed') || reason.includes('auto_round')) return true;
  const ai = round.ai;
  if (ai === null || ai === undefined) return true;
  if (typeof ai === 'object' && !Array.isArray(ai)) {
    return /** @type {Record<string, unknown>} */ (ai).exitCode !== 0;
  }
  return true;
}

/** 從一筆 AutoRoundResult 判斷 fileGuard 是否失敗。 */
function isFileGuardFailed(round) {
  if (toStr(round.stoppedReason).includes('file_guard_failed')) return true;
  const ver = round.verification;
  if (typeof ver !== 'object' || ver === null) return false;
  const fg = /** @type {Record<string, unknown>} */ (ver).fileGuard;
  return typeof fg === 'object' && fg !== null && /** @type {Record<string, unknown>} */ (fg).ok === false;
}

async function main() {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const base = () => ({ startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs });

  const rawText = (await readStdin()).trim();
  if (!rawText) {
    output({ ok: false, ...base(), maxRounds: DEFAULT_MAX_ROUNDS, totalRounds: 0, autoApprove: false, initialMode: '', finalMode: '', stoppedReason: 'no_input', rounds: [], error: '沒有從 stdin 收到任務 JSON' });
    return;
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output({ ok: false, ...base(), maxRounds: DEFAULT_MAX_ROUNDS, totalRounds: 0, autoApprove: false, initialMode: '', finalMode: '', stoppedReason: 'invalid_json', rounds: [], error: `任務 JSON 解析失敗：${message}` });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    output({ ok: false, ...base(), maxRounds: DEFAULT_MAX_ROUNDS, totalRounds: 0, autoApprove: false, initialMode: '', finalMode: '', stoppedReason: 'invalid_input', rounds: [], error: '任務 JSON 應為物件' });
    return;
  }
  const task = /** @type {Record<string, unknown>} */ (parsed);

  const projectPath = toStr(task.projectPath).trim();
  const aiCommand = toStr(task.aiCommand).trim();
  if (!projectPath || !aiCommand) {
    output({ ok: false, ...base(), maxRounds: DEFAULT_MAX_ROUNDS, totalRounds: 0, autoApprove: false, initialMode: '', finalMode: '', stoppedReason: 'invalid_input', rounds: [], error: '缺少必要欄位：projectPath / aiCommand' });
    return;
  }

  const maxRounds = normalizeMaxRounds(task.maxRounds);
  const autoApprove = task.autoApprove === true;

  // 起始 mode：優先用合法的 task.mode，否則依 workflowStage 推導。
  const taskMode = toStr(task.mode).trim();
  const initialMode = MODES.includes(taskMode) ? taskMode : deriveModeFromStage(toStr(task.workflowStage).trim());

  // 共用的任務脈絡欄位（餵給 auto-round，mode 每輪覆蓋）。
  const baseTaskFields = {
    title: toStr(task.title),
    projectPath,
    originalRequirement: toStr(task.originalRequirement),
    specDraft: toStr(task.specDraft),
    targetFiles: toStrArray(task.targetFiles),
    forbiddenFiles: toStrArray(task.forbiddenFiles),
    constraints: toStrArray(task.constraints),
    acceptanceCriteria: toStrArray(task.acceptanceCriteria),
    aiCommand,
  };

  /** @type {Record<string, unknown>[]} */
  const rounds = [];
  let mode = initialMode;
  let ok = false;
  let stoppedReason = '';
  /** @type {string | undefined} */
  let suggestedNextMode;
  let roundIndex = 0;

  while (true) {
    roundIndex += 1;
    const round = await runAutoRound({ ...baseTaskFields, mode });
    rounds.push(round);

    const aiFailed = isAiFailed(round);
    const fileGuardFailed = !aiFailed && isFileGuardFailed(round);
    const roundOk = round.ok === true;
    const nextMode = roundOk ? (SUCCESS_NEXT[mode] ?? 'done') : 'fix';

    progress({
      event: 'round',
      roundIndex,
      mode,
      ok: roundOk,
      ...(aiFailed || fileGuardFailed ? {} : { suggestedNextMode: nextMode }),
    });

    // 1. AI 失敗 → 立即停
    if (aiFailed) { ok = false; stoppedReason = 'ai_failed'; break; }
    // 2. fileGuard 失敗 → 立即停
    if (fileGuardFailed) { ok = false; stoppedReason = 'file_guard_failed'; break; }
    // 3. refactor 成功（nextMode === done）→ 成功停
    if (roundOk && nextMode === 'done') { ok = true; stoppedReason = 'done'; break; }

    // 尚未終止：nextMode 即建議的下一輪 mode
    suggestedNextMode = nextMode;

    // 4. approval gate：未開 autoApprove 時，第一輪後就停下等人核准
    if (!autoApprove) { ok = false; stoppedReason = 'approval_required'; break; }

    // 5. 達 maxRounds 上限 → 停
    if (roundIndex >= maxRounds) { ok = false; stoppedReason = 'max_rounds_reached'; break; }

    mode = nextMode;
  }

  /** @type {Record<string, unknown>} */
  const report = {
    ok,
    ...base(),
    maxRounds,
    totalRounds: rounds.length,
    autoApprove,
    initialMode,
    finalMode: mode,
    stoppedReason,
    rounds,
  };
  if (suggestedNextMode !== undefined && (stoppedReason === 'approval_required' || stoppedReason === 'max_rounds_reached')) {
    report.suggestedNextMode = suggestedNextMode;
  }
  output(report);
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // 透過 output() 以 flush-safe 方式輸出，避免 fatal 訊息也被截斷。
  output({ ok: false, stoppedReason: 'fatal', error: message, rounds: [] });
});
