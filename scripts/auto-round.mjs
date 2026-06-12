#!/usr/bin/env node
// 自動執行「一輪」SDD/TDD：依任務 JSON 產生對應 prompt → 呼叫 AI CLI → 跑本機驗證 → 輸出結果 JSON。
// 第一版只跑一輪，不做循環、不接 UI、不自動 commit / push。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {Object} TaskInput
 * @property {string} title
 * @property {string} projectPath
 * @property {string} originalRequirement
 * @property {string} specDraft
 * @property {string[]} targetFiles
 * @property {string[]} forbiddenFiles
 * @property {string[]} constraints
 * @property {string[]} acceptanceCriteria
 * @property {"test" | "implement" | "refactor" | "fix"} mode
 * @property {string} aiCommand
 */

/**
 * @typedef {Object} AiResult
 * @property {string} command
 * @property {number | null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 * @property {string} [spawnError]
 */

const MODES = ['test', 'implement', 'refactor', 'fix'];

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

/** 把任意值正規化成字串（非字串回傳空字串）。 */
function toStr(value) {
  return typeof value === 'string' ? value : '';
}

/** 把任意值正規化成字串陣列（過濾非字串與空字串）。 */
function toStrArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim().length > 0);
}

/**
 * 解析並驗證任務 JSON；缺少必要欄位或 mode 不合法時丟出帶訊息的錯誤。
 * @param {unknown} raw
 * @returns {TaskInput}
 */
function parseTask(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('任務 JSON 應為物件');
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);

  const projectPath = toStr(obj.projectPath).trim();
  if (!projectPath) throw new Error('缺少必要欄位：projectPath');

  const mode = toStr(obj.mode).trim();
  if (!MODES.includes(mode)) {
    throw new Error(`mode 不合法：必須是 ${MODES.join(' / ')}`);
  }

  const aiCommand = toStr(obj.aiCommand).trim();
  if (!aiCommand) throw new Error('缺少必要欄位：aiCommand');

  return {
    title: toStr(obj.title),
    projectPath,
    originalRequirement: toStr(obj.originalRequirement),
    specDraft: toStr(obj.specDraft),
    targetFiles: toStrArray(obj.targetFiles),
    forbiddenFiles: toStrArray(obj.forbiddenFiles),
    constraints: toStrArray(obj.constraints),
    acceptanceCriteria: toStrArray(obj.acceptanceCriteria),
    mode: /** @type {TaskInput["mode"]} */ (mode),
    aiCommand,
  };
}

