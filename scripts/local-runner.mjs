#!/usr/bin/env node
// 受限的本機 runner server：只在 localhost 監聽，僅提供白名單 endpoint
// （GET /health、POST /auto-spec、POST /auto-round、POST /auto-loop、POST /preflight），
// 內部把 request body 當作 task JSON 餵給對應 scripts/*.mjs 的 stdin，回傳它的輸出 JSON。
// /preflight 只做唯讀檢查（固定指令），不修改任何檔案。
// 不提供任意 shell command endpoint、不接外部網路、不 commit / push。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_SPEC_PATH = join(__dirname, 'auto-spec.mjs');
const AUTO_ROUND_PATH = join(__dirname, 'auto-round.mjs');
const AUTO_LOOP_PATH = join(__dirname, 'auto-loop.mjs');

const HOST = '127.0.0.1'; // 只在 localhost 監聽
const PORT = Number(process.env.RUNNER_PORT) || 4318;

// 允許 ai-coding-relay 前端（localhost:1420）跨來源呼叫。
const ALLOWED_ORIGIN = process.env.RUNNER_ORIGIN || 'http://localhost:1420';

// 白名單：endpoint → { scriptPath, 合成錯誤 JSON 的基底欄位 }。
// 只開放這兩個 endpoint，不提供任意 command；新增 endpoint 必須在此明確列出。
const ENDPOINTS = {
  '/auto-spec': { scriptPath: AUTO_SPEC_PATH, errorBase: { ok: false, ai: null, specDraft: '' } },
  '/auto-round': { scriptPath: AUTO_ROUND_PATH, errorBase: { ok: false, mode: '', ai: null, verification: null } },
  '/auto-loop': { scriptPath: AUTO_LOOP_PATH, errorBase: { ok: false, totalRounds: 0, rounds: [] } },
};

// /health 用來讓 UI 確認「目前監聽的這個 runner 是哪一版、支援哪些 endpoint」，
// 解決舊版 / 新版 runner 佔用同一個 port 卻無法分辨的問題。bump VERSION 代表 endpoint 行為有變動。
const SERVICE = 'ai-coding-relay-local-runner';
const VERSION = 4;
const STARTED_AT = new Date().toISOString();
const SUPPORTED_ENDPOINTS = [...Object.keys(ENDPOINTS), '/health', '/preflight', '/ce-readonly-workflow', '/ce-work', '/ce-review', '/ce-fix-work', '/ce-commit-checkpoint', '/export-ce-artifacts'];

/**
 * 讀取整個 request body。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', (err) => reject(err));
  });
}

/**
 * 取字串前 max 字（不超過時原樣回傳）。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function headText(text, max) {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 取字串最後 max 字；長度不超過 max 時回傳空字串（避免與 preview 重複）。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function tailText(text, max) {
  return text.length > max ? text.slice(-max) : '';
}

/**
 * 合成「script stdout 不是合法 JSON」時要回給 UI 的錯誤 JSON 字串。
 * 刻意不把完整 stdout 塞回（避免再次造成大輸出），只保留位元數與前後片段供 debug。
 * 看起來像被截斷時用 runner_truncated_output，否則用 runner_invalid_json。
 * @param {Record<string, unknown>} errorBase 端點對應的基底欄位（維持回傳形狀相容）
 * @param {string} label endpoint / script 名稱
 * @param {string} stdout child 的原始 stdout
 * @param {string} stderr child 的原始 stderr
 * @param {string} parseError JSON.parse 的錯誤訊息
 * @returns {string}
 */
export function buildInvalidJsonError(errorBase, label, stdout, stderr, parseError) {
  const trimmed = stdout.trim();
  // 截斷徵兆：以 { 開頭卻沒以 } 結尾，或 parse error 指出輸入提前結束。
  const looksTruncated =
    (trimmed.startsWith('{') && !trimmed.endsWith('}')) || /Unexpected end/i.test(parseError);
  return JSON.stringify({
    ...errorBase,
    ok: false,
    stoppedReason: looksTruncated ? 'runner_truncated_output' : 'runner_invalid_json',
    runnerError: parseError,
    script: label,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stdoutPreview: headText(stdout, 1000),
    stdoutTail: tailText(stdout, 1000),
    stderrPreview: headText(stderr, 500),
    stderrTail: tailText(stderr, 500),
  });
}

/**
 * 執行指定的 scripts/*.mjs，把 taskJsonText 寫入 stdin，回傳它印到 stdout 的內容。
 * 這些腳本應 exit 0 並輸出單一合法 JSON；回傳前會先 JSON.parse 驗證：合法則照原樣回，
 * 不合法（例如被截斷）則改回合成的合法錯誤 JSON，避免把壞 JSON 原樣回給 UI。
 * spawn 失敗 / 無輸出時亦回傳合成的錯誤 JSON 字串，不丟例外。
 * @param {string} scriptPath 要執行的腳本絕對路徑
 * @param {string} taskJsonText 餵給 stdin 的 task JSON
 * @param {Record<string, unknown>} errorBase 合成錯誤 JSON 時附帶的基底欄位
 * @param {string} label 用於錯誤訊息 / script 欄位的腳本名稱
 * @returns {Promise<string>}
 */
export function runScript(scriptPath, taskJsonText, errorBase, label) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(process.execPath, [scriptPath], { env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve(JSON.stringify({ ...errorBase, stoppedReason: 'runner_spawn_failed', error: message }));
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      resolve(JSON.stringify({ ...errorBase, stoppedReason: 'runner_spawn_failed', error: err.message }));
    });
    child.on('close', () => {
      const trimmed = stdout.trim();
      if (trimmed) {
        // 回傳前先確認是合法 JSON：合法照原樣回（行為不變）；不合法不把壞 JSON 原樣回 UI，改回合成的合法錯誤 JSON。
        try {
          JSON.parse(trimmed);
          resolve(trimmed);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resolve(buildInvalidJsonError(errorBase, label, stdout, stderr, message));
        }
        return;
      }
      const detail = stderr.trim() ? `：${stderr.trim()}` : '';
      resolve(JSON.stringify({ ...errorBase, stoppedReason: 'runner_no_output', error: `${label} 沒有輸出${detail}` }));
    });
    child.stdin.on('error', () => {});
    child.stdin.write(taskJsonText);
    child.stdin.end();
  });
}

// --- CE Readonly Workflow：呼叫 Claude CLI 跑 Brainstorm / Plan / Audit（只唯讀分析、不修改任何檔案） ---

/**
 * 把任意值正規化成字串（非字串回傳空字串）。
 * @param {unknown} value
 * @returns {string}
 */
