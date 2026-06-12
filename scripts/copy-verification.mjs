#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN_VERIFICATION_PATH = join(__dirname, 'run-verification.mjs');

/**
 * @typedef {Object} ClipboardCandidate
 * @property {string} cmd
 * @property {string[]} args
 */

/**
 * 執行既有的 run-verification.mjs，回傳它寫到 stdout 的內容。
 * run-verification 失敗時 exit code 為 1，但仍會輸出合法 JSON，
 * 因此這裡不依 exit code 判斷成敗，只收集 stdout / stderr。
 * @param {string} scriptPath
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runVerification(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * 依平台回傳要嘗試的剪貼簿工具清單（依序嘗試）。
 * @returns {ClipboardCandidate[]}
 */
function getClipboardCandidates() {
  switch (process.platform) {
    case 'darwin':
      return [{ cmd: 'pbcopy', args: [] }];
    case 'win32':
      return [{ cmd: 'clip', args: [] }];
    default:
      return [
        { cmd: 'xclip', args: ['-selection', 'clipboard'] },
        { cmd: 'xsel', args: ['--clipboard', '--input'] },
      ];
  }
}

/**
 * 嘗試用單一工具把文字寫入剪貼簿。
 * @param {string} text
 * @param {ClipboardCandidate} cand
 * @returns {Promise<void>}
 */
function tryCopy(text, cand) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cand.cmd, cand.args);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cand.cmd} 以結束碼 ${code} 結束`));
    });
    // 避免下游關閉時造成 EPIPE 讓整個 process crash
    child.stdin.on('error', () => {});
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * 依平台嘗試把文字複製到系統剪貼簿；都失敗時丟出友善錯誤。
 * @param {string} text
 * @returns {Promise<string>} 成功使用的工具名稱
 */
async function copyToClipboard(text) {
  const candidates = getClipboardCandidates();
  /** @type {string[]} */
  const errors = [];

  for (const cand of candidates) {
    try {
      await tryCopy(text, cand);
      return cand.cmd;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${cand.cmd}：${message}`);
    }
  }

  const hint =
    process.platform === 'linux'
      ? '請安裝 xclip 或 xsel（例如：sudo apt install xclip）。'
      : process.platform === 'darwin'
        ? '找不到 pbcopy，請確認在 macOS 環境執行。'
        : process.platform === 'win32'
          ? '找不到 clip，請確認在 Windows 環境執行。'
          : '找不到可用的剪貼簿工具。';

  throw new Error(`無法複製到剪貼簿：${hint}\n嘗試過：\n${errors.map((e) => `  - ${e}`).join('\n')}`);
}

async function main() {
  // 1~3. 執行 run-verification.mjs 並取得它的 stdout
  const { code, stdout, stderr } = await runVerification(RUN_VERIFICATION_PATH);

  // 4. 驗證輸出是合法 JSON
  const trimmed = stdout.trim();
  if (!trimmed) {
    const detail = stderr.trim() ? `\n${stderr.trim()}` : '';
    throw new Error(`run-verification.mjs 沒有輸出任何內容（exit code ${code}）。${detail}`);
  }

  /** @type {unknown} */
  let report;
  try {
    report = JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`run-verification.mjs 的輸出不是合法 JSON：${message}`);
  }

  if (typeof report !== 'object' || report === null || !Array.isArray(report.commands)) {
    throw new Error('run-verification.mjs 的輸出缺少 commands 陣列，格式不符。');
  }

  // 5~8. 複製完整 JSON 到剪貼簿（依平台選擇工具）
  const tool = await copyToClipboard(trimmed);

  // 9. 顯示簡短摘要
  const commands = report.commands;
  const failed = commands
    .filter((c) => c && typeof c === 'object' && c.ok === false)
    .map((c) => c.name);

  console.log(`✓ 已複製 verification JSON 到剪貼簿（${tool}，${trimmed.length} 字元）`);
  console.log('');
  console.log(`  ok:        ${report.ok}`);
  console.log(`  commands:  ${commands.length}`);
  console.log(`  failed:    ${failed.length > 0 ? failed.join(', ') : '（無）'}`);
  console.log(`  durationMs: ${typeof report.durationMs === 'number' ? report.durationMs : '—'}`);
  console.log('');
  console.log('現在可以到 UI 的「匯入驗證結果」直接貼上。');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
