#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const GUARD_RULES_PATH = join(PROJECT_ROOT, '.ai-coding-relay', 'guard-rules.json');
const GUARD_SCRIPT_PATH = join(__dirname, 'check-file-guard.mjs');

/**
 * @typedef {Object} FileGuardResult
 * @property {boolean} ok
 * @property {string[]} modifiedFiles
 * @property {string[]} targetFiles
 * @property {string[]} forbiddenFiles
 * @property {{ type: string, file: string }[]} violations
 * @property {string} [error]
 */

/**
 * @typedef {Object} CommandResult
 * @property {string} name
 * @property {string} command
 * @property {number | null} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} durationMs
 * @property {boolean} ok
 * @property {boolean} required
 */

/**
 * @typedef {Object} TaskSpec
 * @property {string} name
 * @property {string} command
 * @property {string[]} args
 * @property {boolean} required
 */

/**
 * @param {TaskSpec} task
 * @returns {Promise<CommandResult>}
 */
function runCommand(task) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const displayCommand = [task.command, ...task.args].join(' ');
    let stdout = '';
    let stderr = '';

    let child;
    try {
      child = spawn(task.command, task.args, {
        shell: false,
        env: process.env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        name: task.name,
        command: displayCommand,
        exitCode: null,
        stdout: '',
        stderr: `[spawn threw] ${message}`,
        durationMs: Date.now() - startedAt,
        ok: false,
        required: task.required,
      });
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      resolve({
        name: task.name,
        command: displayCommand,
        exitCode: null,
        stdout,
        stderr: `${stderr}${stderr ? '\n' : ''}[spawn error] ${err.message}`,
        durationMs: Date.now() - startedAt,
        ok: false,
        required: task.required,
      });
    });

    child.on('close', (code) => {
      resolve({
        name: task.name,
        command: displayCommand,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ok: code === 0,
        required: task.required,
      });
    });
  });
}

/**
 * 把 guard-rules.json 的內容餵給 check-file-guard.mjs（stdin），回傳它輸出的 fileGuard 結果。
 * check-file-guard 在有 violation 時 exit 1，但仍輸出合法 JSON，因此這裡只看 stdout、不看 exit code。
 * @param {string} guardScriptPath
 * @param {string} rulesContent
 * @returns {Promise<FileGuardResult>}
 */
function runFileGuard(guardScriptPath, rulesContent) {
  return new Promise((resolve) => {
    /** @returns {FileGuardResult} */
    const errorResult = (error) => ({
      ok: false,
      modifiedFiles: [],
      targetFiles: [],
      forbiddenFiles: [],
      violations: [],
      error,
    });

    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(process.execPath, [guardScriptPath], { env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve(errorResult(`無法執行 file guard：${message}`));
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => resolve(errorResult(`file guard 執行失敗：${err.message}`)));
    child.on('close', () => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        const detail = stderr.trim() ? `：${stderr.trim()}` : '';
        resolve(errorResult(`file guard 沒有輸出${detail}`));
        return;
      }
      try {
        resolve(/** @type {FileGuardResult} */ (JSON.parse(trimmed)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve(errorResult(`file guard 輸出非合法 JSON：${message}`));
      }
    });

    // 避免下游關閉時造成 EPIPE 讓整個 process crash
    child.stdin.on('error', () => {});
    child.stdin.write(rulesContent);
    child.stdin.end();
  });
}

/**
 * 若專案根目錄存在 .ai-coding-relay/guard-rules.json，執行 file guard 並回傳結果；
 * 不存在則回傳 undefined（verification JSON 不包含 fileGuard）。
 * @returns {Promise<FileGuardResult | undefined>}
 */
async function runOptionalFileGuard() {
  if (!existsSync(GUARD_RULES_PATH)) {
    return undefined;
  }

  let rulesContent;
  try {
    rulesContent = readFileSync(GUARD_RULES_PATH, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      modifiedFiles: [],
      targetFiles: [],
      forbiddenFiles: [],
      violations: [],
      error: `無法讀取 guard-rules.json：${message}`,
    };
  }

  return runFileGuard(GUARD_SCRIPT_PATH, rulesContent);
}

async function main() {
  const startedAt = new Date();
  const startedAtMs = Date.now();

  /** @type {TaskSpec[]} */
  const tasks = [
    { name: 'tsc', command: 'npx', args: ['tsc', '--noEmit'], required: true },
    { name: 'test', command: 'pnpm', args: ['test:run'], required: true },
    { name: 'build', command: 'pnpm', args: ['build'], required: true },
    { name: 'git-status', command: 'git', args: ['status', '--short'], required: false },
    { name: 'git-diff', command: 'git', args: ['diff', '--stat'], required: false },
  ];

  /** @type {CommandResult[]} */
  const commands = [];
  let ok = true;

  for (const task of tasks) {
    const result = await runCommand(task);
    commands.push(result);
    if (task.required && !result.ok) {
      ok = false;
    }
  }

  // 選擇性的 file guard：存在 .ai-coding-relay/guard-rules.json 時才執行。
  // guard 失敗（格式錯誤 / violations / git 失敗）會讓整體 ok 變成 false。
  const fileGuard = await runOptionalFileGuard();
  if (fileGuard && !fileGuard.ok) {
    ok = false;
  }

  const finishedAt = new Date();
  /** @type {{ ok: boolean, startedAt: string, finishedAt: string, durationMs: number, commands: CommandResult[], fileGuard?: FileGuardResult }} */
  const report = {
    ok,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - startedAtMs,
    commands,
  };
  if (fileGuard !== undefined) {
    report.fileGuard = fileGuard;
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(2);
});
