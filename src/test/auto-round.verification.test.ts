import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 針對 scripts/auto-round.mjs 的 verification 解析行為做整合測試（Phase 48）。
 * 用「fake project」模擬目標專案的 scripts/run-verification.mjs，aiCommand 用 `node --version`
 * 等本機指令取代真正的 AI CLI，因此完全不呼叫 Claude/Codex，且結果穩定可重現。
 */

const AUTO_ROUND_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "auto-round.mjs"
);

type AutoRoundResult = {
  ok: boolean;
  mode: string;
  ai: { exitCode: number | null } | null;
  verification: Record<string, unknown> | null;
  stoppedReason?: string;
  verificationError?: string;
  verificationStdout?: string;
};

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 建立一個臨時 fake project。
 * verificationStdout 為 undefined 時「不」建立 scripts/run-verification.mjs（模擬腳本不存在）。
 */
function makeFakeProject(opts: { verificationStdout?: string; exitCode?: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-round-test-"));
  createdDirs.push(dir);
  if (opts.verificationStdout !== undefined) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // 這支 fake run-verification 只把固定字串寫到 stdout 再 exit，不跑任何真實指令。
    const script = `process.stdout.write(${JSON.stringify(opts.verificationStdout)});\nprocess.exit(${opts.exitCode ?? 0});\n`;
    writeFileSync(join(dir, "scripts", "run-verification.mjs"), script, "utf8");
  }
  return dir;
}

/** 組一份合法的 verification 報告 JSON（可選擇是否帶 fileGuard）。 */
function verificationReport(opts: { ok: boolean; fileGuardOk?: boolean }): string {
  const report: Record<string, unknown> = {
    ok: opts.ok,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    commands: [
      {
        name: "tsc",
        command: "npx tsc --noEmit",
        exitCode: opts.ok ? 0 : 1,
        stdout: "",
        stderr: "",
        durationMs: 500,
        ok: opts.ok,
        required: true,
      },
    ],
  };
  if (opts.fileGuardOk !== undefined) {
    report.fileGuard = {
      ok: opts.fileGuardOk,
      modifiedFiles: ["docs/harness-architecture.md"],
      targetFiles: ["docs/harness-architecture.md"],
      forbiddenFiles: [],
      violations: opts.fileGuardOk ? [] : [{ type: "forbidden", file: "package.json" }],
    };
  }
  return JSON.stringify(report, null, 2);
}

/** 以子行程跑 auto-round.mjs，把 task JSON 餵 stdin，解析它印出的結果 JSON。 */
function runAutoRound(task: Record<string, unknown>): Promise<AutoRoundResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUTO_ROUND_PATH], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as AutoRoundResult);
      } catch {
        reject(new Error(`auto-round 輸出無法解析。stderr=${stderr}\nstdout=${stdout}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(task));
    child.stdin.end();
  });
}

/** 預設 task：aiCommand 用 `node --version`（exit 0），不會呼叫真正的 AI。 */
function baseTask(projectPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "auto-round verification test",
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

describe("auto-round verification 解析", () => {
  it("run-verification 回傳 ok=true 合法 JSON → auto-round ok=true 且 verification.commands 存在", async () => {
    const dir = makeFakeProject({ verificationStdout: verificationReport({ ok: true }), exitCode: 0 });
    const result = await runAutoRound(baseTask(dir));
    expect(result.ok).toBe(true);
    expect(result.verification).not.toBeNull();
    expect(result.verification?.ok).toBe(true);
    expect(Array.isArray(result.verification?.commands)).toBe(true);
    expect(result.stoppedReason).toBeUndefined();
  });

  it("run-verification stdout 夾雜進度訊息時仍能解析出 verification（修正 verification_unavailable）", async () => {
    const noisy = `[info] running tsc...\n[info] running tests...\n${verificationReport({ ok: true })}\n[info] done\n`;
    const dir = makeFakeProject({ verificationStdout: noisy, exitCode: 0 });
    const result = await runAutoRound(baseTask(dir));
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.verification?.commands)).toBe(true);
    expect(result.stoppedReason).toBeUndefined();
  });

  it("run-verification.mjs 不存在 → ok=false、verification=null、stoppedReason 含 verification_unavailable", async () => {
    const dir = makeFakeProject({}); // 不建立 run-verification.mjs
    const result = await runAutoRound(baseTask(dir));
    expect(result.ok).toBe(false);
    expect(result.verification).toBeNull();
    expect(result.stoppedReason ?? "").toContain("verification_unavailable");
    expect(result.verificationError ?? "").toContain("run-verification");
  });

  it("run-verification 輸出非法 JSON → stoppedReason 含 verification_unavailable，且保留 stdout 供 debug", async () => {
    const dir = makeFakeProject({ verificationStdout: "not json at all {oops", exitCode: 0 });
    const result = await runAutoRound(baseTask(dir));
    expect(result.ok).toBe(false);
    expect(result.verification).toBeNull();
    expect(result.stoppedReason ?? "").toContain("verification_unavailable");
    expect(result.verificationStdout ?? "").toContain("not json at all");
  });

  it("verification.ok=false → auto-round ok=false 且 stoppedReason 含 verification_failed", async () => {
    const dir = makeFakeProject({ verificationStdout: verificationReport({ ok: false }), exitCode: 1 });
    const result = await runAutoRound(baseTask(dir));
    expect(result.ok).toBe(false);
    expect(result.verification?.ok).toBe(false);
    expect(result.stoppedReason ?? "").toContain("verification_failed");
  });

  it("fileGuard.ok=false → auto-round ok=false 且 stoppedReason 含 file_guard_failed", async () => {
    const dir = makeFakeProject({
      verificationStdout: verificationReport({ ok: true, fileGuardOk: false }),
      exitCode: 0,
    });
    const result = await runAutoRound(baseTask(dir));
    expect(result.ok).toBe(false);
    expect(result.stoppedReason ?? "").toContain("file_guard_failed");
  });

  it("AI exitCode !== 0 → auto-round ok=false 且 stoppedReason 含 ai_failed", async () => {
    const dir = makeFakeProject({ verificationStdout: verificationReport({ ok: true }), exitCode: 0 });
    const result = await runAutoRound(baseTask(dir, { aiCommand: "node -e process.exit(3)" }));
    expect(result.ok).toBe(false);
    expect(result.ai?.exitCode).toBe(3);
    expect(result.stoppedReason ?? "").toContain("ai_failed");
  });
});
