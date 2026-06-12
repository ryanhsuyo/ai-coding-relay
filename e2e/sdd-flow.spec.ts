import { test, expect, type Page } from "@playwright/test";

/**
 * 核心 SDD + TDD + Refactor 半自動流程的 E2E 驗證。
 * 驗證對象是 UI 行為（產生各種 Prompt、匯入驗證結果、顯示 RoundTimeline、持久化），
 * 不重新執行真正的 tsc / test / build；verification JSON 以一份具代表性的固定樣本貼入匯入。
 */

const ORIG = "PHASE30 SDD 流程 E2E 驗證任務";

const SPEC = `## 功能範圍
- 使用者可以在任務輸入並保存規格草稿 specDraft

## 規則
- 規格必須包含 Given-When-Then 場景

## API / UI 設計
- TaskDetail 新增 specDraft textarea，失焦儲存

## Given-When-Then 場景

Scenario: 儲存規格草稿
Given 使用者開啟一個任務
When 在 specDraft 欄位輸入內容並失焦
Then 內容會被保存且重新整理後仍存在

## 不在範圍
- 不實作後端 API`;

/** 一份含 fileGuard 的 verification JSON 樣本（fileGuard.ok=false，帶一筆 forbidden 違規）。 */
const VERIFICATION_JSON = JSON.stringify(
  {
    ok: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5000,
    commands: [
      { name: "tsc", command: "npx tsc --noEmit", exitCode: 0, stdout: "", stderr: "", durationMs: 1200, ok: true, required: true },
      { name: "test", command: "pnpm test:run", exitCode: 0, stdout: "37 passed", stderr: "", durationMs: 900, ok: true, required: true },
      { name: "build", command: "pnpm build", exitCode: 0, stdout: "built", stderr: "", durationMs: 1500, ok: true, required: true },
      { name: "git-status", command: "git status --short", exitCode: 0, stdout: " M src/App.tsx", stderr: "", durationMs: 50, ok: true, required: false },
      { name: "git-diff", command: "git diff --stat", exitCode: 0, stdout: "src/App.tsx | 2 +-", stderr: "", durationMs: 50, ok: true, required: false },
    ],
    fileGuard: {
      ok: false,
      modifiedFiles: ["src/App.tsx", "package.json"],
      targetFiles: ["src/App.tsx", "src/App.css"],
      forbiddenFiles: ["package.json"],
      violations: [{ type: "forbidden", file: "package.json" }],
    },
  },
  null,
  2
);

/** 一份 auto-round JSON 樣本（scripts/auto-round.mjs 輸出格式；含 ai / verification / fileGuard / stoppedReason）。 */
const AUTO_ROUND_JSON = JSON.stringify(
  {
    ok: false,
    mode: "implement",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5000,
    ai: { command: "claude", exitCode: 0, stdout: "AI 已修改 src/App.tsx", stderr: "", durationMs: 1200 },
    verification: {
      ok: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:04.000Z",
      durationMs: 4000,
      commands: [
        { name: "tsc", command: "npx tsc --noEmit", exitCode: 0, stdout: "", stderr: "", durationMs: 1200, ok: true, required: true },
        { name: "test", command: "pnpm test:run", exitCode: 0, stdout: "37 passed", stderr: "", durationMs: 900, ok: true, required: true },
      ],
      fileGuard: {
        ok: false,
        modifiedFiles: ["src/App.tsx", "package.json"],
        targetFiles: ["src/App.tsx"],
        forbiddenFiles: ["package.json"],
        violations: [{ type: "forbidden", file: "package.json" }],
      },
    },
    stoppedReason: "verification_failed,file_guard_failed",
  },
  null,
  2
);

/** 產生一筆 auto-round 結果（auto-loop rounds[] 的元素）。 */
function makeRound(mode: string, ok: boolean, fileGuardOk: boolean, stoppedReason?: string) {
  return {
    ok,
    mode,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2000,
    ai: { command: "claude", exitCode: 0, stdout: `AI ${mode} 輸出`, stderr: "", durationMs: 800 },
    verification: {
      ok,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.500Z",
      durationMs: 1500,
      commands: [
        { name: "tsc", command: "npx tsc --noEmit", exitCode: ok ? 0 : 1, stdout: "", stderr: "", durationMs: 600, ok, required: true },
      ],
      fileGuard: {
        ok: fileGuardOk,
        modifiedFiles: ["src/App.tsx", "package.json"],
        targetFiles: ["src/App.tsx"],
        forbiddenFiles: ["package.json"],
        violations: fileGuardOk ? [] : [{ type: "forbidden", file: "package.json" }],
      },
    },
    ...(stoppedReason ? { stoppedReason } : {}),
  };
}

/** 一份 auto-loop JSON 樣本（scripts/auto-loop.mjs 輸出格式；rounds 至少兩輪）。 */
const AUTO_LOOP_JSON = JSON.stringify(
  {
    ok: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:10.000Z",
    durationMs: 10000,
    maxRounds: 3,
    totalRounds: 3,
    autoApprove: true,
    initialMode: "implement",
    finalMode: "refactor",
    stoppedReason: "file_guard_failed",
    rounds: [
      makeRound("implement", false, true),                                          // verification 失敗
      makeRound("fix", true, true),                                                 // 通過
      makeRound("refactor", false, false, "verification_failed,file_guard_failed"), // fileGuard 失敗
    ],
  },
  null,
  2
);

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** 從 `cat <<'EOF' | pnpm -s auto:round\n{json}\nEOF` 指令文字中取出中間的 task JSON。 */
function extractHeredocJson(command: string): Record<string, unknown> {
  const start = command.indexOf("\n");
  const end = command.lastIndexOf("\nEOF");
  return JSON.parse(command.slice(start + 1, end)) as Record<string, unknown>;
}

async function copyAndRead(page: Page, buttonName: string): Promise<string> {
  await page.getByRole("button", { name: buttonName }).click();
  await expect(page.getByRole("button", { name: "✓ 已複製" }).first()).toBeVisible();
  return readClipboard(page);
}

