import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// 直接匯入 runner 內部的 runScript / buildInvalidJsonError 做函式層測試：真實 auto-* 腳本永遠輸出合法
// JSON，無法經由 HTTP 觸發「壞 JSON」分支，故以暫存腳本驅動 runScript 來驗證 JSON 防禦。
// （e2e/ 不在 tsconfig include 內，import .mjs 不影響 tsc --noEmit。）
import {
  runScript,
  buildInvalidJsonError,
  buildCeReadonlyWorkflowPrompt,
  parseCeReadonlyWorkflowJson,
  extractCeReadonlyWorkflowResult,
  runCeReadonlyWorkflow,
  captureReadonlySnapshot,
  readonlySnapshotsEqual,
  buildCeWorkPrompt,
  parseCeWorkJson,
  runCeWorkWorkflow,
  extractVerificationResult,
  buildCeReviewPrompt,
  parseCeReviewJson,
  runCeReviewWorkflow,
  buildCeFixWorkPrompt,
  parseCeFixWorkJson,
  runCeFixWorkWorkflow,
  runCeCommitCheckpoint,
  parsePorcelainStatus,
  isExcludedCommitPath,
} from "../scripts/local-runner.mjs";

/**
 * 驗證 scripts/local-runner.mjs 的 endpoint 白名單行為（含 GET /health），以及 UI 一鍵執行按鈕與
 * Runner 狀態顯示。
 *
 * - Endpoint 測試：以自訂 PORT 啟動 runner，用 Playwright 的 request fixture 直接打 HTTP，
 *   送「無效 task JSON」讓 auto-* 腳本在驗證階段就回傳錯誤 JSON，因此不會真的呼叫 Claude/Codex。
 * - UI 未連線測試：用 route.abort 模擬「runner 未啟動」，驗證執行按鈕 alert 與狀態顯示未連線。
 * - UI 已連線測試：在 4318 實際啟動一個 runner，驗證狀態顯示已連線與 endpoints。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "..", "scripts", "local-runner.mjs");

// 用非預設 PORT，避免和使用者本機可能已啟動的 4318 runner 衝突。
const RUNNER_PORT = 43187;
const RUNNER_BASE = `http://127.0.0.1:${RUNNER_PORT}`;

let runner: ChildProcess | null = null;

test.beforeAll(async () => {
  runner = spawn(process.execPath, [RUNNER_PATH], {
    env: { ...process.env, RUNNER_PORT: String(RUNNER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 等 runner 印出「已啟動」訊息後再開始打 endpoint。
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("local-runner 啟動逾時")), 10_000);
    runner?.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("已啟動")) {
        clearTimeout(timer);
        resolve();
      }
    });
    runner?.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
});

test.afterAll(() => {
  if (runner && !runner.killed) runner.kill();
});

/** 送一份「缺 projectPath」的無效 task，腳本會在驗證階段就回錯誤 JSON，不會呼叫 AI CLI。 */
const INVALID_TASK = { title: "PHASE46 endpoint 測試", mode: "implement" } as const;

/** 輪詢直到 GET url 回 200（或逾時）；用於等 4318 runner 起來。 */
async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 還沒起來，稍候再試
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`等待 ${url} 逾時`);
}

// --- preflight 用的 fake project 工具：建立臨時專案，測試結束後清除 ---

const createdDirs: string[] = [];

test.afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** 在 dir 同步執行固定的 git 子指令（測試 setup 用）。 */
function git(dir: string, args: string[]): void {
  spawnSync("git", args, { cwd: dir, encoding: "utf8" });
}

type FakeProjectOptions = {
  gitInit?: boolean;
  withPackageJson?: boolean;
  verifyLocal?: boolean;
  /** undefined：不建立 run-verification；否則建立並讓它輸出對應 ok 值的 JSON。 */
  runVerificationOk?: boolean;
  /** Phase 77C：建立 run-verification.mjs 並讓它印出這段「原始 stdout」（可含 prose / code fence / 雜訊），exit 0。 */
  verificationStdout?: string;
  trackNodeModules?: boolean;
  trackLogs?: boolean;
};

/** 依選項建立一個臨時 fake project，回傳其路徑。run-verification.mjs 只印 JSON、不跑真實指令。 */
function makeFakeProject(opts: FakeProjectOptions): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  createdDirs.push(dir);

  if (opts.gitInit) git(dir, ["init"]);

  if (opts.withPackageJson) {
    const pkg: Record<string, unknown> = { name: "fake-target", version: "0.0.0" };
    if (opts.verifyLocal) pkg.scripts = { "verify:local": "node scripts/run-verification.mjs" };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }

  if (opts.verificationStdout !== undefined) {
    // Phase 77C：自訂 run-verification.mjs 的原始 stdout（測 prose / code fence / 雜訊解析），exit 0。
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const script = `process.stdout.write(${JSON.stringify(opts.verificationStdout)});\nprocess.exit(0);\n`;
    writeFileSync(join(dir, "scripts", "run-verification.mjs"), script, "utf8");
  } else if (opts.runVerificationOk !== undefined) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const report = JSON.stringify({
      ok: opts.runVerificationOk,
      commands: [{ name: "tsc", command: "npx tsc --noEmit", exitCode: opts.runVerificationOk ? 0 : 1, ok: opts.runVerificationOk }],
    });
    const script = `process.stdout.write(${JSON.stringify(report)});\nprocess.exit(${opts.runVerificationOk ? 0 : 1});\n`;
    writeFileSync(join(dir, "scripts", "run-verification.mjs"), script, "utf8");
  }

  if (opts.trackNodeModules) {
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
    // 加入 index 即被 git 追蹤；ls-files 不需 commit 就會列出。
    git(dir, ["add", "node_modules"]);
  }

  if (opts.trackLogs) {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "app.log"), "log line\n", "utf8");
    git(dir, ["add", "logs"]);
  }

  return dir;
}

/** 從 preflight 結果裡找指定 check。 */
function findCheck(body: Record<string, unknown>, name: string): PreflightCheckShape | undefined {
  const checks = Array.isArray(body.checks) ? (body.checks as PreflightCheckShape[]) : [];
  return checks.find((c) => c.name === name);
}

type PreflightCheckShape = { name: string; ok: boolean; severity: string; message: string; suggestion?: string; fixCommand?: string };

test("POST /auto-spec 可用：回 200 與 auto-spec 形狀 JSON（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/auto-spec`, { data: INVALID_TASK });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false); // 無效 task 仍回合法 JSON，不 crash
  expect(body).toHaveProperty("specDraft"); // auto-spec 專屬欄位
  expect(body).not.toHaveProperty("rounds");
});

test("POST /auto-round 可用：回 200 與 auto-round 形狀 JSON（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/auto-round`, { data: INVALID_TASK });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body).toHaveProperty("verification"); // auto-round 專屬欄位
  expect(body).toHaveProperty("mode");
  expect(body).not.toHaveProperty("rounds");
});

test("POST /auto-loop 可用：回 200 與 auto-loop 形狀 JSON（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/auto-loop`, { data: INVALID_TASK });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body).toHaveProperty("rounds"); // auto-loop 專屬欄位
  expect(Array.isArray(body.rounds)).toBe(true);
  expect(body).toHaveProperty("totalRounds");
});

test("POST /ce-readonly-workflow：projectPath 不存在 → 200 + ok=false + project_path_invalid（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/ce-readonly-workflow`, {
    data: { task: { projectPath: "/no/such/dir/xyz-ce", title: "t", originalRequirement: "r" }, aiCommand: "claude" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("project_path_invalid");
  expect(typeof body.message).toBe("string");
});

test("POST /ce-readonly-workflow：body 非合法 JSON → 400 + ok=false + runner_error", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/ce-readonly-workflow`, {
    headers: { "Content-Type": "application/json" },
    data: "not json {oops",
  });
  expect(res.status()).toBe(400);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("runner_error");
});

test("POST /ce-work：projectPath 不存在 → 200 + ok=false + project_path_invalid（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/ce-work`, {
    data: { task: { projectPath: "/no/such/dir/xyz-cework", title: "t", originalRequirement: "r", aiWorkflow: { plan: { status: "approved" }, audit: { checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: true, acceptanceCriteriaReviewed: true, minimalChangeReviewed: true } } } }, aiCommand: "claude" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("project_path_invalid");
});

