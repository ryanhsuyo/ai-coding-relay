#!/usr/bin/env node
import { spawn } from 'node:child_process';

/**
 * @typedef {Object} Rules
 * @property {string[]} targetFiles
 * @property {string[]} forbiddenFiles
 */

/**
 * @typedef {Object} Violation
 * @property {"forbidden" | "outside_target"} type
 * @property {string} file
 */

/**
 * @typedef {Object} GuardReport
 * @property {boolean} ok
 * @property {string[]} modifiedFiles
 * @property {string[]} targetFiles
 * @property {string[]} forbiddenFiles
 * @property {Violation[]} violations
 * @property {string} [error]
 */

/** 把任意值正規化成去空白、去重複的字串陣列。 */
function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * 解析從 stdin 讀到的規則 JSON；格式不符會丟出錯誤。
 * @param {string} raw
 * @returns {Rules}
 */
function parseRules(raw) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`stdin 不是合法 JSON：${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('規則格式錯誤：應為包含 targetFiles / forbiddenFiles 的物件');
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  return {
    targetFiles: toStringArray(obj.targetFiles),
    forbiddenFiles: toStringArray(obj.forbiddenFiles),
  };
}

/** 讀取整個 stdin 內容。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', (err) => reject(err));
  });
}

/**
 * 執行 `git diff --name-only`，回傳目前 modified files。
 * git 失敗時不丟例外，改回傳 { ok:false, error }，讓主流程輸出 ok:false。
 * @returns {Promise<{ ok: boolean, files: string[], error?: string }>}
 */
function gitDiffNameOnly() {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('git', ['diff', '--name-only'], { env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ ok: false, files: [], error: `git 無法執行：${message}` });
      return;
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, files: [], error: `git 執行失敗：${err.message}` });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() ? `：${stderr.trim()}` : '';
        resolve({ ok: false, files: [], error: `git diff 以結束碼 ${code} 結束${detail}` });
        return;
      }
      const files = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      resolve({ ok: true, files });
    });
  });
}

/**
 * 寫出 JSON 報告到 stdout 後，以指定碼結束（透過 callback 確保已 flush）。
 * @param {GuardReport} report
 * @param {number} code
 */
function finish(report, code) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(code));
}

async function main() {
  // 1~3. 從 stdin 讀取並解析規則
  const input = await readStdin();
  if (!input.trim()) {
    finish(
      { ok: false, modifiedFiles: [], targetFiles: [], forbiddenFiles: [], violations: [], error: '沒有從 stdin 收到任何規則 JSON' },
      1
    );
    return;
  }

  /** @type {Rules} */
  let rules;
  try {
    rules = parseRules(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish({ ok: false, modifiedFiles: [], targetFiles: [], forbiddenFiles: [], violations: [], error: message }, 1);
    return;
  }

  // 4. 取得目前 modified files
  const git = await gitDiffNameOnly();
  if (!git.ok) {
    finish(
      {
        ok: false,
        modifiedFiles: [],
        targetFiles: rules.targetFiles,
        forbiddenFiles: rules.forbiddenFiles,
        violations: [],
        error: git.error,
      },
      1
    );
    return;
  }

  const modifiedFiles = git.files;
  const forbiddenSet = new Set(rules.forbiddenFiles);
  const targetSet = new Set(rules.targetFiles);
  const hasTarget = rules.targetFiles.length > 0;

  /** @type {Violation[]} */
  const violations = [];
  for (const file of modifiedFiles) {
    // 5. 改到 forbiddenFiles → forbidden violation（優先，不再重複報 outside_target）
    if (forbiddenSet.has(file)) {
      violations.push({ type: 'forbidden', file });
      continue;
    }
    // 6~7. targetFiles 非空時，不在 targetFiles 內 → outside_target violation
    if (hasTarget && !targetSet.has(file)) {
      violations.push({ type: 'outside_target', file });
    }
  }

  const ok = violations.length === 0;
  finish(
    {
      ok,
      modifiedFiles,
      targetFiles: rules.targetFiles,
      forbiddenFiles: rules.forbiddenFiles,
      violations,
    },
    ok ? 0 : 1
  );
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  finish({ ok: false, modifiedFiles: [], targetFiles: [], forbiddenFiles: [], violations: [], error: `[fatal] ${message}` }, 1);
});
