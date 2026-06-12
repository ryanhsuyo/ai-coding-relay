import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 58：驗證 auto-round / auto-loop / auto-spec 在「輸出很大的 JSON」時，
 * 經由 child_process pipe 擷取 stdout 仍可被完整 JSON.parse、內容不被截斷。
 *
 * 背景：這些腳本原本 `process.stdout.write(json); process.exit(0)`，stdout 是 pipe 時
 * write 為非同步，process.exit 會在 buffer flush 完成前結束 process，導致大 JSON 被截斷
 * （Phase 57 實測：auto-round 結果被截到 ~8KB → UI 匯入失敗）。修法為在 write 的 flush
 * callback 內才結束 process。本測試以遠超 pipe buffer（64KB）的輸出，確保截斷會被偵測到。
 */

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
const AUTO_ROUND_PATH = join(SCRIPTS_DIR, "auto-round.mjs");
const AUTO_LOOP_PATH = join(SCRIPTS_DIR, "auto-loop.mjs");
const AUTO_SPEC_PATH = join(SCRIPTS_DIR, "auto-spec.mjs");

// 遠大於典型 pipe buffer（macOS/Linux 約 64KB），確保 buggy 版本一定會截斷、測試能抓到。
const BIG_LEN = 500_000;
const END_MARKER = "__END_OF_BIG_STDOUT__";
const BIG_STDOUT = "x".repeat(BIG_LEN) + END_MARKER;

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** 組一份「verification 報告」JSON，其中 test 指令的 stdout 故意非常大。 */
function bigVerificationReport(): string {
  const report = {
    ok: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    commands: [
      { name: "tsc", command: "npx tsc --noEmit", exitCode: 0, ok: true, required: true, stdout: "", stderr: "", durationMs: 100 },
      { name: "test", command: "node --test", exitCode: 0, ok: true, required: true, stdout: BIG_STDOUT, stderr: "", durationMs: 200 },
      { name: "git-status", command: "git status --short", exitCode: 0, ok: true, required: false, stdout: "", stderr: "", durationMs: 10 },
      { name: "git-diff", command: "git diff --stat", exitCode: 0, ok: true, required: false, stdout: "", stderr: "", durationMs: 10 },
    ],
  };
  return JSON.stringify(report, null, 2);
}

/**
 * 建立 fake project，內含一支 flush-safe 的 run-verification.mjs（用 write callback 才結束），
 * 確保它能可靠地把「大 verification JSON」交付給 auto-round —— 把測試焦點隔離在被測腳本自己的輸出行為。
 */
function makeFakeProject(verificationStdout: string): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-flush-test-"));
  createdDirs.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const script = `process.stdout.write(${JSON.stringify(verificationStdout)}, () => { process.exit(0); });\n`;
  writeFileSync(join(dir, "scripts", "run-verification.mjs"), script, "utf8");
  return dir;
}

/** 建立一支 flush-safe 的 fake AI 腳本，輸出很大的 stdout，回傳其路徑（供 aiCommand 使用）。 */
function makeBigAiScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-flush-ai-"));
  createdDirs.push(dir);
  const path = join(dir, "big-ai.mjs");
  const script = `process.stdout.write(${JSON.stringify(BIG_STDOUT)}, () => { process.exit(0); });\n`;
  writeFileSync(path, script, "utf8");
  return path;
}

type SpawnCapture = { stdout: string; stderr: string };

/** 以子行程跑指定腳本，把 task JSON 餵 stdin，透過 pipe 擷取 stdout/stderr（不在這裡解析）。 */
function runScript(scriptPath: string, task: Record<string, unknown>): Promise<SpawnCapture> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(task));
    child.stdin.end();
  });
}

function baseTask(projectPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "flush test",
    projectPath,
    originalRequirement: "n/a",
    specDraft: "",
    targetFiles: [],
    forbiddenFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    mode: "implement",
    aiCommand: "node --version",
    ...overrides,
  };
}

