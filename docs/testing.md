# 測試與驗證

本文件說明 **AI Coding Relay** 目前的測試與驗證方式，方便新進開發者了解如何在本機跑測試、確認改動沒有破壞既有功能。

---

## 1. 測試框架

目前專案使用 **[Vitest](https://vitest.dev/)** 作為唯一的測試框架。

- 設定檔：`vite.config.ts`（沿用 Vite 的設定，並透過 `vitest/config` 擴充 `test` 區塊）。
- 測試環境：`jsdom`，提供 `localStorage`、`window` 等瀏覽器 API，讓純函式測試可以直接使用儲存層相關邏輯。
- 全域 API：開啟 `globals: true`，測試檔案可以直接使用 `describe`、`it`、`expect`，不需要額外 import。
- Setup 檔案：`src/test/setup.ts`，會在所有測試執行前載入（例如註冊 `@testing-library/jest-dom` 等共用設定）。

專案中尚未引入其他測試框架（例如 Jest、Mocha），所有自動化測試一律以 Vitest 為準。

---

## 2. 可用指令

以下指令皆可在專案根目錄執行。

### `pnpm test`

以 **watch 模式** 啟動 Vitest。檔案有變動時會自動重跑相關測試，適合在本機開發時持續使用。

### `pnpm test:run`

以 **單次執行模式** 跑完所有測試後結束（`vitest run`）。適合在送 PR 前、CI 環境，或想確認整體狀態時使用。

### `npx tsc --noEmit`

執行 TypeScript 型別檢查，但**不輸出**任何編譯產物。用來確認程式碼是否有型別錯誤，不會動到 `dist/` 或其他輸出檔。

> 注意：此指令只做型別檢查，不會跑測試，也不會打包。

### `pnpm build`

執行 `tsc && vite build`：先做一次完整的 TypeScript 編譯檢查，再透過 Vite 打包前端產物。如果型別有錯，build 會直接失敗。送 PR 前建議至少跑過這個指令，確保專案可以正常編譯。

### `pnpm test:e2e`

以 **Playwright** 執行端對端（E2E）測試（`playwright test`），驗證核心 SDD 流程的真實 UI 行為。

- 會**自動啟動 `pnpm dev`**（vite dev server，port 1420），測試結束後自動關閉；若已有 dev server 在跑則沿用（`reuseExistingServer`）。
- 使用 Chromium，並授予剪貼簿權限以驗證各種「複製 Prompt」按鈕的內容。
- 詳見第 5 節。

---

## 3. 目前已有的 Unit Test

目前 Vitest 涵蓋的單元測試集中在「核心邏輯」與「儲存層」，皆為純函式或不依賴 React 元件的模組：

| 測試對象 | 測試檔案 |
| --- | --- |
| `taskService` | `src/core/taskService.test.ts` |
| `searchService` | `src/core/searchService.test.ts` |
| `roundService` | `src/core/roundService.test.ts` |
| `preferenceStorage` | `src/storage/preferenceStorage.test.ts` |

這些測試涵蓋了任務 CRUD、搜尋／篩選邏輯、輪次（round）管理，以及偏好設定的 localStorage 讀寫行為，是目前回歸驗證的主要依據。

---

## 4. 元件測試（尚未正式納入）

目前**尚未**為 React 元件（`src/components/`）建立正式的元件測試。

- `devDependencies` 中已安裝 `@testing-library/react` 與 `@testing-library/jest-dom`，技術上可以直接撰寫元件測試。
- 但目前沒有任何 `*.test.tsx` 檔案被納入專案，也沒有對應的測試規範。
- 元件層的驗證目前仍仰賴 **手動操作 UI** 或下一節提到的 Playwright E2E 測試（後者已涵蓋核心 SDD 流程的關鍵元件互動）。

未來若要補上元件測試，可從互動較複雜的元件（例如任務側欄、編輯區）開始，並沿用既有的 `src/test/setup.ts`。

---

## 5. Playwright E2E 測試（已正式納入專案）

E2E 測試使用 **[Playwright](https://playwright.dev/)**，已正式納入專案，可用 `pnpm test:e2e` 執行（Phase 30 起）。

- **依賴**：`@playwright/test` 已列於 `devDependencies`；`package.json` 有 `"test:e2e": "playwright test"` script。
- **設定檔**：`playwright.config.ts`（位於專案根目錄）。
  - `testDir: "./e2e"`，使用 Chromium。
  - `use.permissions: ["clipboard-read", "clipboard-write"]`——流程會以 `navigator.clipboard` 複製 / 讀取各種 Prompt，需要剪貼簿權限。
  - `webServer` 會**自動啟動 `pnpm dev`**（`http://localhost:1420`），測試跑完自動關閉；已有 server 時沿用（`reuseExistingServer`）。
- **測試位置**：`e2e/sdd-flow.spec.ts` 與 `e2e/local-runner.spec.ts`。
- **測試數量**：`pnpm test:e2e` 目前共 **47 個** E2E 測試（完整涵蓋與最新數字見第 7 節）。下列 (1)–(3) 為最初（Phase 30）納入的三條核心流程；Phase 48–60 又陸續新增 local runner / `/health` / Preflight / 修復建議 / 文件小改模板 / 自動摘要 / 完成建議 / runner 壞 JSON 防禦等測試：
  1. **SDD flow（核心 SDD + TDD + Refactor 流程）**
  2. **auto-round（一輪自動執行的 UI 端）**
  3. **auto-loop（多輪自動執行的 UI 端）**
- **(1) SDD flow 驗證範圍**：核心 SDD + TDD + Refactor 流程的真實 UI 行為，包含：
  - 新增任務（填入 originalRequirement / targetFiles / forbiddenFiles）。
  - workflowStage 預設為 `spec`。
  - 複製 Spec Prompt，並驗證內容（原始需求、目標 / 禁止檔案、Given-When-Then、不要實作程式碼）。
  - 在「規格草稿 Spec」貼入 specDraft。
  - 複製測試 Prompt（red）、實作 Prompt（green）、重構 Prompt（refactor），驗證各自階段關鍵字。
  - 複製 File Guard 設定指令，驗證含 `mkdir -p .ai-coding-relay`、`guard-rules.json` 與任務檔案。
  - 匯入一份含 `fileGuard` 的 verification JSON。
  - RoundTimeline 顯示驗證結果、command logs 與 fileGuard（檔案範圍）。
  - reload 後任務、specDraft、RoundTimeline 仍保留。
- **(2) auto-round 驗證範圍**：
  - 「複製 auto-round 指令」內容（含 `pnpm -s auto:round`、`aiCommand:"claude"`、依 workflowStage 推導的 `mode`）。
  - 匯入 auto-round JSON → RoundTimeline 顯示 auto-round 模式、AI 執行結果、stoppedReason、verification、fileGuard。
- **(3) auto-loop 驗證範圍**：
  - 「複製 auto-loop 指令」內容（含 `pnpm -s auto:loop`、`aiCommand:"claude"`、`maxRounds:3`、`autoApprove:false`、`workflowStage` 與依階段推導的 `mode`）。
  - 匯入多輪 auto-loop JSON → RoundTimeline 顯示 `Loop 1/3`~`3/3`、各輪 AI / stoppedReason / verification / fileGuard，且 reload 後多筆回合仍存在。
- 不需要真的呼叫 AI CLI 或跑 tsc / test / build：verification / auto-round / auto-loop 皆以**固定樣本 JSON**貼入匯入，確保測試快速且穩定。
- **console / pageerror 監聽**：每個測試全程蒐集瀏覽器錯誤，並在最後斷言皆為 0：
  - 監聽 `page.on("console")`，當 console 訊息的 `type` 為 `error` 時記錄下來；測試最後若有任何 console error，斷言會失敗。
  - 監聽 `page.on("pageerror")`，記錄未捕捉的例外；測試最後若有任何 pageerror，斷言會失敗。
  - 因此 **`pnpm test:e2e` 通過代表：核心流程通過，且 console error = 0、pageerror = 0**。

> 與 Vitest 的分工：`pnpm test` / `pnpm test:run` 只跑 `src/**` 下的單元測試（`vite.config.ts` 的 `test.include` 已限定範圍），**不會**撈到 `e2e/` 的 Playwright 規格；E2E 一律以 `pnpm test:e2e` 執行。
>
> Playwright 的輸出目錄（`test-results/`、`playwright-report/` 等）已加入 `.gitignore`。

---

## 6. 送 PR 前的建議流程

在目前的測試覆蓋下，送 PR 前建議至少跑過以下三項：

1. `pnpm test:run` — 確認所有單元測試通過。
2. `npx tsc --noEmit` — 確認沒有型別錯誤。
3. `pnpm build` — 確認專案可以完整編譯與打包。

若改動涉及 UI 或 SDD 流程，請額外跑 `pnpm test:e2e` 確認核心流程未被破壞；E2E 尚未覆蓋的細部互動，仍建議**手動操作受影響的畫面**確認行為符合預期。

---

## 7. 目前測試現況與分層（Phase 48–60 更新）

### 7.1 `pnpm test:run`（Vitest 單元測試）現況

- 目前共 **47 個單元測試**（`src/**` 下，6 個測試檔），全數通過。
- 除了既有的 `taskService` / `searchService` / `roundService` / `preferenceStorage` 純函式測試外，與本階段相關的還包含：
  - **`src/test/auto-round.verification.test.ts`**：以 fake project + 本機指令（如 `node --version`）取代真正的 AI CLI，整合測試 `scripts/auto-round.mjs` 的 verification 解析（合法 JSON、夾雜進度訊息、腳本不存在、非法 JSON、`verification.ok=false`、fileGuard 失敗、AI exitCode≠0 等）。
  - **`src/test/auto-scripts-flush.test.ts`**：以 **500KB 大輸出** + `child_process.spawn` pipe 擷取，驗證 `auto-round` / `auto-loop` / `auto-spec` 的 stdout 不再被 flush 截斷（Phase 58 修正的回歸保護）。
- 這些測試**完全不呼叫真正的 Claude / Codex**，以本機指令或固定樣本取代，確保快速、穩定、可重現。

### 7.2 `pnpm test:e2e`（Playwright E2E）現況

- 目前 **47 passed**（`e2e/sdd-flow.spec.ts` 與 `e2e/local-runner.spec.ts`）。
- 涵蓋範圍：
  - **SDD flow**：核心 SDD + TDD + Refactor 的 UI 行為與持久化。
  - **auto-round / auto-loop**：指令產生（mode 依 workflowStage 推導）、匯入結果、RoundTimeline、`Loop N/M`、reload 保留。
  - **local runner endpoint**：`/health`、`/preflight`、`/auto-spec`、`/auto-round`、`/auto-loop` 的白名單行為與 404；以**無效 task** 讓腳本在驗證階段就回錯誤 JSON，**不呼叫 AI**。
  - **Runner 狀態 UI**：已連線 / 未連線顯示、重新檢查、service / endpoints。
  - **Target Project Preflight**：fake project 的各檢查項、suggestion / fixCommand、UI 顯示與複製修復指令。
  - **執行前自動 Preflight**：auto-round / auto-loop 在 error 不執行、warning confirm、全綠直接執行。
  - **文件小改模板**：自動帶入欄位、不覆蓋 title / 原始需求 / projectPath、`workflowStage=green_implement`。
  - **自動摘要**：匯入後 summary 空白時自動產生草稿、非空不覆蓋。
  - **完成建議**：成功回合顯示、套用後 status / review / workflow 變更且**不自動封存**、失敗或 fileGuard 未過時不顯示。
  - **runner 壞 JSON 防禦（Phase 60）**：以暫存腳本驅動 `runScript`，驗證合法 JSON 照原樣回、非法 / 截斷 JSON 改回合法錯誤 JSON（含 `stoppedReason` / `runnerError` / `stdoutBytes` / `stdoutPreview` / `stdoutTail`）。
- E2E 一律以 **mock runner 或受控 fake project / 暫存腳本**驅動，**不呼叫真正的 Claude / Codex**，確保穩定。

### 7.3 Live smoke test（真實 Claude，手動）

- **Phase 59** 曾以**真實 dev server + 真實 local runner + 真實 Claude CLI** 對真實目標專案（harness）跑完整精簡流程，確認端到端可行（見 `docs/automation.md` 第 9.6 節）。
- **不建議**把這種 live test 預設納入一般 `pnpm test:e2e`：它會**真的呼叫 Claude**（耗時、需登入、有成本）並**實際修改目標專案檔案**，不具備一般 CI 需要的快速、穩定、可重現特性。
- 未來若要保留，建議設計成**獨立、需明確標記（如 `@live`）或手動觸發**的 smoke test，與一般 E2E 分開執行，並在受控的暫存目標專案上跑、跑後還原。

### 7.4 測試分層

| 層級 | 工具 | 目的 / 對象 | 是否呼叫真實 Claude |
| --- | --- | --- | --- |
| **單元 / 類元件測試** | Vitest | 純函式、parser、`scripts/*.mjs` 的行為（含 verification 解析、stdout flush 不截斷）| 否（用本機指令 / fake project / 固定樣本）|
| **Playwright E2E** | Playwright（Chromium）| UI 流程與 runner 整合：用 **mock runner** 或**受控 fake project / 暫存腳本**驗證 | 否 |
| **Live test** | 手動 / 特殊標記 | 真實 Claude + 真實 target project 的端到端煙霧測試 | **是**（手動、不入 CI 預設）|

### 7.5 console / pageerror 策略

- 大部分 E2E 仍全程監聽 `page.on("console")` 與 `page.on("pageerror")`，並在最後斷言 console error / pageerror 為 **0**——把瀏覽器層的非預期錯誤當成測試失敗。
- **例外**：測試「runner 未啟動」情境時，瀏覽器對 `http://localhost:4318` 的請求會出現**預期的** `ERR_CONNECTION_REFUSED`。這類**預期的 runner-down 錯誤**應在測試中過濾 / 容許，**不要**把它當成產品錯誤而使測試失敗（UI 對連不上 runner 的設計就是「不 alert、只顯示未連線並提示 `pnpm runner:local`」）。