test("POST /ce-work：gate 未通過（plan 非 approved/audited）→ 200 + work_gate_failed（不呼叫 AI）", async ({ request }) => {
  // projectPath 用實際存在的 ai-coding-relay 專案根目錄，確保不是 project_path_invalid，純測 gate。
  const projectPath = join(__dirname, "..");
  const res = await request.post(`${RUNNER_BASE}/ce-work`, {
    data: { task: { projectPath, title: "t", originalRequirement: "r", aiWorkflow: { plan: { status: "planned" } } }, aiCommand: "this-binary-should-not-be-called-xyz" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("work_gate_failed");
});

test("POST /ce-review：projectPath 不存在 → 200 + ok=false + project_path_invalid（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/ce-review`, {
    data: { task: { projectPath: "/no/such/dir/xyz-cereview", title: "t", originalRequirement: "r", aiWorkflow: { workReview: { changedFiles: ["src/App.tsx"] } } }, aiCommand: "claude" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("project_path_invalid");
});

test("POST /ce-review：gate 未過（無 Work 結果）→ 200 + review_gate_failed（不呼叫 AI）", async ({ request }) => {
  const projectPath = join(__dirname, "..");
  const res = await request.post(`${RUNNER_BASE}/ce-review`, {
    data: { task: { projectPath, title: "t", originalRequirement: "r", aiWorkflow: { plan: { status: "approved" } } }, aiCommand: "this-binary-should-not-be-called-xyz" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("review_gate_failed");
});

test("POST /ce-fix-work：projectPath 不存在 → 200 + ok=false + project_path_invalid（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/ce-fix-work`, {
    data: { task: { projectPath: "/no/such/dir/xyz-cefix", title: "t", originalRequirement: "r", aiWorkflow: { workReview: { changedFiles: ["src/App.tsx"], codeReviewNotes: "Review result: needs_fix" } } }, aiCommand: "claude" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("project_path_invalid");
});

test("POST /ce-fix-work：gate 未過（非 needs_fix）→ 200 + fix_gate_failed（不呼叫 AI）", async ({ request }) => {
  const projectPath = join(__dirname, "..");
  const res = await request.post(`${RUNNER_BASE}/ce-fix-work`, {
    data: { task: { projectPath, title: "t", originalRequirement: "r", aiWorkflow: { workReview: { changedFiles: ["src/App.tsx"], codeReviewNotes: "Review result: passed" } } }, aiCommand: "this-binary-should-not-be-called-xyz" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("fix_gate_failed");
});

// --- Phase 75：CE Artifact Export endpoint（不呼叫 AI、不執行 shell、不 commit / push）---

const ARTIFACT_NAMES = [
  "requirement.md",
  "brainstorm.md",
  "plan.md",
  "audit.md",
  "work-result.md",
  "review.md",
  "completion.md",
  "compound.md",
  "metadata.json",
];

const EXPORT_TASK_WF = {
  brainstorm: { status: "reviewed", path: "docs/brainstorms/x.md", summary: "腦力激盪摘要" },
  plan: { status: "approved", summary: "計畫摘要" },
  audit: { notes: "審計筆記", riskNotes: ["風險一"], checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: true, acceptanceCriteriaReviewed: true, minimalChangeReviewed: true } },
  workReview: { changedFiles: ["src/App.tsx"], testCommands: ["pnpm test:run"], testResults: "120 passed", codeReviewNotes: "Review result: passed" },
  compound: { lessonLearned: "學到 A", reusablePrompt: "prompt B", compoundNotes: "紀錄 C" },
};

test("POST /export-ce-artifacts：projectPath 不存在 → 200 + ok=false + project_path_invalid（不呼叫 AI）", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/export-ce-artifacts`, {
    data: { task: { projectPath: "/no/such/dir/xyz-export", title: "t", originalRequirement: "r" } },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("project_path_invalid");
});

test("POST /export-ce-artifacts：成功時寫出 9 個固定檔案，全部在 projectPath 底下", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
  const res = await request.post(`${RUNNER_BASE}/export-ce-artifacts`, {
    data: { task: { projectPath: dir, id: "tid-1", title: "Export Flow Demo", originalRequirement: "原始需求內容", aiWorkflow: EXPORT_TASK_WF } },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; artifact?: { relativeDir: string; absoluteDir: string; files: { name: string; relativePath: string }[] } };
  expect(body.ok).toBe(true);
  expect(body.artifact?.relativeDir).toBe("docs/ai-workflows/export-flow-demo");

  // 9 個檔案實際寫出且都在 projectPath/docs/ai-workflows/export-flow-demo 底下。
  const baseDir = join(dir, "docs", "ai-workflows", "export-flow-demo");
  for (const name of ARTIFACT_NAMES) {
    expect(existsSync(join(baseDir, name)), `${name} 應存在`).toBe(true);
  }
  expect(body.artifact?.files.map((f) => f.name).sort()).toEqual([...ARTIFACT_NAMES].sort());
  for (const f of body.artifact?.files ?? []) {
    expect(f.relativePath.startsWith("docs/ai-workflows/export-flow-demo/")).toBe(true);
  }

  // 內容：requirement 含原始需求；compound 含 lessonLearned；metadata 為合法 JSON。
  expect(readFileSync(join(baseDir, "requirement.md"), "utf8")).toContain("原始需求內容");
  expect(readFileSync(join(baseDir, "compound.md"), "utf8")).toContain("學到 A");
  const meta = JSON.parse(readFileSync(join(baseDir, "metadata.json"), "utf8")) as { schemaVersion: number; source: string };
  expect(meta.schemaVersion).toBe(1);
  expect(meta.source).toBe("ai-coding-relay");

  // 不 commit：git log 應無提交（或只有測試 setup 的 baseline，總之沒有 artifact commit）。
  const log = spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
  expect(log.stdout).not.toContain("ai-workflows");
});

test("POST /export-ce-artifacts：title 含 path traversal 字元時 slug 被淨化，不逃出 projectPath", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
  const res = await request.post(`${RUNNER_BASE}/export-ce-artifacts`, {
    data: { task: { projectPath: dir, id: "tid-2", title: "../../etc/passwd", originalRequirement: "r" } },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { ok: boolean; artifact?: { relativeDir: string; absoluteDir: string } };
  expect(body.ok).toBe(true);
  // slug 只保留 ascii 英數，path traversal 字元被轉成連字號並 trim。
  expect(body.artifact?.relativeDir).toBe("docs/ai-workflows/etc-passwd");
  expect(body.artifact?.absoluteDir.startsWith(dir)).toBe(true);
  // 沒有在 projectPath 外建立任何檔案。
  expect(existsSync(join(dir, "docs", "ai-workflows", "etc-passwd", "requirement.md"))).toBe(true);
});

test("POST /export-ce-artifacts：不刪除未知檔案、同名匯出可覆蓋固定檔案", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
  const baseDir = join(dir, "docs", "ai-workflows", "overwrite-demo");
  mkdirSync(baseDir, { recursive: true });
  // 預先放一個「未知檔案」與一份舊版固定檔案。
  writeFileSync(join(baseDir, "unknown-keep.md"), "請保留我", "utf8");
  writeFileSync(join(baseDir, "requirement.md"), "舊內容", "utf8");

  const post = () =>
    request.post(`${RUNNER_BASE}/export-ce-artifacts`, {
      data: { task: { projectPath: dir, id: "tid-3", title: "Overwrite Demo", originalRequirement: "新需求內容", aiWorkflow: EXPORT_TASK_WF } },
    });

  const res1 = await post();
  expect((await res1.json()).ok).toBe(true);
  // 覆蓋固定檔案。
  expect(readFileSync(join(baseDir, "requirement.md"), "utf8")).toContain("新需求內容");
  // 不刪除未知檔案。
  expect(existsSync(join(baseDir, "unknown-keep.md"))).toBe(true);
  expect(readFileSync(join(baseDir, "unknown-keep.md"), "utf8")).toBe("請保留我");

  // 再匯出一次仍成功且未知檔案還在。
  const res2 = await post();
  expect((await res2.json()).ok).toBe(true);
  expect(existsSync(join(baseDir, "unknown-keep.md"))).toBe(true);
});

test("未知 / 任意 command endpoint 一律回 404（不提供任意 shell）", async ({ request }) => {
  // 任意 command 風格的 endpoint 不存在。
  for (const path of ["/unknown", "/run", "/exec", "/command", "/shell"]) {
    const res = await request.post(`${RUNNER_BASE}${path}`, { data: {} });
    expect(res.status(), `POST ${path}`).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.ok, `POST ${path}`).toBe(false);
    expect(String(body.error), `POST ${path}`).toContain("not_found");
  }
  // 白名單 endpoint 也只接受 POST：GET 一律 404。
  for (const path of ["/auto-spec", "/auto-round", "/auto-loop"]) {
    const res = await request.get(`${RUNNER_BASE}${path}`);
    expect(res.status(), `GET ${path}`).toBe(404);
  }
});

test("GET /health 可用：回 200、ok=true、含 service/version/endpoints", async ({ request }) => {
  const res = await request.get(`${RUNNER_BASE}/health`);
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(true);
  expect(body.service).toBe("ai-coding-relay-local-runner");
  expect(typeof body.version).toBe("number");
  expect(Array.isArray(body.endpoints)).toBe(true);
  expect(body.endpoints).toEqual(
    expect.arrayContaining(["/auto-spec", "/auto-round", "/auto-loop", "/health", "/preflight", "/ce-readonly-workflow", "/ce-work", "/ce-review", "/ce-fix-work"])
  );
});

test("POST /preflight：projectPath 不存在 → ok=false 且含 project_path_exists error", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: "/no/such/dir/xyz-preflight" } });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  const check = findCheck(body, "project_path_exists");
  expect(check?.ok).toBe(false);
  expect(check?.severity).toBe("error");
});

test("POST /preflight：fake project 缺 run-verification.mjs → ok=false 且 run_verification_exists error", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verifyLocal: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(findCheck(body, "run_verification_exists")?.ok).toBe(false);
});

test("POST /preflight：完整 fake project（git repo + run-verification ok=true）→ ok=true", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verifyLocal: true, runVerificationOk: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  expect(body.ok, JSON.stringify(body.checks)).toBe(true);
  // 所有 error 級檢查都通過。
  expect(findCheck(body, "git_repo")?.ok).toBe(true);
  expect(findCheck(body, "run_verification_exists")?.ok).toBe(true);
  expect(findCheck(body, "run_verification_json")?.ok).toBe(true);
  expect(findCheck(body, "node_modules_tracked")?.ok).toBe(true);
});

test("POST /preflight：node_modules 被 git 追蹤 → 該 check failed 且整體 ok=false", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true, trackNodeModules: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "node_modules_tracked");
  expect(check?.ok).toBe(false);
  expect(check?.severity).toBe("error");
  expect(body.ok).toBe(false);
});

test("POST /preflight：verify:local 缺少 → verify_local_script warning（不致使整體 failed）", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verifyLocal: false, runVerificationOk: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "verify_local_script");
  expect(check?.ok).toBe(false);
  expect(check?.severity).toBe("warning");
  // warning 不應讓整體 ok 變 false（此 fake project 其他 error 檢查都通過）。
  expect(body.ok, JSON.stringify(body.checks)).toBe(true);
});

test("POST /preflight：git_repo 失敗時回傳 suggestion 與 fixCommand（git init）", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: false, withPackageJson: true, runVerificationOk: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "git_repo");
  expect(check?.ok).toBe(false);
  expect(check?.suggestion, "git_repo 應有 suggestion").toBeTruthy();
  expect(check?.fixCommand ?? "").toContain("git init");
  // .gitignore 排除提醒應出現在建議文字中。
  expect(check?.suggestion ?? "").toContain(".gitignore");
});

test("POST /preflight：run_verification_exists 失敗時回傳 suggestion", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "run_verification_exists");
  expect(check?.ok).toBe(false);
  expect(check?.suggestion, "run_verification_exists 應有 suggestion").toBeTruthy();
});

test("POST /preflight：verify_local_script warning 時回傳 fixCommand（npm pkg set）", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verifyLocal: false, runVerificationOk: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "verify_local_script");
  expect(check?.fixCommand ?? "").toContain("npm pkg set scripts.verify:local");
});

test("POST /preflight：node_modules_tracked 失敗時回傳 fixCommand（git rm --cached node_modules）", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true, trackNodeModules: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "node_modules_tracked");
  expect(check?.ok).toBe(false);
  expect(check?.fixCommand ?? "").toContain("git rm -r --cached node_modules");
});

test("POST /preflight：logs_tracked 失敗時回傳 fixCommand（git rm --cached logs）", async ({ request }) => {
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true, trackLogs: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "logs_tracked");
  expect(check?.ok).toBe(false);
  expect(check?.fixCommand ?? "").toContain("git rm -r --cached logs");
});

test("POST /preflight：git_status_clean warning 時回傳 fixCommand（git status/diff）", async ({ request }) => {
  // 剛 git init 且有未追蹤檔案 → working tree 不乾淨 → warning。
  const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
  const res = await request.post(`${RUNNER_BASE}/preflight`, { data: { projectPath: dir } });
  const body: Record<string, unknown> = await res.json();
  const check = findCheck(body, "git_status_clean");
  expect(check?.ok).toBe(false);
  expect(check?.severity).toBe("warning");
  expect(check?.fixCommand ?? "").toContain("git status --short");
});

/** 建立一筆含目標／禁止檔案的任務，並等詳情面板出現。可選擇填入 projectPath。 */
async function createTask(page: Page, title: string, projectPath?: string): Promise<void> {
  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill(title);
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill("PHASE46 一鍵執行 UI 驗證");
  await page.getByPlaceholder("src/DmForm.tsx\nsrc/index.tsx").fill("src/App.tsx\nsrc/App.css");
  await page.getByPlaceholder("src/CkdForm.tsx\n不要重構無關元件").fill("package.json");
  if (projectPath) {
    await page.getByPlaceholder("/Users/ryan/projects/my-app").fill(projectPath);
  }
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue(title);
}

/**
 * Phase 80：手動 CE 流程（Readonly / Work / Review / Fix / Commit checkpoint）已收進
 * 「Advanced manual controls」折疊區，預設收合。展開它（idempotent，只在收合時點擊）。
 */
async function openAdvanced(page: Page): Promise<void> {
  const details = page.getByTestId("aiwf-advanced");
  if ((await details.getAttribute("open")) === null) {
    await page.getByTestId("aiwf-advanced-toggle").click();
  }
}

/**
 * Phase 80：Brainstorm / Plan / Audit / Work·Review / Compound 欄位 accordion 已收進
 * 「Workflow details」折疊區，預設收合。展開它（idempotent，只在收合時點擊）。
 */
async function openWorkflowDetails(page: Page): Promise<void> {
  const details = page.getByTestId("aiwf-workflow-details");
  if ((await details.getAttribute("open")) === null) {
    await page.getByTestId("aiwf-workflow-details-toggle").click();
  }
}

test("UI 一鍵執行：三顆按鈕存在；runner 未啟動時 auto-spec alert、auto-round / auto-loop 顯示 Preflight 未連線", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  // 模擬「runner 未啟動」：攔截送往 4318 的請求並視為連線失敗。
  await page.route("http://localhost:4318/**", (route) => route.abort("connectionrefused"));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await createTask(page, "PHASE54 一鍵執行 E2E");

  // 1. 三顆執行按鈕都存在。
  for (const name of ["執行 auto-spec", "執行 auto-round", "執行 auto-loop"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }

  // 2. auto-spec 未接 preflight，runner 未啟動時仍以 alert 提示 pnpm runner:local。
  const [specDialog] = await Promise.all([
    page.waitForEvent("dialog"),
    page.getByRole("button", { name: "執行 auto-spec" }).click(),
  ]);
  expect(specDialog.message()).toContain("pnpm runner:local");
  await specDialog.accept();
  await expect(page.getByRole("button", { name: "執行 auto-spec" })).toBeEnabled();

  // 3. auto-round / auto-loop 會先跑 preflight；runner 未啟動時「不 alert」，改在 Preflight 區塊顯示未連線。
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  const preflight = page.getByTestId("preflight");
  for (const name of ["執行 auto-round", "執行 auto-loop"]) {
    await page.getByRole("button", { name }).click();
    await expect(preflight).toHaveAttribute("data-status", "disconnected");
    await expect(preflight).toContainText("pnpm runner:local");
    await expect(page.getByRole("button", { name })).toBeEnabled();
  }
  expect(dialogs, "auto-round / auto-loop 在 runner 未啟動時不應 alert").toEqual([]);

  // 4. fetch 失敗不應建立任何回合。
  expect(await page.locator(".round-card").count()).toBe(0);

  // 5. 不得有 pageerror；console error 僅允許「連線失敗」這類預期的網路錯誤（runner 未啟動本就會發生）。
  const unexpected = consoleErrors.filter(
    (t) => !/4318|Failed to load resource|ERR_/i.test(t)
  );
  expect(unexpected, `unexpected console errors:\n${unexpected.join("\n")}`).toEqual([]);
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("UI runner 狀態：runner 未啟動時顯示未連線與 pnpm runner:local 提示（不 alert）", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let dialogShown = false;
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // health 連不上不應跳 alert；若有 dialog 出現就記錄下來讓斷言失敗。
  page.on("dialog", (d) => { dialogShown = true; void d.accept(); });

  // 模擬「runner 未啟動」：攔截 4318 視為連線失敗。
  await page.route("http://localhost:4318/**", (route) => route.abort("connectionrefused"));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE50 runner 未連線 E2E");

  const status = page.getByTestId("runner-status");
  await expect(status).toHaveAttribute("data-status", "disconnected");
  await expect(status).toContainText("未連線");
  await expect(status).toContainText("pnpm runner:local");
  expect(dialogShown, "health 連不上不應跳 alert").toBe(false);

  const unexpected = consoleErrors.filter((t) => !/4318|Failed to load resource|ERR_/i.test(t));
  expect(unexpected, `unexpected console errors:\n${unexpected.join("\n")}`).toEqual([]);
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("UI Preflight：runner 未啟動時點「檢查目標專案」顯示未連線提示（不 alert）", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let dialogShown = false;
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("dialog", (d) => { dialogShown = true; void d.accept(); });

  await page.route("http://localhost:4318/**", (route) => route.abort("connectionrefused"));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE51 preflight 未連線 E2E");

  const preflight = page.getByTestId("preflight");
  await expect(preflight).toBeVisible();
  await page.getByRole("button", { name: "檢查目標專案" }).click();
  await expect(preflight).toHaveAttribute("data-status", "disconnected");
  await expect(preflight).toContainText("未連線");
  await expect(preflight).toContainText("pnpm runner:local");
  expect(dialogShown, "preflight 連不上不應跳 alert").toBe(false);

  const unexpected = consoleErrors.filter((t) => !/4318|Failed to load resource|ERR_/i.test(t));
  expect(unexpected, `unexpected console errors:\n${unexpected.join("\n")}`).toEqual([]);
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// --- auto-round / auto-loop 執行前自動 Preflight 的 UI 測試（用 route 攔截 4318，不需真實 runner） ---

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const HEALTH_BODY = {
  ok: true,
  service: "ai-coding-relay-local-runner",
  version: 2,
  startedAt: "2026-01-01T00:00:00.000Z",
  port: 4318,
  host: "127.0.0.1",
  endpoints: ["/auto-spec", "/auto-round", "/auto-loop", "/health", "/preflight", "/ce-readonly-workflow", "/ce-work", "/ce-review", "/ce-fix-work"],
};

const PF_ERROR = {
  ok: false,
  projectPath: "/fake",
  checks: [{ name: "git_repo", ok: false, severity: "error", message: "不是 git repo", suggestion: "請初始化 git", fixCommand: "git init" }],
  summary: { errorCount: 1, warningCount: 0 },
};
const PF_WARN = {
  ok: true,
  projectPath: "/fake",
  checks: [{ name: "git_status_clean", ok: false, severity: "warning", message: "working tree 有未提交變更", fixCommand: "git status --short" }],
  summary: { errorCount: 0, warningCount: 1 },
};
const PF_PASS = {
  ok: true,
  projectPath: "/fake",
  checks: [{ name: "git_repo", ok: true, severity: "error", message: "是 git repo" }],
  summary: { errorCount: 0, warningCount: 0 },
};

const AUTO_ROUND_OK = {
  ok: true,
  mode: "implement",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  ai: { command: "claude", exitCode: 0, stdout: "done", stderr: "", durationMs: 500 },
  verification: {
    ok: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.500Z",
    durationMs: 500,
    commands: [{ name: "tsc", command: "npx tsc --noEmit", exitCode: 0, stdout: "", stderr: "", durationMs: 100, ok: true, required: true }],
  },
};
const AUTO_LOOP_OK = {
  ok: true,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:02.000Z",
  durationMs: 2000,
  maxRounds: 3,
  totalRounds: 1,
  autoApprove: false,
  initialMode: "implement",
  finalMode: "implement",
  stoppedReason: "done",
  rounds: [AUTO_ROUND_OK],
};

type RunnerMockOptions = {
  preflight: object;
  autoRoundBody?: object;
  autoLoopBody?: object;
  onAutoRound?: () => void;
  onAutoLoop?: () => void;
  /** 延遲各 endpoint 回應的毫秒數，用來讓「執行中」的進度階段可被觀察。 */
  preflightDelayMs?: number;
  autoRoundDelayMs?: number;
  autoLoopDelayMs?: number;
  /** Phase 70：CE Readonly Workflow endpoint 的回傳與 hook。 */
  ceReadonlyBody?: object;
  onCeReadonly?: () => void;
  ceReadonlyDelayMs?: number;
  /** Phase 71：CE Work endpoint 的回傳與 hook。 */
  ceWorkBody?: object;
  onCeWork?: () => void;
  ceWorkDelayMs?: number;
  /** Phase 72：CE Review endpoint 的回傳與 hook。 */
  ceReviewBody?: object;
  onCeReview?: () => void;
  ceReviewDelayMs?: number;
  /** Phase 73B：CE Fix Work endpoint 的回傳與 hook。 */
  ceFixWorkBody?: object;
  onCeFixWork?: () => void;
  ceFixWorkDelayMs?: number;
  /** Phase 75：CE Artifact Export endpoint 的回傳與 hook。 */
  exportBody?: object;
  onExport?: () => void;
  exportDelayMs?: number;
  /** Phase 77F：CE Commit checkpoint endpoint 的回傳與 hook（hook 會收到 request body 字串）。 */
  ceCommitBody?: object;
  onCeCommit?: (postData: string) => void;
  ceCommitDelayMs?: number;
};

const sleep = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** 攔截送往 4318 的請求並用 fixture 回應（含 CORS / OPTIONS preflight），不需真實 runner。 */
async function mockRunnerRoutes(page: Page, opts: RunnerMockOptions): Promise<void> {
  await page.route("http://localhost:4318/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const url = req.url();
    const json = (body: object) =>
      route.fulfill({ status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (url.endsWith("/health")) return json(HEALTH_BODY);
    if (url.endsWith("/preflight")) { await sleep(opts.preflightDelayMs); return json(opts.preflight); }
    if (url.endsWith("/auto-round")) { opts.onAutoRound?.(); await sleep(opts.autoRoundDelayMs); return json(opts.autoRoundBody ?? { ok: true }); }
    if (url.endsWith("/auto-loop")) { opts.onAutoLoop?.(); await sleep(opts.autoLoopDelayMs); return json(opts.autoLoopBody ?? { ok: true, rounds: [] }); }
    if (url.endsWith("/ce-readonly-workflow")) { opts.onCeReadonly?.(); await sleep(opts.ceReadonlyDelayMs); return json(opts.ceReadonlyBody ?? { ok: true, workflow: {}, canStartWork: false, recommendedNextAction: "", rawNotes: "" }); }
    if (url.endsWith("/ce-work")) { opts.onCeWork?.(); await sleep(opts.ceWorkDelayMs); return json(opts.ceWorkBody ?? { ok: true, work: { changedFiles: [], testCommands: [], testResults: "", implementationSummary: "", notes: "", recommendedNextAction: "" }, verification: { ok: true, commands: [] }, git: { statusShort: "", diffStat: "" }, ai: { command: "claude", exitCode: 0 } }); }
    if (url.endsWith("/ce-review")) { opts.onCeReview?.(); await sleep(opts.ceReviewDelayMs); return json(opts.ceReviewBody ?? { ok: true, review: { result: "passed", notes: "", issues: [], testGaps: [], riskNotes: [], recommendedFixes: [], recommendedNextAction: "" }, git: { statusShort: "", diffStat: "" }, ai: { command: "claude", exitCode: 0 } }); }
    if (url.endsWith("/ce-fix-work")) { opts.onCeFixWork?.(); await sleep(opts.ceFixWorkDelayMs); return json(opts.ceFixWorkBody ?? { ok: true, fix: { changedFiles: [], testCommands: [], fixSummary: "", notes: "", recommendedNextAction: "" }, verification: { ok: true, commands: [] }, git: { statusShort: "", diffStat: "" }, ai: { command: "claude", exitCode: 0 } }); }
    if (url.endsWith("/export-ce-artifacts")) { opts.onExport?.(); await sleep(opts.exportDelayMs); return json(opts.exportBody ?? { ok: true, artifact: { relativeDir: "docs/ai-workflows/x", absoluteDir: "/p/docs/ai-workflows/x", files: [] } }); }
    if (url.endsWith("/ce-commit-checkpoint")) { opts.onCeCommit?.(req.postData() ?? ""); await sleep(opts.ceCommitDelayMs); return json(opts.ceCommitBody ?? { ok: true, commitMessage: "docs: add note", commitHash: "abc1234", committedAt: "2026-06-13T00:00:00.000Z", committedFiles: ["src/App.tsx"], untrackedFiles: [], verification: { ok: true, commands: [] }, statusBefore: " M src/App.tsx", diffStatBefore: " src/App.tsx | 2 +-" }); }
    await route.fulfill({ status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ ok: false }) });
  });
}

test("auto-round 前 Preflight：error 時不執行 auto-round，UI 顯示 Preflight 未通過", async ({ page }) => {
  let autoRoundCalled = false;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await mockRunnerRoutes(page, { preflight: PF_ERROR, onAutoRound: () => { autoRoundCalled = true; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE54 auto-round preflight error");

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  const preflight = page.getByTestId("preflight");
  await expect(preflight).toHaveAttribute("data-status", "done");
  await expect(preflight).toContainText("Preflight 未通過");
  await expect(preflight.locator('[data-check="git_repo"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "執行 auto-round" })).toBeEnabled();
  expect(autoRoundCalled, "preflight error 不應呼叫 /auto-round").toBe(false);
  expect(dialogs, "error 不應跳 confirm").toEqual([]);
  expect(await page.locator(".round-card").count()).toBe(0);
});

test("auto-round 前 Preflight：warning 取消時不執行 auto-round", async ({ page }) => {
  let autoRoundCalled = false;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await mockRunnerRoutes(page, { preflight: PF_WARN, autoRoundBody: AUTO_ROUND_OK, onAutoRound: () => { autoRoundCalled = true; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE54 auto-round preflight warning cancel");

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(dialogs[0]).toContain("Preflight 有 warning");
  expect(dialogs[0]).toContain("auto-round");
  await expect(page.getByRole("button", { name: "執行 auto-round" })).toBeEnabled();
  expect(autoRoundCalled, "warning 取消不應呼叫 /auto-round").toBe(false);
  expect(await page.locator(".round-card").count()).toBe(0);
});

test("auto-round 前 Preflight：warning 確認後執行 auto-round 並建立回合", async ({ page }) => {
  let autoRoundCalled = false;
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_WARN, autoRoundBody: AUTO_ROUND_OK, onAutoRound: () => { autoRoundCalled = true; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE54 auto-round preflight warning accept");

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  await expect.poll(() => autoRoundCalled).toBe(true);
  await expect(page.locator(".round-card")).toHaveCount(1);
});

test("auto-round 前 Preflight：全通過時直接執行 auto-round", async ({ page }) => {
  let autoRoundCalled = false;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  await mockRunnerRoutes(page, { preflight: PF_PASS, autoRoundBody: AUTO_ROUND_OK, onAutoRound: () => { autoRoundCalled = true; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE54 auto-round preflight pass");

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  await expect.poll(() => autoRoundCalled).toBe(true);
  await expect(page.locator(".round-card")).toHaveCount(1);
  expect(dialogs, "全通過不應跳 confirm").toEqual([]);
});

test("auto-loop 前 Preflight：error 時不執行 auto-loop", async ({ page }) => {
  let autoLoopCalled = false;
  page.on("dialog", (d) => void d.dismiss());
  await mockRunnerRoutes(page, { preflight: PF_ERROR, onAutoLoop: () => { autoLoopCalled = true; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE54 auto-loop preflight error");

  await page.getByRole("button", { name: "執行 auto-loop" }).click();

  const preflight = page.getByTestId("preflight");
  await expect(preflight).toHaveAttribute("data-status", "done");
  await expect(preflight).toContainText("Preflight 未通過");
  await expect(page.getByRole("button", { name: "執行 auto-loop" })).toBeEnabled();
  expect(autoLoopCalled, "preflight error 不應呼叫 /auto-loop").toBe(false);
  expect(await page.locator(".round-card").count()).toBe(0);
});

test("auto-loop 前 Preflight：warning 確認後執行 auto-loop 並建立回合", async ({ page }) => {
  let autoLoopCalled = false;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  await mockRunnerRoutes(page, { preflight: PF_WARN, autoLoopBody: AUTO_LOOP_OK, onAutoLoop: () => { autoLoopCalled = true; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE54 auto-loop preflight warning accept");

  await page.getByRole("button", { name: "執行 auto-loop" }).click();

  await expect.poll(() => autoLoopCalled).toBe(true);
  expect(dialogs[0]).toContain("auto-loop");
  await expect(page.locator(".round-card")).toHaveCount(1);
});

// --- Phase 63：建立並執行 auto-round（新增任務後自動觸發 auto-round） ---

const PHASE63_REQUIREMENT = `請在 docs/harness-architecture.md 補充一小段「測試小節」。
1. run loop 實作應保持 TypeScript 檢查通過。`;

/** 開啟新增任務表單並填入「建立並執行 auto-round」所需欄位（選文件小改 auto-round 模板）。 */
async function openCreateAndRunForm(
  page: Page,
  opts: { requirement?: string; projectPath?: string; title?: string }
): Promise<void> {
  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  if (opts.title !== undefined) {
    await page.getByPlaceholder("例：DM 表單新增當年新收案").fill(opts.title);
  }
  if (opts.requirement !== undefined) {
    await page.getByPlaceholder("描述這個任務要完成什麼...").fill(opts.requirement);
  }
  if (opts.projectPath !== undefined) {
    await page.getByPlaceholder("/Users/ryan/projects/my-app").fill(opts.projectPath);
  }
  const templateSelect = page.locator(".form-field", { hasText: "任務模板" }).locator("select");
  await templateSelect.selectOption({ label: "文件小改 auto-round" });
}

test("建立並執行 auto-round：表單顯示按鈕，全通過 Preflight 後建立任務、自動執行、建立回合、產生摘要與完成建議", async ({ page }) => {
  let autoRoundCount = 0;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    autoRoundBody: AUTO_ROUND_OK,
    onAutoRound: () => { autoRoundCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await openCreateAndRunForm(page, {
    requirement: PHASE63_REQUIREMENT,
    projectPath: "/Users/ryan/Desktop/code/harness",
  });

  // 1. 按鈕存在。
  const createAndRunBtn = page.getByRole("button", { name: "建立並執行 auto-round" });
  await expect(createAndRunBtn).toBeVisible();
  await createAndRunBtn.click();

  // 2. 任務被建立並進入 TaskDetail，欄位由 quickFill 自動帶入。
  await expect(page.locator(".task-detail-title-input")).not.toHaveValue("");
  await expect(page.locator(".workflow-stage-select")).toHaveValue("green_implement");
  await expect(page.getByText("docs/harness-architecture.md", { exact: true })).toBeVisible();
  // projectPath 不會進 targetFiles。
  await expect(page.locator(".detail-section", { hasText: "目標檔案" })).not.toContainText(
    "/Users/ryan/Desktop/code/harness"
  );

  // 3. 自動執行 auto-round（含先跑 /preflight）→ 建立一筆回合。
  await expect.poll(() => autoRoundCount).toBe(1);
  await expect(page.locator(".round-card")).toHaveCount(1);

  // 4. 成功後自動產生摘要、出現完成建議。
  await expect(page.locator(".summary-textarea")).toHaveValue(/任務目標：/);
  await expect(page.getByTestId("completion-suggestion")).toBeVisible();

  // 5. 不會重複觸發 auto-round（StrictMode / re-render）。
  await expect(page.locator(".round-card")).toHaveCount(1);
  expect(autoRoundCount, "auto-round 只應被呼叫一次").toBe(1);
  // 全通過不應跳 confirm。
  expect(dialogs, "全通過不應跳 confirm").toEqual([]);
});

test("建立並執行 auto-round：Preflight error 時不呼叫 /auto-round，顯示 Preflight 未通過", async ({ page }) => {
  let autoRoundCount = 0;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await mockRunnerRoutes(page, { preflight: PF_ERROR, onAutoRound: () => { autoRoundCount += 1; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await openCreateAndRunForm(page, {
    requirement: PHASE63_REQUIREMENT,
    projectPath: "/Users/ryan/Desktop/code/harness",
  });
  await page.getByRole("button", { name: "建立並執行 auto-round" }).click();

  // 任務仍建立、進入 TaskDetail，但 Preflight error → 不執行 auto-round。
  await expect(page.locator(".task-detail-title-input")).not.toHaveValue("");
  const preflight = page.getByTestId("preflight");
  await expect(preflight).toHaveAttribute("data-status", "done");
  await expect(preflight).toContainText("Preflight 未通過");
  expect(autoRoundCount, "preflight error 不應呼叫 /auto-round").toBe(0);
  await expect(page.locator(".round-card")).toHaveCount(0);
  expect(dialogs, "error 不應跳 confirm").toEqual([]);
});

test("建立並執行 auto-round：Preflight warning 取消則不執行；確認則執行", async ({ page }) => {
  // 先測「取消」。
  let autoRoundCount = 0;
  let decision: "dismiss" | "accept" = "dismiss";
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    if (decision === "accept") void d.accept();
    else void d.dismiss();
  });
  await mockRunnerRoutes(page, {
    preflight: PF_WARN,
    autoRoundBody: AUTO_ROUND_OK,
    onAutoRound: () => { autoRoundCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await openCreateAndRunForm(page, {
    requirement: PHASE63_REQUIREMENT,
    projectPath: "/Users/ryan/Desktop/code/harness",
  });
  await page.getByRole("button", { name: "建立並執行 auto-round" }).click();

  // warning → 跳 confirm；取消後不呼叫 /auto-round。
  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(dialogs[0]).toContain("Preflight 有 warning");
  expect(dialogs[0]).toContain("auto-round");
  await expect(page.locator(".round-card")).toHaveCount(0);
  expect(autoRoundCount, "warning 取消不應呼叫 /auto-round").toBe(0);

  // 在同一個任務上手動再按一次「執行 auto-round」，這次確認 → 會執行。
  decision = "accept";
  await page.getByRole("button", { name: "執行 auto-round" }).click();
  await expect.poll(() => autoRoundCount).toBe(1);
  await expect(page.locator(".round-card")).toHaveCount(1);
});

test("建立並執行 auto-round：originalRequirement 空白時不建立任務、提示錯誤", async ({ page }) => {
  let autoRoundCount = 0;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  await mockRunnerRoutes(page, { preflight: PF_PASS, onAutoRound: () => { autoRoundCount += 1; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 只填 projectPath，不填原始需求。
  await openCreateAndRunForm(page, { projectPath: "/Users/ryan/Desktop/code/harness" });
  await page.getByRole("button", { name: "建立並執行 auto-round" }).click();

  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(dialogs[0]).toContain("原始需求");
  // 不建立任務：表單仍在、未進入 TaskDetail、未呼叫 auto-round。
  await expect(page.getByRole("button", { name: "建立任務" })).toBeVisible();
  await expect(page.locator(".task-detail-title-input")).toHaveCount(0);
  expect(autoRoundCount).toBe(0);
});

test("建立並執行 auto-round：projectPath 空白時不建立任務、提示錯誤", async ({ page }) => {
  let autoRoundCount = 0;
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  await mockRunnerRoutes(page, { preflight: PF_PASS, onAutoRound: () => { autoRoundCount += 1; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 只填原始需求，不填 projectPath。
  await openCreateAndRunForm(page, { requirement: PHASE63_REQUIREMENT });
  await page.getByRole("button", { name: "建立並執行 auto-round" }).click();

  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(dialogs[0]).toContain("專案路徑");
  await expect(page.getByRole("button", { name: "建立任務" })).toBeVisible();
  await expect(page.locator(".task-detail-title-input")).toHaveCount(0);
  expect(autoRoundCount).toBe(0);
});

test("建立並執行 auto-round：既有「建立任務」按鈕不觸發 auto-round", async ({ page }) => {
  let autoRoundCount = 0;
  await mockRunnerRoutes(page, { preflight: PF_PASS, autoRoundBody: AUTO_ROUND_OK, onAutoRound: () => { autoRoundCount += 1; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await openCreateAndRunForm(page, {
    title: "PHASE63 既有建立任務流程",
    requirement: PHASE63_REQUIREMENT,
    projectPath: "/Users/ryan/Desktop/code/harness",
  });
  // 走既有「建立任務」流程（建立任務需要 title）。
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).not.toHaveValue("");

  // 既有流程不應自動執行 auto-round。
  await expect(page.locator(".round-card")).toHaveCount(0);
  expect(autoRoundCount, "建立任務不應觸發 auto-round").toBe(0);
});

// --- Phase 64：auto-round / auto-loop 執行進度顯示 ---

test("執行進度：auto-round 顯示 Preflight → 執行中 → 已完成，且不影響 RoundTimeline / summary / 完成建議", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    autoRoundBody: AUTO_ROUND_OK,
    preflightDelayMs: 500,
    autoRoundDelayMs: 500,
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE64 auto-round 進度", "/Users/ryan/Desktop/code/harness");

  // idle 時不顯示進度。
  await expect(page.getByTestId("execution-progress")).toHaveCount(0);

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  const progress = page.getByTestId("execution-progress");
  await expect(progress).toBeVisible();
  // 1. Preflight 階段。
  await expect(progress).toHaveAttribute("data-phase", "preflight_running");
  await expect(progress).toContainText("正在檢查目標專案 Preflight");
  // 2. auto-round 執行階段。
  await expect(progress).toHaveAttribute("data-phase", "auto_round_running");
  await expect(progress).toContainText("正在執行 auto-round");
  // 3. 完成。
  await expect(progress).toHaveAttribute("data-phase", "completed");
  await expect(progress).toContainText("已完成");

  // 既有功能不回歸：建立回合、自動摘要、完成建議都在。
  await expect(page.locator(".round-card")).toHaveCount(1);
  await expect(page.locator(".summary-textarea")).toHaveValue(/任務目標：/);
  await expect(page.getByTestId("completion-suggestion")).toBeVisible();
  expect(dialogs, "全通過不應跳 confirm").toEqual([]);
});

test("執行進度：Preflight error 時顯示 preflight_failed「Preflight 未通過」", async ({ page }) => {
  let autoRoundCount = 0;
  page.on("dialog", (d) => void d.dismiss());
  await mockRunnerRoutes(page, { preflight: PF_ERROR, onAutoRound: () => { autoRoundCount += 1; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE64 preflight error 進度", "/Users/ryan/Desktop/code/harness");

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  const progress = page.getByTestId("execution-progress");
  await expect(progress).toHaveAttribute("data-phase", "preflight_failed");
  await expect(progress).toContainText("Preflight 未通過");
  expect(autoRoundCount, "preflight error 不應呼叫 /auto-round").toBe(0);
});

test("執行進度：Preflight warning 取消時顯示「使用者取消執行」，且不呼叫 /auto-round", async ({ page }) => {
  let autoRoundCount = 0;
  page.on("dialog", (d) => void d.dismiss());
  await mockRunnerRoutes(page, { preflight: PF_WARN, autoRoundBody: AUTO_ROUND_OK, onAutoRound: () => { autoRoundCount += 1; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE64 preflight warning 取消進度", "/Users/ryan/Desktop/code/harness");

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  const progress = page.getByTestId("execution-progress");
  await expect(progress).toHaveAttribute("data-phase", "failed");
  await expect(progress).toContainText("使用者取消執行");
  expect(autoRoundCount, "warning 取消不應呼叫 /auto-round").toBe(0);
  await expect(page.locator(".round-card")).toHaveCount(0);
});

test("執行進度：auto-loop 執行期間顯示「正在執行 auto-loop」並完成", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    autoLoopBody: AUTO_LOOP_OK,
    preflightDelayMs: 300,
    autoLoopDelayMs: 500,
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE64 auto-loop 進度", "/Users/ryan/Desktop/code/harness");

  await page.getByRole("button", { name: "執行 auto-loop" }).click();

  const progress = page.getByTestId("execution-progress");
  await expect(progress).toHaveAttribute("data-phase", "auto_loop_running");
  await expect(progress).toContainText("正在執行 auto-loop");
  await expect(progress).toHaveAttribute("data-phase", "completed");
  await expect(page.locator(".round-card")).toHaveCount(1);
});

test("執行進度：fetch /auto-round 失敗時顯示「runner 未連線或執行失敗」", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS });
  // 在通用 mock 之後再針對 /auto-round 註冊 abort（後註冊者優先），模擬執行失敗。
  await page.route("http://localhost:4318/auto-round", (route) => route.abort("connectionrefused"));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE64 fetch 失敗進度", "/Users/ryan/Desktop/code/harness");

  await page.getByRole("button", { name: "執行 auto-round" }).click();

  const progress = page.getByTestId("execution-progress");
  await expect(progress).toHaveAttribute("data-phase", "failed");
  await expect(progress).toContainText("runner 未連線或執行失敗");
  await expect(page.locator(".round-card")).toHaveCount(0);
});

test("執行進度：Phase 63「建立並執行 auto-round」進入 TaskDetail 後也顯示進度並完成（不重複執行）", async ({ page }) => {
  let autoRoundCount = 0;
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    autoRoundBody: AUTO_ROUND_OK,
    preflightDelayMs: 400,
    autoRoundDelayMs: 400,
    onAutoRound: () => { autoRoundCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await openCreateAndRunForm(page, {
    requirement: PHASE63_REQUIREMENT,
    projectPath: "/Users/ryan/Desktop/code/harness",
  });
  await page.getByRole("button", { name: "建立並執行 auto-round" }).click();

  // Phase 63 自動觸發路徑也顯示進度，並走到完成。
  const progress = page.getByTestId("execution-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("data-phase", "completed");
  await expect(progress).toContainText("已完成");

  await expect(page.locator(".round-card")).toHaveCount(1);
  expect(autoRoundCount, "auto-round 只應被呼叫一次").toBe(1);
});

test.describe("UI runner 狀態：已連線", () => {
  let healthRunner: ChildProcess | null = null;

  test.beforeAll(async () => {
    healthRunner = spawn(process.execPath, [RUNNER_PATH], {
      env: { ...process.env, RUNNER_PORT: "4318" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 等 /health 可連線（可能是這個 runner，也可能是本機既有的同版 runner）。
    await waitForHealth("http://127.0.0.1:4318/health", 10_000);
  });

  test.afterAll(() => {
    if (healthRunner && !healthRunner.killed) healthRunner.kill();
  });

  test("health 可用時顯示已連線、service 與 endpoints，重新檢查仍為已連線", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await createTask(page, "PHASE50 runner 已連線 E2E");

    const status = page.getByTestId("runner-status");
    await expect(status).toHaveAttribute("data-status", "connected");
    await expect(status).toContainText("已連線");
    await expect(status).toContainText("ai-coding-relay-local-runner");
    for (const ep of ["/auto-spec", "/auto-round", "/auto-loop", "/health"]) {
      await expect(status).toContainText(ep);
    }

    // 「重新檢查」按鈕可再次檢查，仍為已連線。
    await page.getByRole("button", { name: "重新檢查" }).click();
    await expect(status).toHaveAttribute("data-status", "connected");

    // runner 已連線，health 成功，全程不應有 console error / pageerror。
    expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
    expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  });

  test("health 可用時點「檢查目標專案」顯示 preflight 檢查項", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    // 未設 projectPath（空字串）→ preflight 會回 project_path_exists error，仍能驗證「顯示檢查項」。
    await createTask(page, "PHASE51 preflight 已連線 E2E");

    const preflight = page.getByTestId("preflight");
    await page.getByRole("button", { name: "檢查目標專案" }).click();
    await expect(preflight).toHaveAttribute("data-status", "done");
    // 顯示整體結果與個別 check（含 error 級的 project_path_exists）。
    await expect(preflight).toContainText("Preflight 未通過");
    await expect(preflight.locator('[data-check="project_path_exists"]')).toBeVisible();
    await expect(preflight.locator('[data-check="project_path_exists"]')).toHaveAttribute("data-ok", "false");
    // ok=false 時提示先修正再執行 auto-round / auto-loop。
    await expect(preflight).toContainText("auto-round / auto-loop");

    expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
    expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  });

  test("preflight 回傳 suggestion/fixCommand 時，UI 顯示建議並可複製修復指令", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // 非 git repo 的 fake project → git_repo 失敗，會帶 suggestion 與 fixCommand（git init）。
    const dir = makeFakeProject({ gitInit: false, withPackageJson: true, runVerificationOk: true });

    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await createTask(page, "PHASE52 preflight 修復建議 E2E", dir);

    const preflight = page.getByTestId("preflight");
    await page.getByRole("button", { name: "檢查目標專案" }).click();
    await expect(preflight).toHaveAttribute("data-status", "done");

    // git_repo 檢查顯示建議文字。
    const gitRepoCheck = preflight.locator('[data-check="git_repo"]');
    await expect(gitRepoCheck).toHaveAttribute("data-ok", "false");
    await expect(gitRepoCheck).toContainText("建議：");

    // git_repo 的修復指令區塊存在、含 git init，且可複製。
    const gitRepoFix = preflight.locator('[data-fix-for="git_repo"]');
    await expect(gitRepoFix).toBeVisible();
    await expect(gitRepoFix).toContainText("git init");
    await gitRepoFix.getByRole("button", { name: "複製修復指令" }).click();
    await expect(gitRepoFix.getByRole("button", { name: "✓ 已複製" })).toBeVisible();

    // 剪貼簿應含該修復指令（只複製文字，未執行任何 shell）。
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("git init");
    expect(clip).toContain("initial baseline");

    expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
    expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  });
});

// --- Phase 60：runner 回傳前 JSON.parse 防禦（函式層測試 runScript / buildInvalidJsonError）---

/** 建立一支「flush-safe」的暫存腳本，內容為 body；回傳腳本絕對路徑（測試結束由 afterEach 清除）。 */
function makeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "runscript-test-"));
  createdDirs.push(dir);
  const path = join(dir, "fake.mjs");
  writeFileSync(path, body, "utf8");
  return path;
}

/** 產生「把 raw 寫到 stdout、flush 後才結束」的腳本內容（確保暫存腳本本身不截斷）。 */
function emitStdout(raw: string): string {
  return `process.stdout.write(${JSON.stringify(raw)}, () => { process.exit(0); });\n`;
}

test.describe("runScript stdout JSON 防禦（Phase 60）", () => {
  const AR_BASE = { ok: false, mode: "", ai: null, verification: null };
  const LOOP_BASE = { ok: false, totalRounds: 0, rounds: [] };

  test("合法 JSON：照原樣回傳、可解析、內容不變（auto-round 不回歸）", async () => {
    const valid = JSON.stringify({ ok: true, mode: "implement", ai: null, verification: { ok: true, commands: [] } });
    const out: string = await runScript(makeScript(emitStdout(valid)), "{}", AR_BASE, "auto-round");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe("implement");
    expect(parsed.stoppedReason).toBeUndefined();
    expect(parsed).not.toHaveProperty("runnerError");
  });

  test("非法 JSON：回傳合法錯誤 JSON（ok=false + 診斷欄位），不把壞 JSON 原樣回 UI", async () => {
    const garbage = "not json at all {oops";
    const out: string = await runScript(makeScript(emitStdout(garbage)), "{}", AR_BASE, "auto-round");
    // 重點：runner 回傳的一定要能被 JSON.parse（不再把壞 JSON 原樣回）。
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.stoppedReason).toBe("runner_invalid_json");
    expect(typeof parsed.runnerError).toBe("string");
    expect(String(parsed.runnerError).length).toBeGreaterThan(0);
    expect(parsed.script).toBe("auto-round");
    expect(parsed.stdoutBytes).toBe(Buffer.byteLength(garbage, "utf8"));
    expect(parsed).toHaveProperty("stdoutPreview");
    expect(parsed).toHaveProperty("stdoutTail");
    expect(String(parsed.stdoutPreview)).toContain("not json");
    // 形狀相容：auto-round base 欄位仍在（UI 可建立一筆失敗回合而非崩潰）。
    expect(parsed).toHaveProperty("verification");
    expect(parsed).toHaveProperty("mode");
  });

  test("截斷 JSON：stoppedReason=runner_truncated_output，保留 bytes 與前後片段", async () => {
    // 以 { 開頭、無閉合，且長度 > 1000 以驗證 preview / tail 皆被填入。
    const truncated = `{"verification":{"commands":[{"name":"test","stdout":"` + "x".repeat(1500);
    const out: string = await runScript(makeScript(emitStdout(truncated)), "{}", AR_BASE, "auto-round");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.stoppedReason).toBe("runner_truncated_output");
    expect(parsed.stdoutBytes).toBe(Buffer.byteLength(truncated, "utf8"));
    expect(String(parsed.stdoutPreview).length).toBe(1000);
    expect(String(parsed.stdoutTail).length).toBe(1000);
  });

  test("auto-loop 端點：非法 JSON 也回傳合法錯誤 JSON（含 rounds base、script=auto-loop）", async () => {
    const garbage = "<html>not json</html>";
    const out: string = await runScript(makeScript(emitStdout(garbage)), "{}", LOOP_BASE, "auto-loop");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.script).toBe("auto-loop");
    expect(parsed.stoppedReason).toBe("runner_invalid_json");
    expect(Array.isArray(parsed.rounds)).toBe(true);
    expect(typeof parsed.runnerError).toBe("string");
  });

  test("buildInvalidJsonError：parse error 含 Unexpected end → 視為截斷（auto-spec 標籤）", () => {
    const out: string = buildInvalidJsonError({ ok: false, ai: null, specDraft: "" }, "auto-spec", "{partial", "warn", "Unexpected end of JSON input");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.stoppedReason).toBe("runner_truncated_output");
    expect(parsed.script).toBe("auto-spec");
    expect(String(parsed.runnerError)).toContain("Unexpected end");
    expect(parsed).toHaveProperty("specDraft");
    expect(parsed).toHaveProperty("stderrPreview");
    expect(parsed).toHaveProperty("stderrTail");
  });
});

// --- Phase 70：CE Readonly Workflow runner 函式層測試（prompt builder / JSON parser / runCeReadonlyWorkflow）---

/** 把 body 寫成暫存的 fake AI 腳本，回傳 `node <path>` 形式的 aiCommand（路徑無空白）。 */
function makeAiCommand(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-ai-test-"));
  createdDirs.push(dir);
  const path = join(dir, "fake-ai.mjs");
  writeFileSync(path, body, "utf8");
  return `${process.execPath} ${path}`;
}

test.describe("CE Readonly Workflow 函式層（Phase 70）", () => {
  test("buildCeReadonlyWorkflowPrompt：明確要求唯讀、不修改檔案、不 commit、不進入 Work、只輸出 JSON", () => {
    const prompt: string = buildCeReadonlyWorkflowPrompt({
      projectPath: "/tmp/ce-target",
      title: "登入頁",
      originalRequirement: "需求內容 ABC",
    });
    expect(prompt).toContain("不要修改任何檔案");
    expect(prompt).toContain("不要執行 git commit");
    expect(prompt).toContain("不要 push");
    expect(prompt).toContain("不要進入 Work / implementation");
    expect(prompt).toContain("不要 markdown");
    expect(prompt).toContain("不要 code fence");
    // 任務脈絡被帶入。
    expect(prompt).toContain("/tmp/ce-target");
    expect(prompt).toContain("登入頁");
    expect(prompt).toContain("需求內容 ABC");
    // 含 Brainstorm / Plan / Audit 三段。
    expect(prompt).toContain("Brainstorm");
    expect(prompt).toContain("Plan");
    expect(prompt).toContain("Audit");
  });

  test("parseCeReadonlyWorkflowJson：純 JSON 可解析", () => {
    const obj = parseCeReadonlyWorkflowJson('{"ok":true,"workflow":{"plan":{"status":"approved"}},"canStartWork":true}');
    expect(obj).not.toBeNull();
    expect((obj as Record<string, unknown>).canStartWork).toBe(true);
  });

  test("parseCeReadonlyWorkflowJson：前後夾雜文字時解析最後一個合法 JSON object", () => {
    const stdout =
      'Thinking...\n{"note":"前面雜訊"}\n結果如下：\n{"ok":true,"workflow":{"brainstorm":{"status":"reviewed"}},"canStartWork":false}\n完成。';
    const obj = parseCeReadonlyWorkflowJson(stdout) as Record<string, unknown>;
    expect(obj).not.toBeNull();
    expect(obj.canStartWork).toBe(false);
    expect(obj).toHaveProperty("workflow");
  });

  test("parseCeReadonlyWorkflowJson：無合法 JSON 回傳 null", () => {
    expect(parseCeReadonlyWorkflowJson("not json at all")).toBeNull();
    expect(parseCeReadonlyWorkflowJson("")).toBeNull();
  });

  test("Phase 77B：parseCeReadonlyWorkflowJson 可解析 ```json code fence 內的 result", () => {
    const stdout =
      '這是分析結果：\n```json\n{"ok":true,"workflow":{"plan":{"status":"approved"}},"canStartWork":true}\n```\n以上。';
    const obj = parseCeReadonlyWorkflowJson(stdout) as Record<string, unknown>;
    expect(obj).not.toBeNull();
    expect(obj.canStartWork).toBe(true);
    expect(obj).toHaveProperty("workflow");
  });

  test("Phase 77B：parseCeReadonlyWorkflowJson 可解析裸 ``` code fence（無語言標籤）內的 result", () => {
    const stdout = "前言\n```\n{\"ok\":true,\"workflow\":{},\"canStartWork\":false}\n```\n結語";
    const obj = parseCeReadonlyWorkflowJson(stdout) as Record<string, unknown>;
    expect(obj).not.toBeNull();
    expect(obj.canStartWork).toBe(false);
  });

  test("Phase 77B：parseCeReadonlyWorkflowJson 可從前後 prose 中抓出最後一個藏起來的 result", () => {
    const stdout =
      "Thinking hard...\nLet me analyze the codebase.\n結果：{\"ok\":true,\"workflow\":{\"audit\":{\"notes\":\"n\"}},\"canStartWork\":true,\"recommendedNextAction\":\"go\"}\nDone analyzing.";
    const obj = parseCeReadonlyWorkflowJson(stdout) as Record<string, unknown>;
    expect(obj).not.toBeNull();
    expect(obj.canStartWork).toBe(true);
    expect(obj.recommendedNextAction).toBe("go");
  });

  test("Phase 77B：多個 JSON object 時取最後一個符合 result schema 者", () => {
    const stdout = [
      '{"note":"draft 1","canStartWork":false}',
      "中間想法...",
      '{"ok":true,"workflow":{"plan":{"status":"approved"}},"canStartWork":true,"rawNotes":"final"}',
    ].join("\n");
    const obj = parseCeReadonlyWorkflowJson(stdout) as Record<string, unknown>;
    expect(obj).not.toBeNull();
    expect(obj.canStartWork).toBe(true);
    expect(obj.rawNotes).toBe("final");
  });

  test("Phase 77B：裸 { brainstorm, plan, audit } 被包成 ok:true workflow result", () => {
    const stdout = JSON.stringify({
      brainstorm: { status: "reviewed", summary: "s" },
      plan: { status: "approved", summary: "p" },
      audit: { notes: "n" },
    });
    const obj = parseCeReadonlyWorkflowJson(stdout) as Record<string, unknown>;
    expect(obj).not.toBeNull();
    expect(obj.ok).toBe(true);
    expect(obj).toHaveProperty("workflow");
    const wf = obj.workflow as Record<string, unknown>;
    expect(wf).toHaveProperty("brainstorm");
    expect(wf).toHaveProperty("plan");
    expect(wf).toHaveProperty("audit");
  });

  test("Phase 77B：extractCeReadonlyWorkflowResult 回報 parseAttempts，解析不到時 result=null", () => {
    const fail = extractCeReadonlyWorkflowResult("this is not json at all 純文字");
    expect(fail.result).toBeNull();
    expect(Array.isArray(fail.attempts)).toBe(true);
    expect(fail.attempts).toContain("whole_stdout_failed");

    const ok = extractCeReadonlyWorkflowResult('{"ok":true,"workflow":{},"canStartWork":true}');
    expect(ok.result).not.toBeNull();
  });

  test("runCeReadonlyWorkflow：projectPath 不存在 → ok=false + project_path_invalid（不呼叫 AI）", async () => {
    const result = (await runCeReadonlyWorkflow({
      task: { projectPath: "/no/such/dir/ce-fn", title: "t", originalRequirement: "r" },
      aiCommand: "claude",
    })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("project_path_invalid");
  });

  test("runCeReadonlyWorkflow：缺 aiCommand → ok=false + runner_error", async () => {
    const dir = makeFakeProject({});
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir } })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("runner_error");
  });

  test("runCeReadonlyWorkflow：AI 輸出合法 workflow JSON → ok=true，帶 workflow / canStartWork / ai", async () => {
    const dir = makeFakeProject({});
    const aiJson = JSON.stringify({
      ok: true,
      workflow: {
        brainstorm: { path: "docs/brainstorms/x.md", summary: "s", status: "reviewed" },
        plan: { path: "docs/plans/x.md", summary: "p", status: "approved" },
        audit: { notes: "n", coreAssumptions: ["a"], riskNotes: ["r"], acceptanceCriteria: ["ac"], checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: true, acceptanceCriteriaReviewed: true, minimalChangeReviewed: true } },
      },
      canStartWork: true,
      recommendedNextAction: "可進入 Work",
      rawNotes: "筆記",
    });
    const aiCommand = makeAiCommand(`process.stdout.write(${JSON.stringify(aiJson)});\n`);
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.canStartWork).toBe(true);
    expect(result.recommendedNextAction).toBe("可進入 Work");
    expect(result).toHaveProperty("workflow");
    const wf = result.workflow as Record<string, unknown>;
    expect(wf).toHaveProperty("plan");
    const ai = result.ai as Record<string, unknown>;
    expect(ai.exitCode).toBe(0);
  });

  test("runCeReadonlyWorkflow：AI 輸出非 JSON → ok=false + invalid_json（含診斷片段，不丟壞 JSON）", async () => {
    const dir = makeFakeProject({});
    const aiCommand = makeAiCommand(`process.stdout.write("this is not json at all");\n`);
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("invalid_json");
    expect(result).toHaveProperty("stdoutPreview");
  });

  test("runCeReadonlyWorkflow：AI 無法啟動 → ok=false + ai_failed", async () => {
    const dir = makeFakeProject({});
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand: "this-binary-does-not-exist-xyz-ce" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("ai_failed");
  });
});

// --- Phase 77A：CE Readonly Workflow readonly violation guard（runner 函式層）---

const READONLY_OK_JSON = JSON.stringify({
  ok: true,
  workflow: {
    brainstorm: { status: "reviewed", summary: "s" },
    plan: { status: "approved", summary: "p" },
    audit: { notes: "n", coreAssumptions: ["a"], riskNotes: ["r"], acceptanceCriteria: ["ac"], checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: true, acceptanceCriteriaReviewed: true, minimalChangeReviewed: true } },
  },
  canStartWork: true,
  recommendedNextAction: "可進入 Work",
  rawNotes: "",
});

/** 在 dir commit 目前所有變更（提供乾淨 baseline 用）；帶 -c 設定避免缺 user 設定。 */
function gitCommitAll(dir: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "baseline", "--no-gpg-sign"]);
}