describe("auto scripts 大輸出不截斷（Phase 58）", () => {
  it("auto-round：verification stdout 很大時，結果 JSON 仍可完整解析且 commands 不被截斷", async () => {
    const dir = makeFakeProject(bigVerificationReport());
    const { stdout, stderr } = await runScript(AUTO_ROUND_PATH, baseTask(dir));

    // 1. 收到的位元數應 >> pipe buffer（證明確實是大輸出情境）。
    expect(stdout.length).toBeGreaterThan(BIG_LEN);

    // 2. stdout 必須是單一合法 JSON（截斷會在這裡丟錯）。
    let parsed: Record<string, unknown>;
    expect(() => { parsed = JSON.parse(stdout.trim()); }).not.toThrow(
      `auto-round 輸出無法完整解析（疑似截斷）。bytes=${stdout.length} stderr=${stderr}`
    );
    parsed = JSON.parse(stdout.trim());

    // 3. verification / commands 沒有被截斷：大 stdout 完整保留（含結尾 marker）。
    const verification = parsed.verification as { ok: boolean; commands: { name: string; stdout: string }[] };
    expect(verification).toBeTruthy();
    expect(Array.isArray(verification.commands)).toBe(true);
    const testCmd = verification.commands.find((c) => c.name === "test");
    expect(testCmd).toBeTruthy();
    expect(testCmd?.stdout.length).toBe(BIG_STDOUT.length);
    expect(testCmd?.stdout.endsWith(END_MARKER)).toBe(true);
  });

  it("auto-loop：內嵌大 verification 的回合，結果 JSON 仍可完整解析且 rounds 不被截斷", async () => {
    const dir = makeFakeProject(bigVerificationReport());
    // autoApprove=false → 只跑一輪；該輪 verification 很大，auto-loop 必須完整輸出 rounds[]。
    const task = baseTask(dir, { workflowStage: "green_implement", maxRounds: 3, autoApprove: false });
    const { stdout, stderr } = await runScript(AUTO_LOOP_PATH, task);

    expect(stdout.length).toBeGreaterThan(BIG_LEN);

    let parsed: Record<string, unknown>;
    expect(() => { parsed = JSON.parse(stdout.trim()); }).not.toThrow(
      `auto-loop 輸出無法完整解析（疑似截斷）。bytes=${stdout.length} stderr=${stderr}`
    );
    parsed = JSON.parse(stdout.trim());

    const rounds = parsed.rounds as { verification: { commands: { name: string; stdout: string }[] } | null }[];
    expect(Array.isArray(rounds)).toBe(true);
    expect(rounds.length).toBeGreaterThanOrEqual(1);
    const testCmd = rounds[0].verification?.commands.find((c) => c.name === "test");
    expect(testCmd?.stdout.length).toBe(BIG_STDOUT.length);
    expect(testCmd?.stdout.endsWith(END_MARKER)).toBe(true);
  });

  it("auto-spec：AI stdout 很大時，結果 JSON 仍可完整解析且 specDraft 不被截斷", async () => {
    const aiScript = makeBigAiScript();
    // 不需要 fake project 的 run-verification（auto-spec 不跑驗證）；projectPath 用暫存目錄即可。
    const dir = mkdtempSync(join(tmpdir(), "auto-spec-proj-"));
    createdDirs.push(dir);
    const task = baseTask(dir, { aiCommand: `${process.execPath} ${aiScript}` });
    const { stdout, stderr } = await runScript(AUTO_SPEC_PATH, task);

    expect(stdout.length).toBeGreaterThan(BIG_LEN);

    let parsed: Record<string, unknown>;
    expect(() => { parsed = JSON.parse(stdout.trim()); }).not.toThrow(
      `auto-spec 輸出無法完整解析（疑似截斷）。bytes=${stdout.length} stderr=${stderr}`
    );
    parsed = JSON.parse(stdout.trim());

    const specDraft = parsed.specDraft as string;
    expect(typeof specDraft).toBe("string");
    expect(specDraft.length).toBe(BIG_STDOUT.length);
    expect(specDraft.endsWith(END_MARKER)).toBe(true);
  });
});