/** 把任務內容組成共用的「任務脈絡」純文字區塊，空欄位略過。 */
function buildContext(task) {
  const parts = [];
  if (task.title.trim()) parts.push(`任務標題：\n${task.title.trim()}`);
  if (task.originalRequirement.trim()) parts.push(`原始需求：\n${task.originalRequirement.trim()}`);
  if (task.specDraft.trim()) parts.push(`規格草稿：\n${task.specDraft.trim()}`);
  if (task.targetFiles.length > 0) parts.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join('\n')}`);
  if (task.forbiddenFiles.length > 0) parts.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join('\n')}`);
  if (task.constraints.length > 0) parts.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  if (task.acceptanceCriteria.length > 0) parts.push(`驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);
  return parts.join('\n\n');
}

const MODE_INSTRUCTIONS = {
  test: `請依上述資訊產生測試，這是 TDD 的 red phase：
- 只新增 / 修改測試，先不要實作功能。
- 測試框架優先使用 Vitest，並對應規格草稿的 Given-When-Then 場景。
- 測試應能在功能尚未完成時失敗（red）；若無法先失敗請說明原因。
- 不要修改「禁止修改範圍」內的檔案，只修改「允許修改檔案」；需超出請先回報原因。`,
  implement: `請依上述資訊實作，這是 TDD 的 green phase：
- 依規格草稿與既有測試實作，只做讓測試通過所需的最小實作。
- 不要在 green phase 做額外重構，也不要擴大需求。
- 不要修改「禁止修改範圍」內的檔案，只修改「允許修改檔案」；需超出請先回報原因。`,
  refactor: `請依上述資訊重構，這是 TDD 的 refactor phase：
- 只有在測試已通過的前提下才重構，且不要改變既有行為、不要新增功能、不要擴大需求。
- 過程中保持所有測試持續通過。
- 不要修改「禁止修改範圍」內的檔案，只修改「允許修改檔案」；需超出請先回報原因。`,
  fix: `請依上述資訊修正：
- 根據驗收 / 審查結果修正，使測試與驗收條件通過。
- 不要擴大需求，不要修改「禁止修改範圍」內的檔案，只修改「允許修改檔案」；需超出請先回報原因。`,
};

/**
 * 依 mode 組出要餵給 AI CLI 的 prompt。
 * @param {TaskInput} task
 * @returns {string}
 */
function buildPrompt(task) {
  const context = buildContext(task);
  const instructions = MODE_INSTRUCTIONS[task.mode];
  return context ? `${context}\n\n${instructions}` : instructions;
}

/**
 * 依 targetFiles / forbiddenFiles 在 projectPath 下建立或更新 .ai-coding-relay/guard-rules.json。
 * @param {string} projectPath
 * @param {string[]} targetFiles
 * @param {string[]} forbiddenFiles
 * @returns {string} 寫入的檔案路徑
 */
function writeGuardRules(projectPath, targetFiles, forbiddenFiles) {
  const dir = join(projectPath, '.ai-coding-relay');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'guard-rules.json');
  writeFileSync(path, `${JSON.stringify({ targetFiles, forbiddenFiles }, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * 把 prompt 寫入 AI CLI 的 stdin 並執行；spawn 失敗不丟例外，改回傳 spawnError。
 * @param {string} aiCommand
 * @param {string} prompt
 * @param {string} cwd
 * @returns {Promise<AiResult>}
 */
function runAi(aiCommand, prompt, cwd) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
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
      resolve({ command: aiCommand, exitCode: null, stdout: '', stderr: '', durationMs: Date.now() - startedAt, spawnError: message });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      resolve({ command: aiCommand, exitCode: null, stdout, stderr, durationMs: Date.now() - startedAt, spawnError: err.message });
    });
    child.on('close', (code) => {
      resolve({ command: aiCommand, exitCode: code, stdout, stderr, durationMs: Date.now() - startedAt });
    });

    // 避免下游關閉 stdin 造成 EPIPE 讓整個 process crash
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * 執行目標專案的 scripts/run-verification.mjs（cwd = projectPath），回傳其 stdout / exit code。
 * run-verification 在 ok=false 時 exit 1，但仍輸出合法 JSON，因此只看 stdout、不依 exit code 判斷。
 * @param {string} scriptPath
 * @param {string} cwd
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, spawnError?: string }>}
 */
function runVerification(scriptPath, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(process.execPath, [scriptPath], { cwd, env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ exitCode: null, stdout: '', stderr: '', spawnError: message });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolve({ exitCode: null, stdout, stderr, spawnError: err.message }));
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
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
 * 從可能夾雜其他文字（進度訊息、log）的字串中，掃出所有「頂層平衡的 {...} 區段」。
 * 會正確略過字串字面值內的大括號，避免被 command stdout 內容誤判。
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
 * 從 run-verification.mjs 的 stdout 解析出 verification 物件。
 * 先嘗試整段直接 parse（乾淨輸出）；失敗時掃出所有頂層 JSON 物件，
 * 取「最後一個」看起來像 verification（含 commands 或 ok）的物件，容忍前後夾雜的進度訊息。
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
function parseVerificationJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;

  const candidates = extractBalancedObjects(trimmed);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = tryParseJsonObject(candidates[i]);
    if (obj && ('commands' in obj || 'ok' in obj)) return obj;
  }
  return null;
}

/**
 * 印出單一結果 JSON 到 stdout（永遠 exit 0，讓 stdout 保持乾淨可被解析）。
 * @param {Record<string, unknown>} report
 */
function output(report) {
  // stdout 為 pipe 時 write 是非同步的；在 flush callback 內才結束 process，
  // 避免大 JSON（含大段 verification stdout）在 buffer 排空前被 process.exit 截斷。
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => {
    process.exit(0);
  });
}