/**
 * 產生 fake AI 腳本：可選擇先在 cwd（= projectPath）寫一個檔案（模擬違反 readonly），再印出 readonly JSON。
 * runner 以 cwd=projectPath 執行 AI，所以 process.cwd() 內寫檔等同修改 target project。
 */
function makeReadonlyAiCommand(opts: { json: string; touchFile?: string; touchContent?: string }): string {
  const lines: string[] = ['import fs from "node:fs"; import path from "node:path";'];
  if (opts.touchFile) {
    lines.push(`fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(opts.touchFile)}), ${JSON.stringify(opts.touchContent ?? "modified by ai\n")});`);
  }
  lines.push(`process.stdout.write(${JSON.stringify(opts.json)});`);
  return makeAiCommand(`${lines.join("\n")}\n`);
}

test.describe("CE Readonly Workflow readonly guard（Phase 77A）", () => {
  test("1. target 乾淨 + AI 不改檔 → ok=true（不誤判）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
    gitCommitAll(dir); // 乾淨 baseline
    const aiCommand = makeReadonlyAiCommand({ json: READONLY_OK_JSON });
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result).toHaveProperty("workflow");
  });

  test("2. target 原本 dirty + AI 不造成新變化 → ok=true（dirty baseline 不誤判）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
    // 不 commit：package.json 為 untracked → working tree 已 dirty。
    writeFileSync(join(dir, "preexisting.txt"), "pre-existing dirty\n", "utf8");
    const aiCommand = makeReadonlyAiCommand({ json: READONLY_OK_JSON });
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  test("3. target 原本 dirty + AI 又改檔 → ok=false readonly_violation（含 before/after，不回 workflow）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
    writeFileSync(join(dir, "preexisting.txt"), "pre-existing dirty\n", "utf8");
    const aiCommand = makeReadonlyAiCommand({ json: READONLY_OK_JSON, touchFile: "ai-new.txt", touchContent: "ai added this\n" });
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("readonly_violation");
    expect(result).toHaveProperty("before");
    expect(result).toHaveProperty("after");
    expect(result.workflow).toBeUndefined();
    const after = result.after as { statusShort: string };
    expect(after.statusShort).toContain("ai-new.txt");
    // before 不含 ai-new.txt（只有 pre-existing 的 dirty）。
    const before = result.before as { statusShort: string };
    expect(before.statusShort).not.toContain("ai-new.txt");
  });

  test("4. target 乾淨 + AI 新增檔案 → ok=false readonly_violation", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
    gitCommitAll(dir); // 乾淨 baseline
    const aiCommand = makeReadonlyAiCommand({ json: READONLY_OK_JSON, touchFile: "docs-harness.txt", touchContent: "## 16. CE workflow 測試說明\n" });
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("readonly_violation");
    expect(result.workflow).toBeUndefined();
    const before = result.before as { statusShort: string };
    const after = result.after as { statusShort: string };
    expect(before.statusShort.trim()).toBe("");
    expect(after.statusShort).toContain("docs-harness.txt");
  });

  test("5. captureReadonlySnapshot / readonlySnapshotsEqual：同狀態相等、改檔後不等", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
    gitCommitAll(dir);
    const snap1 = await captureReadonlySnapshot(dir);
    const snap2 = await captureReadonlySnapshot(dir);
    expect(readonlySnapshotsEqual(snap1, snap2)).toBe(true);
    writeFileSync(join(dir, "extra.txt"), "x\n", "utf8");
    const snap3 = await captureReadonlySnapshot(dir);
    expect(readonlySnapshotsEqual(snap1, snap3)).toBe(false);
  });
});