function ceStr(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 組出要餵給 Claude CLI 的 CE Readonly Workflow prompt。
 * 明確要求 Claude 只做唯讀分析（Brainstorm / Plan / Audit），不修改任何檔案、不 commit / push、
 * 不進入 Work，最後只輸出單一 JSON（無 markdown、無 code fence）。純字串組裝，不執行任何 shell。
 * @param {{ projectPath: string, title: string, originalRequirement: string }} task
 * @returns {string}
 */
export function buildCeReadonlyWorkflowPrompt(task) {
  const projectPath = ceStr(task.projectPath).trim();
  const title = ceStr(task.title).trim();
  const requirement = ceStr(task.originalRequirement).trim();

  return [
    '你正在為 ai-coding-relay 執行 CE Readonly Workflow。',
    '',
    `目標專案：\n${projectPath || '(未提供)'}`,
    '',
    `任務標題：\n${title || '(未提供)'}`,
    '',
    `原始需求：\n${requirement || '(未提供)'}`,
    '',
    'Readonly 限制：',
    '- 只做唯讀分析。',
    '- 不要修改任何檔案。',
    '- 不要新增檔案。',
    '- 不要刪除檔案。',
    '- 不要執行 formatter。',
    '- 不要執行 git commit。',
    '- 不要 push。',
    '- 不要進入 Work / implementation。',
    '- 如果需要檢查檔案，只能讀取。',
    '',
    '請依序完成：',
    '1. Brainstorm：問題定義、相關檔案、現況資料流、風險、建議方案、驗收標準。',
    '2. Plan：最小修改計畫、建議修改檔案、分步實作順序、測試策略、不做事項。',
    '3. Audit：核心假設、假設錯誤風險、是否過度設計、是否符合最小修改、可能影響模組、',
    '   驗收標準是否可測、是否建議進入 Work、若不建議原因是什麼。',
    '',
    '輸出格式（務必嚴格遵守，否則結果會被判為無效）：',
    '- 你的回應必須是「單一一個 JSON object」。',
    '- 不要 markdown。',
    '- 不要 code fence（不要 ``` 也不要 ```json）。',
    '- 不要在 JSON 前後加任何說明文字、標題、前言或結語。',
    '- 不要在 JSON 內加註解（comments）。',
    '- 整段回應的「第一個字元必須是 {」。',
    '- 整段回應的「最後一個字元必須是 }」。',
    '- path 可以是建議路徑（例如 docs/brainstorms/<slug>.md 或 docs/plans/<slug>.md），但本階段不要真的寫檔。',
    '- 若風險高或 plan 不足：plan.status 應為 "rejected" 且 canStartWork=false。',
    '- 若可進入 Work：plan.status 可為 "approved" 且 canStartWork=true。',
    '- 若你無法完成這個 readonly 分析，仍必須輸出單一合法 JSON failure object：',
    '  {"ok": false, "stoppedReason": "ai_failed", "message": "無法完成的原因"}',
    '',
    '請完全比照以下 schema 輸出（鍵名一致；這是唯一允許的輸出形狀）：',
    '',
    JSON.stringify(
      {
        ok: true,
        workflow: {
          brainstorm: { path: '', summary: '', status: 'reviewed' },
          plan: { path: '', summary: '', status: 'approved' },
          audit: {
            notes: '',
            coreAssumptions: [],
            riskNotes: [],
            acceptanceCriteria: [],
            checklist: {
              coreAssumptionsReviewed: true,
              riskReviewed: true,
              scopeReviewed: true,
              acceptanceCriteriaReviewed: true,
              minimalChangeReviewed: true,
            },
          },
        },
        canStartWork: true,
        recommendedNextAction: '',
        rawNotes: '',
      },
      null,
      2
    ),
  ].join('\n');
}

/**
 * Phase 77B：從可能夾雜文字的字串中掃出所有 markdown code fence 區段的內文。
 * 支援 ```json ... ```、```jsonc ... ```、```JSON ... ``` 與裸 ``` ... ```。
 * 只回內文（不含 fence 本身），不做 JSON 解析。
 * @param {string} text
 * @returns {string[]}
 */
function extractCodeFenceBlocks(text) {
  /** @type {string[]} */
  const blocks = [];
  const re = /```[^\S\r\n]*[A-Za-z0-9]*[^\S\r\n]*\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (typeof m[1] === 'string') blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Phase 77B：把一個已 parse 的物件正規化成「CeReadonlyWorkflowResult 形狀」。
 * - 已是 result（含 ok / workflow / canStartWork）→ 原樣回傳。
 * - 只是裸的 { brainstorm, plan, audit }（缺 result 外層）→ 包成 { ok:true, workflow:{...} }。
 * - 兩者皆非 → 回 null（不是 readonly workflow 結果）。
 * @param {Record<string, unknown> | null} obj
 * @returns {Record<string, unknown> | null}
 */
function normalizeReadonlyResultObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if ('ok' in obj || 'workflow' in obj || 'canStartWork' in obj) return obj;
  const hasBrainstorm = 'brainstorm' in obj;
  const hasPlan = 'plan' in obj;
  const hasAudit = 'audit' in obj;
  if (hasBrainstorm || hasPlan || hasAudit) {
    /** @type {Record<string, unknown>} */
    const workflow = {};
    if (hasBrainstorm) workflow.brainstorm = obj.brainstorm;
    if (hasPlan) workflow.plan = obj.plan;
    if (hasAudit) workflow.audit = obj.audit;
    return { ok: true, workflow };
  }
  return null;
}

/**
 * Phase 77C：共用的多階段「從 stdout 收集所有可 JSON.parse 的頂層物件」helper。
 * 把 Phase 77B 既有的三階段掃描抽成通用形式，供 /ce-readonly-workflow 與 /ce-work verification 共用。
 * 階段（依序，候選依出現順序累加）：
 *   1. 整段 stdout 直接 JSON.parse。
 *   2. 抓 markdown code fence（```json ... ``` / ``` ... ```）內文逐一解析。
 *   3. bracket matching 掃出所有頂層平衡物件逐一解析（會略過字串字面值內大括號）。
 * 本 helper 不做任何結構判斷（不挑 schema）；呼叫端自行從 candidates 中挑選（通常取最後一個符合者）。
 * 同時回報每階段的簡短嘗試字串（attempts），方便組 debug 摘要。
 * @param {string} stdout
 * @returns {{ candidates: Record<string, unknown>[], attempts: string[] }}
 */
export function collectJsonObjectsFromStdout(stdout) {
  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  /** @type {string[]} */
  const attempts = [];
  const trimmed = (typeof stdout === 'string' ? stdout : '').trim();
  if (!trimmed) {
    attempts.push('empty_stdout');
    return { candidates, attempts };
  }

  // 階段 1：整段直接 parse。
  const whole = tryParseJsonObject(trimmed);
  if (whole) candidates.push(whole);
  else attempts.push('whole_stdout_failed');

  // 階段 2：markdown code fence。
  const fences = extractCodeFenceBlocks(trimmed);
  let fenceParsed = 0;
  for (const fence of fences) {
    const obj = tryParseJsonObject(fence.trim());
    if (obj) { candidates.push(obj); fenceParsed += 1; }
  }
  if (!fences.length) attempts.push('no_code_fence');
  else if (!fenceParsed) attempts.push('json_code_fence_failed');

  // 階段 3：bracket matching 掃出所有頂層物件。
  const scanned = extractBalancedObjects(trimmed);
  let scanParsed = 0;
  for (const segment of scanned) {
    const obj = tryParseJsonObject(segment);
    if (obj) { candidates.push(obj); scanParsed += 1; }
  }
  if (!scanned.length) attempts.push('no_json_object_found');
  else if (!scanParsed) attempts.push('object_scan_failed');

  return { candidates, attempts };
}

/**
 * Phase 77B / 77C：多階段把 Claude CLI 的 stdout 解析成 CE Readonly Workflow 結果物件，並回報每階段嘗試。
 * 走共用的 collectJsonObjectsFromStdout 收集所有候選物件，再：
 *   - 先取「最後一個符合 result schema（含 ok / workflow / canStartWork）」者；
 *   - 再退而求其次取「最後一個裸 brainstorm / plan / audit」並用 normalizeReadonlyResultObject 包成 result。
 * 解析不到回 result=null。
 * @param {string} stdout
 * @returns {{ result: Record<string, unknown> | null, attempts: string[] }}
 */
export function extractCeReadonlyWorkflowResult(stdout) {
  const { candidates, attempts } = collectJsonObjectsFromStdout(stdout);

  // 優先「符合 result schema」者（含 ok / workflow / canStartWork），取最後一個。
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = candidates[i];
    if ('ok' in obj || 'workflow' in obj || 'canStartWork' in obj) {
      return { result: obj, attempts };
    }
  }
  // 退而求其次「裸 brainstorm / plan / audit」，取最後一個並包成 result。
  for (let i = candidates.length - 1; i >= 0; i--) {
    const wrapped = normalizeReadonlyResultObject(candidates[i]);
    if (wrapped) return { result: wrapped, attempts };
  }
  attempts.push('no_readonly_workflow_result');

  return { result: null, attempts };
}

/**
 * 從 Claude CLI 的 stdout 解析出 CE Readonly Workflow 結果物件（薄包裝；只回結果不回 attempts）。
 * 多階段策略見 extractCeReadonlyWorkflowResult。解析不到回 null。
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
export function parseCeReadonlyWorkflowJson(stdout) {
  return extractCeReadonlyWorkflowResult(stdout).result;
}

/**
 * 把 prompt 寫入 AI CLI 的 stdin 並在 cwd 執行；spawn 失敗不丟例外，改回傳 spawnError。
 * 與 scripts/auto-round.mjs 的 runAi 同風格（shell:false、固定 cwd、不接受任意指令字串注入）。
 * @param {string} aiCommand
 * @param {string} prompt
 * @param {string} cwd
 * @returns {Promise<{ command: string, exitCode: number | null, stdout: string, stderr: string, spawnError?: string }>}
 */
function runCeAi(aiCommand, prompt, cwd) {
  return new Promise((resolve) => {
    const parts = aiCommand.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ command: aiCommand, exitCode: null, stdout: '', stderr: '', spawnError: message });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      resolve({ command: aiCommand, exitCode: null, stdout, stderr, spawnError: err.message });
    });
    child.on('close', (code) => {
      resolve({ command: aiCommand, exitCode: code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Phase 77A：記錄 target project working tree 快照（readonly guard 用）。
 * 用三個唯讀 git 指令組成快照：status（含所有 untracked）/ diff --stat / diff --name-status。
 * 非 git repo 時 git 會失敗、stdout 為空字串，before/after 仍會一致（不誤判、安全 fallback）。
 * @param {string} projectPath
 * @returns {Promise<{ statusShort: string, diffStat: string, nameStatus: string }>}
 */
export async function captureReadonlySnapshot(projectPath) {
  const status = await runGit(projectPath, ['status', '--short', '--untracked-files=all']);
  const diffStat = await runGit(projectPath, ['diff', '--stat']);
  const nameStatus = await runGit(projectPath, ['diff', '--name-status']);
  return {
    statusShort: status.stdout,
    diffStat: diffStat.stdout,
    nameStatus: nameStatus.stdout,
  };
}

/**
 * Phase 77A：比較兩個 readonly 快照是否完全一致（三段字串皆相同）。
 * @param {{ statusShort: string, diffStat: string, nameStatus: string }} a
 * @param {{ statusShort: string, diffStat: string, nameStatus: string }} b
 * @returns {boolean}
 */
export function readonlySnapshotsEqual(a, b) {
  return (
    a.statusShort === b.statusShort &&
    a.diffStat === b.diffStat &&
    a.nameStatus === b.nameStatus
  );
}

/**
 * 執行 CE Readonly Workflow：驗證 projectPath → 記錄前快照 → 呼叫 Claude CLI（唯讀 prompt）→ 記錄後快照
 * → 比較快照（硬性 readonly guard）→ parse JSON → 回傳結果物件。
 * runner 自身不寫入 target project、不執行任何修改 target project 的 shell，只呼叫 Claude CLI 並解析其輸出。
 * 永遠 resolve 一個合法的結果物件（成功或失敗），不丟例外，避免把壞 JSON 原樣回給 UI。
 * @param {unknown} body 已 parse 的 request body：{ task: Task, aiCommand: string }，或 flat task + aiCommand。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runCeReadonlyWorkflow(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, stoppedReason: 'runner_error', message: 'request body 應為物件' };
  }
  const obj = /** @type {Record<string, unknown>} */ (body);
  // 支援 { task, aiCommand } 與「flat task + aiCommand」兩種形狀。
  const rawTask =
    typeof obj.task === 'object' && obj.task !== null && !Array.isArray(obj.task)
      ? /** @type {Record<string, unknown>} */ (obj.task)
      : obj;
  const task = {
    projectPath: ceStr(rawTask.projectPath).trim(),
    title: ceStr(rawTask.title),
    originalRequirement: ceStr(rawTask.originalRequirement),
  };
  const aiCommand = ceStr(obj.aiCommand).trim();

  if (!task.projectPath || !existsSync(task.projectPath)) {
    return {
      ok: false,
      stoppedReason: 'project_path_invalid',
      message: `projectPath 不存在或未提供：${task.projectPath || '(空)'}`,
    };
  }
  if (!aiCommand) {
    return { ok: false, stoppedReason: 'runner_error', message: '缺少必要欄位：aiCommand' };
  }

  // Phase 77A：呼叫 Claude 前記錄 working tree 快照（readonly guard）。
  const before = await captureReadonlySnapshot(task.projectPath);

  const prompt = buildCeReadonlyWorkflowPrompt(task);
  const ai = await runCeAi(aiCommand, prompt, task.projectPath);

  // Phase 77A：呼叫 Claude 後再記錄一次快照並比較。
  // 即使 Claude 忽略 prompt 或 aiCommand 帶 acceptEdits，只要 working tree 在執行前後不一致就硬性中止，
  // 回 readonly_violation 且不回傳 workflow（前端不得回填）。此檢查優先於 ai_failed / invalid_json，
  // 因為「檔案被改」是最重要的安全訊號。原本 dirty 但執行後無新變化時 before === after，不會誤判。
  const after = await captureReadonlySnapshot(task.projectPath);
  if (!readonlySnapshotsEqual(before, after)) {
    return {
      ok: false,
      stoppedReason: 'readonly_violation',
      message: 'CE Readonly Workflow modified target project files. Please inspect or revert changes before continuing.',
      before,
      after,
    };
  }

  if (ai.spawnError) {
    return {
      ok: false,
      stoppedReason: 'ai_failed',
      message: `Claude CLI 執行失敗：${ai.spawnError}`,
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }

  const { result: parsed, attempts } = extractCeReadonlyWorkflowResult(ai.stdout);
  if (!parsed) {
    // Phase 77B：invalid_json 時附上安全 debug 摘要（rawOutputPreview ≤ 2000 字、parseAttempts 簡短字串）。
    return {
      ok: false,
      stoppedReason: 'invalid_json',
      message: 'Claude CLI 的輸出無法解析為合法 JSON 結果',
      rawOutputPreview: headText(ai.stdout, 2000),
      parseAttempts: attempts,
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }

  // Phase 77B：Claude 依指示輸出合法 failure JSON（ok:false）時，原樣轉成 failure，不誤報成 ok:true。
  if (parsed.ok === false) {
    return {
      ok: false,
      stoppedReason: 'ai_failed',
      message: ceStr(parsed.message) || 'Claude 回報無法完成 CE Readonly Workflow',
      rawOutputPreview: headText(ai.stdout, 2000),
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }

  // workflow 取 parsed.workflow（不是物件時退回 parsed 本身，容忍 Claude 直接把 brainstorm/plan/audit 攤平）。
  const workflow =
    typeof parsed.workflow === 'object' && parsed.workflow !== null && !Array.isArray(parsed.workflow)
      ? parsed.workflow
      : { brainstorm: parsed.brainstorm, plan: parsed.plan, audit: parsed.audit };

  return {
    ok: true,
    workflow,
    canStartWork: parsed.canStartWork === true,
    recommendedNextAction: ceStr(parsed.recommendedNextAction),
    rawNotes: ceStr(parsed.rawNotes),
    ai: { command: aiCommand, exitCode: ai.exitCode },
  };
}

// --- CE Work：通過 Audit gate 後呼叫 Claude 依已審核 plan 實作 → 跑 verification → 收集 git 結果（不 commit / push）---

const CE_WORK_CHECKLIST_KEYS = [
  'coreAssumptionsReviewed',
  'riskReviewed',
  'scopeReviewed',
  'acceptanceCriteriaReviewed',
  'minimalChangeReviewed',
];

/**
 * CE Work gate：判斷是否允許進入 Work（與 src/core/ceWork.ts 的 evaluateCeWorkGate 一致）。
 * 策略：
 * - plan.status === "rejected" → 不可。
 * - plan.status 必須為 "approved" 或 "audited"，否則不可。
 * - audit.checklist 必須存在（缺 audit → 不可）。
 * - plan.status === "approved" → 可（Phase 70 approved 即視為通過審核）。
 * - plan.status === "audited" → 需 checklist 五項全 true 才可。
 * @param {unknown} aiWorkflow
 * @returns {{ canWork: boolean, reason: string }}
 */
function evaluateCeWorkGateJs(aiWorkflow) {
  const wf = aiWorkflow && typeof aiWorkflow === 'object' && !Array.isArray(aiWorkflow) ? aiWorkflow : {};
  const plan = wf.plan && typeof wf.plan === 'object' ? wf.plan : undefined;
  const audit = wf.audit && typeof wf.audit === 'object' ? wf.audit : undefined;
  const planStatus = plan && typeof plan.status === 'string' ? plan.status : undefined;

  if (planStatus === 'rejected') return { canWork: false, reason: 'Plan 已退回（rejected），不可進入 Work。' };
  if (planStatus !== 'approved' && planStatus !== 'audited') {
    return { canWork: false, reason: 'Plan 尚未 approved / audited，不建議進入 Work。' };
  }
  const checklist = audit && audit.checklist && typeof audit.checklist === 'object' ? audit.checklist : undefined;
  if (!checklist) return { canWork: false, reason: 'Audit 尚未完成（缺 checklist），不建議進入 Work。' };
  if (planStatus === 'approved') return { canWork: true, reason: '' };
  const allPassed = CE_WORK_CHECKLIST_KEYS.every((k) => checklist[k] === true);
  if (allPassed) return { canWork: true, reason: '' };
  return { canWork: false, reason: 'Audit checklist 尚未全部通過，不建議進入 Work。' };
}

/**
 * 組出要餵給 Claude CLI 的 CE Work prompt。
 * 明確要求只依已審核 plan 實作、只改建議範圍內檔案、不額外重構、不改 unrelated files、
 * 不 commit / push，最後只輸出單一 JSON。純字串組裝，不執行任何 shell。
 * @param {{ projectPath: string, title: string, originalRequirement: string, aiWorkflow: Record<string, unknown> }} task
 * @returns {string}
 */
export function buildCeWorkPrompt(task) {
  const wf = task.aiWorkflow && typeof task.aiWorkflow === 'object' ? task.aiWorkflow : {};
  const plan = wf.plan && typeof wf.plan === 'object' ? wf.plan : {};
  const audit = wf.audit && typeof wf.audit === 'object' ? wf.audit : {};
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : []);
  const bullets = (value) => list(value).map((v) => `- ${v}`).join('\n');

  const planSummary = typeof plan.summary === 'string' ? plan.summary.trim() : '';
  const planPath = typeof plan.path === 'string' ? plan.path.trim() : '';
  const auditNotes = typeof audit.notes === 'string' ? audit.notes.trim() : '';
  const coreAssumptions = bullets(audit.coreAssumptions);
  const riskNotes = bullets(audit.riskNotes);
  const acceptanceCriteria = bullets(audit.acceptanceCriteria);

  return [
    '你正在為 ai-coding-relay 執行 CE Work 階段。',
    '',
    `目標專案：\n${ceStr(task.projectPath).trim() || '(未提供)'}`,
    '',
    `任務標題：\n${ceStr(task.title).trim() || '(未提供)'}`,
    '',
    `原始需求：\n${ceStr(task.originalRequirement).trim() || '(未提供)'}`,
    '',
    `Plan：\n${planSummary || '(無摘要)'}${planPath ? `\nPlan 路徑：${planPath}` : ''}`,
    '',
    `Audit：\n${auditNotes || '(無筆記)'}`,
    coreAssumptions ? `核心假設：\n${coreAssumptions}` : '核心假設：\n(無)',
    riskNotes ? `風險：\n${riskNotes}` : '風險：\n(無)',
    acceptanceCriteria ? `驗收標準：\n${acceptanceCriteria}` : '驗收標準：\n(無)',
    '',
    '限制：',
    '- 只依照已審核通過的 plan 實作。',
    '- 只修改 plan / audit 建議範圍內的檔案。',
    '- 不要額外重構。',
    '- 不要修改 unrelated files。',
    '- 不要 commit。',
    '- 不要 push。',
    '- 每完成主要步驟請在最後 JSON 中回報。',
    '- 完成後請只輸出 JSON，不要 markdown，不要 code fence。',
    '',
    '請輸出 JSON（若無法安全實作，請改輸出 { "ok": false, "stoppedReason": "work_blocked", "message": "原因" }）：',
    '',
    JSON.stringify(
      {
        ok: true,
        changedFiles: [],
        testCommands: [],
        implementationSummary: '',
        notes: '',
        recommendedNextAction: '請進行 code review',
      },
      null,
      2
    ),
  ].join('\n');
}

/**
 * 從 Claude CLI 的 stdout 解析出 CE Work 結果物件（容忍前後夾雜文字，取最後一個合法物件）。
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
export function parseCeWorkJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;
  const candidates = extractBalancedObjects(trimmed);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = tryParseJsonObject(candidates[i]);
    if (obj && ('changedFiles' in obj || 'ok' in obj || 'stoppedReason' in obj || 'implementationSummary' in obj)) return obj;
  }
  return null;
}

/**
 * 是否在 projectPath/package.json 的 scripts 內有 verify:local。
 * @param {string} projectPath
 * @returns {boolean}
 */
function hasVerifyLocalScript(projectPath) {
  try {
    const pkg = tryParseJsonObject(readFileSync(join(projectPath, 'package.json'), 'utf8'));
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : null;
    return !!scripts && typeof scripts['verify:local'] === 'string';
  } catch {
    return false;
  }
}

/**
 * 執行目標專案的 verification：優先 `npm run verify:local`，否則 fallback 跑 scripts/run-verification.mjs。
 * 都沒有時視為「略過」（安全 fallback，不阻擋 Work）。回傳解析後的 verification 與可用 / 解析狀態。
 * Phase 77C：parsed=false 時一併回傳 attempts（多階段解析嘗試），供組 verification_failed debug 摘要。
 * Phase 77E：改用 runFixedCaptureFile（stdout 導臨時檔），確保 parser 永遠吃「完整 stdout」，
 * 不受 verification script「印大 JSON 後立刻 process.exit」的 pipe flush 截斷影響。
 * 回傳的 stdout 是完整內容，只供 runner 內 parse / 計長度；回 UI 前必須截斷成 preview。
 * @param {string} projectPath
 * @returns {Promise<{ verification: Record<string, unknown> | null, available: boolean, parsed: boolean, stdout: string, stderr: string, attempts: string[] }>}
 */
async function runCeWorkVerification(projectPath) {
  if (hasVerifyLocalScript(projectPath)) {
    const run = await runFixedCaptureFile('npm', ['run', '--silent', 'verify:local'], projectPath);
    const { result, attempts } = extractVerificationResult(run.stdout);
    return { verification: result, available: true, parsed: !!result, stdout: run.stdout, stderr: run.stderr, attempts };
  }
  const rvRel = join('scripts', 'run-verification.mjs');
  if (existsSync(join(projectPath, rvRel))) {
    const run = await runFixedCaptureFile(process.execPath, [rvRel], projectPath);
    const { result, attempts } = extractVerificationResult(run.stdout);
    return { verification: result, available: true, parsed: !!result, stdout: run.stdout, stderr: run.stderr, attempts };
  }
  return { verification: null, available: false, parsed: false, stdout: '', stderr: '', attempts: [] };
}

/**
 * 執行 CE Work：gate → 呼叫 Claude 實作（允許改檔）→ verification → 收集 git → 回傳結果物件。
 * runner 不自動 commit / push / 封存。永遠 resolve 合法結果物件，不丟例外。
 * @param {unknown} body { task: Task, aiCommand: string } 或 flat task + aiCommand。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runCeWorkWorkflow(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, stoppedReason: 'runner_error', message: 'request body 應為物件' };
  }
  const obj = /** @type {Record<string, unknown>} */ (body);
  const rawTask =
    typeof obj.task === 'object' && obj.task !== null && !Array.isArray(obj.task)
      ? /** @type {Record<string, unknown>} */ (obj.task)
      : obj;
  const aiWorkflow = rawTask.aiWorkflow && typeof rawTask.aiWorkflow === 'object' ? rawTask.aiWorkflow : {};
  const task = {
    projectPath: ceStr(rawTask.projectPath).trim(),
    title: ceStr(rawTask.title),
    originalRequirement: ceStr(rawTask.originalRequirement),
    aiWorkflow,
  };
  const aiCommand = ceStr(obj.aiCommand).trim();

  // 1. projectPath 存在
  if (!task.projectPath || !existsSync(task.projectPath)) {
    return { ok: false, stoppedReason: 'project_path_invalid', message: `projectPath 不存在或未提供：${task.projectPath || '(空)'}` };
  }

  // 2. Work gate（必須在呼叫 AI 之前）
  const gate = evaluateCeWorkGateJs(aiWorkflow);
  if (!gate.canWork) {
    return { ok: false, stoppedReason: 'work_gate_failed', message: gate.reason || 'Audit 尚未通過，不建議進入 Work。' };
  }

  // 3. aiCommand
  if (!aiCommand) {
    return { ok: false, stoppedReason: 'runner_error', message: '缺少必要欄位：aiCommand' };
  }

  // 4. 呼叫 Claude 實作（允許改檔；cwd = projectPath）
  const prompt = buildCeWorkPrompt(task);
  const ai = await runCeAi(aiCommand, prompt, task.projectPath);
  if (ai.spawnError) {
    return {
      ok: false,
      stoppedReason: 'ai_failed',
      message: `Claude CLI 執行失敗：${ai.spawnError}`,
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }

  // 5. 解析 Claude JSON
  const parsed = parseCeWorkJson(ai.stdout);
  if (!parsed) {
    return {
      ok: false,
      stoppedReason: 'invalid_json',
      message: 'Claude CLI 的輸出無法解析為合法 JSON 結果',
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }
  // Claude 自評無法安全實作 → 沿用其 stoppedReason（預設 work_blocked），不跑 verification。
  if (parsed.ok === false) {
    return {
      ok: false,
      stoppedReason: typeof parsed.stoppedReason === 'string' && parsed.stoppedReason ? parsed.stoppedReason : 'work_blocked',
      message: ceStr(parsed.message) || 'Claude 回報無法安全實作。',
    };
  }

  // 6. verification（優先 npm run verify:local，否則 run-verification.mjs，皆無則略過）
  const ver = await runCeWorkVerification(task.projectPath);
  let verificationOut;
  if (!ver.available) {
    // 安全 fallback：沒有任何 verification 機制時不阻擋 Work（標記 skipped）。
    verificationOut = { ok: true, commands: [], skipped: true };
  } else if (!ver.parsed) {
    // Phase 77C：附上安全 debug 摘要（rawOutputPreview ≤ 2000 字、parseAttempts 簡短字串），不塞超長 log。
    // Phase 77E：附上 stdoutLength（完整 stdout 的字數，只是 number），完整 stdout 本身不回傳給 UI。
    return {
      ok: false,
      stoppedReason: 'verification_failed',
      message: 'verification 輸出無法解析為合法 JSON',
      rawOutputPreview: headText(ver.stdout, 2000),
      stdoutLength: ver.stdout.length,
      parseAttempts: ver.attempts,
      stdoutPreview: headText(ver.stdout, 1000),
      stdoutTail: tailText(ver.stdout, 1000),
      stderrPreview: headText(ver.stderr, 500),
      stderrTail: tailText(ver.stderr, 500),
    };
  } else {
    const parsedVer = /** @type {Record<string, unknown>} */ (ver.verification);
    const commands = Array.isArray(parsedVer.commands) ? parsedVer.commands : [];
    verificationOut = { ok: parsedVer.ok === true, commands };
    if (parsedVer.ok !== true) {
      return { ok: false, stoppedReason: 'verification_failed', message: 'verification 未通過（verification.ok !== true）' };
    }
  }

  // 7. 收集 git status / diff（唯讀，不 commit / push）
  const statusRun = await runGit(task.projectPath, ['status', '--short']);
  const diffRun = await runGit(task.projectPath, ['diff', '--stat']);

  return {
    ok: true,
    work: {
      changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.filter((f) => typeof f === 'string') : [],
      testCommands: Array.isArray(parsed.testCommands) ? parsed.testCommands.filter((c) => typeof c === 'string') : [],
      testResults: ceStr(parsed.testResults),
      implementationSummary: ceStr(parsed.implementationSummary),
      notes: ceStr(parsed.notes),
      recommendedNextAction: ceStr(parsed.recommendedNextAction) || '請進行 code review',
    },
    verification: verificationOut,
    git: { statusShort: statusRun.stdout, diffStat: diffRun.stdout },
    ai: { command: aiCommand, exitCode: ai.exitCode },
  };
}

// --- CE Review：Work 完成後呼叫 Claude 做唯讀 review（不改檔 / 不 commit / 不 push / 不自動修正）---

/**
 * CE Review gate：必須已有 Work 結果才可 review（與 src/core/ceReview.ts 的 evaluateCeReviewGate 一致）。
 * 策略：workReview.changedFiles 有值，或 workReview.testResults 有非空字串。
 * @param {unknown} aiWorkflow
 * @returns {{ canReview: boolean, reason: string }}
 */
function evaluateCeReviewGateJs(aiWorkflow) {
  const wf = aiWorkflow && typeof aiWorkflow === 'object' && !Array.isArray(aiWorkflow) ? aiWorkflow : {};
  const wr = wf.workReview && typeof wf.workReview === 'object' && !Array.isArray(wf.workReview) ? wf.workReview : undefined;
  if (!wr) return { canReview: false, reason: '尚未有 Work 結果，不建議進行 Review。' };
  const hasChanged = Array.isArray(wr.changedFiles) && wr.changedFiles.some((f) => typeof f === 'string' && f.trim());
  const hasTestResults = typeof wr.testResults === 'string' && wr.testResults.trim().length > 0;
  if (hasChanged || hasTestResults) return { canReview: true, reason: '' };
  return { canReview: false, reason: '尚未有 Work 結果，不建議進行 Review。' };
}

/**
 * 組出要餵給 Claude CLI 的 CE Review prompt（唯讀）。
 * 明確要求不修改 / 不新增 / 不刪除檔案、不執行 formatter、不 commit / push、不自動修正、不進入下一輪 Work，
 * 最後只輸出單一 JSON。純字串組裝，不執行任何 shell。
 * @param {{ projectPath: string, title: string, originalRequirement: string, aiWorkflow: Record<string, unknown> }} task
 * @returns {string}
 */
export function buildCeReviewPrompt(task) {
  const wf = task.aiWorkflow && typeof task.aiWorkflow === 'object' ? task.aiWorkflow : {};
  const plan = wf.plan && typeof wf.plan === 'object' ? wf.plan : {};
  const audit = wf.audit && typeof wf.audit === 'object' ? wf.audit : {};
  const wr = wf.workReview && typeof wf.workReview === 'object' ? wf.workReview : {};
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : []);
  const bullets = (value) => list(value).map((v) => `- ${v}`).join('\n');

  const planSummary = typeof plan.summary === 'string' ? plan.summary.trim() : '';
  const planPath = typeof plan.path === 'string' ? plan.path.trim() : '';
  const auditNotes = typeof audit.notes === 'string' ? audit.notes.trim() : '';
  const changedFiles = bullets(wr.changedFiles);
  const testCommands = bullets(wr.testCommands);
  const testResults = typeof wr.testResults === 'string' ? wr.testResults.trim() : '';

  return [
    '你正在為 ai-coding-relay 執行 CE Review 階段。',
    '',
    `目標專案：\n${ceStr(task.projectPath).trim() || '(未提供)'}`,
    '',
    `任務標題：\n${ceStr(task.title).trim() || '(未提供)'}`,
    '',
    `原始需求：\n${ceStr(task.originalRequirement).trim() || '(未提供)'}`,
    '',
    `Plan：\n${planSummary || '(無摘要)'}${planPath ? `\nPlan 路徑：${planPath}` : ''}`,
    '',
    `Audit：\n${auditNotes || '(無筆記)'}`,
    '',
    `Work 結果：\nchangedFiles:\n${changedFiles || '(無)'}\n\ntestCommands:\n${testCommands || '(無)'}\n\ntestResults:\n${testResults || '(無)'}`,
    '',
    '限制：',
    '- 只做唯讀 review。',
    '- 不要修改任何檔案。',
    '- 不要新增檔案。',
    '- 不要刪除檔案。',
    '- 不要執行 formatter。',
    '- 不要 commit。',
    '- 不要 push。',
    '- 不要自動修正。',
    '- 不要進入下一輪 Work。',
    '- 可以讀取 git diff 與相關檔案。',
    '- 最後請只輸出 JSON，不要 markdown，不要 code fence。',
    '',
    '請檢查：是否符合原始需求 / 是否符合已審核 plan / 是否過度修改 / 是否有 unrelated changes /',
    '是否有型別風險 / 是否有資料一致性 / transaction / rollback 風險（如相關）/ 是否有測試缺口 /',
    'verification 結果是否足夠 / 是否建議拆分 commit / 可標記 passed 或 needs_fix。',
    '',
    '請輸出 JSON（若無法安全 review，請改輸出 { "ok": false, "stoppedReason": "review_blocked", "message": "原因" }）：',
    '',
    JSON.stringify(
      {
        ok: true,
        review: {
          result: 'passed',
          notes: '',
          issues: [],
          testGaps: [],
          riskNotes: [],
          recommendedFixes: [],
          recommendedNextAction: '',
        },
      },
      null,
      2
    ),
  ].join('\n');
}

/**
 * 從 Claude CLI 的 stdout 解析出 CE Review 結果物件（容忍前後夾雜文字，取最後一個合法物件）。
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
export function parseCeReviewJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;
  const candidates = extractBalancedObjects(trimmed);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = tryParseJsonObject(candidates[i]);
    if (obj && ('review' in obj || 'ok' in obj || 'stoppedReason' in obj)) return obj;
  }
  return null;
}

/**
 * 執行 CE Review：gate → 呼叫 Claude 做唯讀 review → 收集 git（唯讀）→ 回傳結果物件。
 * runner 不寫入 target project、不執行修改 target 的 shell、不 commit / push / 封存 / 套用完成狀態。
 * 永遠 resolve 合法結果物件，不丟例外。
 * @param {unknown} body { task: Task, aiCommand: string } 或 flat task + aiCommand。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runCeReviewWorkflow(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, stoppedReason: 'runner_error', message: 'request body 應為物件' };
  }
  const obj = /** @type {Record<string, unknown>} */ (body);
  const rawTask =
    typeof obj.task === 'object' && obj.task !== null && !Array.isArray(obj.task)
      ? /** @type {Record<string, unknown>} */ (obj.task)
      : obj;
  const aiWorkflow = rawTask.aiWorkflow && typeof rawTask.aiWorkflow === 'object' ? rawTask.aiWorkflow : {};
  const task = {
    projectPath: ceStr(rawTask.projectPath).trim(),
    title: ceStr(rawTask.title),
    originalRequirement: ceStr(rawTask.originalRequirement),
    aiWorkflow,
  };
  const aiCommand = ceStr(obj.aiCommand).trim();

  // 1. projectPath 存在
  if (!task.projectPath || !existsSync(task.projectPath)) {
    return { ok: false, stoppedReason: 'project_path_invalid', message: `projectPath 不存在或未提供：${task.projectPath || '(空)'}` };
  }

  // 2. Review gate（必須在呼叫 AI 之前）
  const gate = evaluateCeReviewGateJs(aiWorkflow);
  if (!gate.canReview) {
    return { ok: false, stoppedReason: 'review_gate_failed', message: gate.reason || '尚未有 Work 結果，不建議進行 Review。' };
  }

  // 3. aiCommand
  if (!aiCommand) {
    return { ok: false, stoppedReason: 'runner_error', message: '缺少必要欄位：aiCommand' };
  }

  // 4. 呼叫 Claude 做唯讀 review（prompt 要求不改檔；cwd = projectPath）
  const prompt = buildCeReviewPrompt(task);
  const ai = await runCeAi(aiCommand, prompt, task.projectPath);
  if (ai.spawnError) {
    return {
      ok: false,
      stoppedReason: 'ai_failed',
      message: `Claude CLI 執行失敗：${ai.spawnError}`,
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }

  // 5. 解析 Claude JSON
  const parsed = parseCeReviewJson(ai.stdout);
  if (!parsed) {
    return {
      ok: false,
      stoppedReason: 'invalid_json',
      message: 'Claude CLI 的輸出無法解析為合法 JSON 結果',
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }
  if (parsed.ok === false) {
    return {
      ok: false,
      stoppedReason: typeof parsed.stoppedReason === 'string' && parsed.stoppedReason ? parsed.stoppedReason : 'review_blocked',
      message: ceStr(parsed.message) || 'Claude 回報無法安全 review。',
    };
  }

  // 6. 整理 review 物件（result 只允許 passed / needs_fix，其餘一律視為 needs_fix）
  const rawReview = parsed.review && typeof parsed.review === 'object' && !Array.isArray(parsed.review) ? parsed.review : {};
  const strArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const review = {
    result: rawReview.result === 'passed' ? 'passed' : 'needs_fix',
    notes: ceStr(rawReview.notes),
    issues: strArray(rawReview.issues),
    testGaps: strArray(rawReview.testGaps),
    riskNotes: strArray(rawReview.riskNotes),
    recommendedFixes: strArray(rawReview.recommendedFixes),
    recommendedNextAction: ceStr(rawReview.recommendedNextAction),
  };

  // 7. 收集 git status / diff（唯讀，不 commit / push）
  const statusRun = await runGit(task.projectPath, ['status', '--short']);
  const diffRun = await runGit(task.projectPath, ['diff', '--stat']);

  return {
    ok: true,
    review,
    git: { statusShort: statusRun.stdout, diffStat: diffRun.stdout },
    ai: { command: aiCommand, exitCode: ai.exitCode },
  };
}

// --- CE Fix Work：CE Review needs_fix 時呼叫 Claude 只針對 recommended fixes 做最小修正（不 commit / push）---

/**
 * CE Fix Work gate（與 src/core/ceFixWork.ts 的 evaluateCeFixWorkGate 一致）。
 * 策略：workReview.codeReviewNotes 精確包含 "Review result: needs_fix"，且已有 Work 結果
 * （changedFiles 有值，或 testResults 有非空字串）。
 * @param {unknown} aiWorkflow
 * @returns {{ canFix: boolean, reason: string }}
 */
function evaluateCeFixWorkGateJs(aiWorkflow) {
  const wf = aiWorkflow && typeof aiWorkflow === 'object' && !Array.isArray(aiWorkflow) ? aiWorkflow : {};
  const wr = wf.workReview && typeof wf.workReview === 'object' && !Array.isArray(wf.workReview) ? wf.workReview : undefined;
  if (!wr) return { canFix: false, reason: '尚未有 Work 結果，不建議執行 Fix Work。' };
  const notes = typeof wr.codeReviewNotes === 'string' ? wr.codeReviewNotes : '';
  if (!notes.includes('Review result: needs_fix')) {
    return { canFix: false, reason: 'CE Review 尚未標記為 needs_fix，不建議執行 Fix Work。' };
  }
  const hasChanged = Array.isArray(wr.changedFiles) && wr.changedFiles.some((f) => typeof f === 'string' && f.trim());
  const hasTestResults = typeof wr.testResults === 'string' && wr.testResults.trim().length > 0;
  if (hasChanged || hasTestResults) return { canFix: true, reason: '' };
  return { canFix: false, reason: '尚未有 Work 結果，不建議執行 Fix Work。' };
}

/**
 * 組出要餵給 Claude CLI 的 CE Fix Work prompt。
 * 明確要求只修 CE Review 提出的 recommended fixes、只做最小修改、不重新設計 / 額外重構 /
 * 改 unrelated files、不 commit / push，最後只輸出單一 JSON。純字串組裝，不執行任何 shell。
 * @param {{ projectPath: string, title: string, originalRequirement: string, aiWorkflow: Record<string, unknown> }} task
 * @returns {string}
 */
export function buildCeFixWorkPrompt(task) {
  const wf = task.aiWorkflow && typeof task.aiWorkflow === 'object' ? task.aiWorkflow : {};
  const plan = wf.plan && typeof wf.plan === 'object' ? wf.plan : {};
  const audit = wf.audit && typeof wf.audit === 'object' ? wf.audit : {};
  const wr = wf.workReview && typeof wf.workReview === 'object' ? wf.workReview : {};
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : []);
  const bullets = (value) => list(value).map((v) => `- ${v}`).join('\n');

  const planSummary = typeof plan.summary === 'string' ? plan.summary.trim() : '';
  const auditNotes = typeof audit.notes === 'string' ? audit.notes.trim() : '';
  const changedFiles = bullets(wr.changedFiles);
  const testCommands = bullets(wr.testCommands);
  const testResults = typeof wr.testResults === 'string' ? wr.testResults.trim() : '';
  const codeReviewNotes = typeof wr.codeReviewNotes === 'string' ? wr.codeReviewNotes.trim() : '';

  return [
    '你正在為 ai-coding-relay 執行 CE Fix Work 階段。',
    '',
    `目標專案：\n${ceStr(task.projectPath).trim() || '(未提供)'}`,
    '',
    `任務標題：\n${ceStr(task.title).trim() || '(未提供)'}`,
    '',
    `原始需求：\n${ceStr(task.originalRequirement).trim() || '(未提供)'}`,
    '',
    `Plan：\n${planSummary || '(無摘要)'}`,
    '',
    `Audit：\n${auditNotes || '(無筆記)'}`,
    '',
    `原 Work 結果：\nchangedFiles:\n${changedFiles || '(無)'}\n\ntestCommands:\n${testCommands || '(無)'}\n\ntestResults:\n${testResults || '(無)'}`,
    '',
    `CE Review 結果：\n${codeReviewNotes || '(無)'}`,
    '',
    '限制：',
    '- 只修 CE Review 提出的 needs_fix / recommended fixes。',
    '- 只做最小修改。',
    '- 不要重新設計。',
    '- 不要額外重構。',
    '- 不要修改 unrelated files。',
    '- 不要 commit。',
    '- 不要 push。',
    '- 如果必須修改原 changedFiles 以外的檔案，請在 JSON notes 中明確說明原因。',
    '- 完成後請只輸出 JSON，不要 markdown，不要 code fence。',
    '',
    '請輸出 JSON（若無法安全修正，請改輸出 { "ok": false, "stoppedReason": "fix_blocked", "message": "原因" }）：',
    '',
    JSON.stringify(
      {
        ok: true,
        fix: {
          changedFiles: [],
          testCommands: [],
          fixSummary: '',
          notes: '',
          recommendedNextAction: '請再次執行 CE Review',
        },
      },
      null,
      2
    ),
  ].join('\n');
}

/**
 * 從 Claude CLI 的 stdout 解析出 CE Fix Work 結果物件（容忍前後夾雜文字，取最後一個合法物件）。
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
export function parseCeFixWorkJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;
  const candidates = extractBalancedObjects(trimmed);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = tryParseJsonObject(candidates[i]);
    if (obj && ('fix' in obj || 'ok' in obj || 'stoppedReason' in obj || 'changedFiles' in obj)) return obj;
  }
  return null;
}

/**
 * 執行 CE Fix Work：gate → 呼叫 Claude 只修 recommended fixes（允許改檔）→ verification → 收集 git → 回傳。
 * runner 不自動 commit / push / 封存 / 套用完成狀態 / 重跑 CE Review。永遠 resolve 合法結果物件。
 * @param {unknown} body { task: Task, aiCommand: string } 或 flat task + aiCommand。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runCeFixWorkWorkflow(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, stoppedReason: 'runner_error', message: 'request body 應為物件' };
  }
  const obj = /** @type {Record<string, unknown>} */ (body);
  const rawTask =
    typeof obj.task === 'object' && obj.task !== null && !Array.isArray(obj.task)
      ? /** @type {Record<string, unknown>} */ (obj.task)
      : obj;
  const aiWorkflow = rawTask.aiWorkflow && typeof rawTask.aiWorkflow === 'object' ? rawTask.aiWorkflow : {};
  const task = {
    projectPath: ceStr(rawTask.projectPath).trim(),
    title: ceStr(rawTask.title),
    originalRequirement: ceStr(rawTask.originalRequirement),
    aiWorkflow,
  };
  const aiCommand = ceStr(obj.aiCommand).trim();

  // 1. projectPath 存在
  if (!task.projectPath || !existsSync(task.projectPath)) {
    return { ok: false, stoppedReason: 'project_path_invalid', message: `projectPath 不存在或未提供：${task.projectPath || '(空)'}` };
  }

  // 2. Fix gate（必須在呼叫 AI 之前）
  const gate = evaluateCeFixWorkGateJs(aiWorkflow);
  if (!gate.canFix) {
    return { ok: false, stoppedReason: 'fix_gate_failed', message: gate.reason || 'CE Review 尚未標記為 needs_fix，不建議執行 Fix Work。' };
  }

  // 3. aiCommand
  if (!aiCommand) {
    return { ok: false, stoppedReason: 'runner_error', message: '缺少必要欄位：aiCommand' };
  }

  // 4. 呼叫 Claude 只修 recommended fixes（允許改檔；cwd = projectPath）
  const prompt = buildCeFixWorkPrompt(task);
  const ai = await runCeAi(aiCommand, prompt, task.projectPath);
  if (ai.spawnError) {
    return {
      ok: false,
      stoppedReason: 'ai_failed',
      message: `Claude CLI 執行失敗：${ai.spawnError}`,
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }

  // 5. 解析 Claude JSON
  const parsed = parseCeFixWorkJson(ai.stdout);
  if (!parsed) {
    return {
      ok: false,
      stoppedReason: 'invalid_json',
      message: 'Claude CLI 的輸出無法解析為合法 JSON 結果',
      stdoutPreview: headText(ai.stdout, 1000),
      stdoutTail: tailText(ai.stdout, 1000),
      stderrPreview: headText(ai.stderr, 500),
      stderrTail: tailText(ai.stderr, 500),
    };
  }
  if (parsed.ok === false) {
    return {
      ok: false,
      stoppedReason: typeof parsed.stoppedReason === 'string' && parsed.stoppedReason ? parsed.stoppedReason : 'fix_blocked',
      message: ceStr(parsed.message) || 'Claude 回報無法安全修正。',
    };
  }

  // 6. verification（沿用 Phase 71 的策略）
  const ver = await runCeWorkVerification(task.projectPath);
  let verificationOut;
  if (!ver.available) {
    verificationOut = { ok: true, commands: [], skipped: true };
  } else if (!ver.parsed) {
    // Phase 77C：附上安全 debug 摘要（rawOutputPreview ≤ 2000 字、parseAttempts 簡短字串），不塞超長 log。
    // Phase 77E：附上 stdoutLength（完整 stdout 的字數，只是 number），完整 stdout 本身不回傳給 UI。
    return {
      ok: false,
      stoppedReason: 'verification_failed',
      message: 'verification 輸出無法解析為合法 JSON',
      rawOutputPreview: headText(ver.stdout, 2000),
      stdoutLength: ver.stdout.length,
      parseAttempts: ver.attempts,
      stdoutPreview: headText(ver.stdout, 1000),
      stdoutTail: tailText(ver.stdout, 1000),
      stderrPreview: headText(ver.stderr, 500),
      stderrTail: tailText(ver.stderr, 500),
    };
  } else {
    const parsedVer = /** @type {Record<string, unknown>} */ (ver.verification);
    const commands = Array.isArray(parsedVer.commands) ? parsedVer.commands : [];
    verificationOut = { ok: parsedVer.ok === true, commands };
    if (parsedVer.ok !== true) {
      return { ok: false, stoppedReason: 'verification_failed', message: 'verification 未通過（verification.ok !== true）' };
    }
  }

  // 7. 收集 git status / diff（不 commit / push）
  const statusRun = await runGit(task.projectPath, ['status', '--short']);
  const diffRun = await runGit(task.projectPath, ['diff', '--stat']);

  // fix 取 parsed.fix（不是物件時退回 parsed 本身，容忍 Claude 攤平輸出）
  const rawFix = parsed.fix && typeof parsed.fix === 'object' && !Array.isArray(parsed.fix) ? parsed.fix : parsed;

  return {
    ok: true,
    fix: {
      changedFiles: Array.isArray(rawFix.changedFiles) ? rawFix.changedFiles.filter((f) => typeof f === 'string') : [],
      testCommands: Array.isArray(rawFix.testCommands) ? rawFix.testCommands.filter((c) => typeof c === 'string') : [],
      fixSummary: ceStr(rawFix.fixSummary),
      notes: ceStr(rawFix.notes),
      recommendedNextAction: ceStr(rawFix.recommendedNextAction) || '請再次執行 CE Review',
    },
    verification: verificationOut,
    git: { statusShort: statusRun.stdout, diffStat: diffRun.stdout },
    ai: { command: aiCommand, exitCode: ai.exitCode },
  };
}

// --- Phase 77F：CE Commit checkpoint：使用者按確認後才執行 verification → git add（只加 tracked）→ git commit ---
// 永不 push、不動 remote、不自動觸發。detached HEAD（smoke worktree）也允許 commit。

/**
 * 解析 `git status --porcelain` 的輸出。
 * - tracked：有任何 tracked 變更（modified / deleted / added / renamed…，XY 非 "??"）的檔案路徑；
 *   rename（"R  old -> new"）取箭頭後的新路徑。
 * - untracked：XY 為 "??" 的路徑（不會被自動加入 commit，只回報供 UI 顯示警告）。
 * @param {string} porcelain
 * @returns {{ tracked: string[], untracked: string[] }}
 */
export function parsePorcelainStatus(porcelain) {
  /** @type {string[]} */
  const tracked = [];
  /** @type {string[]} */
  const untracked = [];
  for (const line of porcelain.split('\n')) {
    if (line.trim().length === 0) continue;
    const xy = line.slice(0, 2);
    let path = line.slice(3);
    // porcelain 會把含特殊字元的路徑用雙引號包起來；保守地去掉外層引號。
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path.includes(' -> ')) path = path.split(' -> ').pop() ?? path;
    if (!path) continue;
    if (xy === '??') untracked.push(path);
    else tracked.push(path);
  }
  return { tracked, untracked };
}

/**
 * 是否為「不應自動加入 commit」的路徑：.env*（任何目錄層級）、node_modules / dist / build / coverage
 * 目錄底下、或 *.log。保守排除，避免把秘密或大型 build artifact 帶進 commit。
 * @param {string} path
 * @returns {boolean}
 */
export function isExcludedCommitPath(path) {
  const segments = path.split('/');
  const base = segments[segments.length - 1];
  if (base.startsWith('.env')) return true;
  if (base.endsWith('.log')) return true;
  return segments.some((seg) => seg === 'node_modules' || seg === 'dist' || seg === 'build' || seg === 'coverage');
}

/**
 * 執行 CE Commit checkpoint：
 *   1. projectPath / commitMessage 驗證（空 message 不可 commit）。
 *   2. git status --porcelain：失敗 → git_status_failed；無 tracked 變更 → nothing_to_commit。
 *   3. 只取 tracked 變更檔案（排除 .env / node_modules / build artifacts；untracked 不自動加入，僅回報）。
 *      body.changedFiles 有提供時再取交集（UI 已知的變更清單作為額外限制）。
 *   4. verification（沿用 runCeWorkVerification：npm run verify:local 優先，Phase 77E 完整 stdout capture）。
 *      失敗 → verification_failed，不 commit。無 verification 機制 → 視為 skipped（與 CE Work 一致）。
 *   5. git add -- <files> → git commit -m <message> → git rev-parse --short HEAD。
 * 永不 push、不動 remote。detached HEAD 一樣可 commit（git commit 不需要 branch）。
 * 永遠 resolve 合法結果物件，不丟例外。
 * @param {unknown} body { projectPath: string, commitMessage: string, changedFiles?: string[] }
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runCeCommitCheckpoint(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, stoppedReason: 'runner_error', message: 'request body 應為物件' };
  }
  const obj = /** @type {Record<string, unknown>} */ (body);
  const projectPath = ceStr(obj.projectPath).trim();
  const commitMessage = ceStr(obj.commitMessage).trim();
  const requestedFiles = Array.isArray(obj.changedFiles)
    ? obj.changedFiles.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
    : [];

  // 1. projectPath / commitMessage
  if (!projectPath || !existsSync(projectPath)) {
    return { ok: false, stoppedReason: 'project_path_invalid', message: `projectPath 不存在或未提供：${projectPath || '(空)'}` };
  }
  if (!commitMessage) {
    return { ok: false, stoppedReason: 'invalid_commit_message', message: 'commit message 不可為空' };
  }

  // 2. git status --porcelain（同時收 --short 與 diff --stat 供回傳顯示）
  const statusRun = await runGit(projectPath, ['status', '--porcelain']);
  if (statusRun.exitCode !== 0) {
    return {
      ok: false,
      stoppedReason: 'git_status_failed',
      message: `git status 失敗（exitCode=${statusRun.exitCode ?? 'null'}）`,
      stdoutPreview: headText(statusRun.stdout, 1000),
      stderrPreview: headText(statusRun.stderr, 500),
    };
  }
  const { tracked, untracked } = parsePorcelainStatus(statusRun.stdout);

  // 3. 只取 tracked 變更，排除敏感 / artifact 路徑；body.changedFiles 有提供時取交集。
  let files = tracked.filter((f) => !isExcludedCommitPath(f));
  if (requestedFiles.length > 0) {
    const requested = new Set(requestedFiles);
    files = files.filter((f) => requested.has(f));
  }
  if (files.length === 0) {
    const untrackedHint = untracked.length > 0 ? `（有 ${untracked.length} 個 untracked file，不會自動加入 commit）` : '';
    return {
      ok: false,
      stoppedReason: 'nothing_to_commit',
      message: `沒有可 commit 的 tracked 變更${untrackedHint}`,
      untrackedFiles: untracked,
    };
  }

  const statusBefore = statusRun.stdout;
  const diffStatRun = await runGit(projectPath, ['diff', '--stat']);
  const diffStatBefore = diffStatRun.stdout;

  // 4. verification（失敗就不 commit；無機制視為 skipped，與 CE Work 一致）
  const ver = await runCeWorkVerification(projectPath);
  let verificationOut;
  if (!ver.available) {
    verificationOut = { ok: true, commands: [], skipped: true };
  } else if (!ver.parsed || /** @type {Record<string, unknown>} */ (ver.verification).ok !== true) {
    return {
      ok: false,
      stoppedReason: 'verification_failed',
      message: ver.parsed ? 'verification 未通過（verification.ok !== true），不執行 commit' : 'verification 輸出無法解析為合法 JSON，不執行 commit',
      verificationPreview: headText(ver.stdout, 2000),
      stderrPreview: headText(ver.stderr, 500),
      untrackedFiles: untracked,
    };
  } else {
    const parsedVer = /** @type {Record<string, unknown>} */ (ver.verification);
    verificationOut = { ok: true, commands: Array.isArray(parsedVer.commands) ? parsedVer.commands : [] };
  }

  // 5. git add（只加白名單後的 tracked 檔案，不用 git add .）→ git commit → rev-parse short hash
  const addRun = await runGit(projectPath, ['add', '--', ...files]);
  if (addRun.exitCode !== 0) {
    return {
      ok: false,
      stoppedReason: 'git_commit_failed',
      message: `git add 失敗（exitCode=${addRun.exitCode ?? 'null'}）`,
      stdoutPreview: headText(addRun.stdout, 1000),
      stderrPreview: headText(addRun.stderr, 500),
    };
  }
  const commitRun = await runGit(projectPath, ['commit', '-m', commitMessage]);
  if (commitRun.exitCode !== 0) {
    return {
      ok: false,
      stoppedReason: 'git_commit_failed',
      message: `git commit 失敗（exitCode=${commitRun.exitCode ?? 'null'}）`,
      stdoutPreview: headText(commitRun.stdout, 1000),
      stderrPreview: headText(commitRun.stderr, 500),
    };
  }
  const hashRun = await runGit(projectPath, ['rev-parse', '--short', 'HEAD']);
  if (hashRun.exitCode !== 0) {
    return {
      ok: false,
      stoppedReason: 'git_commit_failed',
      message: `git rev-parse 失敗（commit 可能已建立，請手動確認）`,
      stdoutPreview: headText(hashRun.stdout, 1000),
      stderrPreview: headText(hashRun.stderr, 500),
    };
  }

  return {
    ok: true,
    commitMessage,
    commitHash: hashRun.stdout.trim(),
    committedAt: new Date().toISOString(),
    committedFiles: files,
    untrackedFiles: untracked,
    verification: verificationOut,
    statusBefore,
    diffStatBefore,
  };
}

// --- CE Artifact Export：把 task 的 CE workflow 紀錄寫成 docs/ai-workflows/<task-slug>/ 下的固定檔案 ---
// 只寫固定檔名、限制在 projectPath 底下、不刪檔、不 commit / push、不呼叫 AI、不執行任意 shell。
// 內容產生邏輯與 src/core/ceArtifactExport.ts 一致（該檔為 TS 純函式版本，供 UI / unit test 使用）。

/** 固定輸出檔名（順序固定）；runner 只允許寫這些檔名。與 src/core/ceArtifactExport.ts 的 ARTIFACT_FILE_NAMES 一致。 */
const ARTIFACT_FILE_NAMES = [
  'requirement.md',
  'brainstorm.md',
  'plan.md',
  'audit.md',
  'work-result.md',
  'review.md',
  'completion.md',
  'compound.md',
  'metadata.json',
];

const ARTIFACT_MAX_SLUG_LENGTH = 80;

/** trim 後的字串；非字串回空字串。 */
function artStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 字串陣列 → markdown bullet 清單（過濾空白）；無內容回空字串。 */
function artBullets(value) {
  const clean = Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [];
  return clean.length > 0 ? clean.map((v) => `- ${v}`).join('\n') : '';
}

/** 只把 ASCII 英數字保留成 slug；其餘轉連字號，限制長度。中文等非 ASCII 會被移除。 */
function artSlugifyAscii(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ARTIFACT_MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * 由 task 推導安全 slug：優先 title，其次 id，皆無 ASCII 字元時回退 "task"。
 * 結果只含 [a-z0-9-]，不可能包含路徑分隔字元或 ".."。
 * @param {Record<string, unknown>} task
 * @returns {string}
 */
function artSlugifyTask(task) {
  const fromTitle = artSlugifyAscii(artStr(task.title));
  if (fromTitle) return fromTitle;
  const fromId = artSlugifyAscii(artStr(task.id));
  if (fromId) return fromId;
  return 'task';
}

const ARTIFACT_CHECKLIST_ITEMS = [
  { key: 'coreAssumptionsReviewed', label: '核心假設已審查' },
  { key: 'riskReviewed', label: '風險已審查' },
  { key: 'scopeReviewed', label: '修改範圍已審查' },
  { key: 'acceptanceCriteriaReviewed', label: '驗收標準已審查' },
  { key: 'minimalChangeReviewed', label: '是否符合最小修改原則' },
];

/** 取 task.aiWorkflow（非物件回 {}）。 */
function artWorkflow(task) {
  return task.aiWorkflow && typeof task.aiWorkflow === 'object' && !Array.isArray(task.aiWorkflow) ? task.aiWorkflow : {};
}

/** 取巢狀子物件（非物件回 {}）。 */
function artObj(obj, key) {
  const v = obj[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** 產生 requirement.md。 */
function artRequirementMd(task) {
  const tags = Array.isArray(task.tags) ? task.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
  return [
    '# Requirement',
    '',
    `- Title: ${artStr(task.title) || '(未命名)'}`,
    `- Project: ${artStr(task.project) || '(未設定)'}`,
    `- Project Path: ${artStr(task.projectPath) || '(未設定)'}`,
    `- Priority: ${artStr(task.priority) || '(未設定)'}`,
    `- Due Date: ${artStr(task.dueDate) || '(未設定)'}`,
    `- Tags: ${tags.length > 0 ? tags.join(', ') : '(無)'}`,
    `- Created At: ${artStr(task.createdAt) || '(未知)'}`,
    `- Updated At: ${artStr(task.updatedAt) || '(未知)'}`,
    '',
    '## Original Requirement',
    '',
    artStr(task.originalRequirement) || '(未提供原始需求)',
    '',
  ].join('\n');
}

/** 產生 brainstorm.md。 */
function artBrainstormMd(task) {
  const b = artObj(artWorkflow(task), 'brainstorm');
  const status = artStr(b.status);
  const path = artStr(b.path);
  const summary = artStr(b.summary);
  if (!status && !path && !summary) return ['# Brainstorm', '', '尚未產生 Brainstorm 紀錄。', ''].join('\n');
  return ['# Brainstorm', '', `- Status: ${status || '(未設定)'}`, `- Path: ${path || '(未設定)'}`, '', '## Summary', '', summary || '(無摘要)', ''].join('\n');
}

/** 產生 plan.md。 */
function artPlanMd(task) {
  const p = artObj(artWorkflow(task), 'plan');
  const status = artStr(p.status);
  const path = artStr(p.path);
  const summary = artStr(p.summary);
  if (!status && !path && !summary) return ['# Plan', '', '尚未產生 Plan 紀錄。', ''].join('\n');
  return ['# Plan', '', `- Status: ${status || '(未設定)'}`, `- Path: ${path || '(未設定)'}`, '', '## Summary', '', summary || '(無摘要)', ''].join('\n');
}

/** 產生 audit.md。 */
function artAuditMd(task) {
  const a = artObj(artWorkflow(task), 'audit');
  const notes = artStr(a.notes);
  const coreAssumptions = artBullets(a.coreAssumptions);
  const riskNotes = artBullets(a.riskNotes);
  const acceptanceCriteria = artBullets(a.acceptanceCriteria);
  const checklist = a.checklist && typeof a.checklist === 'object' ? a.checklist : undefined;
  const hasAny = !!notes || !!coreAssumptions || !!riskNotes || !!acceptanceCriteria || !!checklist;
  if (!hasAny) return ['# Audit', '', '尚未產生 Audit 紀錄。', ''].join('\n');
  const checklistMd = ARTIFACT_CHECKLIST_ITEMS.map((item) => `- [${checklist && checklist[item.key] ? 'x' : ' '}] ${item.label}`).join('\n');
  return [
    '# Audit', '',
    '## Notes', '', notes || '(無筆記)', '',
    '## Core Assumptions', '', coreAssumptions || '(無)', '',
    '## Risk Notes', '', riskNotes || '(無)', '',
    '## Acceptance Criteria', '', acceptanceCriteria || '(無)', '',
    '## Checklist', '', checklistMd, '',
  ].join('\n');
}

/** 產生 work-result.md。 */
function artWorkResultMd(task) {
  const wr = artObj(artWorkflow(task), 'workReview');
  const changedFiles = artBullets(wr.changedFiles);
  const testCommands = artBullets(wr.testCommands);
  const testResults = artStr(wr.testResults);
  const commitHash = artStr(wr.commitHash);
  const commitMessage = artStr(wr.commitMessage);
  const hasAny = !!changedFiles || !!testCommands || !!testResults || !!commitHash || !!commitMessage;
  if (!hasAny) return ['# Work Result', '', '尚未產生 Work 紀錄。', ''].join('\n');
  return [
    '# Work Result', '',
    '## Changed Files', '', changedFiles || '(無)', '',
    '## Test Commands', '', testCommands || '(無)', '',
    '## Test Results', '', testResults || '(無)', '',
    '## Commit', '', `- Hash: ${commitHash || '(未提供)'}`, `- Message: ${commitMessage || '(未提供)'}`, '',
  ].join('\n');
}

/** 產生 review.md。 */
function artReviewMd(task) {
  const notes = artStr(artObj(artWorkflow(task), 'workReview').codeReviewNotes);
  if (!notes) return ['# Review', '', '尚未產生 Review 紀錄。', ''].join('\n');
  return ['# Review', '', '## Code Review Notes', '', notes, ''].join('\n');
}

/** 產生 completion.md。 */
function artCompletionMd(task) {
  const completedAt = artStr(task.completedAt);
  const history = Array.isArray(task.completionHistory) ? task.completionHistory : [];
  const historyMd = history.length > 0
    ? history.map((e, i) => `${i + 1}. ${artStr(e && e.createdAt)} — ${artStr(e && e.message)}`).join('\n')
    : '';
  const lines = [
    '# Completion', '',
    `- Status: ${artStr(task.status) || '(未設定)'}`,
    `- Review Result: ${artStr(task.reviewResult) || '(未設定)'}`,
    `- Workflow Stage: ${artStr(task.workflowStage) || '(未設定)'}`,
    `- Completed At: ${completedAt || '(尚未完成)'}`,
    '',
    '## Summary', '', artStr(task.summary) || '(無摘要)', '',
    '## Completion History', '', historyMd || '(無)', '',
  ];
  if (!completedAt && history.length === 0) lines.push('尚未套用完成狀態。', '');
  return lines.join('\n');
}

/** 產生 compound.md。 */
function artCompoundMd(task) {
  const c = artObj(artWorkflow(task), 'compound');
  const lessonLearned = artStr(c.lessonLearned);
  const reusablePrompt = artStr(c.reusablePrompt);
  const compoundNotes = artStr(c.compoundNotes);
  if (!lessonLearned && !reusablePrompt && !compoundNotes) return ['# Compound', '', '尚未產生 Compound Notes。', ''].join('\n');
  return [
    '# Compound', '',
    '## Lesson Learned', '', lessonLearned || '(無)', '',
    '## Reusable Prompt', '', reusablePrompt || '(無)', '',
    '## Compound Notes', '', compoundNotes || '(無)', '',
  ].join('\n');
}

/** 產生 metadata.json 內容字串。 */
function artMetadataJson(task, relativeDir) {
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: 'ai-coding-relay',
    task: {
      id: artStr(task.id),
      title: artStr(task.title),
      project: artStr(task.project),
      projectPath: artStr(task.projectPath),
      status: artStr(task.status),
      reviewResult: artStr(task.reviewResult),
      workflowStage: artStr(task.workflowStage),
      createdAt: artStr(task.createdAt),
      updatedAt: artStr(task.updatedAt),
      completedAt: artStr(task.completedAt),
    },
    artifact: { relativeDir, files: [...ARTIFACT_FILE_NAMES] },
  }, null, 2);
}

/**
 * 產生全部 artifact 檔案（name + 內容）。與 src/core/ceArtifactExport.ts 的 buildCeArtifactFiles 一致。
 * @param {Record<string, unknown>} task
 * @param {string} relativeDir
 * @returns {{ name: string, content: string }[]}
 */
function buildArtifactFiles(task, relativeDir) {
  return [
    { name: 'requirement.md', content: artRequirementMd(task) },
    { name: 'brainstorm.md', content: artBrainstormMd(task) },
    { name: 'plan.md', content: artPlanMd(task) },
    { name: 'audit.md', content: artAuditMd(task) },
    { name: 'work-result.md', content: artWorkResultMd(task) },
    { name: 'review.md', content: artReviewMd(task) },
    { name: 'completion.md', content: artCompletionMd(task) },
    { name: 'compound.md', content: artCompoundMd(task) },
    { name: 'metadata.json', content: artMetadataJson(task, relativeDir) },
  ];
}

/**
 * 執行 CE Artifact Export：驗證 projectPath → 建立安全路徑 → 寫固定檔名。
 * 路徑安全：slug 只含 [a-z0-9-]；輸出目錄與每個檔案都用 resolve 後驗證仍在 projectPath 底下，
 * 且檔名只允許白名單（不含路徑分隔字元）。不刪檔、不 commit / push、不呼叫 AI、不執行任意 shell。
 * 永遠 resolve 合法結果物件，不丟例外。
 * @param {unknown} body { task: Task } 或 flat task。
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runExportCeArtifacts(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, stoppedReason: 'runner_error', message: 'request body 應為物件' };
  }
  const obj = /** @type {Record<string, unknown>} */ (body);
  const task =
    typeof obj.task === 'object' && obj.task !== null && !Array.isArray(obj.task)
      ? /** @type {Record<string, unknown>} */ (obj.task)
      : obj;

  const projectPath = artStr(task.projectPath);

  // 1. projectPath 存在
  if (!projectPath || !existsSync(projectPath)) {
    return { ok: false, stoppedReason: 'project_path_invalid', message: `projectPath 不存在或未提供：${projectPath || '(空)'}` };
  }
  // 2. projectPath 是資料夾
  let isDir = false;
  try { isDir = statSync(projectPath).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return { ok: false, stoppedReason: 'project_path_invalid', message: `projectPath 不是資料夾：${projectPath}` };
  }

  // 3. 建立安全路徑（slug 只含 [a-z0-9-]，再以 resolve 後前綴比對防 path traversal）
  const slug = artSlugifyTask(task);
  const relativeDir = `docs/ai-workflows/${slug}`;
  const baseDir = resolve(projectPath);
  const targetDir = resolve(baseDir, 'docs', 'ai-workflows', slug);
  const baseWithSep = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (targetDir !== baseDir && !targetDir.startsWith(baseWithSep)) {
    return { ok: false, stoppedReason: 'path_escape_detected', message: '輸出路徑超出 projectPath 範圍' };
  }

  const files = buildArtifactFiles(task, relativeDir);

  // 4. 逐檔案再次驗證檔名（只允許白名單、不得含路徑分隔字元）並寫入
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stoppedReason: 'write_failed', message: `建立目錄失敗：${message}` };
  }

  /** @type {{ name: string, relativePath: string }[]} */
  const written = [];
  for (const file of files) {
    const name = file.name;
    // 檔名必須在白名單內（這同時擋掉任意檔名 / 路徑分隔字元 / "..")。
    if (!ARTIFACT_FILE_NAMES.includes(name)) {
      return { ok: false, stoppedReason: 'path_escape_detected', message: `不允許的檔名：${name}` };
    }
    const absFile = resolve(targetDir, name);
    const targetDirWithSep = targetDir.endsWith(sep) ? targetDir : targetDir + sep;
    if (!absFile.startsWith(targetDirWithSep)) {
      return { ok: false, stoppedReason: 'path_escape_detected', message: `檔案路徑超出輸出目錄：${name}` };
    }
    try {
      writeFileSync(absFile, file.content, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, stoppedReason: 'write_failed', message: `寫入失敗（${name}）：${message}` };
    }
    written.push({ name, relativePath: `${relativeDir}/${name}` });
  }

  return {
    ok: true,
    artifact: {
      relativeDir,
      absoluteDir: targetDir,
      files: written,
    },
  };
}

// --- Preflight：在 projectPath 執行一組固定的唯讀檢查，不修改任何檔案、不接受任意指令 ---

/**
 * 在 cwd 執行固定的 git 子指令（shell:false、固定 args），回傳 exitCode / stdout / stderr。
 * spawn 失敗不丟例外，改回傳 exitCode=null。
 * @param {string} cwd
 * @param {string[]} args 例如 ['rev-parse', '--is-inside-work-tree']
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string }>}
 */
function runGit(cwd, args) {
  return runFixed('git', args, cwd);
}

/**
 * 執行固定指令（不接受來自 request 的任意指令；command 與 args 都是程式內寫死的）。
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string }>}
 */
function runFixed(command, args, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ exitCode: null, stdout: '', stderr: message });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

/**
 * Phase 77E：執行固定指令，但把 child 的 stdout 導到臨時檔案，結束後讀回「完整 stdout」。
 * 為什麼不用 pipe：target project 的 verification script 常見「印出大 JSON 後立刻 process.exit()」，
 * stdout 是 pipe 時 Node 的寫入是 async、process.exit 不等 flush，超過 pipe buffer 的部分會被丟棄，
 * runner 只收到 JSON 開頭（沒有 outer 結尾 `}`），導致 parser 解析失敗。stdout 是檔案時寫入是同步的，
 * 不受 process.exit 截斷影響。stderr 量小、維持 pipe 收集。
 * 回傳的 stdout 是完整內容，只供 runner 內部 parse 使用；回給 UI 前仍須經 headText / tailText 截斷。
 * 無法建立臨時檔時 fallback 回 runFixed（pipe 模式），不丟例外。
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string }>}
 */
function runFixedCaptureFile(command, args, cwd) {
  /** @type {string} */
  let tmpDir;
  /** @type {string} */
  let outPath;
  /** @type {number} */
  let fd;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'ai-coding-relay-verify-'));
    outPath = join(tmpDir, 'stdout.log');
    fd = openSync(outPath, 'w');
  } catch {
    // 建臨時檔失敗時 fallback 回 pipe 模式（仍可運作，只是超大輸出可能受 flush 截斷影響）。
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清不掉不影響結果 */ }
    }
    return runFixed(command, args, cwd);
  }
  return new Promise((resolve) => {
    let stderr = '';
    let done = false;
    /** @param {number | null} code @param {string} extraStderr */
    const finish = (code, extraStderr) => {
      if (done) return;
      done = true;
      try { closeSync(fd); } catch { /* 已關閉 */ }
      let stdout = '';
      try { stdout = readFileSync(outPath, 'utf8'); } catch { /* 讀不到時維持空字串 */ }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清不掉不影響結果 */ }
      resolve({ exitCode: code, stdout, stderr: `${stderr}${extraStderr}` });
    };
    let child;
    try {
      child = spawn(command, args, { cwd, shell: false, env: process.env, stdio: ['ignore', fd, 'pipe'] });
    } catch (err) {
      finish(null, err instanceof Error ? err.message : String(err));
      return;
    }
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code, ''));
  });
}

/**
 * 嘗試把字串 parse 成「非陣列物件」；失敗或不是物件時回傳 null。
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function tryParseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 從可能夾雜其他文字的字串中掃出所有「頂層平衡的 {...} 區段」，會略過字串字面值內的大括號。
 * （與 scripts/auto-round.mjs 的穩健解析邏輯一致。）
 * @param {string} text
 * @returns {string[]}
 */
function extractBalancedObjects(text) {
  /** @type {string[]} */
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Phase 77D：嚴格判斷一個已 parse 的物件是否為「run-verification 最外層 report」。
 * 必須同時滿足（不能只因為有 ok=true 就算 report，避免誤選 commands[] 內層 command object）：
 *   - 是非 null、非陣列的 object。
 *   - ok 是 boolean。
 *   - commands 是 array（這是最外層 report 的主要判斷條件；command object 沒有 commands array）。
 *   - commands 內每個元素若存在，至少是 object（非 null、非陣列）。
 * startedAt / finishedAt / durationMs 是常見欄位但非必要（容忍精簡 report）。
 * @param {Record<string, unknown>} obj
 * @returns {boolean}
 */
function isVerificationReport(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.ok !== 'boolean') return false;
  if (!Array.isArray(obj.commands)) return false;
  for (const cmd of obj.commands) {
    if (typeof cmd !== 'object' || cmd === null || Array.isArray(cmd)) return false;
  }
  return true;
}

/**
 * Phase 77C / 77D：多階段把 run-verification.mjs / npm run verify:local 的 stdout 解析成最外層
 * verification report，並回報每階段嘗試。走共用的 collectJsonObjectsFromStdout
 * （whole parse / code fence / bracket matching）取得所有「頂層」候選物件，
 * 再用嚴格的 isVerificationReport 過濾，取「最後一個完整 outer report」。
 *
 * 為什麼這樣不會誤選 commands[] 內層 object：
 *   - bracket matching 只回傳 depth-0（最外層）物件，內層 command object 不會成為候選；
 *   - 即使有其他雜訊物件，isVerificationReport 嚴格要求 commands 是 array，
 *     command object（只有 name/command/exitCode/ok…）不含 commands array 一律被排除。
 * 容忍前面有 npm prefix（> pkg@ver verify:local）/ prose / warning，以及 commands[].stdout
 * 內很長的 TAP log（escaped newline / 中文 / --- / ... / # / 跳脫雙引號）。
 * @param {string} stdout
 * @returns {{ result: Record<string, unknown> | null, attempts: string[] }}
 */
export function extractVerificationResult(stdout) {
  const { candidates, attempts } = collectJsonObjectsFromStdout(stdout);
  // 取最後一個「完整 outer report」（多個 report 時選最後一個）。
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (isVerificationReport(candidates[i])) return { result: candidates[i], attempts };
  }
  attempts.push('no_verification_report');
  return { result: null, attempts };
}

/**
 * 從 run-verification.mjs 的 stdout 解析出 verification 物件（薄包裝；只回結果不回 attempts）。
 * 多階段策略見 extractVerificationResult。解析不到回 null。
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
function parseVerificationJson(stdout) {
  return extractVerificationResult(stdout).result;
}

/**
 * 從 checks 彙整 summary 與整體 ok：只要有 severity=error 的失敗，ok 即為 false。
 * @param {string} projectPath
 * @param {{ name: string, ok: boolean, severity: string, message: string }[]} checks
 */
function finalizePreflight(projectPath, checks) {
  let errorCount = 0;
  let warningCount = 0;
  for (const c of checks) {
    if (!c.ok) {
      if (c.severity === 'error') errorCount += 1;
      else if (c.severity === 'warning') warningCount += 1;
    }
  }
  return { ok: errorCount === 0, projectPath, checks, summary: { errorCount, warningCount } };
}

/**
 * 對 projectPath 執行一組固定的唯讀前置檢查。全程不修改任何檔案、不接受任意指令。
 * @param {string} projectPath
 */
async function runPreflight(projectPath) {
  /** @type {{ name: string, ok: boolean, severity: string, message: string, suggestion?: string, fixCommand?: string }[]} */
  const checks = [];
  /**
   * 新增一筆檢查結果。suggestion / fixCommand 只在「檢查未通過」時附上（通過時保持精簡）。
   * fixCommand 一律是純文字，runner 不會執行它。
   * @param {string} name
   * @param {boolean} ok
   * @param {string} severity
   * @param {string} message
   * @param {{ suggestion?: string, fixCommand?: string }} [fix]
   */
  const add = (name, ok, severity, message, fix) => {
    /** @type {{ name: string, ok: boolean, severity: string, message: string, suggestion?: string, fixCommand?: string }} */
    const check = { name, ok, severity, message };
    if (!ok && fix) {
      if (fix.suggestion) check.suggestion = fix.suggestion;
      if (fix.fixCommand) check.fixCommand = fix.fixCommand;
    }
    checks.push(check);
  };
  // 在 fixCommand 中安全嵌入 projectPath（用雙引號包住，避免路徑含空白）。
  const cd = `cd "${projectPath}"`;

  // 1. projectPath 是否存在
  const exists = typeof projectPath === 'string' && projectPath.length > 0 && existsSync(projectPath);
  add('project_path_exists', exists, 'error', exists ? `projectPath 存在：${projectPath}` : `projectPath 不存在：${projectPath || '(空)'}`, {
    // 不提供自動 mkdir 的 fixCommand，避免在錯誤路徑建立專案。
    suggestion: '確認任務的 projectPath 是否填錯，或先建立 / clone 該專案後再重試。',
  });

  // 2. projectPath 是否為資料夾
  let isDir = false;
  if (exists) {
    try { isDir = statSync(projectPath).isDirectory(); } catch { isDir = false; }
  }
  add('project_path_is_directory', isDir, 'error', isDir ? 'projectPath 是資料夾' : 'projectPath 不是資料夾', {
    suggestion: 'projectPath 必須是資料夾，請改成專案的根目錄路徑。',
  });

  // 不是有效資料夾時，後續檢查無法在其 cwd 進行，直接彙整回傳（避免在無效 cwd spawn）。
  if (!isDir) return finalizePreflight(projectPath, checks);

  // 3. git_repo
  const gitRepo = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  const isGitRepo = gitRepo.exitCode === 0 && gitRepo.stdout.trim() === 'true';
  add('git_repo', isGitRepo, 'error', isGitRepo ? 'projectPath 是 git repo' : 'projectPath 不是 git repo（git rev-parse --is-inside-work-tree 失敗）', {
    suggestion: '目標專案需要初始化 git，auto-round 才能比對修改範圍與 diff。初始化前建議先建立 .gitignore，排除 node_modules/、logs/、.ai-coding-relay/，避免把不該追蹤的檔案 commit 進 baseline。',
    fixCommand: `${cd}\ngit init\ngit add .\ngit commit -m "initial baseline"`,
  });

  // 4. run_verification_exists
  const runVerificationPath = join(projectPath, 'scripts', 'run-verification.mjs');
  const rvExists = existsSync(runVerificationPath);
  add('run_verification_exists', rvExists, 'error', rvExists ? '存在 scripts/run-verification.mjs' : '缺少 scripts/run-verification.mjs', {
    suggestion: '目標專案需要 scripts/run-verification.mjs，auto-round 才能自動跑驗證並回灌結果。第一版不自動寫檔，請自行新增。',
    fixCommand: '# 建議在目標專案新增 scripts/run-verification.mjs\n# 並讓它輸出 { "ok": boolean, "commands": [...] } JSON',
  });

  // 5. package_json_exists
  const pkgPath = join(projectPath, 'package.json');
  const pkgExists = existsSync(pkgPath);
  add('package_json_exists', pkgExists, 'error', pkgExists ? '存在 package.json' : '缺少 package.json', {
    // 不提供自動初始化的 fixCommand，避免錯誤初始化覆蓋既有設定。
    suggestion: '目標專案需要 package.json，才能判斷 npm scripts 與 Node 專案的驗證方式。',
  });

  // 6. verify_local_script（warning）
  let hasVerifyLocal = false;
  if (pkgExists) {
    try {
      const pkg = tryParseJsonObject(readFileSync(pkgPath, 'utf8'));
      const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? /** @type {Record<string, unknown>} */ (pkg.scripts) : null;
      hasVerifyLocal = !!scripts && typeof scripts['verify:local'] === 'string';
    } catch { hasVerifyLocal = false; }
  }
  add('verify_local_script', hasVerifyLocal, 'warning', hasVerifyLocal ? 'package.json 有 scripts.verify:local' : 'package.json 缺少 scripts.verify:local（建議補上）', {
    suggestion: '建議在 package.json 加入 verify:local 指令，讓本機與 auto-round 使用一致的驗證流程。',
    fixCommand: `${cd}\nnpm pkg set scripts.verify:local="node scripts/run-verification.mjs"`,
  });

  // 7. node_modules_tracked（被追蹤 → error）。非 git repo 時 git 會失敗、視為未追蹤。
  const nmTrackedRun = await runGit(projectPath, ['ls-files', 'node_modules']);
  const nmTracked = nmTrackedRun.exitCode === 0 && nmTrackedRun.stdout.trim().length > 0;
  add('node_modules_tracked', !nmTracked, 'error', nmTracked ? 'node_modules 被 git 追蹤（不應追蹤，會污染 diff，請加入 .gitignore）' : 'node_modules 未被 git 追蹤', {
    suggestion: 'node_modules 不應被 git 追蹤，請從 index 移除並加入 .gitignore。',
    fixCommand: `${cd}\nprintf "node_modules/\\n" >> .gitignore\ngit rm -r --cached node_modules\ngit add .gitignore\ngit commit -m "chore: stop tracking node_modules"`,
  });

  // 8. logs_tracked（被追蹤 → error，會干擾 diff）
  const logsTrackedRun = await runGit(projectPath, ['ls-files', 'logs']);
  const logsTracked = logsTrackedRun.exitCode === 0 && logsTrackedRun.stdout.trim().length > 0;
  add('logs_tracked', !logsTracked, 'error', logsTracked ? 'logs 被 git 追蹤（會干擾 diff，請加入 .gitignore）' : 'logs 未被 git 追蹤', {
    suggestion: 'logs 會干擾 diff，建議不要追蹤，請從 index 移除並加入 .gitignore。',
    fixCommand: `${cd}\nprintf "logs/\\n" >> .gitignore\ngit rm -r --cached logs\ngit add .gitignore\ngit commit -m "chore: stop tracking logs"`,
  });

  // 9. git_status_clean（有變更 → warning）
  const statusRun = await runGit(projectPath, ['status', '--short']);
  const statusClean = statusRun.exitCode === 0 && statusRun.stdout.trim().length === 0;
  add('git_status_clean', statusClean, 'warning', statusClean ? 'git working tree 乾淨' : 'git working tree 有未提交變更（目前不是乾淨 baseline）', {
    suggestion: '目前 target project 有未提交變更。執行 auto-round 前請確認這些變更是預期的，否則 diff 會混在一起。',
    fixCommand: `${cd}\ngit status --short\ngit diff --stat`,
  });

  // 10. run_verification_json：執行 node scripts/run-verification.mjs 並嘗試解析其輸出
  const runVerificationFix = `${cd}\nnode scripts/run-verification.mjs`;
  if (!rvExists) {
    add('run_verification_json', false, 'error', '無法執行：scripts/run-verification.mjs 不存在', {
      suggestion: 'scripts/run-verification.mjs 不存在，請先新增該檔（見 run_verification_exists 的建議）。',
      fixCommand: runVerificationFix,
    });
  } else {
    // Phase 77E：與 runCeWorkVerification 一致，用 runFixedCaptureFile 拿完整 stdout（避免 pipe flush 截斷）。
    const verRun = await runFixedCaptureFile(process.execPath, [join('scripts', 'run-verification.mjs')], projectPath);
    if (verRun.exitCode === null) {
      add('run_verification_json', false, 'error', `無法執行 run-verification.mjs：${verRun.stderr.trim() || '未知錯誤'}`, {
        suggestion: '請確認可在目標專案執行 node scripts/run-verification.mjs；若 exitCode 非 0，請先修復目前的測試或型別錯誤。',
        fixCommand: runVerificationFix,
      });
    } else {
      const parsed = parseVerificationJson(verRun.stdout);
      if (!parsed) {
        add('run_verification_json', false, 'error', 'run-verification.mjs 的輸出無法解析為 verification JSON', {
          suggestion: '請確認 scripts/run-verification.mjs 的 stdout 最後有輸出 verification JSON（{ "ok": boolean, "commands": [...] }）。',
          fixCommand: runVerificationFix,
        });
      } else if (parsed.ok !== true) {
        // ok !== true 視為 warning：有時本來就是 red phase（測試尚未通過）。
        add('run_verification_json', false, 'warning', 'run-verification.mjs 可執行且輸出可解析，但 verification.ok !== true（可能是 red phase）', {
          suggestion: '代表目前驗證未全綠，可依工作流階段決定是否進入 fix；若目前是 red phase 屬正常情況。',
          fixCommand: runVerificationFix,
        });
      } else {
        add('run_verification_json', true, 'error', 'run-verification.mjs 可執行且輸出合法 verification JSON（ok=true）');
      }
    }
  }

  return finalizePreflight(projectPath, checks);
}

/**
 * 設定共用的回應標頭（CORS 限定來源、JSON）。
 * @param {import('node:http').ServerResponse} res
 */
function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} jsonText
 */
function sendJson(res, status, jsonText) {
  setCommonHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(jsonText);
}

const server = createServer((req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  // CORS preflight
  if (method === 'OPTIONS') {
    setCommonHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  // GET /health：回報 runner 的身分、版本與支援的 endpoint；不執行任何 shell、不需 body。
  if (method === 'GET' && url === '/health') {
    sendJson(res, 200, JSON.stringify({
      ok: true,
      service: SERVICE,
      version: VERSION,
      startedAt: STARTED_AT,
      port: PORT,
      host: HOST,
      endpoints: SUPPORTED_ENDPOINTS,
    }));
    return;
  }

  // POST /preflight：對 request body 的 projectPath 做一組固定的唯讀檢查；不修改檔案、不接受任意指令。
  if (method === 'POST' && url === '/preflight') {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        let projectPath = '';
        if (text) {
          const parsed = tryParseJsonObject(text);
          if (parsed && typeof parsed.projectPath === 'string') projectPath = parsed.projectPath;
        }
        // projectPath 為空 / 不存在會由 project_path_exists 檢查標記為 error，不在此另外報錯。
        return runPreflight(projectPath).then((result) => sendJson(res, 200, JSON.stringify(result)));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ok: false, projectPath: '', checks: [], summary: { errorCount: 1, warningCount: 0 }, error: message }));
      });
    return;
  }

  // POST /ce-readonly-workflow：呼叫 Claude CLI 跑 Brainstorm / Plan / Audit（唯讀）；
  // runner 不寫入 target project、不執行修改 target project 的 shell，只解析 Claude 輸出並回傳 JSON。
  if (method === 'POST' && url === '/ce-readonly-workflow') {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        if (!text) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 為空' }));
          return;
        }
        const parsed = tryParseJsonObject(text);
        if (!parsed) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 不是合法 JSON 物件' }));
          return;
        }
        return runCeReadonlyWorkflow(parsed).then((result) => sendJson(res, 200, JSON.stringify(result)));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message }));
      });
    return;
  }

  // POST /ce-work：通過 Audit gate 後呼叫 Claude 依已審核 plan 實作 → verification → 收集 git。
  // gate 不通過不呼叫 AI；runner 不自動 commit / push / 封存。
  if (method === 'POST' && url === '/ce-work') {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        if (!text) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 為空' }));
          return;
        }
        const parsed = tryParseJsonObject(text);
        if (!parsed) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 不是合法 JSON 物件' }));
          return;
        }
        return runCeWorkWorkflow(parsed).then((result) => sendJson(res, 200, JSON.stringify(result)));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message }));
      });
    return;
  }

  // POST /ce-review：Work 完成後呼叫 Claude 做唯讀 review。gate 不過不呼叫 AI；
  // runner 不寫入 target project、不 commit / push / 封存 / 套用完成狀態。
  if (method === 'POST' && url === '/ce-review') {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        if (!text) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 為空' }));
          return;
        }
        const parsed = tryParseJsonObject(text);
        if (!parsed) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 不是合法 JSON 物件' }));
          return;
        }
        return runCeReviewWorkflow(parsed).then((result) => sendJson(res, 200, JSON.stringify(result)));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message }));
      });
    return;
  }

  // POST /ce-fix-work：CE Review needs_fix 時呼叫 Claude 只修 recommended fixes → verification → 收集 git。
  // gate 不過不呼叫 AI；runner 不自動 commit / push / 封存 / 套用完成狀態 / 重跑 CE Review。
  if (method === 'POST' && url === '/ce-fix-work') {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        if (!text) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 為空' }));
          return;
        }
        const parsed = tryParseJsonObject(text);
        if (!parsed) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 不是合法 JSON 物件' }));
          return;
        }
        return runCeFixWorkWorkflow(parsed).then((result) => sendJson(res, 200, JSON.stringify(result)));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message }));
      });
    return;
  }

  // POST /ce-commit-checkpoint：使用者按確認後才執行 verification → git add（只加 tracked）→ git commit。
  // 永不 push、不動 remote、不自動觸發；verification 失敗 / 無變更 / message 空皆不 commit。
  if (method === 'POST' && url === '/ce-commit-checkpoint') {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        if (!text) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 為空' }));
          return;
        }
        const parsed = tryParseJsonObject(text);
        if (!parsed) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 不是合法 JSON 物件' }));
          return;
        }
        return runCeCommitCheckpoint(parsed).then((result) => sendJson(res, 200, JSON.stringify(result)));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message }));
      });
    return;
  }

  // POST /export-ce-artifacts：把 task 的 CE workflow 紀錄寫成 docs/ai-workflows/<task-slug>/ 下的固定檔案。
  // 只寫固定檔名、限制在 projectPath 底下、不刪檔、不 commit / push、不呼叫 AI、不執行任意 shell。
  if (method === 'POST' && url === '/export-ce-artifacts') {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        if (!text) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 為空' }));
          return;
        }
        const parsed = tryParseJsonObject(text);
        if (!parsed) {
          sendJson(res, 400, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message: 'request body 不是合法 JSON 物件' }));
          return;
        }
        return runExportCeArtifacts(parsed).then((result) => sendJson(res, 200, JSON.stringify(result)));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ok: false, stoppedReason: 'runner_error', message }));
      });
    return;
  }

  // 「只」開放白名單 endpoint（POST），其餘一律拒絕（不提供任意 command）。
  const endpoint = method === 'POST' ? ENDPOINTS[url] : undefined;
  if (endpoint) {
    readBody(req)
      .then((body) => {
        const text = body.trim();
        if (!text) {
          sendJson(res, 400, JSON.stringify({ ...endpoint.errorBase, stoppedReason: 'no_body', error: 'request body 為空' }));
          return;
        }
        // 不在 runner 解析語意，直接把 body 當 task JSON 餵給腳本（由它驗證）。
        return runScript(endpoint.scriptPath, text, endpoint.errorBase, url.slice(1)).then((resultJson) => {
          sendJson(res, 200, resultJson);
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, JSON.stringify({ ...endpoint.errorBase, stoppedReason: 'runner_error', error: message }));
      });
    return;
  }

  sendJson(res, 404, JSON.stringify({ ok: false, error: 'not_found：只提供 GET /health、POST /auto-spec、POST /auto-round、POST /auto-loop、POST /preflight、POST /ce-readonly-workflow、POST /ce-work、POST /ce-review、POST /ce-fix-work、POST /ce-commit-checkpoint、POST /export-ce-artifacts' }));
});

// 只在「直接以 node scripts/local-runner.mjs 執行」時才綁 port；被測試 import 時不啟動 server。
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`local-runner 已啟動：http://${HOST}:${PORT}（GET /health、POST /auto-spec、POST /auto-round、POST /auto-loop、POST /preflight、POST /ce-readonly-workflow、POST /ce-work、POST /ce-review、POST /ce-fix-work、POST /export-ce-artifacts，允許來源 ${ALLOWED_ORIGIN}）\n`);
  });
}