async function main() {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const base = () => ({ startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs });

  // 1. 讀取並解析任務 JSON
  const rawText = (await readStdin()).trim();
  if (!rawText) {
    output({ ok: false, mode: '', ...base(), ai: null, verification: null, stoppedReason: 'no_input', error: '沒有從 stdin 收到任務 JSON' });
    return;
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output({ ok: false, mode: '', ...base(), ai: null, verification: null, stoppedReason: 'invalid_json', error: `任務 JSON 解析失敗：${message}` });
    return;
  }

  /** @type {TaskInput} */
  let task;
  try {
    task = parseTask(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const mode = typeof parsed === 'object' && parsed !== null ? toStr(/** @type {Record<string, unknown>} */ (parsed).mode) : '';
    output({ ok: false, mode, ...base(), ai: null, verification: null, stoppedReason: 'invalid_input', error: message });
    return;
  }

  // 2. projectPath 必須存在
  if (!existsSync(task.projectPath)) {
    output({ ok: false, mode: task.mode, ...base(), ai: null, verification: null, stoppedReason: 'project_path_not_found', error: `projectPath 不存在：${task.projectPath}` });
    return;
  }

  // 3. 執行 AI 前，建立 / 更新 guard-rules.json
  try {
    writeGuardRules(task.projectPath, task.targetFiles, task.forbiddenFiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output({ ok: false, mode: task.mode, ...base(), ai: null, verification: null, stoppedReason: 'guard_rules_write_failed', error: `無法寫入 guard-rules.json：${message}` });
    return;
  }

  // 4. 呼叫 AI CLI（把 prompt 寫入 stdin）
  const prompt = buildPrompt(task);
  const ai = await runAi(task.aiCommand, prompt, task.projectPath);
  const aiOk = ai.exitCode === 0 && !ai.spawnError;

  // AI 完全無法啟動時不再跑驗證（不會有任何改動可驗）
  if (ai.spawnError) {
    output({ ok: false, mode: task.mode, ...base(), ai, verification: null, stoppedReason: 'ai_failed', error: `AI CLI 執行失敗：${ai.spawnError}` });
    return;
  }

  // 5. 執行目標專案的 run-verification.mjs，並從其 stdout 解析 verification JSON。
  //    腳本不存在 / spawn 失敗 / 輸出非合法 JSON 都不 crash，改成 verification=null 並記錄錯誤與原始 stdout。
  const verificationScript = join(task.projectPath, 'scripts', 'run-verification.mjs');

  /** @type {Record<string, unknown> | null} */
  let verification = null;
  let verificationParsed = false;
  let verificationError = '';
  let verificationStdout = '';

  if (!existsSync(verificationScript)) {
    verificationError = `找不到 run-verification.mjs：${verificationScript}`;
  } else {
    const verRun = await runVerification(verificationScript, task.projectPath);
    verificationStdout = verRun.stdout;
    if (verRun.spawnError) {
      verificationError = `run-verification.mjs 執行失敗：${verRun.spawnError}`;
    } else {
      const parsed = parseVerificationJson(verRun.stdout);
      if (parsed) {
        verification = parsed;
        verificationParsed = true;
      } else {
        const detail = verRun.stderr.trim() ? `：${verRun.stderr.trim()}` : '';
        verificationError = `run-verification.mjs 輸出非合法 verification JSON${detail}`;
      }
    }
  }

  // 6. 彙整整體 ok 與 stoppedReason
  /** @type {string[]} */
  const reasons = [];
  let ok = true;
  if (!aiOk) { ok = false; reasons.push('ai_failed'); }

  if (!verificationParsed) {
    ok = false;
    reasons.push('verification_unavailable');
  } else {
    const ver = /** @type {Record<string, unknown>} */ (verification);
    if (ver.ok !== true) { ok = false; reasons.push('verification_failed'); }
    const fg = ver.fileGuard;
    if (typeof fg === 'object' && fg !== null && /** @type {Record<string, unknown>} */ (fg).ok === false) {
      ok = false;
      reasons.push('file_guard_failed');
    }
  }

  /** @type {Record<string, unknown>} */
  const report = { ok, mode: task.mode, ...base(), ai, verification };
  if (reasons.length > 0) report.stoppedReason = reasons.join(',');
  // 解析失敗時保留錯誤訊息與原始 stdout，方便 debug（成功時不夾帶以保持結果精簡）。
  if (!verificationParsed) {
    if (verificationError) report.verificationError = verificationError;
    if (verificationStdout.trim()) report.verificationStdout = verificationStdout;
  }
  output(report);
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // 透過 output() 以 flush-safe 方式輸出，避免 fatal 訊息也被截斷。
  output({ ok: false, mode: '', stoppedReason: 'fatal', error: message });
});