// --- Phase 77B：CE Readonly Workflow JSON output hardening（runner 函式層）---

test.describe("CE Readonly Workflow JSON hardening（Phase 77B）", () => {
  test("buildCeReadonlyWorkflowPrompt：強化輸出格式（單一 JSON、首字 {、末字 }、可輸出 failure JSON）", () => {
    const prompt: string = buildCeReadonlyWorkflowPrompt({
      projectPath: "/tmp/ce-target",
      title: "登入頁",
      originalRequirement: "需求 ABC",
    });
    expect(prompt).toContain("單一一個 JSON object");
    expect(prompt).toContain("第一個字元必須是 {");
    expect(prompt).toContain("最後一個字元必須是 }");
    expect(prompt).toContain("不要 markdown");
    expect(prompt).toContain("不要 code fence");
    expect(prompt).toContain('"stoppedReason": "ai_failed"');
  });

  test("runCeReadonlyWorkflow：AI 輸出 ```json code fence → ok=true（解析成功）", async () => {
    const dir = makeFakeProject({});
    const inner = JSON.stringify({
      ok: true,
      workflow: { plan: { status: "approved", summary: "p" } },
      canStartWork: true,
      recommendedNextAction: "go",
      rawNotes: "",
    });
    const fullStdout = "分析完成，結果如下：\n```json\n" + inner + "\n```\n以上。";
    const aiCommand = makeAiCommand(`process.stdout.write(${JSON.stringify(fullStdout)});\n`);
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.canStartWork).toBe(true);
    expect(result).toHaveProperty("workflow");
  });

  test("runCeReadonlyWorkflow：AI 輸出 prose + JSON → ok=true（從雜訊中抓出 result）", async () => {
    const dir = makeFakeProject({});
    const inner = JSON.stringify({ ok: true, workflow: { audit: { notes: "n" } }, canStartWork: false, recommendedNextAction: "補強 plan", rawNotes: "" });
    const fullStdout = "Thinking...\n讓我分析一下。\n結果：" + inner + "\n分析完成。";
    const aiCommand = makeAiCommand(`process.stdout.write(${JSON.stringify(fullStdout)});\n`);
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.canStartWork).toBe(false);
    expect(result.recommendedNextAction).toBe("補強 plan");
  });

  test("runCeReadonlyWorkflow：AI 輸出裸 { brainstorm, plan, audit } → ok=true，包成 workflow", async () => {
    const dir = makeFakeProject({});
    const inner = JSON.stringify({
      brainstorm: { status: "reviewed", summary: "s" },
      plan: { status: "approved", summary: "p" },
      audit: { notes: "n" },
    });
    const aiCommand = makeAiCommand(`process.stdout.write(${JSON.stringify(inner)});\n`);
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const wf = result.workflow as Record<string, unknown>;
    expect(wf).toHaveProperty("brainstorm");
    expect(wf).toHaveProperty("plan");
    expect(wf).toHaveProperty("audit");
  });

  test("runCeReadonlyWorkflow：AI 輸出無法解析 → invalid_json 帶 rawOutputPreview（≤2000）與 parseAttempts", async () => {
    const dir = makeFakeProject({});
    const aiCommand = makeAiCommand(`process.stdout.write("a".repeat(5000));\n`);
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("invalid_json");
    expect(typeof result.rawOutputPreview).toBe("string");
    expect((result.rawOutputPreview as string).length).toBeLessThanOrEqual(2000);
    expect(Array.isArray(result.parseAttempts)).toBe(true);
    // 失敗時不得回 workflow。
    expect(result.workflow).toBeUndefined();
  });

  test("runCeReadonlyWorkflow：readonly_violation 優先於 invalid_json（改檔 + 壞 stdout → readonly_violation）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true });
    gitCommitAll(dir); // 乾淨 baseline
    // AI 既改檔又輸出非 JSON：readonly guard 必須先觸發，回 readonly_violation 而非 invalid_json。
    const aiCommand = makeReadonlyAiCommand({ json: "this is not json at all", touchFile: "ai-new.txt", touchContent: "x\n" });
    const result = (await runCeReadonlyWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R" }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("readonly_violation");
    expect(result.workflow).toBeUndefined();
  });
});

// --- Phase 70：CE Readonly Workflow UI（用 route 攔截 4318，不需真實 runner / 不呼叫 Claude）---

const CE_OK = {
  ok: true,
  workflow: {
    brainstorm: { path: "docs/brainstorms/login.md", summary: "brainstorm 結果", status: "reviewed" },
    plan: { path: "docs/plans/login.md", summary: "plan 結果", status: "approved" },
    audit: {
      notes: "audit 筆記",
      coreAssumptions: ["假設一"],
      riskNotes: ["風險一"],
      acceptanceCriteria: ["驗收一"],
      checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: true, acceptanceCriteriaReviewed: true, minimalChangeReviewed: true },
    },
  },
  canStartWork: true,
  recommendedNextAction: "Audit 通過，可進入 Work",
  rawNotes: "原始筆記",
};

const CE_REJECTED = {
  ok: true,
  workflow: {
    brainstorm: { path: "docs/brainstorms/login.md", summary: "b", status: "reviewed" },
    plan: { path: "docs/plans/login.md", summary: "p", status: "rejected" },
    audit: { notes: "風險過高", checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: false, acceptanceCriteriaReviewed: false, minimalChangeReviewed: false } },
  },
  canStartWork: false,
  recommendedNextAction: "請先補強 plan 的測試策略",
  rawNotes: "",
};

const CE_INVALID = {
  ok: false,
  stoppedReason: "invalid_json",
  message: "Claude CLI 的輸出無法解析為合法 JSON 結果",
  stdoutPreview: "亂碼",
  // Phase 77B：invalid_json debug 摘要。
  rawOutputPreview: "Sure! 這是我的分析（非 JSON）：\n專案看起來需要先補強 plan...",
  parseAttempts: ["whole_stdout_failed", "no_code_fence", "object_scan_no_valid_result"],
};

test("CE Readonly UI：按鈕呼叫 runner、顯示執行中與完成、回填 brainstorm/plan/audit、保留 work/review/compound、canStartWork=true 顯示可進入 Work", async ({ page }) => {
  let ceCount = 0;
  let autoRoundCount = 0;
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceReadonlyDelayMs: 400,
    onCeReadonly: () => { ceCount += 1; },
    onAutoRound: () => { autoRoundCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE70 CE Readonly", "/Users/ryan/Desktop/code/harness");

  // 既有 AI Workflow 區塊與 Phase 69 進度面板存在（不回歸）。
  await expect(page.getByTestId("ai-workflow")).toBeVisible();
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();

  // 先在 Work / Review 與 Compound 填值並保存，稍後驗證不被 CE Readonly 清掉。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await page.getByTestId("aiwf-changed-files").fill("src/Existing.tsx");
  await page.getByTestId("aiwf-test-results").fill("既有測試結果");
  await page.getByTestId("aiwf-toggle-compound").click();
  await page.getByTestId("aiwf-lesson-learned").fill("既有經驗");
  await page.getByTestId("aiwf-save").click();

  // 執行 CE Readonly Workflow。
  await openAdvanced(page);
  await expect(page.getByTestId("ce-readonly-status")).toHaveCount(0);
  await page.getByTestId("ce-readonly-run").click();

  // 1. 顯示執行中 loading。
  const status = page.getByTestId("ce-readonly-status");
  await expect(status).toHaveAttribute("data-phase", "running");
  await expect(status).toContainText("正在執行 CE Readonly Workflow");

  // 2. 呼叫 runner endpoint 一次。
  await expect.poll(() => ceCount).toBe(1);

  // 3. 完成狀態。
  await expect(status).toHaveAttribute("data-phase", "completed");
  await expect(status).toContainText("已完成 CE Readonly Workflow");

  // 4. canStartWork=true 顯示可進入 Work。
  const readiness = page.getByTestId("ce-readonly-readiness");
  await expect(readiness).toHaveAttribute("data-can-start-work", "true");
  await expect(readiness).toContainText("可進入 Work");

  // 5. 回填 brainstorm / plan / audit。
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-path")).toHaveValue("docs/brainstorms/login.md");
  await expect(page.getByTestId("aiwf-brainstorm-status")).toHaveValue("reviewed");
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("approved");
  await page.getByTestId("aiwf-toggle-audit").click();
  await expect(page.getByTestId("aiwf-audit-notes")).toHaveValue("audit 筆記");
  await expect(page.getByTestId("aiwf-audit-core-assumptions")).toHaveValue("假設一");

  // 6. Work / Review / Compound 不被清掉。
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue("src/Existing.tsx");
  await expect(page.getByTestId("aiwf-test-results")).toHaveValue("既有測試結果");
  await expect(page.getByTestId("aiwf-lesson-learned")).toHaveValue("既有經驗");

  // 7. 重新整理後仍保留（已保存到 localStorage）。reload 會清掉 selectedTask（React state），需重新點選任務。
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE70 CE Readonly");
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("approved");
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-lesson-learned")).toHaveValue("既有經驗");

  // 8. 不自動 auto-round、不建立回合、不自動封存。
  expect(autoRoundCount, "不應自動觸發 auto-round").toBe(0);
  await expect(page.locator(".round-card")).toHaveCount(0);
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE70 CE Readonly");
});

test("CE Readonly UI：copy prompt 按鈕仍可用（不影響既有 Phase 68 功能）", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE70 CE Readonly copy", "/Users/ryan/Desktop/code/harness");

  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await page.getByTestId("aiwf-copy-brainstorm").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("ce-brainstorm");
});

test("CE Readonly UI：canStartWork=false / plan rejected 顯示尚不建議進入 Work 與 recommendedNextAction", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_REJECTED });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE70 CE Readonly rejected", "/Users/ryan/Desktop/code/harness");

  await openAdvanced(page);
  await page.getByTestId("ce-readonly-run").click();

  const status = page.getByTestId("ce-readonly-status");
  await expect(status).toHaveAttribute("data-phase", "completed");
  const readiness = page.getByTestId("ce-readonly-readiness");
  await expect(readiness).toHaveAttribute("data-can-start-work", "false");
  await expect(readiness).toContainText("尚不建議進入 Work");
  await expect(readiness).toContainText("請先補強 plan 的測試策略");

  // plan 被回填為 rejected。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("rejected");
});

test("CE Readonly UI：runner 回 invalid_json 時顯示失敗（data-phase=failed）", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_INVALID });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE70 CE Readonly invalid", "/Users/ryan/Desktop/code/harness");

  await openAdvanced(page);
  await page.getByTestId("ce-readonly-run").click();

  const status = page.getByTestId("ce-readonly-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("invalid_json");
  // 失敗不回填、不建立回合。
  await expect(page.getByTestId("ce-readonly-readiness")).toHaveCount(0);
  await expect(page.locator(".round-card")).toHaveCount(0);
});

test("CE Readonly UI（Phase 77B）：invalid_json 顯示 Claude 輸出預覽、不回填、不啟用 Work gate", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_INVALID });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77B CE Readonly invalid preview", "/Users/ryan/Desktop/code/harness");

  await openAdvanced(page);
  await page.getByTestId("ce-readonly-run").click();

  const status = page.getByTestId("ce-readonly-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("invalid_json");

  // 1. 顯示 Claude 輸出預覽。
  const preview = page.getByTestId("ce-readonly-raw-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Claude 輸出預覽");
  await expect(preview).toContainText("這是我的分析（非 JSON）");

  // 2. 不回填 Brainstorm / Plan / Audit、不顯示成功 readiness。
  await expect(page.getByTestId("ce-readonly-readiness")).toHaveCount(0);
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-summary")).toHaveValue("");
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("");

  // 3. Work gate 未被啟用：CE Work 按鈕 disabled。
  await expect(page.getByTestId("ce-work-run")).toBeDisabled();

  // 4. 不保存 aiWorkflow、不建立回合。
  const stored = await readStoredTaskByTitle(page, "PHASE77B CE Readonly invalid preview");
  expect(stored?.aiWorkflow).toBeUndefined();
  await expect(page.locator(".round-card")).toHaveCount(0);
});

const CE_READONLY_VIOLATION = {
  ok: false,
  stoppedReason: "readonly_violation",
  message: "CE Readonly Workflow modified target project files. Please inspect or revert changes before continuing.",
  before: { statusShort: "", diffStat: "", nameStatus: "" },
  after: {
    statusShort: " M docs/harness-architecture.md",
    diffStat: " docs/harness-architecture.md | 4 ++++",
    nameStatus: "M\tdocs/harness-architecture.md",
  },
};

test("CE Readonly UI（Phase 77A）：readonly_violation 顯示清楚錯誤與變更摘要、不回填、不啟用 Work gate", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_READONLY_VIOLATION });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77A readonly violation", "/Users/ryan/Desktop/code/harness");

  await openAdvanced(page);
  await page.getByTestId("ce-readonly-run").click();

  // 1. 顯示 readonly violation 清楚訊息。
  const status = page.getByTestId("ce-readonly-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("CE Readonly Workflow 修改了目標專案檔案，已中止");
  // 顯示 after 變更摘要。
  await expect(page.getByTestId("ce-readonly-violation")).toContainText("docs/harness-architecture.md");

  // 2. 不回填 Brainstorm / Plan / Audit（欄位仍為空）、不顯示成功 readiness。
  await expect(page.getByTestId("ce-readonly-readiness")).toHaveCount(0);
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-summary")).toHaveValue("");
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("");
  await page.getByTestId("aiwf-toggle-audit").click();
  await expect(page.getByTestId("aiwf-audit-notes")).toHaveValue("");

  // 3. Work gate 未被啟用：CE Work 按鈕 disabled。
  await expect(page.getByTestId("ce-work-run")).toBeDisabled();

  // 4. 不保存到 localStorage（aiWorkflow 仍 undefined）、不建立回合。
  const stored = await readStoredTaskByTitle(page, "PHASE77A readonly violation");
  expect(stored?.aiWorkflow).toBeUndefined();
  await expect(page.locator(".round-card")).toHaveCount(0);
});

test("CE Readonly UI：runner 未連線時顯示失敗、不建立回合、不封存", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("dialog", (d) => void d.accept());
  // 攔截 4318 視為連線失敗；health 也連不上（runner 未啟動）。
  await page.route("http://localhost:4318/**", (route) => route.abort("connectionrefused"));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE70 CE Readonly offline", "/Users/ryan/Desktop/code/harness");

  await openAdvanced(page);
  await page.getByTestId("ce-readonly-run").click();

  const status = page.getByTestId("ce-readonly-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("pnpm runner:local");
  await expect(page.locator(".round-card")).toHaveCount(0);
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE70 CE Readonly offline");
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// --- Phase 71：CE Work runner 函式層測試（gate / prompt builder / parser / runCeWorkWorkflow）---

const CE_WORK_APPROVED_WF = {
  plan: { status: "approved", summary: "已審核的 plan", path: "docs/plans/x.md" },
  audit: {
    notes: "audit 筆記",
    coreAssumptions: ["假設一"],
    riskNotes: ["風險一"],
    acceptanceCriteria: ["驗收一"],
    checklist: { coreAssumptionsReviewed: true, riskReviewed: true, scopeReviewed: true, acceptanceCriteriaReviewed: true, minimalChangeReviewed: true },
  },
};

/** 寫一支會修改 cwd 內檔案並輸出指定 stdout 的 fake AI，回傳 aiCommand。 */
function makeWorkAiCommand(stdout: string): string {
  const body = `import { writeFileSync } from 'node:fs';\nwriteFileSync('ce-work-output.txt', 'done\\n');\nprocess.stdout.write(${JSON.stringify(stdout)});\n`;
  return makeAiCommand(body);
}

test.describe("CE Work 函式層（Phase 71）", () => {
  test("buildCeWorkPrompt：要求只依已審核 plan 實作、不額外重構、不 commit / push、只輸出 JSON", () => {
    const prompt: string = buildCeWorkPrompt({
      projectPath: "/tmp/ce-work",
      title: "登入頁",
      originalRequirement: "需求 ABC",
      aiWorkflow: CE_WORK_APPROVED_WF,
    });
    expect(prompt).toContain("只依照已審核通過的 plan 實作");
    expect(prompt).toContain("不要額外重構");
    expect(prompt).toContain("不要修改 unrelated files");
    expect(prompt).toContain("不要 commit");
    expect(prompt).toContain("不要 push");
    expect(prompt).toContain("不要 markdown");
    expect(prompt).toContain("登入頁");
    expect(prompt).toContain("需求 ABC");
    expect(prompt).toContain("已審核的 plan");
    expect(prompt).toContain("audit 筆記");
  });

  test("parseCeWorkJson：純 JSON / 前後夾雜 / work_blocked / 無 JSON", () => {
    expect((parseCeWorkJson('{"ok":true,"changedFiles":["a"]}') as Record<string, unknown>).ok).toBe(true);
    const mixed = parseCeWorkJson('log...\n{"x":1}\n結果：\n{"ok":true,"changedFiles":[],"implementationSummary":"s"}\n done') as Record<string, unknown>;
    expect(mixed.implementationSummary).toBe("s");
    const blocked = parseCeWorkJson('{"ok":false,"stoppedReason":"work_blocked","message":"無法"}') as Record<string, unknown>;
    expect(blocked.ok).toBe(false);
    expect(blocked.stoppedReason).toBe("work_blocked");
    expect(parseCeWorkJson("not json")).toBeNull();
  });

  test("runCeWorkWorkflow：projectPath 不存在 → project_path_invalid（不呼叫 AI）", async () => {
    const result = (await runCeWorkWorkflow({ task: { projectPath: "/no/such/ce-work", aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand: "claude" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("project_path_invalid");
  });

  test("runCeWorkWorkflow：gate 未過（plan rejected）→ work_gate_failed（不呼叫 AI）", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: { plan: { status: "rejected" }, audit: { checklist: CE_WORK_APPROVED_WF.audit.checklist } } }, aiCommand: "this-should-not-run-xyz" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("work_gate_failed");
  });

  test("runCeWorkWorkflow：gate 未過（無 audit）→ work_gate_failed", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: { plan: { status: "approved" } } }, aiCommand: "x" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("work_gate_failed");
  });

  test("runCeWorkWorkflow：Claude 合法 JSON + verification 通過 → ok=true，帶 work / verification / git / ai", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: ["pnpm test"], implementationSummary: "完成實作", notes: "", recommendedNextAction: "請進行 code review" });
    const aiCommand = makeWorkAiCommand(aiJson);
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R", aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const work = result.work as Record<string, unknown>;
    expect(work.changedFiles).toEqual(["ce-work-output.txt"]);
    expect(work.implementationSummary).toBe("完成實作");
    const verification = result.verification as Record<string, unknown>;
    expect(verification.ok).toBe(true);
    const git = result.git as Record<string, unknown>;
    expect(String(git.statusShort)).toContain("ce-work-output.txt");
    const ai = result.ai as Record<string, unknown>;
    expect(ai.exitCode).toBe(0);
  });

  test("runCeWorkWorkflow：Claude 非 JSON → invalid_json（含診斷片段）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const aiCommand = makeWorkAiCommand("this is not json");
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("invalid_json");
    expect(result).toHaveProperty("stdoutPreview");
  });

  test("runCeWorkWorkflow：Claude ok 但 verification 未通過 → verification_failed", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: false });
    const aiJson = JSON.stringify({ ok: true, changedFiles: [], testCommands: [], implementationSummary: "x", notes: "", recommendedNextAction: "" });
    const aiCommand = makeWorkAiCommand(aiJson);
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("verification_failed");
  });

  test("runCeWorkWorkflow：Claude 回 work_blocked → ok=false work_blocked（不跑 verification）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const aiCommand = makeWorkAiCommand(JSON.stringify({ ok: false, stoppedReason: "work_blocked", message: "缺乏資訊" }));
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("work_blocked");
  });

  test("runCeWorkWorkflow：AI 無法啟動 → ai_failed", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand: "this-binary-does-not-exist-xyz-cework" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("ai_failed");
  });
});

// --- Phase 77C：CE Work verification JSON parsing hardening（parser 函式層 + runner）---

const VERIFICATION_REPORT = {
  ok: true,
  commands: [{ name: "tsc", command: "npx tsc --noEmit", exitCode: 0, ok: true }],
  startedAt: "2026-06-12T00:00:00.000Z",
  finishedAt: "2026-06-12T00:00:03.000Z",
  durationMs: 3000,
};

test.describe("CE Work verification JSON hardening（Phase 77C）", () => {
  test("extractVerificationResult：純 JSON verification report", () => {
    const { result, attempts } = extractVerificationResult(JSON.stringify(VERIFICATION_REPORT));
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).ok).toBe(true);
    expect(Array.isArray(attempts)).toBe(true);
  });

  test("extractVerificationResult：前後有 npm log / prose 雜訊但內含 verification JSON", () => {
    const stdout =
      "> fake-target@0.0.0 verify:local\n> node scripts/run-verification.mjs\nnpm warn config ignoring foo\n" +
      JSON.stringify(VERIFICATION_REPORT) +
      "\n\n所有檢查完成。\n";
    const { result } = extractVerificationResult(stdout);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).durationMs).toBe(3000);
  });

  test("extractVerificationResult：markdown code fence 內的 verification JSON", () => {
    const stdout = "驗證結果如下：\n```json\n" + JSON.stringify(VERIFICATION_REPORT) + "\n```\n";
    const { result } = extractVerificationResult(stdout);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).ok).toBe(true);
  });

  test("extractVerificationResult：多個 JSON object 時取最後一個合法 verification report", () => {
    const stdout =
      JSON.stringify({ note: "前置設定", foo: 1 }) +
      "\n中間日誌...\n" +
      JSON.stringify({ ...VERIFICATION_REPORT, finishedAt: "2026-06-12T00:00:09.000Z" });
    const { result } = extractVerificationResult(stdout);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).finishedAt).toBe("2026-06-12T00:00:09.000Z");
  });

  test("extractVerificationResult：無 verification report → result=null 且 attempts 有紀錄", () => {
    const { result, attempts } = extractVerificationResult("npm warn ... 純文字 log，沒有任何 JSON");
    expect(result).toBeNull();
    expect(attempts).toContain("whole_stdout_failed");
  });

  test("runCeWorkWorkflow：verification stdout 前後有 prose + JSON → ok=true（正常回填 work / verification）", async () => {
    const verStdout =
      "> verify:local\nnpm warn config ignoring foo\n" + JSON.stringify(VERIFICATION_REPORT) + "\n完成。\n";
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verificationStdout: verStdout });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: ["pnpm test"], implementationSummary: "完成", notes: "", recommendedNextAction: "請進行 code review" });
    const aiCommand = makeWorkAiCommand(aiJson);
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R", aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const verification = result.verification as Record<string, unknown>;
    expect(verification.ok).toBe(true);
    const work = result.work as Record<string, unknown>;
    expect(work.changedFiles).toEqual(["ce-work-output.txt"]);
  });

  test("runCeWorkWorkflow：verification stdout 為 code fence JSON → ok=true", async () => {
    const verStdout = "驗證結果：\n```json\n" + JSON.stringify(VERIFICATION_REPORT) + "\n```\n";
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verificationStdout: verStdout });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: [], implementationSummary: "完成", notes: "", recommendedNextAction: "" });
    const aiCommand = makeWorkAiCommand(aiJson);
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((result.verification as Record<string, unknown>).ok).toBe(true);
  });

  test("runCeWorkWorkflow：verification stdout 無合法 JSON → verification_failed 帶 rawOutputPreview（≤2000）與 parseAttempts，不回填 work", async () => {
    const verStdout = "npm warn ".repeat(600); // 約 5400 字，無 JSON
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verificationStdout: verStdout });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: [], implementationSummary: "完成", notes: "", recommendedNextAction: "" });
    const aiCommand = makeWorkAiCommand(aiJson);
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("verification_failed");
    expect(typeof result.rawOutputPreview).toBe("string");
    expect((result.rawOutputPreview as string).length).toBeLessThanOrEqual(2000);
    expect(Array.isArray(result.parseAttempts)).toBe(true);
    // 失敗時不回填 work / verification result。
    expect(result.work).toBeUndefined();
    expect(result.verification).toBeUndefined();
  });
});

