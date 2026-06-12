#!/usr/bin/env node
// auto-spec：依任務 JSON 產生 Spec Prompt，呼叫 AI CLI，把 AI 的 stdout 當作 specDraft 輸出。
// 第一版只做 CLI，不接 UI、不自動 commit / push。stdout 只輸出單一合法 JSON。
import { spawn } from 'node:child_process';

/**
 * @typedef {Object} TaskInput
 * @property {string} title
 * @property {string} projectPath
 * @property {string} originalRequirement
 * @property {string[]} targetFiles
 * @property {string[]} forbiddenFiles
 * @property {string[]} constraints
 * @property {string[]} acceptanceCriteria
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

const SPEC_PROMPT_INSTRUCTIONS = `請依上述資訊，產生一份結構化規格草稿（specDraft），格式如下：

## 功能範圍

## 規則

## API / UI 設計

## Given-When-Then 場景

Scenario:
Given
When
Then

## 不在範圍

注意事項：
- 不要實作程式碼，只產生規格草稿（specDraft）。
- 不要擴大需求範圍，只根據上述資訊撰寫。
- 不確定的地方請另外列出「待確認問題」，不要自行假設。
- 直接輸出規格草稿內容本身，不要加開場白或結尾語。`;

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
 * 解析並驗證任務 JSON；缺少必要欄位時丟出帶訊息的錯誤。
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

  const aiCommand = toStr(obj.aiCommand).trim();
  if (!aiCommand) throw new Error('缺少必要欄位：aiCommand');

  return {
    title: toStr(obj.title),
    projectPath,
    originalRequirement: toStr(obj.originalRequirement),
    targetFiles: toStrArray(obj.targetFiles),
    forbiddenFiles: toStrArray(obj.forbiddenFiles),
    constraints: toStrArray(obj.constraints),
    acceptanceCriteria: toStrArray(obj.acceptanceCriteria),
    aiCommand,
  };
}

/**
 * 依任務內容組出 Spec Prompt，空欄位略過、陣列以條列輸出。
 * @param {TaskInput} task
 * @returns {string}
 */
function buildSpecPrompt(task) {
  const sections = ['請幫我把以下任務的粗需求，整理成一份可驗證的結構化規格草稿。'];

  if (task.title.trim()) sections.push(`任務標題：\n${task.title.trim()}`);
  if (task.originalRequirement.trim()) sections.push(`原始需求：\n${task.originalRequirement.trim()}`);
  if (task.targetFiles.length > 0) sections.push(`允許修改檔案：\n${task.targetFiles.map((f) => `- ${f}`).join('\n')}`);
  if (task.forbiddenFiles.length > 0) sections.push(`禁止修改範圍：\n${task.forbiddenFiles.map((f) => `- ${f}`).join('\n')}`);
  if (task.constraints.length > 0) sections.push(`限制條件：\n${task.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  if (task.acceptanceCriteria.length > 0) sections.push(`驗收條件：\n${task.acceptanceCriteria.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);

  sections.push(SPEC_PROMPT_INSTRUCTIONS);
  return sections.join('\n\n');
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
 * 印出單一結果 JSON 到 stdout（永遠 exit 0，讓 stdout 保持乾淨可被解析）。
 * @param {Record<string, unknown>} report
 */
function output(report) {
  // stdout 為 pipe 時 write 是非同步的；在 flush callback 內才結束 process，
  // 避免大 JSON（specDraft / ai.stdout 可能很大）在 buffer 排空前被 process.exit 截斷。
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
    output({ ok: false, ...base(), ai: null, specDraft: '', stoppedReason: 'no_input', error: '沒有從 stdin 收到任務 JSON' });
    return;
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output({ ok: false, ...base(), ai: null, specDraft: '', stoppedReason: 'invalid_json', error: `任務 JSON 解析失敗：${message}` });
    return;
  }

  /** @type {TaskInput} */
  let task;
  try {
    task = parseTask(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output({ ok: false, ...base(), ai: null, specDraft: '', stoppedReason: 'invalid_input', error: message });
    return;
  }

  // 2. 產生 Spec Prompt 並呼叫 AI CLI
  const prompt = buildSpecPrompt(task);
  const ai = await runAi(task.aiCommand, prompt, task.projectPath);

  if (ai.spawnError) {
    output({ ok: false, ...base(), ai, specDraft: '', stoppedReason: 'ai_failed', error: `AI CLI 執行失敗：${ai.spawnError}` });
    return;
  }

  const aiOk = ai.exitCode === 0;
  const specDraft = ai.stdout.trim();

  /** @type {Record<string, unknown>} */
  const report = { ok: aiOk, ...base(), ai, specDraft };
  if (!aiOk) report.stoppedReason = 'ai_failed';
  output(report);
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // 透過 output() 以 flush-safe 方式輸出，避免 fatal 訊息也被截斷。
  output({ ok: false, ai: null, specDraft: '', stoppedReason: 'fatal', error: message });
});