test("核心 SDD 流程：產生 prompts、匯入驗證、顯示 RoundTimeline、reload 保留", async ({ page }) => {
  // 全程蒐集 console error 與未捕捉的 pageerror，測試最後斷言皆為 0
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    // Phase 50 起 TaskDetail 會在載入時 ping local runner http://localhost:4318/health。
    // runner 未啟動時瀏覽器會記錄連線失敗的資源錯誤（ERR_CONNECTION_REFUSED），這是預期情況、
    // 不算 App 的 console error，故過濾掉；真正的 App 錯誤仍會被收集到。
    if (msg.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/i.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 1. 新增任務（填入 originalRequirement / targetFiles / forbiddenFiles）
  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE30 E2E 任務");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill(ORIG);
  await page.getByPlaceholder("src/DmForm.tsx\nsrc/index.tsx").fill("src/App.tsx\nsrc/App.css");
  await page.getByPlaceholder("src/CkdForm.tsx\n不要重構無關元件").fill("package.json");
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE30 E2E 任務");

  // 2. workflowStage 預設 spec
  await expect(page.locator(".workflow-stage-select")).toHaveValue("spec");

  // 3. 複製 Spec Prompt
  const spec = await copyAndRead(page, "複製 Spec Prompt");
  expect(spec).toContain(ORIG);
  expect(spec).toContain("src/App.tsx");
  expect(spec).toContain("package.json");
  expect(spec).toContain("Given-When-Then");
  expect(spec).toContain("不要實作程式碼");

  // 4. 貼入 specDraft（失焦儲存）
  await page.locator(".spec-draft-textarea").fill(SPEC);
  await page.locator(".spec-draft-textarea").blur();

  // 5. 複製測試 Prompt（red phase）
  const testPrompt = await copyAndRead(page, "複製測試 Prompt");
  expect(testPrompt).toContain("儲存規格草稿");
  expect(testPrompt).toContain("Vitest");
  expect(testPrompt).toContain("red");

  // 6. 複製實作 Prompt（green phase）
  const impl = await copyAndRead(page, "複製實作 Prompt");
  expect(impl).toContain("儲存規格草稿");
  expect(impl).toContain("green phase");
  expect(impl).toContain("pnpm verify:copy");

  // 7. 複製重構 Prompt（refactor phase）
  const refactor = await copyAndRead(page, "複製重構 Prompt");
  expect(refactor).toContain("儲存規格草稿");
  expect(refactor).toContain("refactor phase");
  expect(refactor).toContain("不要改變既有行為");

  // 8. 複製 File Guard 設定指令
  const guardCmd = await copyAndRead(page, "複製 File Guard 設定指令");
  expect(guardCmd).toContain("mkdir -p .ai-coding-relay");
  expect(guardCmd).toContain(".ai-coding-relay/guard-rules.json");
  expect(guardCmd).toContain("src/App.tsx");
  expect(guardCmd).toContain("package.json");

  // 9. 匯入 verification JSON（用 placeholder 鎖定驗證匯入的 textarea，避免與 auto-round textarea 混淆）
  await page.locator('textarea[placeholder^="貼上 verification JSON"]').fill(VERIFICATION_JSON);
  await page.getByRole("button", { name: "匯入驗證結果" }).click();

  // 10. RoundTimeline 顯示驗證結果與 fileGuard
  await expect(page.locator(".round-timeline")).toBeVisible();
  expect(await page.locator(".command-log-row").count()).toBeGreaterThan(0);
  await expect(page.locator(".file-guard").first()).toBeVisible();
  await expect(page.locator(".round-timeline")).toContainText("檔案範圍");

  // 11. reload 後資料保留
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE30 E2E 任務");
  await expect(page.locator(".spec-draft-textarea")).toContainText("儲存規格草稿");
  await expect(page.locator(".round-timeline")).toBeVisible();

  // 12. 全程不得有 console error 或 pageerror
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("auto-round 流程：複製指令（mode 依階段推導）、匯入結果、顯示 RoundTimeline、reload 保留", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    // Phase 50 起 TaskDetail 會在載入時 ping local runner http://localhost:4318/health。
    // runner 未啟動時瀏覽器會記錄連線失敗的資源錯誤（ERR_CONNECTION_REFUSED），這是預期情況、
    // 不算 App 的 console error，故過濾掉；真正的 App 錯誤仍會被收集到。
    if (msg.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/i.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 新增任務並填入欄位
  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE35 auto-round E2E");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill("auto-round 流程 E2E 驗證");
  await page.getByPlaceholder("src/DmForm.tsx\nsrc/index.tsx").fill("src/App.tsx\nsrc/App.css");
  await page.getByPlaceholder("src/CkdForm.tsx\n不要重構無關元件").fill("package.json");
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE35 auto-round E2E");

  // 1. 複製 auto-round 指令：含 pnpm -s auto:round 與 aiCommand "claude"
  const cmd = await copyAndRead(page, "複製 auto-round 指令");
  expect(cmd).toContain("pnpm -s auto:round");
  expect(cmd).toContain("cat <<'EOF'");
  const taskJson = extractHeredocJson(cmd);
  expect(taskJson.aiCommand).toBe("claude --permission-mode acceptEdits");
  expect(taskJson.title).toBe("PHASE35 auto-round E2E");
  expect(taskJson.targetFiles).toContain("src/App.tsx");
  expect(taskJson.forbiddenFiles).toContain("package.json");

  // 2. mode 依 workflowStage 推導
  const stageSelect = page.locator(".workflow-stage-select");
  const modeCases: Array<[string, string]> = [
    ["red_test", "test"],
    ["green_implement", "implement"],
    ["refactor", "refactor"],
    ["fix", "fix"],
  ];
  for (const [stage, expectedMode] of modeCases) {
    await stageSelect.selectOption(stage);
    const c = await copyAndRead(page, "複製 auto-round 指令");
    expect(extractHeredocJson(c).mode, `stage=${stage}`).toBe(expectedMode);
  }

  // 3. 匯入一份 auto-round JSON
  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_JSON);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();

  // 4. RoundTimeline 顯示 auto-round mode / AI 執行結果 / stoppedReason / verification / fileGuard
  const timeline = page.locator(".round-timeline");
  await expect(timeline).toBeVisible();
  await expect(page.locator(".auto-round-section").first()).toBeVisible();
  await expect(timeline).toContainText("auto-round");
  await expect(timeline).toContainText("implement");
  await expect(timeline).toContainText("claude"); // AI 執行結果
  await expect(timeline).toContainText("file_guard_failed"); // stoppedReason
  expect(await page.locator(".command-log-row").count()).toBeGreaterThan(0); // verification 結果
  await expect(page.locator(".file-guard").first()).toBeVisible(); // fileGuard 結果
  await expect(timeline).toContainText("檔案範圍");

  // 5. reload 後 auto-round round 仍存在
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.locator(".auto-round-section").first()).toBeVisible();
  await expect(page.locator(".round-timeline")).toContainText("implement");

  // 6. 全程不得有 console error 或 pageerror
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("AI Command 設定：預設值、修改後三種複製指令皆套用、reload 保留", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    // Phase 50 起 TaskDetail 會在載入時 ping local runner http://localhost:4318/health。
    // runner 未啟動時瀏覽器會記錄連線失敗的資源錯誤（ERR_CONNECTION_REFUSED），這是預期情況、
    // 不算 App 的 console error，故過濾掉；真正的 App 錯誤仍會被收集到。
    if (msg.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/i.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE49 AI Command E2E");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill("AI Command 設定 E2E 驗證");
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE49 AI Command E2E");

  // 1. 預設值為 claude --permission-mode acceptEdits
  const aiInput = page.locator(".ai-command-input");
  await expect(aiInput).toHaveValue("claude --permission-mode acceptEdits");

  // 2. 預設值下三種複製指令的 aiCommand 都是預設值
  for (const buttonName of ["複製 auto-spec 指令", "複製 auto-round 指令", "複製 auto-loop 指令"]) {
    const c = await copyAndRead(page, buttonName);
    expect(extractHeredocJson(c).aiCommand, buttonName).toBe("claude --permission-mode acceptEdits");
  }

  // 3. 改成 codex 後，三種複製指令都套用新值
  await aiInput.fill("codex");
  await aiInput.blur();
  for (const buttonName of ["複製 auto-spec 指令", "複製 auto-round 指令", "複製 auto-loop 指令"]) {
    const c = await copyAndRead(page, buttonName);
    expect(extractHeredocJson(c).aiCommand, buttonName).toBe("codex");
  }

  // 4. reload 後仍保留 codex
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.locator(".ai-command-input")).toHaveValue("codex");
  const afterReload = await copyAndRead(page, "複製 auto-round 指令");
  expect(extractHeredocJson(afterReload).aiCommand).toBe("codex");

  // 5. 清空後失焦會還原成預設值
  await page.locator(".ai-command-input").fill("");
  await page.locator(".ai-command-input").blur();
  await expect(page.locator(".ai-command-input")).toHaveValue("claude --permission-mode acceptEdits");

  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("auto-loop 流程：複製指令（mode 依階段推導）、匯入多輪結果、顯示 Loop N/M、reload 保留", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    // Phase 50 起 TaskDetail 會在載入時 ping local runner http://localhost:4318/health。
    // runner 未啟動時瀏覽器會記錄連線失敗的資源錯誤（ERR_CONNECTION_REFUSED），這是預期情況、
    // 不算 App 的 console error，故過濾掉；真正的 App 錯誤仍會被收集到。
    if (msg.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource/i.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE39 auto-loop E2E");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill("auto-loop 流程 E2E 驗證");
  await page.getByPlaceholder("src/DmForm.tsx\nsrc/index.tsx").fill("src/App.tsx\nsrc/App.css");
  await page.getByPlaceholder("src/CkdForm.tsx\n不要重構無關元件").fill("package.json");
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE39 auto-loop E2E");

  // 1. 複製 auto-loop 指令：含 pnpm -s auto:loop / aiCommand / maxRounds / autoApprove / workflowStage
  const cmd = await copyAndRead(page, "複製 auto-loop 指令");
  expect(cmd).toContain("pnpm -s auto:loop");
  expect(cmd).toContain("cat <<'EOF'");
  const taskJson = extractHeredocJson(cmd);
  expect(taskJson.aiCommand).toBe("claude --permission-mode acceptEdits");
  expect(taskJson.maxRounds).toBe(3);
  expect(taskJson.autoApprove).toBe(false);
  expect(taskJson.workflowStage).toBe("spec");
  expect(taskJson.title).toBe("PHASE39 auto-loop E2E");
  expect(taskJson.targetFiles).toContain("src/App.tsx");
  expect(taskJson.forbiddenFiles).toContain("package.json");

  // 2. mode 依 workflowStage 推導（指令中的 mode 與 workflowStage 都會更新）
  const stageSelect = page.locator(".workflow-stage-select");
  const modeCases: Array<[string, string]> = [
    ["red_test", "test"],
    ["green_implement", "implement"],
    ["refactor", "refactor"],
    ["fix", "fix"],
  ];
  for (const [stage, expectedMode] of modeCases) {
    await stageSelect.selectOption(stage);
    const c = await copyAndRead(page, "複製 auto-loop 指令");
    const j = extractHeredocJson(c);
    expect(j.mode, `stage=${stage}`).toBe(expectedMode);
    expect(j.workflowStage, `stage=${stage}`).toBe(stage);
  }

  // 3. 匯入一份 auto-loop JSON（rounds 三輪）
  await page.locator('textarea[placeholder^="貼上 auto-loop JSON"]').fill(AUTO_LOOP_JSON);
  await page.getByRole("button", { name: "匯入 auto-loop 結果" }).click();

  // 4. RoundTimeline 顯示多筆回合與 Loop N/M
  await expect(page.locator(".round-timeline")).toBeVisible();
  expect(await page.locator(".round-card").count()).toBe(3);
  const timeline = page.locator(".round-timeline");
  await expect(timeline).toContainText("Loop 1/3");
  await expect(timeline).toContainText("Loop 2/3");
  await expect(timeline).toContainText("Loop 3/3");
  await expect(timeline).toContainText("claude"); // AI 執行結果
  await expect(timeline).toContainText("file_guard_failed"); // stoppedReason
  expect(await page.locator(".command-log-row").count()).toBeGreaterThanOrEqual(3); // verification 結果
  expect(await page.locator(".file-guard").count()).toBeGreaterThanOrEqual(1); // fileGuard 結果
  await expect(timeline).toContainText("檔案範圍");

  // 5. reload 後 auto-loop rounds 仍存在
  await page.reload();
  await page.locator(".task-card").first().click();
  expect(await page.locator(".round-card").count()).toBe(3);
  await expect(page.locator(".round-timeline")).toContainText("Loop 1/3");

  // 6. 全程不得有 console error 或 pageerror
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("任務模板「文件小改 auto-round」：自動帶入欄位、不覆蓋 title / 原始需求 / projectPath、workflowStage=green_implement", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "＋ 新增任務" }).click();

  // 先填 title / 原始需求 / projectPath，稍後驗證套用模板不會覆蓋它們。
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE53 文件小改任務");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill("補充 harness 架構文件");
  await page.getByPlaceholder("/Users/ryan/projects/my-app").fill("/Users/ryan/projects/harness");

  // 選擇「文件小改 auto-round」模板。
  const templateSelect = page.locator(".form-field", { hasText: "任務模板" }).locator("select");
  await templateSelect.selectOption({ label: "文件小改 auto-round" });

  // 選後顯示提示。
  await expect(page.locator(".modal-box")).toContainText("可直接搭配 Preflight 與 auto-round 使用");

  // 任務類型變成「文件」(docs)。
  await expect(page.locator(".form-field", { hasText: "任務類型" }).locator("select")).toHaveValue("docs");

  // targetFiles 自動帶入 docs/harness-architecture.md。
  await expect(page.getByPlaceholder("src/DmForm.tsx\nsrc/index.tsx")).toHaveValue(/docs\/harness-architecture\.md/);

  // forbiddenFiles 自動包含各禁止範圍。
  const forbidden = page.getByPlaceholder("src/CkdForm.tsx\n不要重構無關元件");
  for (const re of [/src\//, /tests\//, /scripts\//, /package\.json/, /package-lock\.json/, /pnpm-lock\.yaml/, /tsconfig\.json/]) {
    await expect(forbidden).toHaveValue(re);
  }

  // constraints / acceptanceCriteria 自動帶入。
  await expect(page.getByPlaceholder("不要改 CKD / DKD\n不要重構無關元件")).toHaveValue(/只修改文件檔案/);
  await expect(page.getByPlaceholder("送出後欄位清空\n資料正確存入")).toHaveValue(/npm run verify:local 通過/);

  // 不覆蓋使用者已填的 title / 原始需求 / projectPath。
  await expect(page.getByPlaceholder("例：DM 表單新增當年新收案")).toHaveValue("PHASE53 文件小改任務");
  await expect(page.getByPlaceholder("描述這個任務要完成什麼...")).toHaveValue("補充 harness 架構文件");
  await expect(page.getByPlaceholder("/Users/ryan/projects/my-app")).toHaveValue("/Users/ryan/projects/harness");

  // 建立任務後 workflowStage = green_implement，且欄位寫入 Task。
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE53 文件小改任務");
  await expect(page.locator(".workflow-stage-select")).toHaveValue("green_implement");
  await expect(page.getByText("docs/harness-architecture.md", { exact: true })).toBeVisible();

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("不使用模板時，新增任務既有行為不變（預設 type=bug、workflowStage=spec、欄位空白）", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE53 無模板任務");
  // 模板維持「（不使用模板）」：欄位應保持空白、type 維持預設 bug。
  await expect(page.locator(".form-field", { hasText: "任務類型" }).locator("select")).toHaveValue("bug");
  await expect(page.getByPlaceholder("src/DmForm.tsx\nsrc/index.tsx")).toHaveValue("");
  await expect(page.getByPlaceholder("src/CkdForm.tsx\n不要重構無關元件")).toHaveValue("");

  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE53 無模板任務");
  // 未使用模板 → workflowStage 維持預設 spec。
  await expect(page.locator(".workflow-stage-select")).toHaveValue("spec");
});

// --- PHASE62 快速建立 / 自然語言自動填入欄位 ---

const QUICK_FILL_REQUIREMENT = `請在 docs/harness-architecture.md 補充一小段「測試小節」。
1. run loop 實作應保持 TypeScript 檢查通過。
2. 每個 phase 應有最小測試保護。
3. verification JSON 是 auto-round 回灌的重要依據。`;

test("快速建立：填原始需求+projectPath，選文件模板後『自動填入欄位』自動產生欄位", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "＋ 新增任務" }).click();

  // 只填原始需求 + projectPath（title 留空，待自動產生）。
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill(QUICK_FILL_REQUIREMENT);
  await page.getByPlaceholder("/Users/ryan/projects/my-app").fill("/Users/ryan/Desktop/code/harness");

  // 選「文件小改 auto-round」模板。
  const templateSelect = page.locator(".form-field", { hasText: "任務模板" }).locator("select");
  await templateSelect.selectOption({ label: "文件小改 auto-round" });

  // 按「自動填入欄位」。
  await page.getByRole("button", { name: "自動填入欄位" }).click();

  // 成功提示出現（成功不 alert）。
  await expect(page.locator(".quick-fill-hint")).toContainText(
    "已自動填入 targetFiles / constraints / acceptanceCriteria"
  );

  // title 自動產生（非空白）。
  await expect(page.getByPlaceholder("例：DM 表單新增當年新收案")).not.toHaveValue("");

  // targetFiles = docs/harness-architecture.md，且不含 projectPath。
  const targetFiles = page.getByPlaceholder("src/DmForm.tsx\nsrc/index.tsx");
  await expect(targetFiles).toHaveValue("docs/harness-architecture.md");
  await expect(targetFiles).not.toHaveValue(/Users\/ryan\/Desktop\/code\/harness/);

  // forbiddenFiles 包含各禁止範圍。
  const forbidden = page.getByPlaceholder("src/CkdForm.tsx\n不要重構無關元件");
  for (const re of [/src\//, /tests\//, /scripts\//, /package\.json/, /package-lock\.json/, /pnpm-lock\.yaml/, /tsconfig\.json/]) {
    await expect(forbidden).toHaveValue(re);
  }

  // constraints 有「只修改 docs/harness-architecture.md」。
  await expect(page.getByPlaceholder("不要改 CKD / DKD\n不要重構無關元件")).toHaveValue(
    /只修改 docs\/harness-architecture\.md/
  );

  // acceptanceCriteria 有 npm run verify:local 通過。
  await expect(page.getByPlaceholder("送出後欄位清空\n資料正確存入")).toHaveValue(
    /npm run verify:local 通過/
  );

  // projectPath 保留、未被改動。
  await expect(page.getByPlaceholder("/Users/ryan/projects/my-app")).toHaveValue(
    "/Users/ryan/Desktop/code/harness"
  );

  // 建立任務後 workflowStage = green_implement。
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".workflow-stage-select")).toHaveValue("green_implement");
  await expect(page.getByText("docs/harness-architecture.md", { exact: true })).toBeVisible();

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("快速建立：title 已有內容時，『自動填入欄位』不覆蓋 title", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("我自己的標題");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill(QUICK_FILL_REQUIREMENT);

  const templateSelect = page.locator(".form-field", { hasText: "任務模板" }).locator("select");
  await templateSelect.selectOption({ label: "文件小改 auto-round" });
  await page.getByRole("button", { name: "自動填入欄位" }).click();

  await expect(page.getByPlaceholder("例：DM 表單新增當年新收案")).toHaveValue("我自己的標題");
});

test("快速建立：原始需求空白時按『自動填入欄位』顯示錯誤提示且不 crash", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByRole("button", { name: "＋ 新增任務" }).click();

  // 攔截 alert，確認有錯誤提示。
  let alerted = "";
  page.on("dialog", (d) => { alerted = d.message(); void d.accept(); });
  await page.getByRole("button", { name: "自動填入欄位" }).click();

  await expect.poll(() => alerted).toContain("原始需求");
  // 表單仍在、未 crash，且未出現成功提示。
  await expect(page.getByRole("button", { name: "建立任務" })).toBeVisible();
  await expect(page.locator(".quick-fill-hint")).toHaveCount(0);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

/** 一份成功的 auto-round JSON（含 git-status / git-diff，可推導修改檔案）。 */
const AUTO_ROUND_WITH_DIFF = JSON.stringify(
  {
    ok: true,
    mode: "implement",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5000,
    ai: { command: "claude", exitCode: 0, stdout: "已修改 docs/harness-architecture.md，補上模組架構說明。", stderr: "", durationMs: 1200 },
    verification: {
      ok: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:04.000Z",
      durationMs: 4000,
      commands: [
        { name: "tsc", command: "npx tsc --noEmit", exitCode: 0, stdout: "", stderr: "", durationMs: 1200, ok: true, required: true },
        { name: "test", command: "pnpm test:run", exitCode: 0, stdout: "44 passed", stderr: "", durationMs: 900, ok: true, required: true },
        { name: "git-status", command: "git status --short", exitCode: 0, stdout: " M docs/harness-architecture.md", stderr: "", durationMs: 50, ok: true, required: false },
        { name: "git-diff", command: "git diff --stat", exitCode: 0, stdout: " docs/harness-architecture.md | 8 ++++----", stderr: "", durationMs: 50, ok: true, required: false },
      ],
    },
  },
  null,
  2
);

/** 在 sdd-flow 內快速建立一筆任務並等詳情面板出現。 */
async function createSimpleTask(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill(title);
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue(title);
}

test("auto-round 匯入後 summary 空白時自動產生摘要草稿（含修改檔案、驗收結果、成功資訊）", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE55 auto-round 摘要");

  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_WITH_DIFF);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();

  const summary = page.locator(".summary-textarea");
  // 六個區塊標題都在
  for (const label of ["任務目標：", "修改檔案：", "遇到問題：", "最後解法：", "驗收結果：", "下次注意："]) {
    await expect(summary).toHaveValue(new RegExp(label));
  }
  // 修改檔案從 git-diff / git-status 推導
  await expect(summary).toHaveValue(/docs\/harness-architecture\.md/);
  // 驗收結果列出 verification commands
  await expect(summary).toHaveValue(/- tsc: 通過/);
  await expect(summary).toHaveValue(/- test: 通過/);
  // 成功 → 下次注意填可沿用此流程
  await expect(summary).toHaveValue(/可沿用此流程/);
  // 透過 auto-round 執行的字樣
  await expect(summary).toHaveValue(/auto-round 執行/);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("auto-round 匯入：summary 非空時不覆蓋；手動重產會 confirm 並帶入 stoppedReason", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE55 不覆蓋摘要");

  // 先手動填入並保存摘要。
  const summary = page.locator(".summary-textarea");
  await summary.fill("我手動寫的摘要，不應被覆蓋");
  await page.getByRole("button", { name: "保存摘要" }).click();

  // 匯入失敗的 auto-round（含 stoppedReason）；summary 非空 → 不自動覆蓋。
  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_JSON);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();
  await expect(summary).toHaveValue("我手動寫的摘要，不應被覆蓋");

  // 手動「根據最新回合產生摘要」：summary 非空 → 先 confirm，accept 後覆蓋並帶入 stoppedReason。
  let confirmed = "";
  page.on("dialog", (d) => { confirmed = d.message(); void d.accept(); });
  await page.getByRole("button", { name: "根據最新回合產生摘要" }).click();
  await expect.poll(() => confirmed).toContain("要覆蓋嗎");
  await expect(summary).toHaveValue(/停止原因/);
  await expect(summary).toHaveValue(/verification_failed|file_guard_failed/);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("auto-loop 匯入後 summary 空白時自動產生摘要草稿（含 auto-loop 共 N 輪）", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE55 auto-loop 摘要");

  await page.locator('textarea[placeholder^="貼上 auto-loop JSON"]').fill(AUTO_LOOP_JSON);
  await page.getByRole("button", { name: "匯入 auto-loop 結果" }).click();

  const summary = page.locator(".summary-textarea");
  for (const label of ["任務目標：", "修改檔案：", "遇到問題：", "最後解法：", "驗收結果：", "下次注意："]) {
    await expect(summary).toHaveValue(new RegExp(label));
  }
  await expect(summary).toHaveValue(/auto-loop 執行（共 3 輪）/);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// --- PHASE56 完成建議 / 一鍵套用完成狀態 ---

/** 一份成功的 auto-loop JSON：最後一輪通過、loop 整體成功（stoppedReason=done）。 */
const AUTO_LOOP_SUCCESS = JSON.stringify(
  {
    ok: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:08.000Z",
    durationMs: 8000,
    maxRounds: 3,
    totalRounds: 2,
    autoApprove: true,
    initialMode: "implement",
    finalMode: "fix",
    stoppedReason: "done",
    rounds: [
      makeRound("implement", false, true),  // 第一輪 verification 失敗
      makeRound("fix", true, true),         // 最後一輪通過
    ],
  },
  null,
  2
);

/** 一份 auto-round JSON：verification 通過但 fileGuard 失敗（隔離測試 fileGuard 阻擋完成建議）。 */
const AUTO_ROUND_FILEGUARD_FAIL = JSON.stringify(
  {
    ok: true,
    mode: "implement",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5000,
    ai: { command: "claude", exitCode: 0, stdout: "已修改", stderr: "", durationMs: 1200 },
    verification: {
      ok: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:04.000Z",
      durationMs: 4000,
      commands: [
        { name: "tsc", command: "npx tsc --noEmit", exitCode: 0, stdout: "", stderr: "", durationMs: 1200, ok: true, required: true },
      ],
      fileGuard: {
        ok: false,
        modifiedFiles: ["src/App.tsx", "package.json"],
        targetFiles: ["src/App.tsx"],
        forbiddenFiles: ["package.json"],
        violations: [{ type: "forbidden", file: "package.json" }],
      },
    },
  },
  null,
  2
);

test("完成建議：成功 auto-round 匯入後顯示，套用後 status/review/workflow 變更且不自動封存", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE56 完成建議 auto-round");

  // 匯入前：不顯示完成建議。
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);

  // 匯入成功 auto-round JSON（ok=true、verification ok、無 fileGuard）。
  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_WITH_DIFF);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();

  // 出現完成建議與「套用完成狀態」按鈕，依據含 verification 通過。
  const suggestion = page.getByTestId("completion-suggestion");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText("建議套用完成狀態");
  await expect(suggestion).toContainText("verification 通過");
  const applyBtn = page.getByRole("button", { name: "套用完成狀態" });
  await expect(applyBtn).toBeVisible();

  // 套用前：封存按鈕為「封存」（未封存）。
  await expect(page.getByRole("button", { name: "封存", exact: true })).toBeVisible();

  await applyBtn.click();

  // 套用後：status=done、reviewResult=passed、workflowStage=done。
  await expect(page.locator(".status-select")).toHaveValue("done");
  await expect(page.locator(".review-select")).toHaveValue("passed");
  await expect(page.locator(".workflow-stage-select")).toHaveValue("done");

  // 不自動封存：仍是「封存」按鈕、任務詳情仍在。
  await expect(page.getByRole("button", { name: "封存", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "還原" })).toHaveCount(0);
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE56 完成建議 auto-round");

  // 已 done/passed/done → 不再重複顯示完成建議。
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);

  // reload 後狀態保留、仍不再顯示建議。
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.locator(".status-select")).toHaveValue("done");
  await expect(page.locator(".review-select")).toHaveValue("passed");
  await expect(page.locator(".workflow-stage-select")).toHaveValue("done");
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("完成建議：成功 auto-loop 匯入後顯示完成建議（依據含 auto-loop 該輪通過）", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE56 完成建議 auto-loop");

  await page.locator('textarea[placeholder^="貼上 auto-loop JSON"]').fill(AUTO_LOOP_SUCCESS);
  await page.getByRole("button", { name: "匯入 auto-loop 結果" }).click();

  const suggestion = page.getByTestId("completion-suggestion");
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toContainText("auto-loop");
  await expect(page.getByRole("button", { name: "套用完成狀態" })).toBeVisible();

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("完成建議：verification 失敗的 auto-round 不顯示完成建議", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE56 verification 失敗");

  // AUTO_ROUND_JSON：ok=false、verification 失敗、fileGuard 失敗。
  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_JSON);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();

  await expect(page.locator(".auto-round-section").first()).toBeVisible(); // 確認回合已匯入
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("完成建議：fileGuard 失敗（verification 通過）的 auto-round 不顯示完成建議", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE56 fileGuard 失敗");

  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_FILEGUARD_FAIL);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();

  await expect(page.locator(".auto-round-section").first()).toBeVisible();
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("完成建議：手動狀態下拉仍可獨立調整（不受完成建議影響）", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE56 手動下拉");

  // 沒有任何回合時不顯示完成建議；手動下拉仍可用。
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);
  await page.locator(".status-select").selectOption("in_progress");
  await expect(page.locator(".status-select")).toHaveValue("in_progress");
  await page.locator(".review-select").selectOption("needs_fix");
  await expect(page.locator(".review-select")).toHaveValue("needs_fix");

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// --- PHASE65 套用完成狀態時自動保存摘要並留下完成紀錄 ---

/** 從 localStorage 讀出指定標題的任務（含 summary / completedAt / completionHistory）。 */
async function readStoredTask(page: Page, title: string): Promise<Record<string, unknown> | null> {
  return page.evaluate((t) => {
    const raw = localStorage.getItem("ai-coding-relay:task-store");
    if (!raw) return null;
    const store = JSON.parse(raw) as { tasks: Record<string, unknown>[] };
    return store.tasks.find((x) => x.title === t) ?? null;
  }, title);
}

test("套用完成狀態：保存目前摘要 textarea、寫入 completedAt 與 completionHistory（summarySaved=true），reload 後保留", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE65 完成並保存摘要");

  // 匯入成功 auto-round → 出現完成建議、自動產生摘要。
  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_WITH_DIFF);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();
  await expect(page.getByTestId("completion-suggestion")).toBeVisible();

  // 使用者改寫摘要 textarea（不另外按保存摘要）。
  const mysummary = "我的 PHASE65 完成摘要：文件已補充並通過驗證。";
  await page.locator(".summary-textarea").fill(mysummary);

  // 按「套用完成狀態」。
  await page.getByRole("button", { name: "套用完成狀態" }).click();

  // 狀態套用：done / passed / done。
  await expect(page.locator(".status-select")).toHaveValue("done");
  await expect(page.locator(".review-select")).toHaveValue("passed");
  await expect(page.locator(".workflow-stage-select")).toHaveValue("done");

  // 完成建議消失、完成紀錄出現並顯示成功回饋與 message。
  await expect(page.getByTestId("completion-suggestion")).toHaveCount(0);
  const history = page.getByTestId("completion-history");
  await expect(history).toBeVisible();
  await expect(history).toContainText("已保存摘要並套用完成狀態");
  await expect(history).toContainText("套用完成狀態並保存摘要");
  await expect(history).toContainText("完成時間：");

  // 摘要 textarea 被保存為最新內容。
  await expect(page.locator(".summary-textarea")).toHaveValue(mysummary);

  // localStorage 內的資料正確。
  const stored = await readStoredTask(page, "PHASE65 完成並保存摘要");
  expect(stored?.summary).toBe(mysummary);
  expect(typeof stored?.completedAt).toBe("string");
  const events = stored?.completionHistory as Array<Record<string, unknown>>;
  expect(Array.isArray(events)).toBe(true);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("completion_applied");
  expect(events[0].summarySaved).toBe(true);
  expect(events[0].status).toBe("done");
  expect(events[0].reviewResult).toBe("passed");
  expect(events[0].workflowStage).toBe("done");
  expect(typeof events[0].sourceRoundId).toBe("string"); // 有回合 → 帶 sourceRoundId

  // reload 後 completedAt / completionHistory / summary 仍保留。
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.locator(".summary-textarea")).toHaveValue(mysummary);
  await expect(page.getByTestId("completion-history")).toBeVisible();
  await expect(page.getByTestId("completion-history")).toContainText("已保存摘要並套用完成狀態");
  const reread = await readStoredTask(page, "PHASE65 完成並保存摘要");
  expect((reread?.completionHistory as unknown[]).length).toBe(1);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("套用完成狀態：摘要為空仍可完成，summarySaved=false 並顯示摘要為空提示", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE65 摘要為空完成");

  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_WITH_DIFF);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();
  await expect(page.getByTestId("completion-suggestion")).toBeVisible();

  // 清空摘要 textarea，再套用完成狀態（不阻止完成）。
  await page.locator(".summary-textarea").fill("");
  await page.getByRole("button", { name: "套用完成狀態" }).click();

  // 仍套用 done / passed / done。
  await expect(page.locator(".status-select")).toHaveValue("done");
  await expect(page.locator(".review-select")).toHaveValue("passed");
  await expect(page.locator(".workflow-stage-select")).toHaveValue("done");

  // 完成紀錄顯示「摘要為空」提示。
  const history = page.getByTestId("completion-history");
  await expect(history).toBeVisible();
  await expect(history).toContainText("摘要為空");

  const stored = await readStoredTask(page, "PHASE65 摘要為空完成");
  const events = stored?.completionHistory as Array<Record<string, unknown>>;
  expect(events).toHaveLength(1);
  expect(events[0].summarySaved).toBe(false);
  expect(events[0].message).toBe("套用完成狀態，摘要為空");
  expect(typeof stored?.completedAt).toBe("string");

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("套用完成狀態：不自動封存，手動「保存摘要」與狀態下拉仍可用", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE65 不封存與手動保存");

  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_WITH_DIFF);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();
  await page.getByRole("button", { name: "套用完成狀態" }).click();

  // 不自動封存：仍是「封存」按鈕、任務詳情仍在。
  await expect(page.getByRole("button", { name: "封存", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "還原" })).toHaveCount(0);

  // 手動「保存摘要」仍可用：改寫摘要後保存成功。
  await page.locator(".summary-textarea").fill("完成後再補充的摘要");
  await page.getByRole("button", { name: "保存摘要" }).click();
  await expect(page.getByRole("button", { name: "✓ 已保存" })).toBeVisible();
  const stored = await readStoredTask(page, "PHASE65 不封存與手動保存");
  expect(stored?.summary).toBe("完成後再補充的摘要");

  // 手動狀態下拉仍可獨立調整。
  await page.locator(".status-select").selectOption("in_progress");
  await expect(page.locator(".status-select")).toHaveValue("in_progress");

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// ── Phase 67：AI Workflow UI 基礎欄位 ──

test("AI Workflow：所有欄位可填寫並保存、string[] 與 checklist 正確、reload 保留", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE67 AI Workflow E2E");

  // 1. TaskDetail 顯示 AI Workflow 區塊
  await expect(page.getByTestId("ai-workflow")).toBeVisible();

  // 2. Brainstorm
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await page.getByTestId("aiwf-brainstorm-path").fill("docs/brainstorms/login.md");
  await page.getByTestId("aiwf-brainstorm-summary").fill("brainstorm 摘要內容");
  await page.getByTestId("aiwf-brainstorm-status").selectOption("drafted");

  // 3. Plan
  await page.getByTestId("aiwf-toggle-plan").click();
  await page.getByTestId("aiwf-plan-path").fill("docs/plans/login.md");
  await page.getByTestId("aiwf-plan-summary").fill("plan 摘要內容");
  await page.getByTestId("aiwf-plan-status").selectOption("approved");

  // 4. Audit：多行 textarea → string[]、checklist
  await page.getByTestId("aiwf-toggle-audit").click();
  await page.getByTestId("aiwf-audit-notes").fill("審計筆記");
  await page.getByTestId("aiwf-audit-core-assumptions").fill("假設一\n\n  假設二  ");
  await page.getByTestId("aiwf-audit-risk-notes").fill("風險一\n風險二");
  await page.getByTestId("aiwf-audit-acceptance-criteria").fill("驗收一\n驗收二");
  await page.getByTestId("aiwf-check-coreAssumptionsReviewed").check();
  await page.getByTestId("aiwf-check-minimalChangeReviewed").check();

  // 5. Work / Review
  await page.getByTestId("aiwf-toggle-work-review").click();
  await page.getByTestId("aiwf-changed-files").fill("src/App.tsx\nsrc/App.css");
  await page.getByTestId("aiwf-test-commands").fill("pnpm test:run\nnpx tsc --noEmit");
  await page.getByTestId("aiwf-test-results").fill("96 passed");
  await page.getByTestId("aiwf-code-review-notes").fill("review 筆記");
  await page.getByTestId("aiwf-commit-hash").fill("abc1234");
  await page.getByTestId("aiwf-commit-message").fill("feat: phase 67");

  // 6. Compound
  await page.getByTestId("aiwf-toggle-compound").click();
  await page.getByTestId("aiwf-reusable-prompt").fill("可重用 prompt 內容");
  await page.getByTestId("aiwf-lesson-learned").fill("學到的事內容");
  await page.getByTestId("aiwf-compound-notes").fill("compound 筆記內容");

  // 7. 保存並顯示已保存回饋
  await page.getByTestId("aiwf-save").click();
  await expect(page.getByRole("button", { name: "✓ 已保存 AI Workflow" })).toBeVisible();

  // 8. localStorage：string[] 欄位保存為字串陣列、checklist 缺勾項補 false、status 正確
  const stored = await readStoredTask(page, "PHASE67 AI Workflow E2E");
  const wf = stored?.aiWorkflow as {
    brainstorm?: { path?: string; summary?: string; status?: string };
    plan?: { path?: string; status?: string };
    audit?: {
      coreAssumptions?: string[];
      riskNotes?: string[];
      acceptanceCriteria?: string[];
      checklist?: Record<string, boolean>;
    };
    workReview?: { changedFiles?: string[]; testCommands?: string[]; testResults?: string; commitHash?: string; commitMessage?: string };
    compound?: { reusablePrompt?: string; lessonLearned?: string; compoundNotes?: string };
  };
  expect(wf.brainstorm?.path).toBe("docs/brainstorms/login.md");
  expect(wf.brainstorm?.status).toBe("drafted");
  expect(wf.plan?.status).toBe("approved");
  expect(wf.audit?.coreAssumptions).toEqual(["假設一", "假設二"]);
  expect(wf.audit?.riskNotes).toEqual(["風險一", "風險二"]);
  expect(wf.audit?.acceptanceCriteria).toEqual(["驗收一", "驗收二"]);
  expect(wf.audit?.checklist).toEqual({
    coreAssumptionsReviewed: true,
    riskReviewed: false,
    scopeReviewed: false,
    acceptanceCriteriaReviewed: false,
    minimalChangeReviewed: true,
  });
  expect(wf.workReview?.changedFiles).toEqual(["src/App.tsx", "src/App.css"]);
  expect(wf.workReview?.testCommands).toEqual(["pnpm test:run", "npx tsc --noEmit"]);
  expect(wf.workReview?.testResults).toBe("96 passed");
  expect(wf.workReview?.commitHash).toBe("abc1234");
  expect(wf.workReview?.commitMessage).toBe("feat: phase 67");
  expect(wf.compound?.reusablePrompt).toBe("可重用 prompt 內容");
  expect(wf.compound?.lessonLearned).toBe("學到的事內容");
  expect(wf.compound?.compoundNotes).toBe("compound 筆記內容");

  // 9. reload 後資料保留（UI 顯示填回的值）
  await page.reload();
  await page.locator(".task-card").first().click();
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-path")).toHaveValue("docs/brainstorms/login.md");
  await expect(page.getByTestId("aiwf-brainstorm-status")).toHaveValue("drafted");
  await page.getByTestId("aiwf-toggle-plan").click();
  await expect(page.getByTestId("aiwf-plan-status")).toHaveValue("approved");
  await page.getByTestId("aiwf-toggle-audit").click();
  await expect(page.getByTestId("aiwf-audit-core-assumptions")).toHaveValue("假設一\n假設二");
  await expect(page.getByTestId("aiwf-check-coreAssumptionsReviewed")).toBeChecked();
  await expect(page.getByTestId("aiwf-check-riskReviewed")).not.toBeChecked();
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-changed-files")).toHaveValue("src/App.tsx\nsrc/App.css");
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-lesson-learned")).toHaveValue("學到的事內容");

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

test("AI Workflow：不影響既有 Summary 保存與套用完成狀態 / completionHistory", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await createSimpleTask(page, "PHASE67 不回歸驗證");

  // 先保存一份 AI Workflow
  await page.getByTestId("aiwf-toggle-plan").click();
  await page.getByTestId("aiwf-plan-path").fill("docs/plans/x.md");
  await page.getByTestId("aiwf-save").click();
  await expect(page.getByRole("button", { name: "✓ 已保存 AI Workflow" })).toBeVisible();

  // Summary 保存不受影響
  await page.locator(".summary-textarea").fill("phase67 摘要");
  await page.getByRole("button", { name: "保存摘要" }).click();
  await expect(page.getByRole("button", { name: "✓ 已保存", exact: true })).toBeVisible();

  // 匯入成功的 auto-round → 完成建議顯示 → 套用完成狀態 → completionHistory 寫入
  await page.locator('textarea[placeholder^="貼上 auto-round JSON"]').fill(AUTO_ROUND_WITH_DIFF);
  await page.getByRole("button", { name: "匯入 auto-round 結果" }).click();
  await expect(page.locator(".completion-suggestion")).toBeVisible();
  await page.getByRole("button", { name: "套用完成狀態" }).click();

  const stored = await readStoredTask(page, "PHASE67 不回歸驗證");
  expect(stored?.summary).toBe("phase67 摘要");
  expect(stored?.status).toBe("done");
  expect(Array.isArray(stored?.completionHistory)).toBe(true);
  expect((stored?.completionHistory as unknown[]).length).toBe(1);
  // aiWorkflow 仍保留
  const wf = stored?.aiWorkflow as { plan?: { path?: string } };
  expect(wf.plan?.path).toBe("docs/plans/x.md");

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// ── Phase 68：AI Workflow Copy Prompt Buttons ──

test("AI Workflow Copy Prompt：五個按鈕、使用最新 draft、copy 不自動保存、保存仍可用", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 建立含 originalRequirement 的任務
  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE68 Copy Prompt E2E");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill("PHASE68 複製 prompt 的原始需求內容");
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE68 Copy Prompt E2E");

  // 1. 展開各區塊後五個 copy 按鈕都在
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await page.getByTestId("aiwf-toggle-plan").click();
  await page.getByTestId("aiwf-toggle-audit").click();
  await page.getByTestId("aiwf-toggle-work-review").click();
  await expect(page.getByTestId("aiwf-copy-brainstorm")).toBeVisible();
  await expect(page.getByTestId("aiwf-copy-plan")).toBeVisible();
  await expect(page.getByTestId("aiwf-copy-audit")).toBeVisible();
  await expect(page.getByTestId("aiwf-copy-work")).toBeVisible();
  await expect(page.getByTestId("aiwf-copy-review")).toBeVisible();

  // 2. Brainstorm Prompt：含 ce-brainstorm、唯讀分析、不修改檔案、originalRequirement
  await page.getByTestId("aiwf-copy-brainstorm").click();
  await expect(page.getByRole("button", { name: "✓ 已複製 Brainstorm Prompt" })).toBeVisible();
  const brainstorm = await readClipboard(page);
  expect(brainstorm).toContain("/compound-engineering:ce-brainstorm");
  expect(brainstorm).toContain("唯讀分析");
  expect(brainstorm).toContain("不要修改任何檔案");
  expect(brainstorm).toContain("PHASE68 複製 prompt 的原始需求內容");

  // 3. 填 brainstorm path、不按保存，直接複製 ce-plan Prompt → 用到最新 draft path
  await page.getByTestId("aiwf-brainstorm-path").fill("docs/brainstorms/test.md");
  await page.getByTestId("aiwf-copy-plan").click();
  await expect(page.getByRole("button", { name: "✓ 已複製 ce-plan Prompt" })).toBeVisible();
  const plan = await readClipboard(page);
  expect(plan).toContain("/compound-engineering:ce-plan docs/brainstorms/test.md");

  // 4. 填 plan summary / audit 驗收標準、不按保存，複製 Audit Prompt → 含審計問題與最新 draft 內容
  await page.getByTestId("aiwf-plan-summary").fill("PLAN 摘要 draft 內容");
  await page.getByTestId("aiwf-audit-acceptance-criteria").fill("驗收標準 draft 一\n驗收標準 draft 二");
  await page.getByTestId("aiwf-copy-audit").click();
  await expect(page.getByRole("button", { name: "✓ 已複製 Audit Prompt" })).toBeVisible();
  const audit = await readClipboard(page);
  expect(audit).toContain("核心假設是什麼");
  expect(audit).toContain("是否有過度設計");
  expect(audit).toContain("PLAN 摘要 draft 內容");
  expect(audit).toContain("驗收標準 draft 一");

  // 5. Work Prompt
  await page.getByTestId("aiwf-copy-work").click();
  await expect(page.getByRole("button", { name: "✓ 已複製 Work Prompt" })).toBeVisible();
  const work = await readClipboard(page);
  expect(work).toContain("請依照已審核通過的 plan 實作");
  expect(work).toContain("只修改 plan 中列出的檔案");
  expect(work).toContain("不要額外重構");

  // 6. Review Prompt
  await page.getByTestId("aiwf-copy-review").click();
  await expect(page.getByRole("button", { name: "✓ 已複製 Review Prompt" })).toBeVisible();
  const review = await readClipboard(page);
  expect(review).toContain("不要再改檔案");
  expect(review).toContain("是否符合原 plan");
  expect(review).toContain("型別風險");
  expect(review).toContain("測試缺口");

  // 7. Copy 不會自動保存：localStorage 的 aiWorkflow 仍未設定
  const stored = await readStoredTask(page, "PHASE68 Copy Prompt E2E");
  expect(stored?.aiWorkflow).toBeUndefined();

  // reload 後未保存的 draft 不保留
  await page.reload();
  await page.locator(".task-card").first().click();
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await expect(page.getByTestId("aiwf-brainstorm-path")).toHaveValue("");

  // 8. 既有「保存 AI Workflow」仍可用
  await page.getByTestId("aiwf-brainstorm-path").fill("docs/brainstorms/saved.md");
  await page.getByTestId("aiwf-save").click();
  await expect(page.getByRole("button", { name: "✓ 已保存 AI Workflow" })).toBeVisible();
  const saved = await readStoredTask(page, "PHASE68 Copy Prompt E2E");
  const wf = saved?.aiWorkflow as { brainstorm?: { path?: string } };
  expect(wf.brainstorm?.path).toBe("docs/brainstorms/saved.md");

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// ── Phase 69：AI Workflow 階段總覽 ──

test("AI Workflow 進度：顯示 8 階段、依最新 draft 即時推導、不自動保存", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 1+3. 無 originalRequirement 的任務 → define 未完成；補上後 → define completed、下一步指向 Brainstorm
  await createSimpleTask(page, "PHASE69 進度總覽 E2E");
  await expect(page.getByTestId("aiwf-progress")).toBeVisible();
  await expect(page.getByTestId("aiwf-progress")).toContainText("AI Workflow 進度");

  // 2. 顯示 8 個階段
  for (const key of ["define", "brainstorm", "plan", "audit", "work", "review", "commit", "compound"]) {
    await expect(page.getByTestId(`aiwf-step-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId("aiwf-step-define")).toHaveAttribute("data-state", "not_started");
  await expect(page.getByTestId("aiwf-next-action")).toContainText("先補上 originalRequirement");

  // 填原始需求（失焦保存）→ define completed、下一步指向 Brainstorm
  const requirementBox = page
    .locator(".detail-section")
    .filter({ has: page.locator(".detail-label", { hasText: "原始需求" }) })
    .locator("textarea.inline-edit-textarea");
  await requirementBox.fill("PHASE69 進度總覽的原始需求");
  await requirementBox.blur();
  await expect(page.getByTestId("aiwf-step-define")).toHaveAttribute("data-state", "completed");
  await expect(page.getByTestId("aiwf-next-action")).toContainText("Brainstorm Prompt");

  // 4. 填 brainstorm draft（不按保存）→ 進度即時反映
  await page.getByTestId("aiwf-toggle-brainstorm").click();
  await page.getByTestId("aiwf-brainstorm-status").selectOption("drafted");
  await expect(page.getByTestId("aiwf-step-brainstorm")).toHaveAttribute("data-state", "in_progress");
  await expect(page.getByTestId("aiwf-step-brainstorm")).toContainText("Brainstorm 草稿完成");
  await page.getByTestId("aiwf-brainstorm-status").selectOption("reviewed");
  await expect(page.getByTestId("aiwf-step-brainstorm")).toHaveAttribute("data-state", "completed");

  // 5. plan.status 選 rejected（不按保存）→ blocked、提示修正 plan、不可進入 Work
  await page.getByTestId("aiwf-toggle-plan").click();
  await page.getByTestId("aiwf-plan-status").selectOption("rejected");
  await expect(page.getByTestId("aiwf-step-plan")).toHaveAttribute("data-state", "blocked");
  await expect(page.getByTestId("aiwf-step-plan")).toContainText("Plan 已退回");
  await expect(page.getByTestId("aiwf-next-action")).toContainText("Plan 已退回，請先修正 plan");
  await expect(page.getByTestId("aiwf-work-readiness")).toContainText("尚不建議進入 Work");

  // plan approved → plan completed、audit 連帶 completed → 可進入 Work
  await page.getByTestId("aiwf-plan-status").selectOption("approved");
  await expect(page.getByTestId("aiwf-step-plan")).toHaveAttribute("data-state", "completed");
  await expect(page.getByTestId("aiwf-step-audit")).toHaveAttribute("data-state", "completed");
  await expect(page.getByTestId("aiwf-work-readiness")).toContainText("可進入 Work 階段");

  // 6. audit checklist 勾選 → 顯示 x/5
  await expect(page.getByTestId("aiwf-audit-count")).toContainText("Audit checklist：0/5");
  await page.getByTestId("aiwf-toggle-audit").click();
  await page.getByTestId("aiwf-check-coreAssumptionsReviewed").check();
  await page.getByTestId("aiwf-check-riskReviewed").check();
  await expect(page.getByTestId("aiwf-audit-count")).toContainText("Audit checklist：2/5");

  // 7. 推導不自動保存：localStorage 的 aiWorkflow 仍未設定
  const stored = await readStoredTask(page, "PHASE69 進度總覽 E2E");
  expect(stored?.aiWorkflow).toBeUndefined();

  // 9. copy prompt button 仍可用（用 plan：draft 尚無 path，prompt 仍可複製）
  await page.getByTestId("aiwf-copy-brainstorm").click();
  await expect(page.getByRole("button", { name: "✓ 已複製 Brainstorm Prompt" })).toBeVisible();
  const brainstorm = await readClipboard(page);
  expect(brainstorm).toContain("/compound-engineering:ce-brainstorm");
  expect(brainstorm).toContain("PHASE69 進度總覽的原始需求");

  // 8. 保存 AI Workflow 仍可用；reload 後進度依已保存資料推導
  await page.getByTestId("aiwf-save").click();
  await expect(page.getByRole("button", { name: "✓ 已保存 AI Workflow" })).toBeVisible();
  await page.reload();
  await page.locator(".task-card").first().click();
  await expect(page.getByTestId("aiwf-step-brainstorm")).toHaveAttribute("data-state", "completed");
  await expect(page.getByTestId("aiwf-step-plan")).toHaveAttribute("data-state", "completed");
  await expect(page.getByTestId("aiwf-audit-count")).toContainText("Audit checklist：2/5");

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});

// ── Phase 74：CE Compound Notes Generator ──

test("CE Compound Notes：產生按鈕回填 draft、不自動保存、保存後 reload 保留、使用最新 draft", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // 建立含 originalRequirement 的任務
  await page.getByRole("button", { name: "＋ 新增任務" }).click();
  await page.getByPlaceholder("例：DM 表單新增當年新收案").fill("PHASE74 Compound E2E");
  await page.getByPlaceholder("描述這個任務要完成什麼...").fill("PHASE74 沉澱知識的原始需求內容");
  await page.getByRole("button", { name: "建立任務" }).click();
  await expect(page.locator(".task-detail-title-input")).toHaveValue("PHASE74 Compound E2E");

  // 1. Compound 區塊顯示「產生 Compound Notes」按鈕
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-generate-compound")).toBeVisible();

  // 5. 使用目前 draft：先在 audit / work 填入未保存的內容
  await page.getByTestId("aiwf-toggle-audit").click();
  await page.getByTestId("aiwf-audit-risk-notes").fill("PHASE74 草稿風險一\nPHASE74 草稿風險二");
  await page.getByTestId("aiwf-toggle-work-review").click();
  await page.getByTestId("aiwf-changed-files").fill("src/phase74-draft.ts");

  // 2. 按下後三個 textarea 會被填入，並顯示提示
  await page.getByTestId("aiwf-generate-compound").click();
  await expect(page.getByTestId("aiwf-compound-hint")).toContainText("已產生 Compound Notes 草稿");

  const reusable = await page.getByTestId("aiwf-reusable-prompt").inputValue();
  const lesson = await page.getByTestId("aiwf-lesson-learned").inputValue();
  const notes = await page.getByTestId("aiwf-compound-notes").inputValue();
  expect(reusable.length).toBeGreaterThan(0);
  expect(lesson.length).toBeGreaterThan(0);
  expect(notes.length).toBeGreaterThan(0);

  // 內容使用最新 draft（風險 / changed files / 原始需求）
  expect(reusable).toContain("PHASE74 Compound E2E");
  expect(reusable).toContain("PHASE74 草稿風險一");
  expect(lesson).toContain("PHASE74 沉澱知識的原始需求內容");
  expect(notes).toContain("src/phase74-draft.ts");

  // 3. 按下後不會自動保存 localStorage
  const beforeSave = await readStoredTask(page, "PHASE74 Compound E2E");
  expect(beforeSave?.aiWorkflow).toBeUndefined();

  // 4. 按「保存 AI Workflow」後 reload，compound 欄位保留
  await page.getByTestId("aiwf-save").click();
  await expect(page.getByRole("button", { name: "✓ 已保存 AI Workflow" })).toBeVisible();

  const stored = await readStoredTask(page, "PHASE74 Compound E2E");
  const wf = stored?.aiWorkflow as {
    compound?: { reusablePrompt?: string; lessonLearned?: string; compoundNotes?: string };
  };
  expect(wf.compound?.reusablePrompt).toContain("PHASE74 Compound E2E");
  expect(wf.compound?.lessonLearned).toContain("PHASE74 沉澱知識的原始需求內容");
  expect(wf.compound?.compoundNotes).toContain("src/phase74-draft.ts");

  await page.reload();
  await page.locator(".task-card").first().click();
  await page.getByTestId("aiwf-toggle-compound").click();
  await expect(page.getByTestId("aiwf-lesson-learned")).toHaveValue(/PHASE74 沉澱知識的原始需求內容/);
  await expect(page.getByTestId("aiwf-compound-notes")).toHaveValue(/src\/phase74-draft\.ts/);

  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toEqual([]);
});