// --- Phase 77D：verification parser 必須解析實際 run-verification 最外層 report（含很長 TAP stdout）---

/**
 * 接近真實 scripts/run-verification.mjs 輸出的 fixture：最外層 report 含 ok/startedAt/finishedAt/durationMs/commands，
 * commands[1].stdout 是很長的 TAP log（TAP version 13 / # Subtest / 中文 / --- / ... / escaped newline / 跳脫雙引號）。
 * 用 JSON.stringify 產生，確保是合法 JSON（escape 正確），模擬真實 runner 行為。
 */
function makeRealisticVerificationReport(): Record<string, unknown> {
  const longTapStdout =
    "TAP version 13\n" +
    "# Subtest: 架構文件測試\n" +
    "    # Subtest: 應該存在且包含必要章節\n" +
    "    ok 1 - 應該存在且包含必要章節\n" +
    "      ---\n" +
    "      duration_ms: 1.234567\n" +
    '      detail: "包含 {巢狀} 與 \\"跳脫雙引號\\" 與反斜線 \\\\ 的內容"\n' +
    "      ...\n" +
    "    1..1\n" +
    "ok 1 - 架構文件測試\n" +
    "# tests 1\n# pass 1\n# fail 0\n" +
    "中文測試名稱：驗證 } 與 { 不會破壞 bracket matching\n".repeat(40) +
    "1..1\n";
  return {
    ok: true,
    startedAt: "2026-06-12T03:38:06.824Z",
    finishedAt: "2026-06-12T03:38:09.245Z",
    durationMs: 2421,
    commands: [
      { name: "tsc", command: "npx tsc --noEmit", exitCode: 0, ok: true, required: true, stdout: "", stderr: "" },
      { name: "test", command: "node --import tsx --test tests/architecture-doc.test.ts", exitCode: 0, ok: true, required: true, stdout: longTapStdout, stderr: "" },
      { name: "git-status", command: "git status --short", exitCode: 0, ok: true, required: false, stdout: " M docs/harness-architecture.md\n", stderr: "" },
      { name: "git-diff", command: "git diff --stat", exitCode: 0, ok: true, required: false, stdout: " docs/harness-architecture.md | 11 +++++++++++\n 1 file changed, 11 insertions(+)\n", stderr: "" },
    ],
  };
}

test.describe("CE Work verification outer-report parsing（Phase 77D）", () => {
  test("parseVerificationJson(extract)：解析實際 run-verification outer JSON（含很長 TAP stdout）", () => {
    const report = makeRealisticVerificationReport();
    const { result } = extractVerificationResult(JSON.stringify(report, null, 2));
    expect(result).not.toBeNull();
    const r = result as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.commands)).toBe(true);
    expect((r.commands as unknown[]).length).toBe(4);
    expect(r.durationMs).toBe(2421);
  });

  test("stdout 前面有 npm prefix（> harness verify:local / > node ...）仍可解析 outer report", () => {
    const report = makeRealisticVerificationReport();
    const stdout =
      "> harness@1.0.0 verify:local\n> node scripts/run-verification.mjs\n\n" + JSON.stringify(report, null, 2) + "\n";
    const { result } = extractVerificationResult(stdout);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).ok).toBe(true);
    expect(((result as Record<string, unknown>).commands as unknown[]).length).toBe(4);
  });

  test("commands[] 內層 object 有 ok=true 時不得被誤選為 report（lone command object → null）", () => {
    const innerCommand = JSON.stringify({ name: "git-diff", command: "git diff --stat", exitCode: 0, ok: true, required: false, stdout: "x", stderr: "" });
    const { result } = extractVerificationResult(innerCommand);
    expect(result).toBeNull();
  });

  test("report 後面接一個 ok=true 的 command-like object：只選含 commands array 的 outer report", () => {
    const report = makeRealisticVerificationReport();
    const stray = JSON.stringify({ name: "git-diff", command: "git diff --stat", exitCode: 0, ok: true });
    const stdout = JSON.stringify(report) + "\n殘留物件：\n" + stray;
    const { result } = extractVerificationResult(stdout);
    expect(result).not.toBeNull();
    const r = result as Record<string, unknown>;
    // 必須是 outer report（含 commands array），不是 stray command object。
    expect(Array.isArray(r.commands)).toBe(true);
    expect((r.commands as unknown[]).length).toBe(4);
    expect(r.name).toBeUndefined();
  });

  test("commands[].stdout 含 escaped newline / 中文 / --- / ... / # / 很長文字仍可解析", () => {
    const report = makeRealisticVerificationReport();
    const { result } = extractVerificationResult(JSON.stringify(report));
    expect(result).not.toBeNull();
    const commands = (result as Record<string, unknown>).commands as Record<string, unknown>[];
    const testCmd = commands[1];
    expect(typeof testCmd.stdout).toBe("string");
    expect(testCmd.stdout as string).toContain("TAP version 13");
    expect(testCmd.stdout as string).toContain("中文測試名稱");
  });

  test("strict report：缺 commands array 或 ok 非 boolean → 不算 report", () => {
    expect(extractVerificationResult(JSON.stringify({ ok: true })).result).toBeNull(); // 缺 commands
    expect(extractVerificationResult(JSON.stringify({ commands: [] })).result).toBeNull(); // 缺 ok
    expect(extractVerificationResult(JSON.stringify({ ok: "true", commands: [] })).result).toBeNull(); // ok 非 boolean
    expect(extractVerificationResult(JSON.stringify({ ok: true, commands: [1, 2] })).result).toBeNull(); // commands 元素非 object
    expect(extractVerificationResult(JSON.stringify({ ok: true, commands: [] })).result).not.toBeNull(); // 合法精簡 report
  });

  test("runCeWorkWorkflow：實際 run-verification 風格 outer JSON（含很長 TAP stdout）→ ok=true 並回填 work", async () => {
    const report = makeRealisticVerificationReport();
    const verStdout = JSON.stringify(report, null, 2) + "\n";
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verificationStdout: verStdout });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: ["npm run verify:local"], implementationSummary: "完成", notes: "", recommendedNextAction: "請進行 code review" });
    const aiCommand = makeWorkAiCommand(aiJson);
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R", aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify({ stoppedReason: result.stoppedReason, message: result.message })).toBe(true);
    expect((result.verification as Record<string, unknown>).ok).toBe(true);
    expect((result.work as Record<string, unknown>).changedFiles).toEqual(["ce-work-output.txt"]);
  });
});

// --- Phase 77E：verification parser 必須吃「完整 stdout」（修 pipe flush 截斷；preview 截斷只用於 UI debug）---

/**
 * 產生超過指定字數的「實際 run-verification 風格」report：commands[].stdout 塞很長的 TAP log
 * （TAP version 13 / 中文 / escaped newline / --- / ... / #），讓整份 JSON 超過 minJsonLength。
 * fixture 的 run-verification.mjs 印完後會立刻 process.exit(0)：stdout 是 pipe 時這正是
 * 「大輸出被 flush 截斷」的情境（Phase 77E 修正前 parser 只拿得到 JSON 開頭）。
 */
function makeHugeVerificationReport(minJsonLength: number): Record<string, unknown> {
  const tapChunk =
    "TAP version 13\n# Subtest: 架構文件測試\nok 1 - 中文測試名稱（含 --- 與 ... 與 # 與 {大括號}）\n  ---\n  duration_ms: 1.5\n  ...\n";
  let longStdout = "";
  while (JSON.stringify(longStdout).length < minJsonLength) longStdout += tapChunk;
  return {
    ok: true,
    startedAt: "2026-06-12T03:38:06.824Z",
    finishedAt: "2026-06-12T03:38:09.245Z",
    durationMs: 2421,
    commands: [
      { name: "tsc", command: "npx tsc --noEmit", exitCode: 0, ok: true, required: true, stdout: "", stderr: "" },
      { name: "test", command: "node --test", exitCode: 0, ok: true, required: true, stdout: longStdout, stderr: "" },
    ],
  };
}

test.describe("CE Work verification full-stdout parsing（Phase 77E）", () => {
  test("verification JSON 超過 2000 字（rawOutputPreview 截斷範圍）但完整 → ok=true 回填 work", async () => {
    const report = makeHugeVerificationReport(6000);
    const verStdout = JSON.stringify(report, null, 2) + "\n";
    expect(verStdout.length).toBeGreaterThan(2000);
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verificationStdout: verStdout });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: [], implementationSummary: "完成", notes: "", recommendedNextAction: "請進行 code review" });
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand: makeWorkAiCommand(aiJson) })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify({ stoppedReason: result.stoppedReason, message: result.message })).toBe(true);
    expect((result.verification as Record<string, unknown>).ok).toBe(true);
    expect((result.work as Record<string, unknown>).changedFiles).toEqual(["ce-work-output.txt"]);
  });

  test("超大（>200KB，超過 pipe buffer）完整 verification JSON + npm prefix + 立刻 process.exit → parser 仍吃到完整 stdout，ok=true", async () => {
    // Phase 77E 修正前：fixture 印完大 JSON 立刻 exit，pipe 模式下 stdout 被 flush 截斷（只剩開頭），
    // parser 解析失敗 → verification_failed。修正後（stdout 導臨時檔）必須完整解析成功。
    const report = makeHugeVerificationReport(200_000);
    const verStdout = "> fake-target@0.0.0 verify:local\n> node scripts/run-verification.mjs\n\n" + JSON.stringify(report, null, 2) + "\n";
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verifyLocal: true, verificationStdout: verStdout });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: ["npm run verify:local"], implementationSummary: "完成", notes: "", recommendedNextAction: "請進行 code review" });
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R", aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand: makeWorkAiCommand(aiJson) })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify({ stoppedReason: result.stoppedReason, message: result.message })).toBe(true);
    expect((result.verification as Record<string, unknown>).ok).toBe(true);
    expect((result.work as Record<string, unknown>).changedFiles).toEqual(["ce-work-output.txt"]);
  });

  test("verification stdout 超長且無 JSON → verification_failed 帶 stdoutLength（完整長度）+ 截斷 preview，不回傳完整 stdout", async () => {
    const noise = "npm warn 模組解析中（純雜訊、無 JSON）".repeat(5000); // 遠超過 pipe buffer 與 preview 上限
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verificationStdout: noise });
    const aiJson = JSON.stringify({ ok: true, changedFiles: ["ce-work-output.txt"], testCommands: [], implementationSummary: "完成", notes: "", recommendedNextAction: "" });
    const result = (await runCeWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_WORK_APPROVED_WF }, aiCommand: makeWorkAiCommand(aiJson) })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("verification_failed");
    // stdoutLength 是「完整 stdout」的長度（證明 parser 輸入未被截斷），只回 number。
    expect(result.stdoutLength).toBe(noise.length);
    // preview / tail 只用於 UI debug：各自截斷，完整 stdout 不回傳。
    expect((result.rawOutputPreview as string).length).toBeLessThanOrEqual(2000);
    expect((result.stdoutPreview as string).length).toBeLessThanOrEqual(1000);
    expect((result.stdoutTail as string).length).toBeLessThanOrEqual(1000);
    expect(result).not.toHaveProperty("stdout");
    expect(Array.isArray(result.parseAttempts)).toBe(true);
    expect(result.work).toBeUndefined();
    expect(result.verification).toBeUndefined();
  });

  test("CE Fix Work 共用 runCeWorkVerification：超大完整 verification JSON 仍 ok=true（一起受益）", async () => {
    const report = makeHugeVerificationReport(200_000);
    const verStdout = JSON.stringify(report, null, 2) + "\n";
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, verificationStdout: verStdout });
    const aiJson = JSON.stringify({ ok: true, fix: { changedFiles: ["ce-work-output.txt"], testCommands: [], fixSummary: "修正完成", notes: "", recommendedNextAction: "請再次執行 CE Review" } });
    const wf = {
      plan: { status: "approved", summary: "已審核的 plan" },
      audit: { notes: "audit 筆記" },
      workReview: { changedFiles: ["src/App.tsx"], testResults: "本機驗證：通過", codeReviewNotes: "Review result: needs_fix\n\nRecommended fixes:\n- 補上測試" },
    };
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, aiWorkflow: wf }, aiCommand: makeWorkAiCommand(aiJson) })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify({ stoppedReason: result.stoppedReason, message: result.message })).toBe(true);
    expect((result.verification as Record<string, unknown>).ok).toBe(true);
  });
});

// --- Phase 77F：CE Commit checkpoint（使用者確認後 verification → git add tracked → git commit；不 push）---

/** 在 dir 同步執行 git 並回傳 stdout（測試斷言用）。 */
function gitOut(dir: string, args: string[]): string {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout ?? "";
}

/**
 * 建一個可 commit 的 fixture git repo：設定 identity、寫 README baseline、（可選）verification script、
 * baseline commit。verificationOk 省略時不建 run-verification.mjs（runner 視為 skipped）。
 */
function makeCommitProject(opts: { verificationOk?: boolean; detached?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-commit-test-"));
  createdDirs.push(dir);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "CE Test"]);
  writeFileSync(join(dir, "README.md"), "baseline\n", "utf8");
  if (opts.verificationOk !== undefined) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    const report = JSON.stringify({
      ok: opts.verificationOk,
      commands: [{ name: "tsc", command: "npx tsc --noEmit", exitCode: opts.verificationOk ? 0 : 1, ok: opts.verificationOk }],
    });
    writeFileSync(join(dir, "scripts", "run-verification.mjs"), `process.stdout.write(${JSON.stringify(report)});\nprocess.exit(0);\n`, "utf8");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "baseline"]);
  if (opts.detached) git(dir, ["checkout", "--detach"]);
  return dir;
}

/** repo 目前的 commit 數。 */
function commitCount(dir: string): number {
  const out = gitOut(dir, ["rev-list", "--count", "HEAD"]).trim();
  return Number(out) || 0;
}

test.describe("CE Commit checkpoint 函式層（Phase 77F）", () => {
  test("parsePorcelainStatus：modified / deleted / rename / untracked / 引號路徑", () => {
    const porcelain = [
      " M docs/harness-architecture.md",
      "D  src/old.ts",
      "R  src/a.ts -> src/b.ts",
      "?? tmp.txt",
      '?? "with space.txt"',
      "",
    ].join("\n");
    const { tracked, untracked } = parsePorcelainStatus(porcelain) as { tracked: string[]; untracked: string[] };
    expect(tracked).toEqual(["docs/harness-architecture.md", "src/old.ts", "src/b.ts"]);
    expect(untracked).toEqual(["tmp.txt", "with space.txt"]);
  });

  test("isExcludedCommitPath：.env / node_modules / dist / build / coverage / *.log 排除；一般檔不排除", () => {
    expect(isExcludedCommitPath(".env")).toBe(true);
    expect(isExcludedCommitPath(".env.local")).toBe(true);
    expect(isExcludedCommitPath("config/.env.production")).toBe(true);
    expect(isExcludedCommitPath("node_modules/left-pad/index.js")).toBe(true);
    expect(isExcludedCommitPath("dist/app.js")).toBe(true);
    expect(isExcludedCommitPath("packages/x/build/out.js")).toBe(true);
    expect(isExcludedCommitPath("coverage/lcov.info")).toBe(true);
    expect(isExcludedCommitPath("logs/app.log")).toBe(true);
    expect(isExcludedCommitPath("src/App.tsx")).toBe(false);
    expect(isExcludedCommitPath("docs/harness-architecture.md")).toBe(false);
  });

  test("happy path：tracked 變更 + verification ok → commit 成功、回 short hash、status 乾淨", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    writeFileSync(join(dir, "README.md"), "baseline\nupdated\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: update readme" })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(String(result.commitHash)).toMatch(/^[0-9a-f]{4,12}$/);
    expect(result.commitMessage).toBe("docs: update readme");
    expect(typeof result.committedAt).toBe("string");
    expect(result.committedFiles).toEqual(["README.md"]);
    expect((result.verification as Record<string, unknown>).ok).toBe(true);
    expect(String(result.statusBefore)).toContain("README.md");
    // commit 確實建立、working tree 乾淨、message 正確。
    expect(commitCount(dir)).toBe(2);
    expect(gitOut(dir, ["status", "--porcelain"]).trim()).toBe("");
    expect(gitOut(dir, ["log", "-1", "--pretty=%s"]).trim()).toBe("docs: update readme");
  });

  test("git status 乾淨 → nothing_to_commit，不建立 commit", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: nothing" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("nothing_to_commit");
    expect(commitCount(dir)).toBe(1);
  });

  test("commit message 空字串 → invalid_commit_message，不建立 commit", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    writeFileSync(join(dir, "README.md"), "changed\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "   " })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("invalid_commit_message");
    expect(commitCount(dir)).toBe(1);
  });

  test("projectPath 不存在 → project_path_invalid", async () => {
    const result = (await runCeCommitCheckpoint({ projectPath: "/no/such/ce-commit", commitMessage: "x" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("project_path_invalid");
  });

  test("verification 失敗 → verification_failed、帶 verificationPreview、不建立 commit", async () => {
    const dir = makeCommitProject({ verificationOk: false });
    writeFileSync(join(dir, "README.md"), "changed\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: should not commit" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("verification_failed");
    expect(typeof result.verificationPreview).toBe("string");
    expect(commitCount(dir)).toBe(1);
    // 變更仍在 working tree，未被 add / commit。
    expect(gitOut(dir, ["status", "--porcelain"])).toContain("README.md");
  });

  test("只有 untracked files → nothing_to_commit，untracked 不會被默默 commit", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    writeFileSync(join(dir, "new-file.txt"), "untracked\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "feat: untracked only" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("nothing_to_commit");
    expect(result.untrackedFiles).toEqual(["new-file.txt"]);
    expect(String(result.message)).toContain("untracked");
    expect(commitCount(dir)).toBe(1);
  });

  test("tracked 變更 + untracked 並存 → 只 commit tracked，untracked 留在 working tree 並回報", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    writeFileSync(join(dir, "README.md"), "changed\n", "utf8");
    writeFileSync(join(dir, "scratch.txt"), "untracked\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: tracked only" })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.committedFiles).toEqual(["README.md"]);
    expect(result.untrackedFiles).toEqual(["scratch.txt"]);
    // untracked 檔仍是 untracked（沒有被 git add）。
    expect(gitOut(dir, ["status", "--porcelain"]).trim()).toBe("?? scratch.txt");
  });

  test("tracked 的 .env 變更會被排除，不進 commit", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    writeFileSync(join(dir, ".env"), "SECRET=1\n", "utf8");
    git(dir, ["add", ".env"]);
    git(dir, ["commit", "-m", "track env (fixture)"]);
    writeFileSync(join(dir, ".env"), "SECRET=2\n", "utf8");
    writeFileSync(join(dir, "README.md"), "changed\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: no env" })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.committedFiles).toEqual(["README.md"]);
    // .env 變更仍留在 working tree，未被 commit。
    expect(gitOut(dir, ["status", "--porcelain"])).toContain(".env");
    expect(gitOut(dir, ["show", "--stat", "HEAD"])).not.toContain(".env");
  });

  test("body.changedFiles 提供時只 commit 交集內的檔案", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    writeFileSync(join(dir, "README.md"), "changed\n", "utf8");
    writeFileSync(join(dir, "other.md"), "second tracked file\n", "utf8");
    git(dir, ["add", "other.md"]);
    git(dir, ["commit", "-m", "add other (fixture)"]);
    writeFileSync(join(dir, "other.md"), "changed too\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: only readme", changedFiles: ["README.md"] })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.committedFiles).toEqual(["README.md"]);
    expect(gitOut(dir, ["status", "--porcelain"])).toContain("other.md");
  });

  test("detached HEAD worktree 也可 commit", async () => {
    const dir = makeCommitProject({ verificationOk: true, detached: true });
    writeFileSync(join(dir, "README.md"), "detached change\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: detached commit" })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(commitCount(dir)).toBe(2);
    // 仍是 detached HEAD（沒有切 branch、沒動 remote）。
    expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: dir, encoding: "utf8" }).status).not.toBe(0);
  });

  test("不會 push：有 remote 時 commit 後 remote 仍無任何 commit", async () => {
    const dir = makeCommitProject({ verificationOk: true });
    const remoteDir = mkdtempSync(join(tmpdir(), "ce-commit-remote-"));
    createdDirs.push(remoteDir);
    git(remoteDir, ["init", "--bare"]);
    git(dir, ["remote", "add", "origin", remoteDir]);
    writeFileSync(join(dir, "README.md"), "changed\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: local only" })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // remote（bare repo）沒有任何 ref / commit。
    expect(gitOut(remoteDir, ["show-ref"]).trim()).toBe("");
  });

  test("無 verification 機制 → 視為 skipped，仍可 commit（與 CE Work fallback 一致）", async () => {
    const dir = makeCommitProject({});
    writeFileSync(join(dir, "README.md"), "changed\n", "utf8");
    const result = (await runCeCommitCheckpoint({ projectPath: dir, commitMessage: "docs: no verification" })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((result.verification as Record<string, unknown>).skipped).toBe(true);
  });
});

test("POST /ce-commit-checkpoint：endpoint 存在；projectPath 不存在 → 200 + project_path_invalid；health 列出 endpoint", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/ce-commit-checkpoint`, {
    data: { projectPath: "/no/such/dir/ce-commit", commitMessage: "x" },
  });
  expect(res.status()).toBe(200);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("project_path_invalid");

  const health: Record<string, unknown> = await (await request.get(`${RUNNER_BASE}/health`)).json();
  expect(health.endpoints).toEqual(expect.arrayContaining(["/ce-commit-checkpoint"]));
});

test("POST /ce-commit-checkpoint：body 非合法 JSON → 400 + runner_error", async ({ request }) => {
  const res = await request.post(`${RUNNER_BASE}/ce-commit-checkpoint`, {
    headers: { "Content-Type": "application/json" },
    data: "not json {oops",
  });
  expect(res.status()).toBe(400);
  const body: Record<string, unknown> = await res.json();
  expect(body.ok).toBe(false);
  expect(body.stoppedReason).toBe("runner_error");
});

// --- Phase 71：CE Work UI（用 route 攔截 4318，不需真實 runner / 不呼叫 Claude）---

const CE_WORK_OK = {
  ok: true,
  work: {
    changedFiles: ["src/App.tsx"],
    testCommands: ["pnpm test:run"],
    testResults: "",
    implementationSummary: "依 plan 完成實作",
    notes: "",
    recommendedNextAction: "請進行 code review",
  },
  verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc --noEmit", ok: true }] },
  git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 4 ++--" },
  ai: { command: "claude", exitCode: 0 },
};

/** 在已選任務上跑 CE Readonly（CE_OK），讓 plan=approved + audit checklist 5/5 回填，使 CE Work gate 通過。 */
async function runReadonlyToUnlockWork(page: Page): Promise<void> {
  await openAdvanced(page);
  await page.getByTestId("ce-readonly-run").click();
  await expect(page.getByTestId("ce-readonly-status")).toHaveAttribute("data-phase", "completed");
}

test("CE Work UI：gate 未過時「開始 CE Work」disabled，並顯示尚不建議進入 Work", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE71 CE Work gate disabled", "/Users/ryan/Desktop/code/harness");

  // 新任務沒有 plan/audit → gate 不過。
  await openAdvanced(page);
  await expect(page.getByTestId("ce-work-run")).toBeDisabled();
  await expect(page.getByTestId("ce-work-gate-hint")).toContainText("尚不建議進入 Work");
});

test("CE Work UI：CE Readonly 通過後 enabled；confirm 後呼叫 /ce-work、回填 workReview、保留其他段、不封存/不完成", async ({ page }) => {
  let ceWorkCount = 0;
  let completionApplied = false;
  let decision: "dismiss" | "accept" = "dismiss";
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    if (decision === "accept") void d.accept();
    else void d.dismiss();
  });
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: CE_WORK_OK,
    ceWorkDelayMs: 300,
    onCeWork: () => { ceWorkCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE71 CE Work flow", "/Users/ryan/Desktop/code/harness");

  // gate 一開始不過。
  await openAdvanced(page);
  await expect(page.getByTestId("ce-work-run")).toBeDisabled();

  // 跑 CE Readonly 回填 plan=approved + audit checklist 5/5 → gate 通過。
  await runReadonlyToUnlockWork(page);
  await expect(page.getByTestId("ce-work-run")).toBeEnabled();

  // 先填 compound 並保存，稍後驗證 CE Work 不覆蓋。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-compound").click();
  await page.getByTestId("aiwf-lesson-learned").fill("既有經驗");
  await page.getByTestId("aiwf-save").click();

  // 1. 按下會跳 confirm；先 cancel → 不呼叫 /ce-work。
  await page.getByTestId("ce-work-run").click();
  await expect.poll(() => dialogs.some((m) => m.includes("CE Work 會允許 Claude 修改目標專案檔案"))).toBe(true);
  await expect.poll(() => ceWorkCount).toBe(0);
  await expect(page.getByTestId("ce-work-status")).toHaveCount(0);

  // 2. confirm 後呼叫 /ce-work，顯示 loading，完成後回填。
  decision = "accept";
  await page.getByTestId("ce-work-run").click();
  const status = page.getByTestId("ce-work-status");
  await expect(status).toHaveAttribute("data-phase", "running");
  await expect(status).toContainText("正在執行 CE Work");
  await expect.poll(() => ceWorkCount).toBe(1);
  await expect(status).toHaveAttribute("data-phase", "completed");
  await expect(status).toContainText("已完成 CE Work");

  // 3. 回填 workReview。
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue("src/App.tsx");
  await expect(page.getByTestId("aiwf-test-commands")).toHaveValue("pnpm test:run");
  await expect(page.getByTestId("aiwf-test-results")).toContainText("本機驗證：通過");
  await expect(page.getByTestId("aiwf-code-review-notes")).toHaveValue("待 Review");

  // 4. 保留 brainstorm / plan / audit / compound。
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-path")).toHaveValue("docs/brainstorms/login.md");
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("approved");
  await page.getByTestId("aiwf-toggle-audit").click();
  await expect(page.getByTestId("aiwf-audit-notes")).toHaveValue("audit 筆記");
  await expect(page.getByTestId("aiwf-lesson-learned")).toHaveValue("既有經驗");

  // 5. 不自動套用完成狀態、不自動封存、不建立回合。
  completionApplied = await page.evaluate(() => {
    const raw = localStorage.getItem("ai-coding-relay:task-store") ?? "";
    return /"status"\s*:\s*"done"/.test(raw) || /completion_applied/.test(raw) || /"archived"\s*:\s*true/.test(raw);
  });
  expect(completionApplied, "不應自動完成 / 封存").toBe(false);
  await expect(page.locator(".round-card")).toHaveCount(0);
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE71 CE Work flow");

  // 6. reload 後 workReview 仍保留（已存 localStorage）。
  await page.reload();
  await page.locator(".task-card").first().click();
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue("src/App.tsx");
});

test("CE Work UI：runner 回失敗（work_gate_failed）時顯示失敗、不回填", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: { ok: false, stoppedReason: "work_gate_failed", message: "Audit 尚未通過，不建議進入 Work。" },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE71 CE Work fail", "/Users/ryan/Desktop/code/harness");
  await runReadonlyToUnlockWork(page);

  await page.getByTestId("ce-work-run").click();
  const status = page.getByTestId("ce-work-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("work_gate_failed");
  // 失敗不建立回合。
  await expect(page.locator(".round-card")).toHaveCount(0);
});

test("CE Work UI（Phase 77C）：verification_failed 顯示 Verification 輸出預覽、不回填 Work、不啟用 Review gate", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: {
      ok: false,
      stoppedReason: "verification_failed",
      message: "verification 輸出無法解析為合法 JSON",
      rawOutputPreview: "> verify:local\nnpm warn config ignoring foo\n（後面沒有任何合法 verification JSON）",
      parseAttempts: ["whole_stdout_failed", "no_code_fence", "no_verification_report"],
    },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77C CE Work verification failed", "/Users/ryan/Desktop/code/harness");
  await runReadonlyToUnlockWork(page);

  await page.getByTestId("ce-work-run").click();
  const status = page.getByTestId("ce-work-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("verification_failed");

  // 1. 顯示 Verification 輸出預覽。
  const preview = page.getByTestId("ce-work-raw-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Verification 輸出預覽");
  await expect(preview).toContainText("npm warn config ignoring foo");

  // 2. 不回填 Work：workReview 仍空、Review gate（ce-review-run）未啟用。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue("");
  await expect(page.getByTestId("ce-review-run")).toBeDisabled();

  // 3. 不建立回合。
  await expect(page.locator(".round-card")).toHaveCount(0);
});

test("CE Work UI（Phase 77E）：verification_failed 顯示 Verification stdout length（只顯示字數，不顯示完整 stdout）", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: {
      ok: false,
      stoppedReason: "verification_failed",
      message: "verification 輸出無法解析為合法 JSON",
      rawOutputPreview: '{\n  "ok": true,\n  "startedAt": "2026-06-12T03:38:06.824Z",（被截斷的開頭）',
      parseAttempts: ["whole_stdout_failed", "no_code_fence", "no_verification_report"],
      stdoutLength: 123456,
    },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77E CE Work stdout length", "/Users/ryan/Desktop/code/harness");
  await runReadonlyToUnlockWork(page);

  await page.getByTestId("ce-work-run").click();
  const status = page.getByTestId("ce-work-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("verification_failed");

  // 顯示完整 stdout 的字數，且 preview 仍在（preview 只是 debug 顯示）。
  await expect(page.getByTestId("ce-work-stdout-length")).toHaveText("Verification stdout length: 123456");
  await expect(page.getByTestId("ce-work-raw-preview")).toBeVisible();

  // 不回填 Work、Review gate 不開。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue("");
  await expect(page.getByTestId("ce-review-run")).toBeDisabled();
});

test("CE Work UI：不影響 CE Readonly / Copy Prompt 按鈕 / 進度面板", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK, ceWorkBody: CE_WORK_OK });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE71 CE Work no-regression", "/Users/ryan/Desktop/code/harness");

  // 進度面板與 CE Readonly runner 仍在。
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();
  await openAdvanced(page);
  await expect(page.getByTestId("ce-readonly-run")).toBeVisible();

  // Copy Prompt 仍可用。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-plan").click();
  await page.getByTestId("aiwf-copy-plan").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("ce-plan");
});

// --- Phase 72：CE Review runner 函式層測試（gate / prompt builder / parser / runCeReviewWorkflow）---

const CE_REVIEW_WORKED_WF = {
  plan: { status: "approved", summary: "已審核的 plan", path: "docs/plans/x.md" },
  audit: { notes: "audit 筆記" },
  workReview: { changedFiles: ["src/App.tsx"], testCommands: ["pnpm test:run"], testResults: "本機驗證：通過" },
};

test.describe("CE Review 函式層（Phase 72）", () => {
  test("buildCeReviewPrompt：要求唯讀、不修改/新增/刪除檔案、不 commit / push、不自動修正、只輸出 JSON", () => {
    const prompt: string = buildCeReviewPrompt({
      projectPath: "/tmp/ce-review",
      title: "登入頁",
      originalRequirement: "需求 ABC",
      aiWorkflow: CE_REVIEW_WORKED_WF,
    });
    expect(prompt).toContain("只做唯讀 review");
    expect(prompt).toContain("不要修改任何檔案");
    expect(prompt).toContain("不要新增檔案");
    expect(prompt).toContain("不要刪除檔案");
    expect(prompt).toContain("不要 commit");
    expect(prompt).toContain("不要 push");
    expect(prompt).toContain("不要自動修正");
    expect(prompt).toContain("不要 markdown");
    expect(prompt).toContain("登入頁");
    expect(prompt).toContain("需求 ABC");
    // 帶入 Work 結果。
    expect(prompt).toContain("src/App.tsx");
    expect(prompt).toContain("本機驗證：通過");
  });

  test("parseCeReviewJson：純 JSON / 前後夾雜 / review_blocked / 無 JSON", () => {
    expect((parseCeReviewJson('{"ok":true,"review":{"result":"passed"}}') as Record<string, unknown>).ok).toBe(true);
    const mixed = parseCeReviewJson('log...\n{"x":1}\n結果：\n{"ok":true,"review":{"result":"needs_fix"}}\n done') as Record<string, unknown>;
    expect(mixed).toHaveProperty("review");
    const blocked = parseCeReviewJson('{"ok":false,"stoppedReason":"review_blocked","message":"無法"}') as Record<string, unknown>;
    expect(blocked.ok).toBe(false);
    expect(blocked.stoppedReason).toBe("review_blocked");
    expect(parseCeReviewJson("not json")).toBeNull();
  });

  test("runCeReviewWorkflow：projectPath 不存在 → project_path_invalid（不呼叫 AI）", async () => {
    const result = (await runCeReviewWorkflow({ task: { projectPath: "/no/such/ce-review", aiWorkflow: CE_REVIEW_WORKED_WF }, aiCommand: "claude" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("project_path_invalid");
  });

  test("runCeReviewWorkflow：gate 未過（無 Work 結果）→ review_gate_failed（不呼叫 AI）", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const result = (await runCeReviewWorkflow({ task: { projectPath: dir, aiWorkflow: { plan: { status: "approved" } } }, aiCommand: "this-should-not-run-xyz" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("review_gate_failed");
  });

  test("runCeReviewWorkflow：Claude 合法 JSON → ok=true，帶 review / git / ai；runner 不寫入 target（git 仍乾淨）", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const reviewJson = JSON.stringify({ ok: true, review: { result: "passed", notes: "看起來不錯", issues: [], testGaps: [], riskNotes: [], recommendedFixes: [], recommendedNextAction: "可標記完成" } });
    const aiCommand = makeAiCommand(`process.stdout.write(${JSON.stringify(reviewJson)});\n`);
    const result = (await runCeReviewWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R", aiWorkflow: CE_REVIEW_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const review = result.review as Record<string, unknown>;
    expect(review.result).toBe("passed");
    expect(review.recommendedNextAction).toBe("可標記完成");
    const git = result.git as Record<string, unknown>;
    // fake AI 只寫 stdout、runner 唯讀，故 git 仍乾淨（無新增/修改檔案）。
    expect(String(git.statusShort).trim()).toBe("");
    const ai = result.ai as Record<string, unknown>;
    expect(ai.exitCode).toBe(0);
  });

  test("runCeReviewWorkflow：review.result 非白名單 → 視為 needs_fix（保守）", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const aiCommand = makeAiCommand(`process.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, review: { result: "maybe" } }))});\n`);
    const result = (await runCeReviewWorkflow({ task: { projectPath: dir, aiWorkflow: CE_REVIEW_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect((result.review as Record<string, unknown>).result).toBe("needs_fix");
  });

  test("runCeReviewWorkflow：Claude 非 JSON → invalid_json（含診斷片段）", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const aiCommand = makeAiCommand(`process.stdout.write("this is not json");\n`);
    const result = (await runCeReviewWorkflow({ task: { projectPath: dir, aiWorkflow: CE_REVIEW_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("invalid_json");
    expect(result).toHaveProperty("stdoutPreview");
  });

  test("runCeReviewWorkflow：Claude 回 review_blocked → ok=false review_blocked", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const aiCommand = makeAiCommand(`process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, stoppedReason: "review_blocked", message: "資訊不足" }))});\n`);
    const result = (await runCeReviewWorkflow({ task: { projectPath: dir, aiWorkflow: CE_REVIEW_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("review_blocked");
  });

  test("runCeReviewWorkflow：AI 無法啟動 → ai_failed", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const result = (await runCeReviewWorkflow({ task: { projectPath: dir, aiWorkflow: CE_REVIEW_WORKED_WF }, aiCommand: "this-binary-does-not-exist-xyz-cereview" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("ai_failed");
  });
});

// --- Phase 72：CE Review UI（用 route 攔截 4318，不需真實 runner / 不呼叫 Claude）---

const CE_REVIEW_PASSED = {
  ok: true,
  review: { result: "passed", notes: "整體符合需求", issues: [], testGaps: [], riskNotes: [], recommendedFixes: [], recommendedNextAction: "可標記完成" },
  git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 2 +-" },
  ai: { command: "claude", exitCode: 0 },
};

const CE_REVIEW_NEEDS_FIX = {
  ok: true,
  review: { result: "needs_fix", notes: "缺測試", issues: ["問題一"], testGaps: ["缺 A"], riskNotes: [], recommendedFixes: ["補測試"], recommendedNextAction: "請補測試" },
  git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 2 +-" },
  ai: { command: "claude", exitCode: 0 },
};

/** 在已選任務上把 changedFiles / testResults 填入 workReview 並保存，使 CE Review gate 通過。 */
async function seedWorkResult(page: Page): Promise<void> {
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await page.getByTestId("aiwf-changed-files").fill("src/App.tsx");
  await page.getByTestId("aiwf-test-commands").fill("pnpm test:run");
  await page.getByTestId("aiwf-test-results").fill("本機驗證：通過");
  await page.getByTestId("aiwf-save").click();
}

test("CE Review UI：Work 沒結果時「開始 CE Review」disabled，並顯示尚未有 Work 結果", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE72 CE Review gate disabled", "/Users/ryan/Desktop/code/harness");

  await openAdvanced(page);
  await expect(page.getByTestId("ce-review-run")).toBeDisabled();
  await expect(page.getByTestId("ce-review-gate-hint")).toContainText("尚未有 Work 結果");
});

test("CE Review UI：Work 有結果後 enabled；cancel confirm 不呼叫；confirm 後呼叫、回填 codeReviewNotes、不覆蓋其他、不封存/不完成", async ({ page }) => {
  let ceReviewCount = 0;
  let decision: "dismiss" | "accept" = "dismiss";
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    if (decision === "accept") void d.accept();
    else void d.dismiss();
  });
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    ceReviewDelayMs: 300,
    onCeReview: () => { ceReviewCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE72 CE Review flow", "/Users/ryan/Desktop/code/harness");

  // gate 一開始不過。
  await openAdvanced(page);
  await expect(page.getByTestId("ce-review-run")).toBeDisabled();

  // 先跑 CE Readonly 回填 brainstorm/plan/audit，再填 compound，再填 Work 結果。
  await page.getByTestId("ce-readonly-run").click();
  await expect(page.getByTestId("ce-readonly-status")).toHaveAttribute("data-phase", "completed");
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-compound").click();
  await page.getByTestId("aiwf-lesson-learned").fill("既有經驗");
  await seedWorkResult(page);

  await expect(page.getByTestId("ce-review-run")).toBeEnabled();

  // 1. cancel confirm → 不呼叫 /ce-review。
  await page.getByTestId("ce-review-run").click();
  await expect.poll(() => dialogs.some((m) => m.includes("CE Review 只會讀取目標專案"))).toBe(true);
  await expect.poll(() => ceReviewCount).toBe(0);
  await expect(page.getByTestId("ce-review-status")).toHaveCount(0);

  // 2. confirm → 呼叫 /ce-review，loading，完成後回填。
  decision = "accept";
  await page.getByTestId("ce-review-run").click();
  const status = page.getByTestId("ce-review-status");
  await expect(status).toHaveAttribute("data-phase", "running");
  await expect(status).toContainText("正在執行 CE Review");
  await expect.poll(() => ceReviewCount).toBe(1);
  await expect(status).toHaveAttribute("data-phase", "completed");
  await expect(page.getByTestId("ce-review-verdict")).toHaveAttribute("data-verdict", "passed");

  // 3. 回填 codeReviewNotes（含 Review result: passed）。
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-code-review-notes")).toHaveValue(/Review result: passed/);

  // 4. 不覆蓋 changedFiles / testCommands / testResults。
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue("src/App.tsx");
  await expect(page.getByTestId("aiwf-test-commands")).toHaveValue("pnpm test:run");
  await expect(page.getByTestId("aiwf-test-results")).toHaveValue("本機驗證：通過");

  // 5. 不覆蓋 Brainstorm / Plan / Audit / Compound。
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-path")).toHaveValue("docs/brainstorms/login.md");
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("approved");
  await expect(page.getByTestId("aiwf-lesson-learned")).toHaveValue("既有經驗");

  // 6. 不自動套用完成狀態 / 不自動封存 / 不自動改 reviewResult / 不建立回合。
  await expect(page.locator(".review-select")).toHaveAttribute("data-review", "not_reviewed");
  const autoFinished = await page.evaluate(() => {
    const raw = localStorage.getItem("ai-coding-relay:task-store") ?? "";
    return /"status"\s*:\s*"done"/.test(raw) || /completion_applied/.test(raw) || /"archived"\s*:\s*true/.test(raw);
  });
  expect(autoFinished, "不應自動完成 / 封存").toBe(false);
  await expect(page.locator(".round-card")).toHaveCount(0);

  // 7. reload 後 codeReviewNotes 保留。
  await page.reload();
  await page.locator(".task-card").first().click();
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-code-review-notes")).toHaveValue(/Review result: passed/);
});

test("CE Review UI：needs_fix 顯示「Review 需要修正」", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReviewBody: CE_REVIEW_NEEDS_FIX });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE72 CE Review needs_fix", "/Users/ryan/Desktop/code/harness");
  await seedWorkResult(page);

  await openAdvanced(page);
  await page.getByTestId("ce-review-run").click();
  const status = page.getByTestId("ce-review-status");
  await expect(status).toHaveAttribute("data-phase", "completed");
  const verdict = page.getByTestId("ce-review-verdict");
  await expect(verdict).toHaveAttribute("data-verdict", "needs_fix");
  await expect(verdict).toContainText("Review 需要修正");
  // needs_fix 不自動執行 Work 修正、不建立回合。
  await expect(page.locator(".round-card")).toHaveCount(0);
});

test("CE Review UI：runner 回 review_blocked 時顯示失敗、不回填", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReviewBody: { ok: false, stoppedReason: "review_blocked", message: "資訊不足" } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE72 CE Review blocked", "/Users/ryan/Desktop/code/harness");
  await seedWorkResult(page);

  await openAdvanced(page);
  await page.getByTestId("ce-review-run").click();
  const status = page.getByTestId("ce-review-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("review_blocked");
  // 失敗不回填 codeReviewNotes（維持空白）。
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-code-review-notes")).toHaveValue("");
});

test("CE Review UI：不影響 CE Readonly / CE Work runner / Copy Prompt / 進度面板", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK, ceWorkBody: CE_WORK_OK, ceReviewBody: CE_REVIEW_PASSED });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE72 CE Review no-regression", "/Users/ryan/Desktop/code/harness");

  // 三個 runner 與進度面板都在。
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();
  await openAdvanced(page);
  await expect(page.getByTestId("ce-readonly-run")).toBeVisible();
  await expect(page.getByTestId("ce-work-run")).toBeVisible();
  await expect(page.getByTestId("ce-review-run")).toBeVisible();

  // Copy Prompt 仍可用。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await page.getByTestId("aiwf-copy-brainstorm").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("ce-brainstorm");
});

// --- Phase 73A：CE Review Passed Completion Gate（沿用 Phase 65 applyCompletion）---

/** 讀 localStorage task-store 內指定標題的任務。 */
async function readStoredTaskByTitle(page: Page, title: string): Promise<Record<string, unknown> | null> {
  return page.evaluate((t) => {
    const raw = localStorage.getItem("ai-coding-relay:task-store");
    if (!raw) return null;
    const store = JSON.parse(raw) as { tasks?: Array<Record<string, unknown>> };
    return (store.tasks ?? []).find((x) => x.title === t) ?? null;
  }, title);
}

/** createTask → seedWorkResult → 跑 CE Review（passed）→ 回填 codeReviewNotes 使 completion gate 出現。 */
async function reachCeReviewPassed(page: Page, title: string): Promise<void> {
  await createTask(page, title, "/Users/ryan/Desktop/code/harness");
  await seedWorkResult(page);
  await openAdvanced(page);
  await page.getByTestId("ce-review-run").click();
  await expect(page.getByTestId("ce-review-status")).toHaveAttribute("data-phase", "completed");
}

test("CE Completion Gate：CE Review passed 後顯示建議與「套用 CE 完成狀態」；改 summary 後套用 → done/passed/done + completionHistory，不封存", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReviewBody: CE_REVIEW_PASSED });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await reachCeReviewPassed(page, "PHASE73A CE completion passed");

  // 1. completion gate 顯示。
  const gate = page.getByTestId("ce-completion-gate");
  await expect(gate).toBeVisible();
  await expect(gate).toContainText("CE Review 已通過");
  await expect(gate).toContainText("建議套用完成狀態");
  await expect(page.getByTestId("ce-completion-apply")).toBeVisible();
  // CE 流程無回合 → 不應出現 auto-round 完成建議（避免兩個完成按鈕）。
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);

  // 2. 改寫 summary textarea（不另外按保存摘要）。
  const mysummary = "PHASE73A：CE Review 通過，完成。";
  await page.locator(".summary-textarea").fill(mysummary);

  // 3. 按「套用 CE 完成狀態」→ 沿用 Phase 65 applyCompletion。
  await page.getByTestId("ce-completion-apply").click();

  await expect(page.locator(".status-select")).toHaveValue("done");
  await expect(page.locator(".review-select")).toHaveValue("passed");
  await expect(page.locator(".workflow-stage-select")).toHaveValue("done");

  // 4. gate 消失、完成紀錄出現。
  await expect(page.getByTestId("ce-completion-gate")).toHaveCount(0);
  const history = page.getByTestId("completion-history");
  await expect(history).toBeVisible();
  await expect(history).toContainText("已保存摘要並套用完成狀態");

  // 5. localStorage 正確、不自動封存。
  const stored = await readStoredTaskByTitle(page, "PHASE73A CE completion passed");
  expect(stored?.summary).toBe(mysummary);
  expect(stored?.status).toBe("done");
  expect(stored?.reviewResult).toBe("passed");
  expect(stored?.workflowStage).toBe("done");
  expect(typeof stored?.completedAt).toBe("string");
  expect(stored?.archived).not.toBe(true);
  const events = stored?.completionHistory as Array<Record<string, unknown>>;
  expect(Array.isArray(events)).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("completion_applied");
  expect(events[0].summarySaved).toBe(true);
  expect(events[0].status).toBe("done");
  // codeReviewNotes（Brainstorm/Plan/Audit 不在此驗，workReview 仍保留）。
  const wf = stored?.aiWorkflow as { workReview?: { codeReviewNotes?: string; changedFiles?: string[] } } | undefined;
  expect(wf?.workReview?.changedFiles).toContain("src/App.tsx");
  expect(String(wf?.workReview?.codeReviewNotes)).toContain("Review result: passed");
});

test("CE Completion Gate：summary 空白也可套用，summarySaved=false，顯示摘要為空提示", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReviewBody: CE_REVIEW_PASSED });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await reachCeReviewPassed(page, "PHASE73A CE completion empty summary");

  // 確保 summary 為空。
  await page.locator(".summary-textarea").fill("");
  const gate = page.getByTestId("ce-completion-gate");
  await expect(gate).toContainText("摘要為空");

  await page.getByTestId("ce-completion-apply").click();
  await expect(page.locator(".status-select")).toHaveValue("done");

  const history = page.getByTestId("completion-history");
  await expect(history).toContainText("已套用完成狀態；摘要為空");

  const stored = await readStoredTaskByTitle(page, "PHASE73A CE completion empty summary");
  expect(stored?.status).toBe("done");
  const events = stored?.completionHistory as Array<Record<string, unknown>>;
  expect(events[0].summarySaved).toBe(false);
  expect(stored?.archived).not.toBe(true);
});

test("CE Completion Gate：CE Review needs_fix 時不顯示完成按鈕，改顯示需要修正提示", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReviewBody: CE_REVIEW_NEEDS_FIX });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await reachCeReviewPassed(page, "PHASE73A CE completion needs_fix");

  await expect(page.getByTestId("ce-completion-gate")).toHaveCount(0);
  await expect(page.getByTestId("ce-completion-apply")).toHaveCount(0);
  const needsFix = page.getByTestId("ce-completion-needs-fix");
  await expect(needsFix).toBeVisible();
  await expect(needsFix).toContainText("CE Review 需要修正");
  await expect(needsFix).toContainText("recommended fixes");

  // 不自動完成 / 不自動封存。
  await expect(page.locator(".status-select")).not.toHaveValue("done");
  const stored = await readStoredTaskByTitle(page, "PHASE73A CE completion needs_fix");
  expect(stored?.status).not.toBe("done");
  expect(stored?.archived).not.toBe(true);
});

test("CE Completion Gate：無 CE Review 結果的新任務不顯示 gate（不影響既有 runner / copy 按鈕）", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK, ceWorkBody: CE_WORK_OK, ceReviewBody: CE_REVIEW_PASSED });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE73A no gate", "/Users/ryan/Desktop/code/harness");

  // 未跑 CE Review → 不顯示 completion gate / needs-fix。
  await expect(page.getByTestId("ce-completion-gate")).toHaveCount(0);
  await expect(page.getByTestId("ce-completion-needs-fix")).toHaveCount(0);

  // 三個 runner 與進度面板不受影響。
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();
  await openAdvanced(page);
  await expect(page.getByTestId("ce-readonly-run")).toBeVisible();
  await expect(page.getByTestId("ce-work-run")).toBeVisible();
  await expect(page.getByTestId("ce-review-run")).toBeVisible();
});

// --- Phase 77F：CE Commit checkpoint UI（用 route 攔截 4318，不需真實 runner / 不呼叫 Claude / 不真的 commit）---

/** 跑 CE Readonly + 填 Work 結果 + 跑 CE Review（passed），讓 Commit checkpoint 出現。 */
async function reachReviewPassed(page: Page): Promise<void> {
  await openAdvanced(page);
  await page.getByTestId("ce-readonly-run").click();
  await expect(page.getByTestId("ce-readonly-status")).toHaveAttribute("data-phase", "completed");
  await seedWorkResult(page);
  await page.getByTestId("ce-review-run").click();
  await expect(page.getByTestId("ce-review-status")).toHaveAttribute("data-phase", "completed");
  await expect(page.getByTestId("ce-review-verdict")).toHaveAttribute("data-verdict", "passed");
}

test("CE Commit UI：Review 未 passed 時不顯示；passed 後自動產生可編輯 commit message 與檔案摘要", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK, ceReviewBody: CE_REVIEW_PASSED });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77F add commit checkpoint", "/Users/ryan/Desktop/code/harness");

  // Review 未 passed → 區塊不顯示。
  await openAdvanced(page);
  await expect(page.getByTestId("ce-commit-checkpoint")).toHaveCount(0);

  await reachReviewPassed(page);

  // passed 後顯示，且自動產生 conventional commit message（英文標題直接當 subject）。
  const block = page.getByTestId("ce-commit-checkpoint");
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute("data-committed", "false");
  const message = page.getByTestId("ce-commit-message");
  await expect(message).toHaveValue(/^(feat|fix|docs|test): /);
  await expect(message).toHaveValue(/add commit checkpoint/i);

  // 顯示本次將 commit 的檔案摘要（來自 workReview.changedFiles）。
  await expect(page.getByTestId("ce-commit-files")).toContainText("src/App.tsx");

  // message 可編輯。
  await message.fill("docs: my edited message");
  await expect(message).toHaveValue("docs: my edited message");

  // 清空 message 時「確認並 Commit」disabled。
  await message.fill("");
  await expect(page.getByTestId("ce-commit-run")).toBeDisabled();
});

test("CE Commit UI：按「確認並 Commit」呼叫 /ce-commit-checkpoint（帶編輯後 message），成功後 ✅、寫回 hash、下一步 Compound", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  const commitRequests: string[] = [];
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    ceCommitBody: {
      ok: true,
      commitMessage: "docs: my edited message",
      commitHash: "abc1234",
      committedAt: "2026-06-13T00:00:00.000Z",
      committedFiles: ["src/App.tsx"],
      untrackedFiles: [],
      verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc --noEmit", ok: true }] },
      statusBefore: " M src/App.tsx",
      diffStatBefore: " src/App.tsx | 2 +-",
    },
    onCeCommit: (postData) => { commitRequests.push(postData); },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77F CE Commit flow", "/Users/ryan/Desktop/code/harness");
  await reachReviewPassed(page);

  // commit 進度此時尚未完成。
  await expect(page.getByTestId("aiwf-step-commit")).not.toHaveAttribute("data-state", "completed");

  // 編輯 message 後按確認並 Commit。
  await page.getByTestId("ce-commit-message").fill("docs: my edited message");
  await page.getByTestId("ce-commit-run").click();

  // 呼叫 /ce-commit-checkpoint，帶編輯後 message、projectPath 與 changedFiles。
  await expect.poll(() => commitRequests.length).toBe(1);
  const req = JSON.parse(commitRequests[0]) as Record<string, unknown>;
  expect(req.commitMessage).toBe("docs: my edited message");
  expect(req.projectPath).toBe("/Users/ryan/Desktop/code/harness");
  expect(req.changedFiles).toEqual(["src/App.tsx"]);

  // 成功後：卡片變完成、顯示 message / hash / committedAt / files、下一步 Compound。
  const block = page.getByTestId("ce-commit-checkpoint");
  await expect(block).toHaveAttribute("data-committed", "true");
  await expect(page.getByTestId("ce-commit-done-message")).toContainText("docs: my edited message");
  await expect(page.getByTestId("ce-commit-done-hash")).toContainText("abc1234");
  await expect(page.getByTestId("ce-commit-done-at")).toContainText("2026-06-13");
  await expect(page.getByTestId("ce-commit-done-files")).toContainText("src/App.tsx");
  await expect(page.getByTestId("ce-commit-next")).toContainText("Compound");

  // 進度面板 Commit ✅。
  await expect(page.getByTestId("aiwf-step-commit")).toHaveAttribute("data-state", "completed");

  // 欄位已寫回（workReview.commitHash / commitMessage）。
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-commit-hash")).toHaveValue("abc1234");
  await expect(page.getByTestId("aiwf-commit-message")).toHaveValue("docs: my edited message");

  // reload 後保留（已持久化）。
  await page.reload();
  await page.locator(".task-card").first().click();
  await openAdvanced(page);
  await expect(page.getByTestId("ce-commit-checkpoint")).toHaveAttribute("data-committed", "true");
  await expect(page.getByTestId("aiwf-step-commit")).toHaveAttribute("data-state", "completed");
});

test("CE Commit UI：runner 回失敗（nothing_to_commit）→ 不標記 ✅、顯示錯誤與 untracked 警告", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    ceCommitBody: {
      ok: false,
      stoppedReason: "nothing_to_commit",
      message: "沒有可 commit 的 tracked 變更（有 1 個 untracked file，不會自動加入 commit）",
      untrackedFiles: ["scratch.txt"],
    },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77F CE Commit nothing", "/Users/ryan/Desktop/code/harness");
  await reachReviewPassed(page);

  await page.getByTestId("ce-commit-run").click();
  const status = page.getByTestId("ce-commit-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("nothing_to_commit");
  await expect(page.getByTestId("ce-commit-untracked")).toContainText("scratch.txt");

  // 不標記完成。
  await expect(page.getByTestId("ce-commit-checkpoint")).toHaveAttribute("data-committed", "false");
  await expect(page.getByTestId("aiwf-step-commit")).not.toHaveAttribute("data-state", "completed");
});

test("CE Commit UI：verification_failed 顯示 verification preview，不標記 ✅", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    ceCommitBody: {
      ok: false,
      stoppedReason: "verification_failed",
      message: "verification 未通過（verification.ok !== true），不執行 commit",
      verificationPreview: '{"ok": false, "commands": [...]}（verification 輸出開頭）',
    },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77F CE Commit verify fail", "/Users/ryan/Desktop/code/harness");
  await reachReviewPassed(page);

  await page.getByTestId("ce-commit-run").click();
  const status = page.getByTestId("ce-commit-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("verification_failed");
  await expect(status).toContainText("verification 輸出開頭");
  await expect(page.getByTestId("ce-commit-checkpoint")).toHaveAttribute("data-committed", "false");
});

test("CE Commit UI：「只記錄 smoke checkpoint」不呼叫 endpoint，寫入固定標記 hash 並標記 ✅", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  let ceCommitCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    onCeCommit: () => { ceCommitCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE77F CE Commit smoke", "/Users/ryan/Desktop/code/harness");
  await reachReviewPassed(page);

  await page.getByTestId("ce-commit-smoke").click();

  // 不呼叫 /ce-commit-checkpoint。
  expect(ceCommitCount).toBe(0);

  // 寫入固定標記 hash，Commit 進度 ✅。
  await expect(page.getByTestId("ce-commit-checkpoint")).toHaveAttribute("data-committed", "true");
  await expect(page.getByTestId("ce-commit-done-hash")).toContainText("not committed - smoke test only");
  await expect(page.getByTestId("aiwf-step-commit")).toHaveAttribute("data-state", "completed");
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-commit-hash")).toHaveValue("not committed - smoke test only");
});

// --- Phase 78：一鍵 CE Pipeline UI（route 攔截 4318；Work 前 / Commit 前必須人工確認；不 push）---

/** 開新頁 + 清 localStorage + 建立帶 projectPath 的任務（pipeline 測試共用前置）。 */
async function setupPipelinePage(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, title, "/Users/ryan/Desktop/code/harness");
}

test("CE Pipeline：Run 後自動跑 Readonly → 停在 waiting_work_confirmation，不自動 Work", async ({ page }) => {
  let readonlyCount = 0;
  let workCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    onCeReadonly: () => { readonlyCount += 1; },
    onCeWork: () => { workCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline readonly stop");

  await page.getByTestId("ce-pipeline-run").click();

  const status = page.getByTestId("ce-pipeline-status");
  await expect(status).toHaveAttribute("data-status", "waiting_work_confirmation");
  await expect.poll(() => readonlyCount).toBe(1);
  expect(workCount, "Work 不可自動執行").toBe(0);

  // 確認區顯示 plan / audit checklist 摘要與確認按鈕。
  const summary = page.getByTestId("ce-pipeline-work-summary");
  await expect(summary).toContainText("plan 結果");
  await expect(summary).toContainText("Audit checklist：5/5");
  await expect(page.getByTestId("ce-pipeline-confirm-work")).toBeVisible();
  // Run 按鈕在 pipeline 進行中 disabled。
  await expect(page.getByTestId("ce-pipeline-run")).toBeDisabled();
});

test("CE Pipeline：Readonly failed → failed 顯示 stoppedReason / preview，不呼叫 Work", async ({ page }) => {
  let workCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: { ok: false, stoppedReason: "invalid_json", message: "Claude 輸出無法解析", rawOutputPreview: "雜訊輸出開頭…" },
    onCeWork: () => { workCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline readonly failed");

  await page.getByTestId("ce-pipeline-run").click();

  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "failed");
  const error = page.getByTestId("ce-pipeline-error");
  await expect(error).toContainText("invalid_json");
  await expect(error).toContainText("雜訊輸出開頭");
  expect(workCount).toBe(0);
  // 失敗後可重新啟動。
  await expect(page.getByTestId("ce-pipeline-run")).toBeEnabled();
});

test("CE Pipeline：Confirm Work → Work → 自動 Review（passed）→ 產生 commit message 停在 commit 確認；顯示無關變更警告；不呼叫 commit", async ({ page }) => {
  let workCount = 0;
  let reviewCount = 0;
  let commitCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    // git status 含一個與 changedFiles 無關的檔案 → 應顯示警告。
    ceWorkBody: {
      ...CE_WORK_OK,
      git: { statusShort: " M src/App.tsx\n M src/unrelated.ts", diffStat: " src/App.tsx | 4 ++--" },
    },
    ceReviewBody: CE_REVIEW_PASSED,
    onCeWork: () => { workCount += 1; },
    onCeReview: () => { reviewCount += 1; },
    onCeCommit: () => { commitCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline to commit confirmation");

  await page.getByTestId("ce-pipeline-run").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "waiting_work_confirmation");
  expect(workCount).toBe(0);

  await page.getByTestId("ce-pipeline-confirm-work").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "waiting_commit_confirmation");
  await expect.poll(() => workCount).toBe(1);
  await expect.poll(() => reviewCount).toBe(1);
  expect(commitCount, "Commit 不可自動執行").toBe(0);

  // 產生 conventional commit message，可編輯。
  const message = page.getByTestId("ce-pipeline-commit-message");
  await expect(message).toHaveValue(/^(feat|fix|docs|test): /);
  await message.fill("docs: edited in pipeline");
  await expect(message).toHaveValue("docs: edited in pipeline");

  // changed files / diff stat / verification summary。
  await expect(page.getByTestId("ce-pipeline-changed-files")).toContainText("src/App.tsx");
  await expect(page.getByTestId("ce-pipeline-verification-summary")).toContainText("verification 通過");
  // 無關變更警告。
  await expect(page.getByTestId("ce-pipeline-unrelated")).toContainText("src/unrelated.ts");

  // 步驟紀錄含 Readonly / Work / Review。
  const logText = await page.getByTestId("ce-pipeline-log").textContent();
  expect(logText).toContain("Readonly");
  expect(logText).toContain("Work");
  expect(logText).toContain("Review");
});

test("CE Pipeline：Work failed → 停止，不呼叫 Review", async ({ page }) => {
  let reviewCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: { ok: false, stoppedReason: "verification_failed", message: "verification 輸出無法解析為合法 JSON", rawOutputPreview: "verification stdout 開頭…" },
    onCeReview: () => { reviewCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline work failed");

  await page.getByTestId("ce-pipeline-run").click();
  await page.getByTestId("ce-pipeline-confirm-work").click();

  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId("ce-pipeline-error")).toContainText("verification_failed");
  expect(reviewCount, "Work 失敗不可自動 Review").toBe(0);
});

test("CE Pipeline：Review needs_fix → 停止顯示 recommended fixes，不自動 Fix，既有 CE Fix Work 區塊接手", async ({ page }) => {
  let fixCount = 0;
  let commitCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: CE_WORK_OK,
    ceReviewBody: CE_REVIEW_NEEDS_FIX,
    onCeFixWork: () => { fixCount += 1; },
    onCeCommit: () => { commitCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline needs fix");

  await page.getByTestId("ce-pipeline-run").click();
  await page.getByTestId("ce-pipeline-confirm-work").click();

  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "needs_fix");
  await expect(page.getByTestId("ce-pipeline-needs-fix")).toContainText("補測試");
  expect(fixCount, "不可自動進 CE Fix Work").toBe(0);
  expect(commitCount).toBe(0);
  // 既有 CE Fix Work 區塊出現（codeReviewNotes 已回填 needs_fix）。
  await openAdvanced(page);
  await expect(page.getByTestId("ce-fix-work-run")).toBeVisible();
});

test("CE Pipeline：Confirm Commit → commit → 自動 Compound → 自動保存 → completed；export 預設不自動", async ({ page }) => {
  const commitRequests: string[] = [];
  let exportCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: CE_WORK_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    ceCommitBody: {
      ok: true,
      commitMessage: "docs: pipeline commit",
      commitHash: "f78abcd",
      committedAt: "2026-06-13T02:00:00.000Z",
      committedFiles: ["src/App.tsx"],
      untrackedFiles: [],
      verification: { ok: true, commands: [] },
      statusBefore: " M src/App.tsx",
      diffStatBefore: "",
    },
    onCeCommit: (postData) => { commitRequests.push(postData); },
    onExport: () => { exportCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline full chain");

  await page.getByTestId("ce-pipeline-run").click();
  await page.getByTestId("ce-pipeline-confirm-work").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "waiting_commit_confirmation");

  await page.getByTestId("ce-pipeline-commit-message").fill("docs: pipeline commit");
  await page.getByTestId("ce-pipeline-confirm-commit").click();

  // 呼叫 /ce-commit-checkpoint，帶編輯後 message 與 projectPath。
  await expect.poll(() => commitRequests.length).toBe(1);
  const req = JSON.parse(commitRequests[0]) as Record<string, unknown>;
  expect(req.commitMessage).toBe("docs: pipeline commit");
  expect(req.projectPath).toBe("/Users/ryan/Desktop/code/harness");

  // completed：commit hash / compound / 手動匯出按鈕（export 預設不自動）。
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("ce-pipeline-commit-hash")).toContainText("f78abcd");
  await expect(page.getByTestId("ce-pipeline-compound")).toContainText("Compound Notes 已產生");
  expect(exportCount, "export 預設不可自動").toBe(0);
  await expect(page.getByTestId("ce-pipeline-export")).toBeVisible();

  // Compound 已自動產生並寫進欄位。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-lesson-learned")).not.toHaveValue("");

  // 自動保存：reload 後 commit hash / compound 保留。
  await page.reload();
  await page.locator(".task-card").first().click();
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-commit-hash")).toHaveValue("f78abcd");
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-lesson-learned")).not.toHaveValue("");
  // 進度面板 Commit ✅。
  await expect(page.getByTestId("aiwf-step-commit")).toHaveAttribute("data-state", "completed");

  // completed 後可手動匯出。
});

test("CE Pipeline：勾選自動匯出 → commit + compound 後自動呼叫 export 並顯示結果", async ({ page }) => {
  let exportCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: CE_WORK_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    exportBody: { ok: true, artifact: { relativeDir: "docs/ai-workflows/phase78", absoluteDir: "/p/docs/ai-workflows/phase78", files: [] } },
    onExport: () => { exportCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline auto export");

  await page.getByTestId("ce-pipeline-auto-export").check();
  await page.getByTestId("ce-pipeline-run").click();
  await page.getByTestId("ce-pipeline-confirm-work").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "waiting_commit_confirmation");
  await page.getByTestId("ce-pipeline-confirm-commit").click();

  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "completed");
  await expect.poll(() => exportCount).toBe(1);
  await expect(page.getByTestId("ce-pipeline-export-result")).toContainText("docs/ai-workflows/phase78");
});

test("CE Pipeline：Cancel 後不繼續執行後續步驟", async ({ page }) => {
  let workCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    onCeWork: () => { workCount += 1; },
  });
  await setupPipelinePage(page, "PHASE78 pipeline cancel");

  await page.getByTestId("ce-pipeline-run").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "waiting_work_confirmation");

  await page.getByTestId("ce-pipeline-cancel").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "cancelled");
  // 確認按鈕消失、不會再呼叫 Work、Run 可重新啟動。
  await expect(page.getByTestId("ce-pipeline-confirm-work")).toHaveCount(0);
  expect(workCount).toBe(0);
  await expect(page.getByTestId("ce-pipeline-run")).toBeEnabled();
});

test("CE Pipeline：不影響既有手動按鈕（CE Readonly / Work / Review / Commit checkpoint 區塊仍在）", async ({ page }) => {
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK });
  await setupPipelinePage(page, "PHASE78 pipeline no regression");

  await expect(page.getByTestId("ce-pipeline-run")).toBeVisible();
  await openAdvanced(page);
  await expect(page.getByTestId("ce-readonly-run")).toBeVisible();
  await expect(page.getByTestId("ce-work-run")).toBeVisible();
  await expect(page.getByTestId("ce-review-run")).toBeVisible();
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();
});

// --- Phase 79B：完成 workflow 不可誤跑 Pipeline + desktop 雙欄版面 ---

const CE_COMMIT_DONE = {
  ok: true,
  commitMessage: "docs: pipeline commit",
  commitHash: "f79done",
  committedAt: "2026-06-13T03:00:00.000Z",
  committedFiles: ["src/App.tsx"],
  untrackedFiles: [],
  verification: { ok: true, commands: [] },
  statusBefore: " M src/App.tsx",
  diffStatBefore: "",
};

test("CE Pipeline（Phase 79B）：完成一輪後 reload，CE Pipeline 顯示已完成、Run disabled、不再呼叫 Readonly", async ({ page }) => {
  let readonlyCount = 0;
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: CE_WORK_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    ceCommitBody: CE_COMMIT_DONE,
    onCeReadonly: () => { readonlyCount += 1; },
  });
  await setupPipelinePage(page, "PHASE79B completed rerun guard");

  // 跑完整一輪到 completed。
  await page.getByTestId("ce-pipeline-run").click();
  await page.getByTestId("ce-pipeline-confirm-work").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "waiting_commit_confirmation");
  await page.getByTestId("ce-pipeline-confirm-commit").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "completed");
  expect(readonlyCount).toBe(1);

  // 完成後（status 仍 completed），data-completed=true 且 Run 已 disabled，避免立即誤跑。
  await expect(page.getByTestId("ce-pipeline")).toHaveAttribute("data-completed", "true");
  await expect(page.getByTestId("ce-pipeline-run")).toBeDisabled();

  // reload 後（status 重置為 idle，但 workflow 已完成）：顯示已完成提示、Run disabled 文字「Pipeline 已完成」。
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.getByTestId("ce-pipeline")).toHaveAttribute("data-completed", "true");
  const run = page.getByTestId("ce-pipeline-run");
  await expect(run).toBeDisabled();
  await expect(run).toHaveText("Pipeline 已完成");
  await expect(page.getByTestId("ce-pipeline-completed-notice")).toBeVisible();
  // 不會再自動 / 誤觸 Readonly。
  expect(readonlyCount).toBe(1);
});

test("CE Pipeline（Phase 79B）：未完成 workflow 仍可 Run（按鈕 enabled 且會呼叫 Readonly）", async ({ page }) => {
  let readonlyCount = 0;
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK, onCeReadonly: () => { readonlyCount += 1; } });
  await setupPipelinePage(page, "PHASE79B not completed runnable");

  await expect(page.getByTestId("ce-pipeline")).toHaveAttribute("data-completed", "false");
  const run = page.getByTestId("ce-pipeline-run");
  await expect(run).toBeEnabled();
  await expect(run).toHaveText("Run CE Pipeline");
  await expect(page.getByTestId("ce-pipeline-completed-notice")).toHaveCount(0);

  await run.click();
  await expect.poll(() => readonlyCount).toBe(1);
});

test("AI Workflow（Phase 79B）：desktop 雙欄版面 — wide layout wrapper 與右側 summary panel 存在", async ({ page }) => {
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK });
  await setupPipelinePage(page, "PHASE79B layout");

  // 雙欄 wrapper 與 summary panel 存在且可見。
  const layout = page.getByTestId("aiwf-layout");
  await expect(layout).toBeVisible();
  const sidePanel = page.getByTestId("aiwf-summary-panel");
  await expect(sidePanel).toBeVisible();
  // summary panel 內含進度總覽。
  await expect(sidePanel.getByTestId("aiwf-progress")).toBeVisible();

  // desktop（viewport ≥1100）summary panel 應在主流程右側（grid 第二欄）。
  const sideBox = await sidePanel.boundingBox();
  const pipelineBox = await page.getByTestId("ce-pipeline").boundingBox();
  expect(sideBox, "summary panel 應有版面位置").not.toBeNull();
  expect(pipelineBox, "pipeline 卡片應有版面位置").not.toBeNull();
  if (sideBox && pipelineBox) {
    // summary panel 左緣明顯比 pipeline 卡片右側更靠右（即在右欄，不是擠在左邊）。
    expect(sideBox.x).toBeGreaterThan(pipelineBox.x + 200);
  }
});

test("AI Workflow（Phase 79B）：narrow viewport（<1100）fallback 單欄，summary panel 仍存在於上方", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK });
  await setupPipelinePage(page, "PHASE79B narrow layout");

  const sidePanel = page.getByTestId("aiwf-summary-panel");
  await expect(sidePanel).toBeVisible();
  const sideBox = await sidePanel.boundingBox();
  const pipelineBox = await page.getByTestId("ce-pipeline").boundingBox();
  // 單欄：summary panel 與 pipeline 卡片左緣大致對齊（非並排）。
  if (sideBox && pipelineBox) {
    expect(Math.abs(sideBox.x - pipelineBox.x)).toBeLessThan(40);
    // summary panel 在 pipeline 卡片上方。
    expect(sideBox.y).toBeLessThan(pipelineBox.y);
  }
});

// --- Phase 80：AI Workflow UI cleanup — 主畫面以 Run CE Pipeline 為主，舊手動流程 / 欄位收進折疊區 ---

test("AI Workflow（Phase 80）：主畫面以 Run CE Pipeline 為主；Advanced 與 Workflow details 預設收合", async ({ page }) => {
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK });
  await setupPipelinePage(page, "PHASE80 main entry cleanup");

  // 主入口與常駐元件可見。
  await expect(page.getByTestId("ce-pipeline-run")).toBeVisible();
  await expect(page.getByTestId("aiwf-save")).toBeVisible();
  await expect(page.getByTestId("aiwf-summary-panel")).toBeVisible();
  await expect(page.getByTestId("aiwf-summary-card")).toBeVisible();

  // Advanced manual controls 預設收合（無 open 屬性），舊手動按鈕不直接顯示在主畫面。
  expect(await page.getByTestId("aiwf-advanced").getAttribute("open")).toBeNull();
  await expect(page.getByTestId("ce-readonly-run")).not.toBeVisible();
  await expect(page.getByTestId("ce-work-run")).not.toBeVisible();
  await expect(page.getByTestId("ce-review-run")).not.toBeVisible();

  // Workflow details 預設收合，欄位不直接顯示。
  expect(await page.getByTestId("aiwf-workflow-details").getAttribute("open")).toBeNull();
  await expect(page.getByTestId("aiwf-brainstorm-path")).not.toBeVisible();
});

test("AI Workflow（Phase 80）：展開 Advanced 後手動按鈕可見；展開 Workflow details 後欄位可見", async ({ page }) => {
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK });
  await setupPipelinePage(page, "PHASE80 expand controls");

  // 展開 Advanced manual controls → 舊手動 CE Readonly / Work / Review 按鈕仍可操作。
  await page.getByTestId("aiwf-advanced-toggle").click();
  await expect(page.getByTestId("ce-readonly-run")).toBeVisible();
  await expect(page.getByTestId("ce-work-run")).toBeVisible();
  await expect(page.getByTestId("ce-review-run")).toBeVisible();

  // 展開 Workflow details → Brainstorm / Plan / Audit / Work·Review / Compound accordion 仍可看到。
  await page.getByTestId("aiwf-workflow-details-toggle").click();
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-path")).toBeVisible();
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-generate-compound")).toBeVisible();
});

test("AI Workflow（Phase 80）：完成 workflow 後主畫面乾淨 — Run disabled、Advanced 仍收合、手動流程不在主畫面", async ({ page }) => {
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReadonlyBody: CE_OK,
    ceWorkBody: CE_WORK_OK,
    ceReviewBody: CE_REVIEW_PASSED,
    ceCommitBody: CE_COMMIT_DONE,
  });
  await setupPipelinePage(page, "PHASE80 completed clean");

  await page.getByTestId("ce-pipeline-run").click();
  await page.getByTestId("ce-pipeline-confirm-work").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "waiting_commit_confirmation");
  await page.getByTestId("ce-pipeline-confirm-commit").click();
  await expect(page.getByTestId("ce-pipeline-status")).toHaveAttribute("data-status", "completed");

  // 完成後：Run disabled、Advanced 仍預設收合、舊手動流程不直接顯示在主畫面。
  await expect(page.getByTestId("ce-pipeline-run")).toBeDisabled();
  expect(await page.getByTestId("aiwf-advanced").getAttribute("open")).toBeNull();
  await expect(page.getByTestId("ce-readonly-run")).not.toBeVisible();
  await expect(page.getByTestId("ce-commit-run")).not.toBeVisible();
  // summary 摘要卡反映完成（commit hash 與 review passed）。
  await expect(page.getByTestId("aiwf-summary-commit")).toContainText("f79done");
  await expect(page.getByTestId("aiwf-summary-review")).toContainText("passed");
});

// --- Phase 73B：CE Fix Work runner 函式層測試（gate / prompt builder / parser / runCeFixWorkWorkflow）---

const CE_FIX_WORKED_WF = {
  plan: { status: "approved", summary: "已審核的 plan" },
  audit: { notes: "audit 筆記" },
  workReview: {
    changedFiles: ["src/App.tsx"],
    testCommands: ["pnpm test:run"],
    testResults: "本機驗證：通過",
    codeReviewNotes: "Review result: needs_fix\n\nRecommended fixes:\n- 補上測試",
  },
};

test.describe("CE Fix Work 函式層（Phase 73B）", () => {
  test("buildCeFixWorkPrompt：要求只修 recommended fixes、最小修改、不重新設計 / 不 unrelated / 不 commit-push、只輸出 JSON", () => {
    const prompt: string = buildCeFixWorkPrompt({
      projectPath: "/tmp/ce-fix",
      title: "登入頁",
      originalRequirement: "需求 ABC",
      aiWorkflow: CE_FIX_WORKED_WF,
    });
    expect(prompt).toContain("只修 CE Review 提出的 needs_fix / recommended fixes");
    expect(prompt).toContain("只做最小修改");
    expect(prompt).toContain("不要重新設計");
    expect(prompt).toContain("不要額外重構");
    expect(prompt).toContain("不要修改 unrelated files");
    expect(prompt).toContain("不要 commit");
    expect(prompt).toContain("不要 push");
    expect(prompt).toContain("不要 markdown");
    expect(prompt).toContain("登入頁");
    // 帶入原 Work 結果與 Review。
    expect(prompt).toContain("src/App.tsx");
    expect(prompt).toContain("Review result: needs_fix");
    expect(prompt).toContain("補上測試");
  });

  test("parseCeFixWorkJson：純 JSON / 前後夾雜 / fix_blocked / 無 JSON", () => {
    expect((parseCeFixWorkJson('{"ok":true,"fix":{"changedFiles":["a"]}}') as Record<string, unknown>).ok).toBe(true);
    const mixed = parseCeFixWorkJson('log...\n{"x":1}\n結果：\n{"ok":true,"fix":{"fixSummary":"s"}}\n done') as Record<string, unknown>;
    expect(mixed).toHaveProperty("fix");
    const blocked = parseCeFixWorkJson('{"ok":false,"stoppedReason":"fix_blocked","message":"無法"}') as Record<string, unknown>;
    expect(blocked.ok).toBe(false);
    expect(blocked.stoppedReason).toBe("fix_blocked");
    expect(parseCeFixWorkJson("not json")).toBeNull();
  });

  test("runCeFixWorkWorkflow：projectPath 不存在 → project_path_invalid（不呼叫 AI）", async () => {
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: "/no/such/ce-fix", aiWorkflow: CE_FIX_WORKED_WF }, aiCommand: "claude" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("project_path_invalid");
  });

  test("runCeFixWorkWorkflow：gate 未過（非 needs_fix）→ fix_gate_failed（不呼叫 AI）", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, aiWorkflow: { workReview: { changedFiles: ["src/App.tsx"], codeReviewNotes: "Review result: passed" } } }, aiCommand: "this-should-not-run-xyz" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("fix_gate_failed");
  });

  test("runCeFixWorkWorkflow：gate 未過（needs_fix 但無 Work 結果）→ fix_gate_failed", async () => {
    const dir = makeFakeProject({ gitInit: true });
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, aiWorkflow: { workReview: { codeReviewNotes: "Review result: needs_fix" } } }, aiCommand: "x" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("fix_gate_failed");
  });

  test("runCeFixWorkWorkflow：Claude 合法 JSON + verification 通過 → ok=true，帶 fix / verification / git / ai", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const aiJson = JSON.stringify({ ok: true, fix: { changedFiles: ["ce-work-output.txt"], testCommands: ["pnpm test"], fixSummary: "補上測試", notes: "", recommendedNextAction: "請再次執行 CE Review" } });
    const aiCommand = makeWorkAiCommand(aiJson);
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, title: "T", originalRequirement: "R", aiWorkflow: CE_FIX_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const fix = result.fix as Record<string, unknown>;
    expect(fix.changedFiles).toEqual(["ce-work-output.txt"]);
    expect(fix.fixSummary).toBe("補上測試");
    const verification = result.verification as Record<string, unknown>;
    expect(verification.ok).toBe(true);
    const git = result.git as Record<string, unknown>;
    expect(String(git.statusShort)).toContain("ce-work-output.txt");
    const ai = result.ai as Record<string, unknown>;
    expect(ai.exitCode).toBe(0);
  });

  test("runCeFixWorkWorkflow：Claude 非 JSON → invalid_json（含診斷片段）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const aiCommand = makeWorkAiCommand("this is not json");
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_FIX_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("invalid_json");
    expect(result).toHaveProperty("stdoutPreview");
  });

  test("runCeFixWorkWorkflow：Claude 回 fix_blocked → ok=false fix_blocked（不跑 verification）", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const aiCommand = makeWorkAiCommand(JSON.stringify({ ok: false, stoppedReason: "fix_blocked", message: "無法安全修正" }));
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_FIX_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("fix_blocked");
  });

  test("runCeFixWorkWorkflow：Claude ok 但 verification 未通過 → verification_failed", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: false });
    const aiCommand = makeWorkAiCommand(JSON.stringify({ ok: true, fix: { changedFiles: [], testCommands: [], fixSummary: "x", notes: "", recommendedNextAction: "" } }));
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_FIX_WORKED_WF }, aiCommand })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("verification_failed");
  });

  test("runCeFixWorkWorkflow：AI 無法啟動 → ai_failed", async () => {
    const dir = makeFakeProject({ gitInit: true, withPackageJson: true, runVerificationOk: true });
    const result = (await runCeFixWorkWorkflow({ task: { projectPath: dir, aiWorkflow: CE_FIX_WORKED_WF }, aiCommand: "this-binary-does-not-exist-xyz-cefix" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.stoppedReason).toBe("ai_failed");
  });
});

// --- Phase 73B：CE Fix Work UI（用 route 攔截 4318，不需真實 runner / 不呼叫 Claude）---

const CE_FIX_WORK_OK = {
  ok: true,
  fix: { changedFiles: ["src/App.fix.tsx"], testCommands: ["pnpm test:run"], fixSummary: "補上測試", notes: "", recommendedNextAction: "請再次執行 CE Review" },
  verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc --noEmit", ok: true }] },
  git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 2 +-" },
  ai: { command: "claude", exitCode: 0 },
};

test("CE Fix Work UI：Review passed 時不顯示「開始 CE Fix Work」", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReviewBody: CE_REVIEW_PASSED });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE73B fix not shown when passed", "/Users/ryan/Desktop/code/harness");
  await seedWorkResult(page);
  await openAdvanced(page);
  await page.getByTestId("ce-review-run").click();
  await expect(page.getByTestId("ce-review-status")).toHaveAttribute("data-phase", "completed");

  // passed → 不顯示 Fix Work runner。
  await expect(page.getByTestId("ce-fix-work-run")).toHaveCount(0);
});

test("CE Fix Work UI：needs_fix 但無 Work 結果時按鈕 disabled", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE73B fix disabled no work", "/Users/ryan/Desktop/code/harness");

  // 直接把 codeReviewNotes 設成 needs_fix（不填 changedFiles / testResults）並保存。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-work-review").click();
  await page.getByTestId("aiwf-code-review-notes").fill("Review result: needs_fix");
  await page.getByTestId("aiwf-save").click();

  await openAdvanced(page);
  await expect(page.getByTestId("ce-fix-work-run")).toBeVisible();
  await expect(page.getByTestId("ce-fix-work-run")).toBeDisabled();
});

test("CE Fix Work UI：needs_fix + Work 結果 → enabled；cancel 不呼叫；confirm 後回填、codeReviewNotes=待 Review、不自動 Review/完成/封存", async ({ page }) => {
  let ceFixCount = 0;
  let ceReviewCount = 0;
  // 先 accept（讓 CE Review confirm 通過），稍後改成 dismiss 測 Fix cancel。
  let decision: "dismiss" | "accept" = "accept";
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    if (decision === "accept") void d.accept();
    else void d.dismiss();
  });
  await mockRunnerRoutes(page, {
    preflight: PF_PASS,
    ceReviewBody: CE_REVIEW_NEEDS_FIX,
    ceFixWorkBody: CE_FIX_WORK_OK,
    ceFixWorkDelayMs: 300,
    onCeFixWork: () => { ceFixCount += 1; },
    onCeReview: () => { ceReviewCount += 1; },
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE73B fix loop", "/Users/ryan/Desktop/code/harness");
  await seedWorkResult(page);

  // 跑 CE Review → needs_fix（ceReviewCount=1；confirm 已 accept）。
  await openAdvanced(page);
  await page.getByTestId("ce-review-run").click();
  await expect(page.getByTestId("ce-review-status")).toHaveAttribute("data-phase", "completed");
  await expect.poll(() => ceReviewCount).toBe(1);

  // needs_fix → Fix Work runner 顯示且 enabled。
  const fixBtn = page.getByTestId("ce-fix-work-run");
  await expect(fixBtn).toBeVisible();
  await expect(fixBtn).toBeEnabled();

  // 1. cancel confirm → 不呼叫 /ce-fix-work。
  decision = "dismiss";
  await fixBtn.click();
  await expect.poll(() => dialogs.some((m) => m.includes("CE Fix Work 會允許 Claude 修改目標專案檔案"))).toBe(true);
  await expect.poll(() => ceFixCount).toBe(0);
  await expect(page.getByTestId("ce-fix-work-status")).toHaveCount(0);

  // 2. confirm → 呼叫 /ce-fix-work，loading，完成。
  decision = "accept";
  await fixBtn.click();
  const status = page.getByTestId("ce-fix-work-status");
  await expect(status).toHaveAttribute("data-phase", "running");
  await expect(status).toContainText("正在執行 CE Fix Work");
  await expect.poll(() => ceFixCount).toBe(1);
  await expect(status).toHaveAttribute("data-phase", "completed");
  await expect(status).toContainText("請再次執行 CE Review");

  // 3. 回填 changedFiles / testCommands / testResults；codeReviewNotes = 待 Review。
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue(/src\/App\.tsx/);
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue(/src\/App\.fix\.tsx/);
  await expect(page.getByTestId("aiwf-test-results")).toContainText("CE Fix Work");
  await expect(page.getByTestId("aiwf-code-review-notes")).toHaveValue("待 Review");

  // 4. 不自動重新 CE Review（count 仍為 1）、不自動完成 / 封存。
  expect(ceReviewCount, "不應自動呼叫 /ce-review").toBe(1);
  await expect(page.locator(".status-select")).not.toHaveValue("done");
  const stored = await readStoredTaskByTitle(page, "PHASE73B fix loop");
  expect(stored?.status).not.toBe("done");
  expect(stored?.archived).not.toBe(true);
  const wf = stored?.aiWorkflow as { workReview?: { codeReviewNotes?: string } } | undefined;
  expect(wf?.workReview?.codeReviewNotes).toBe("待 Review");
  // CE Completion Gate（passed path）不出現。
  await expect(page.getByTestId("ce-completion-gate")).toHaveCount(0);
});

test("CE Fix Work UI：runner 回 fix_blocked 時顯示失敗、不回填", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReviewBody: CE_REVIEW_NEEDS_FIX, ceFixWorkBody: { ok: false, stoppedReason: "fix_blocked", message: "無法安全修正" } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE73B fix blocked", "/Users/ryan/Desktop/code/harness");
  await seedWorkResult(page);
  await openAdvanced(page);
  await page.getByTestId("ce-review-run").click();
  await expect(page.getByTestId("ce-review-status")).toHaveAttribute("data-phase", "completed");

  await page.getByTestId("ce-fix-work-run").click();
  const status = page.getByTestId("ce-fix-work-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("fix_blocked");

  // 失敗不改 codeReviewNotes（仍為 needs_fix）。
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-code-review-notes")).toHaveValue(/Review result: needs_fix/);
});

test("CE Fix Work UI：不影響 CE Completion passed path / CE Work / CE Review runner / Copy Prompt", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK, ceWorkBody: CE_WORK_OK, ceReviewBody: CE_REVIEW_PASSED, ceFixWorkBody: CE_FIX_WORK_OK });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE73B no-regression", "/Users/ryan/Desktop/code/harness");

  // 新任務（無 needs_fix）→ Fix Work runner 不顯示，其他 runner 與進度面板都在。
  await openAdvanced(page);
  await expect(page.getByTestId("ce-fix-work-run")).toHaveCount(0);
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();
  await expect(page.getByTestId("ce-readonly-run")).toBeVisible();
  await expect(page.getByTestId("ce-work-run")).toBeVisible();
  await expect(page.getByTestId("ce-review-run")).toBeVisible();

  // CE Review passed path → CE Completion Gate 仍正常。
  await seedWorkResult(page);
  await page.getByTestId("ce-review-run").click();
  await expect(page.getByTestId("ce-review-status")).toHaveAttribute("data-phase", "completed");
  await expect(page.getByTestId("ce-completion-gate")).toBeVisible();
  await expect(page.getByTestId("ce-fix-work-run")).toHaveCount(0);

  // Copy Prompt 仍可用。
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await page.getByTestId("aiwf-copy-brainstorm").click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("ce-brainstorm");
});

// --- Phase 75：CE Artifact Export UI（用 route 攔截 4318，不需真實 runner / 不寫真實檔案）---

const EXPORT_UI_DIR = "docs/ai-workflows/phase75-export-ui";
const EXPORT_OK = {
  ok: true,
  artifact: {
    relativeDir: EXPORT_UI_DIR,
    absoluteDir: `/Users/ryan/Desktop/code/harness/${EXPORT_UI_DIR}`,
    files: ARTIFACT_NAMES.map((name) => ({ name, relativePath: `${EXPORT_UI_DIR}/${name}` })),
  },
};

test("CE Artifact Export UI：顯示按鈕、點擊呼叫 /export-ce-artifacts、loading、成功顯示 relativeDir 與 files；不自動保存 draft / 不完成 / 不封存", async ({ page }) => {
  let exportCount = 0;
  await mockRunnerRoutes(page, { preflight: PF_PASS, exportBody: EXPORT_OK, exportDelayMs: 300, onExport: () => { exportCount += 1; } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE75 export ui", "/Users/ryan/Desktop/code/harness");

  // 1. Compound 區塊有「匯出 CE Artifacts」按鈕與提示。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("ce-export-run")).toBeVisible();
  await expect(page.getByTestId("ce-export-hint")).toContainText("已保存");

  // 在 compound textarea 填入未保存草稿（驗證 export 不會偷偷保存它）。
  await page.getByTestId("aiwf-compound-notes").fill("未保存的 compound 草稿");

  // 2 + 3. 點擊 → 呼叫 endpoint、顯示 loading。
  await page.getByTestId("ce-export-run").click();
  const status = page.getByTestId("ce-export-status");
  await expect(status).toHaveAttribute("data-phase", "running");
  await expect(status).toContainText("正在匯出 CE Artifacts");
  await expect.poll(() => exportCount).toBe(1);

  // 4 + 5. 成功 → 顯示 relativeDir 與 files list（9 項）。
  await expect(status).toHaveAttribute("data-phase", "completed");
  await expect(page.getByTestId("ce-export-dir")).toContainText(EXPORT_UI_DIR);
  await expect(page.getByTestId("ce-export-files").getByTestId("ce-export-file")).toHaveCount(9);
  await expect(page.getByTestId("ce-export-files")).toContainText("requirement.md");
  await expect(page.getByTestId("ce-export-files")).toContainText("metadata.json");

  // 7. 不自動保存 unsaved draft：localStorage 的 aiWorkflow 仍未設定。
  const stored = await readStoredTaskByTitle(page, "PHASE75 export ui");
  expect(stored?.aiWorkflow).toBeUndefined();
  // 8 + 9. 不自動完成 / 不自動封存。
  expect(stored?.status).not.toBe("done");
  expect(stored?.archived).not.toBe(true);
  await expect(page.locator(".status-select")).not.toHaveValue("done");
});

test("CE Artifact Export UI：失敗時顯示錯誤訊息（project_path_invalid）", async ({ page }) => {
  await mockRunnerRoutes(page, { preflight: PF_PASS, exportBody: { ok: false, stoppedReason: "project_path_invalid", message: "projectPath 不存在" } });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE75 export fail", "/Users/ryan/Desktop/code/harness");

  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-compound").click();
  await page.getByTestId("ce-export-run").click();
  const status = page.getByTestId("ce-export-status");
  await expect(status).toHaveAttribute("data-phase", "failed");
  await expect(status).toContainText("project_path_invalid");
});

test("CE Artifact Export UI：不影響 CE Readonly / Work / Review / Completion Gate / Compound Generator", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await mockRunnerRoutes(page, { preflight: PF_PASS, ceReadonlyBody: CE_OK, ceWorkBody: CE_WORK_OK, ceReviewBody: CE_REVIEW_PASSED, exportBody: EXPORT_OK });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createTask(page, "PHASE75 export no-regression", "/Users/ryan/Desktop/code/harness");

  // 其他 runner 與進度面板仍在。
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();
  await openAdvanced(page);
  await expect(page.getByTestId("ce-readonly-run")).toBeVisible();
  await expect(page.getByTestId("ce-work-run")).toBeVisible();
  await expect(page.getByTestId("ce-review-run")).toBeVisible();

  // Compound Generator（Phase 74）仍可用，且與 export 並存。
  await openWorkflowDetails(page);
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-generate-compound")).toBeVisible();
  await page.getByTestId("aiwf-generate-compound").click();
  await expect(page.getByTestId("aiwf-compound-hint")).toContainText("已產生 Compound Notes 草稿");
  await expect(page.getByTestId("ce-export-run")).toBeVisible();

  // CE Review passed path → Completion Gate 仍正常。
  await seedWorkResult(page);
  await page.getByTestId("ce-review-run").click();
  await expect(page.getByTestId("ce-review-status")).toHaveAttribute("data-phase", "completed");
  await expect(page.getByTestId("ce-completion-gate")).toBeVisible();
});
