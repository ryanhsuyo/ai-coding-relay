# 半自動 AI Coding Relay 流程（SDD + TDD + Refactor + local runner 半自動穩定版）

本文件說明 **AI Coding Relay** 目前的「半自動」自動化流程：哪些階段已經完成、完整的人機協作使用流程、目前刻意保留為手動的部分與原因，以及之後可能的演進方向。

這裡的「relay（接力）」指的是 **規格 → 規格審查 → 測試 → 實作 → 重構 → 本機驗證 → 把結果帶回 UI → 產生下一輪 prompt** 的循環。目前這個循環是**半自動**：機械性、可程式化的步驟已經工具化，但「實際撰寫程式」與「決定下一步」仍由人在掌舵。

隨著 Phase 12–39 完成，整體流程已從單純的「驗證 relay」演進為 **SDD（Spec-Driven Development）+ TDD（含 red / green / refactor 三相）** 導向：先把粗需求整理成可驗證的規格草稿（specDraft）、檢查規格完整性，再依規格產生會先失敗的測試（red）、依規格與測試做最小實作（green）、在測試通過後做小範圍重構（refactor），全程以 File Guard 限制改動範圍。每筆任務並以 **workflowStage** 明確標記目前所處的流程階段（見第 4 節）。

Phase 32 起更進一步加入**本機 AI CLI 自動執行**：`pnpm auto:round`（一輪）與 `pnpm auto:loop`（多輪）可在 terminal 自動呼叫 AI CLI 跑一/多輪並驗證，結果再貼回 UI 匯入（見第 4.5 節）。這一段仍是「使用者在 terminal 主動執行、瀏覽器不執行 shell」的半自動模式。

**Phase 48–60** 再把上面「terminal 跑 + 手動貼回」這段升級為 **UI 一鍵 → 本機 local runner 執行 → 自動回灌**：新增 local runner（`/health`、`/preflight`、`/auto-spec`、`/auto-round`、`/auto-loop`）、UI Runner 狀態、目標專案 Preflight 與修復建議、「文件小改 auto-round」任務模板、執行前自動 Preflight、完成後自動產生任務摘要草稿、完成建議與一鍵套用，並完成兩次穩定化（auto scripts 的 stdout flush 截斷修正、runner 回傳前 JSON 防禦）。目前已是一個涵蓋 **SDD + TDD + Refactor + workflowStage + Playwright E2E + auto-spec/auto-round/auto-loop + local runner + AI Command 設定 + Runner health + Target Project Preflight + Preflight 修復建議 + 文件小改模板 + 執行前自動 Preflight + 自動摘要 + 完成建議 + stdout flush 修正 + runner JSON 防禦** 的**半自動穩定版**。完整整理見第 9 節；**瀏覽器仍不執行 shell**，實際呼叫 AI CLI 與跑驗證的是本機 local runner（見第 9.4 安全邊界）。

---

## 1. 已完成的自動化階段（Phase 1–39）

以下階段已實作並通過驗證，依建置順序排列。

### 1.1 `verify:local` — 本機驗證 runner

- 指令：`pnpm verify:local`（`scripts/run-verification.mjs`）。
- 依序執行：`npx tsc --noEmit`、`pnpm test:run`、`pnpm build`、`git status --short`、`git diff --stat`。
- 每個指令記錄 `name`、`command`、`exitCode`、`stdout`、`stderr`、`durationMs`、`ok`、`required`。
- `tsc` / `test` / `build` 任一失敗 → 整體 `ok` 為 `false`；`git status` / `git diff` 失敗只記錄、不影響整體流程，也不會讓 script crash。
- 最後把整體結果以合法 JSON 輸出到 stdout：

  ```json
  {
    "ok": true,
    "startedAt": "...",
    "finishedAt": "...",
    "durationMs": 5575,
    "commands": [ /* CommandResult[] */ ],
    "fileGuard": { /* 選擇性，見 1.7 */ }
  }
  ```

### 1.2 verification JSON 匯入

- 在 TaskDetail 的「匯入驗證結果」區塊，貼上 `run-verification.mjs` 輸出的 JSON 即可匯入。
- 解析後**新增一筆 TaskRound**，並保存：
  - `verificationOk`：整體是否通過。
  - `checklist`：`tsc` / `test` / `build` 的 passed / failed 狀態。
  - `commandLogs`：每個指令的 name、command、exitCode、ok、durationMs（以及 stdout / stderr）。
  - `gitStatus`：取 `name === "git-status"` 的 stdout。
  - `gitDiff`：取 `name === "git-diff"` 的 stdout。
  - `fileGuard`：選擇性，存在時一併保存（見 1.8）。
- JSON 格式錯誤時以 `alert` 顯示錯誤，不會讓畫面 crash；匯入成功後 textarea 清空，資料寫入 `localStorage`，重新整理後仍存在。
- RoundTimeline 會顯示「✅ 驗證通過 / ❌ 驗證未通過」徽章、checklist、可折疊的指令結果與 git status / diff。

### 1.3 審查 Prompt 自動包含驗證結果

- TaskDetail 的「複製審查 Prompt」會自動帶入該任務**最新一筆 verification round** 的結果。
- 在 prompt 中加入「本機驗證結果」區塊：驗證狀態、checklist、commandLogs **摘要**（不含 stdout / stderr 全文）、gitStatus、gitDiff，以及 fileGuard（見 1.9）。
- 沒有 verification round 時，審查 Prompt 維持原本格式。

### 1.4 修正 Prompt 自動包含驗證結果

- TaskDetail 的「複製修正 Prompt」同樣會自動帶入最新 verification round 的「本機驗證結果」區塊。
- 位置固定在「驗收結果」之後、「下一步」之前；commandLogs 同樣只放摘要。
- 與審查 Prompt 共用同一套 `findLatestVerificationRound` / `buildVerificationSection`，沒有重複實作。

### 1.5 `verify:copy` — 驗證結果自動複製到剪貼簿

- 指令：`pnpm verify:copy`（`scripts/copy-verification.mjs`）。
- 執行既有的 `run-verification.mjs`，取得 JSON 後驗證為合法 JSON，再複製到系統剪貼簿：
  - macOS：`pbcopy`
  - Windows：`clip`
  - Linux：依序嘗試 `xclip`、`xsel`，都不存在時顯示友善錯誤。
- terminal 顯示簡短摘要：`ok`、commands 數量、failed commands、`durationMs`。

### 1.6 UI 顯示並複製驗證指令

- 「匯入驗證結果」區塊顯示建議指令 `pnpm verify:copy`，並提供「複製驗證指令」按鈕。
- 點擊後以 `navigator.clipboard.writeText("pnpm verify:copy")` 複製，成功後按鈕短暫顯示「✓ 已複製」，失敗則 `alert`。
- 目的是讓使用者一鍵拿到指令，回 terminal 貼上執行即可，降低手動輸入錯誤。

### 1.7 File Guard runner（Phase 8）

- `scripts/check-file-guard.mjs`：從 stdin 讀取 `{ targetFiles, forbiddenFiles }` 規則，對 `git diff --name-only` 取得的「目前已修改檔案」做範圍比對，輸出 `fileGuard` 結果 JSON。
- 違規類型：
  - `forbidden`：改到 `forbiddenFiles` 內的檔案（優先判定，不再重複報 outside_target）。
  - `outside_target`：`targetFiles` 非空時，改到不在 `targetFiles` 內的檔案。
- `run-verification.mjs` 在**專案根目錄存在 `.ai-coding-relay/guard-rules.json` 時**會自動執行 File Guard，並把 `fileGuard` 加進 verification JSON；不存在時則略過（向後相容）。
- File Guard 有違規時整體 `ok` 會變成 `false`。

### 1.8 UI 產生 File Guard 設定指令 + 顯示結果（Phase 9–10）

- 「匯入驗證結果」區塊附近提供「複製 File Guard 設定指令」按鈕：依**目前任務的 `targetFiles` / `forbiddenFiles`** 產生一段 terminal 指令（`mkdir -p .ai-coding-relay` + heredoc 寫入 `guard-rules.json`），讓使用者複製後自行貼到 terminal 執行。**瀏覽器本身不執行 shell。**
- 匯入 verification JSON 時若含 `fileGuard`，會保存到 `round.fileGuard`。
- RoundTimeline 顯示 File Guard 區塊：狀態（通過 / 未通過）、`modifiedFiles`、`targetFiles`、`forbiddenFiles`、`violations`（含 type 與 file）、`error`；`ok === false` 時以徽章標示「檔案範圍未通過」。沒有 fileGuard 的舊 round 不顯示該區塊。

### 1.9 審查 / 修正 Prompt 自動包含 fileGuard（Phase 11）

- `buildVerificationSection` 的「本機驗證結果」區塊會在最新 verification round 有 `fileGuard` 時，加入「檔案範圍檢查」資訊：狀態、`violations`（type / file）、`error`、以及非空的 `modifiedFiles` / `targetFiles` / `forbiddenFiles`（空陣列略過以免 prompt 過長）。
- 審查 Prompt 與修正 Prompt 共用同一函式，兩者都會自動帶入。

### 1.10 specDraft 規格草稿欄位（Phase 12）

- `Task` 新增選擇性 `specDraft?: string`，承載結構化規格與 Given-When-Then 場景；舊資料保持 `undefined`。
- TaskDetail 新增「規格草稿 Spec」textarea，失焦時儲存，空字串存成 `undefined`。
- specDraft 納入搜尋、匯出 / 匯入與 `localStorage` 持久化。
- 各 prompt（實作 / 審查 / 修正 / 規格審查 / 測試 / 重構）在 specDraft 存在時都會帶入。

### 1.11 複製 Spec Prompt（Phase 13）

- 依目前任務的粗需求（標題、originalRequirement、現有 specDraft、targetFiles、forbiddenFiles、constraints、acceptanceCriteria）產生 prompt，請 Claude 輸出一份結構化規格草稿。
- 要求輸出格式包含：**功能範圍 / 規則 / API · UI 設計 / Given-When-Then 場景 / 不在範圍**。
- 明確提醒：不要實作程式碼、只產生 specDraft、不要擴大需求、不確定處列出待確認問題。

### 1.12 複製測試 Prompt（Phase 14）

- 依任務標題、originalRequirement、specDraft、targetFiles / forbiddenFiles / constraints / acceptanceCriteria 產生 prompt，請 Claude 依 specDraft 產生測試。
- 此為基礎版；Phase 20 進一步強化為 TDD red phase（見 1.16）。

### 1.13 複製實作 Prompt（Phase 15–16）

- 原本的「複製 Claude Prompt」升級為「複製實作 Prompt」，以 Spec + Test 為核心。
- 此為基礎版；Phase 21 進一步強化為 TDD green phase（見 1.17）。
- Prompt 工具群顯示順序整理為 SDD + TDD 流程（Phase 22 後為 **Spec → Spec Review → Test → Implement → Refactor → Review → Fix**）。

### 1.14 完整 E2E 流程驗證（Phase 17）

- 以 Playwright（Chromium）驅動真實 UI，端到端跑完整 SDD 流程並讀取剪貼簿內容驗證，37 checks 全通過、零 console / page error。為 SDD 半自動穩定版的第一個 E2E 基準。

### 1.15 複製 Spec Review Prompt（Phase 19）

- 在「複製 Spec Prompt」之後、「複製測試 Prompt」之前新增「複製 Spec Review Prompt」按鈕，作為 specDraft 與測試之間的**規格完整性檢查點**。
- 帶入任務標題、originalRequirement、specDraft、targetFiles / forbiddenFiles / constraints / acceptanceCriteria（空欄位略過、陣列條列）。
- specDraft **存在**時要求 Claude 檢查：功能範圍是否清楚、規則是否明確、API · UI 設計是否足夠、Given-When-Then 場景是否足夠、不在範圍是否寫清楚、是否遺漏邊界條件、**是否足以產生測試**、是否有需求不明確處；並要求回覆格式：**結論（可進入測試產生 / 需要補規格）**、缺口列表、建議補充的 Given-When-Then 場景、建議補充的不在範圍、待確認問題。
- specDraft **不存在**時，明確要求先補上 specDraft、補齊前不要直接進入測試。

### 1.16 測試 Prompt 強化為 TDD red phase（Phase 20）

- 測試 Prompt 明確要求進入 **TDD red phase**：這階段只新增 / 修改測試、不要實作功能；測試對應 specDraft 的 Given-When-Then 場景（每場景至少一測試）；測試應能在功能尚未完成時失敗，若無法先失敗需說明原因；不要修改 production code（除非為了暴露可測試 API，且需先說明理由）；不要擴大需求；不要修改 forbiddenFiles。
- 回覆要求新增 / 修改的測試檔案、測試案例摘要（對應哪些場景）、**如何執行測試**、**預期哪些測試會先失敗（red）及原因**、無法先失敗的原因、需確認處。

### 1.17 實作 Prompt 強化為 TDD green phase（Phase 21）

- specDraft 存在時，實作 Prompt 明確標示 **TDD green phase**：依 specDraft 與既有測試實作、**只做讓測試通過所需的最小實作**、**不要在 green phase 做額外重構**、不要擴大需求、保留 forbiddenFiles / targetFiles 護欄、實作後建議 `pnpm verify:copy`。
- specDraft 不存在時保留安全提醒（需求不明確先提待確認問題、不擴大需求、檔案護欄、建議驗證）。
- 兩種情況都要求回覆：修改檔案清單、實作摘要、對應哪些測試 / 驗收條件、是否有未完成事項、建議執行的驗證指令。

### 1.18 複製重構 Prompt（Phase 22）

- 在「複製實作 Prompt」之後、「複製審查 Prompt」之前新增「複製重構 Prompt」按鈕，補上 **TDD refactor phase**。
- 帶入任務標題、originalRequirement、specDraft、**最新本機驗證結果 + fileGuard 結果**（共用 `findLatestVerificationRound` / `buildVerificationSection`）、targetFiles / forbiddenFiles / constraints / acceptanceCriteria。
- 明確要求：只有測試已通過時才進行、**不改變既有行為**、**不新增功能**、**不擴大需求**、保持測試持續通過、保留 forbiddenFiles / targetFiles 護欄、重構後建議 `pnpm verify:copy`。
- 回覆要求：重構檔案清單、重構摘要、**為什麼不影響既有行為**、需重新跑的驗證指令、風險或待確認事項。

### 1.19 完整 SDD + TDD + Refactor E2E 驗證（Phase 23）

- 以 Playwright（Chromium）端到端驗證涵蓋 red / green / refactor 三相的完整流程，27 checks 全通過、零錯誤。詳見第 5 節。

### 1.20 workflowStage 工作流階段欄位與 UI（Phase 25）

- `Task` 新增 `workflowStage` 欄位（九個階段，見第 4 節），新任務預設 `spec`，舊資料讀取時補成 `spec`；納入匯出 / 匯入與 `localStorage` 持久化。
- TaskDetail 新增「工作流階段」select；TaskSidebar 任務卡顯示 workflowStage badge，並新增 workflowStage 篩選（與 status / dueDate / tag / project / reviewResult / 搜尋 / 排序一起作用）。
- 統計摘要新增主要階段數量：規格、紅燈、綠燈、修正、完成。

### 1.21 下一階段快速推進（Phase 26）

- TaskDetail 在 workflowStage select 旁新增「下一階段」按鈕，依目前階段推進到下一階段（推進規則見第 4 節），按鈕文字顯示下一階段名稱（例如「下一階段：規格審查」）。
- `done` 時按鈕 disabled 並顯示「已完成」；推進後立即保存到 `localStorage`，不影響手動 select。

### 1.22 階段說明提示（Phase 27）

- TaskDetail 在 workflowStage 控制項附近顯示一段**唯讀**提示，依目前階段說明「此階段該做什麼、建議按哪個 Prompt」（缺值時視為 `spec`）。
- 純顯示，不改變流程邏輯、不自動切換階段。

### 1.23 workflowStage 完整流程 E2E 驗證（Phase 28）

- 以 Playwright（Chromium）端到端驗證 workflowStage 的預設值、階段提示、下一階段推進、手動 select、reload 持久化、sidebar badge、篩選與統計，29 checks 全通過、零錯誤。詳見第 5 節。

### 1.24 Playwright E2E 正式納入專案（Phase 30）

- 先前各階段（Phase 17 / 23 / 28）的 Playwright E2E 是以 `/tmp` 下的**臨時腳本**手動執行；Phase 30 起，E2E 已**正式納入專案**：
  - `@playwright/test` 列入 `devDependencies`，`package.json` 新增 `"test:e2e": "playwright test"`。
  - 新增 `playwright.config.ts`（testDir `./e2e`、Chromium、剪貼簿權限、`webServer` 自動啟動 `pnpm dev`）。
  - 新增正式測試 `e2e/sdd-flow.spec.ts`，驗證核心 SDD 流程。
  - `vite.config.ts` 的 vitest `test.include` 限定 `src/**`，避免單元測試撈到 e2e 規格；Playwright 輸出已加入 `.gitignore`。
- 詳見第 5 節，以及 `docs/testing.md`。

### 1.25 auto-round — 一輪自動執行 CLI（Phase 32）

- 指令：`pnpm auto:round`（`scripts/auto-round.mjs`），從 **stdin 讀任務 JSON**，自動跑「一輪」並輸出結果 JSON 到 stdout。
- 流程：驗證必要欄位 → 檢查 `projectPath` 存在 → 依 `targetFiles`/`forbiddenFiles` 建立 `.ai-coding-relay/guard-rules.json` → 把依 `mode` 產生的 prompt 餵給 `aiCommand`（AI CLI）的 stdin → 執行目標專案的 `scripts/run-verification.mjs` → 輸出 `{ ok, mode, ai, verification, stoppedReason? }`。
- `mode` 對應 TDD 階段（`test`/`implement`/`refactor`/`fix`）。整體 `ok` = AI 成功 ∧ verification 通過 ∧ fileGuard 未違規；**fileGuard 失敗時 `stoppedReason` 含 `file_guard_failed`**。
- **不自動 commit / push**；瀏覽器不參與（純 CLI）。

### 1.26 UI 匯入 auto-round 結果（Phase 33）

- TaskDetail 可貼上 auto-round JSON，解析後新增一筆 TaskRound，保存 `autoRoundMode` / `aiResult` / `autoRoundOk` / `stoppedReason` 以及 verification 的 commandLogs / gitStatus / gitDiff / fileGuard / checklist。
- RoundTimeline 顯示 auto-round 模式徽章、AI 執行結果、stoppedReason、verification 與 fileGuard。匯入入口會自動辨識「本機驗證 JSON / auto-round JSON」格式。

### 1.27 UI 產生 auto-round 指令（Phase 34）

- TaskDetail 提供「複製 auto-round 指令」按鈕，依目前任務產生 `cat <<'EOF' | pnpm -s auto:round … EOF` 指令（含任務欄位 + `mode` + `aiCommand`），複製後由使用者貼到 terminal 執行。**瀏覽器不執行 shell。**
- `mode` 依 workflowStage 推導（`red_test→test`、`green_implement→implement`、`refactor→refactor`、`fix→fix`、其他→`implement`），`aiCommand` 第一版固定 `claude`。

### 1.28 auto-round 流程納入 E2E（Phase 35）

- `e2e/sdd-flow.spec.ts` 新增 auto-round 測試：驗證指令產生（含 mode 推導）、匯入 auto-round JSON、RoundTimeline 顯示，並監聽 console / pageerror 為 0。

### 1.29 auto-loop — 多輪自動執行 CLI（Phase 36）

- 指令：`pnpm auto:loop`（`scripts/auto-loop.mjs`），從 stdin 讀任務 JSON，依狀態機跑「多輪」，每輪呼叫 `scripts/auto-round.mjs`。
- **狀態機**（成功 → 失敗）：`test → implement / fix`、`implement → refactor / fix`、`fix → refactor / fix`、`refactor → done / fix`。
- **approval gate**：`autoApprove` 預設 `false` → **只跑一輪**並輸出 `suggestedNextMode`（交給人核准）；`autoApprove: true` 才允許多輪。
- **maxRounds**：預設 `3`，clamp 到 `1..10`；達上限停止（`stoppedReason: "max_rounds_reached"`）。
- **停止規則**：`fileGuard` 失敗 → 立即停（`file_guard_failed`）；AI 失敗 → 停（`ai_failed`）；`refactor` 成功 → `done`（`ok:true`）。**verification 失敗不直接停，下一輪進 `fix`。**
- **輸出**：stdout 只輸出單一合法 JSON（`{ ok, maxRounds, totalRounds, autoApprove, initialMode, finalMode, suggestedNextMode?, stoppedReason, rounds: [] }`）；stderr 每輪一行 NDJSON progress。**不自動 commit / push。**

### 1.30 UI 匯入 auto-loop 結果（Phase 37）

- TaskDetail 可貼上 auto-loop JSON，依 `rounds[]` **逐筆新增多筆 TaskRound**，每筆額外保存 loop metadata（`loopRoundIndex` / `loopTotalRounds` / `loopStoppedReason`）。
- RoundTimeline 顯示 `Loop N/M` 徽章、各輪 AI 結果、stoppedReason、verification 與 fileGuard。匯入入口自動辨識三種格式（驗證 / auto-round / auto-loop）。

### 1.31 UI 產生 auto-loop 指令（Phase 38）

- TaskDetail 提供「複製 auto-loop 指令」按鈕，依目前任務產生 `cat <<'EOF' | pnpm -s auto:loop … EOF` 指令，內容含任務欄位 + `workflowStage` + `mode`（同 1.27 推導）+ `aiCommand:"claude"` + `maxRounds:3` + `autoApprove:false`。

### 1.32 auto-loop 流程納入 E2E（Phase 39）

- `e2e/sdd-flow.spec.ts` 新增 auto-loop 測試：驗證指令產生（含 mode/maxRounds/autoApprove/workflowStage）、匯入多輪 auto-loop JSON、RoundTimeline 顯示 `Loop 1/3`~`3/3`、reload 持久化，並監聽 console / pageerror 為 0。

---

## 2. 七種 Prompt 一覽

目前 TaskDetail 的「Prompt 工具」群依 SDD + TDD 流程排列，共七種 prompt（皆以 `navigator.clipboard.writeText` 複製，成功短暫顯示「✓ 已複製」、失敗 `alert`，**不直接呼叫任何 AI**）：

| 順序 | Prompt | 階段 | 用途 |
| --- | --- | --- | --- |
| 1 | **Spec Prompt** | 規格 | 依粗需求請 AI 產生結構化 specDraft |
| 2 | **Spec Review Prompt** | 規格審查 | 檢查 specDraft 是否清楚、完整、足以產生測試 |
| 3 | **Test Prompt** | 測試（red） | 依 specDraft 先寫會失敗的測試，不實作功能 |
| 4 | **Implement Prompt** | 實作（green） | 依 spec + 測試做最小實作讓測試通過 |
| 5 | **Refactor Prompt** | 重構（refactor） | 測試通過後做不改變行為的小範圍重構 |
| 6 | **Review Prompt** | 審查 | 帶入最新驗證結果 + fileGuard 請 AI 審查 |
| 7 | **Fix Prompt** | 修正 | 帶入驗收結果 + 驗證結果產生下一輪修正 prompt |

> Spec / Spec Review / Test / Implement / Refactor 在 specDraft 存在時都會帶入規格；Refactor / Review / Fix 會帶入最新 verification round 的本機驗證結果與 fileGuard。

---

## 3. 目前穩定流程（SDD + TDD + Refactor 半自動）

一輪完整的 relay 如下：

```
複製 Spec Prompt（依粗需求）→ 貼給 Claude，產生規格草稿
        │
        ▼
把規格貼回 UI 的「規格草稿 Spec」欄位（specDraft）
        │
        ▼
複製 Spec Review Prompt → 貼給 Claude，檢查規格完整性
（結論：可進入測試產生 / 需要補規格；不足則補規格後再來一次）
        │
        ▼
複製 Test Prompt（red）→ 貼給 Claude，先寫會失敗的測試、不實作功能
        │
        ▼
複製 Implement Prompt（green）→ 貼給 Claude，做最小實作讓測試通過
        │
        ▼
複製 Refactor Prompt（refactor）→ 測試通過後做不改變行為的小範圍重構
        │
        ▼
複製 File Guard 設定指令 → 在 terminal 執行
（依任務 targetFiles / forbiddenFiles 建立 .ai-coding-relay/guard-rules.json）
        │
        ▼
在 terminal 執行 pnpm verify:copy
（自動跑 tsc / test / build / git + File Guard，並把 JSON 複製到剪貼簿）
        │
        ▼
回 UI，在「匯入驗證結果」貼上 JSON → 點「匯入驗證結果」
（新增一筆 TaskRound，保存 verificationOk / checklist / commandLogs / gitStatus / gitDiff / fileGuard）
        │
        ▼
複製 Review Prompt 或 Fix Prompt
（自動帶入 specDraft + 本機驗證結果 + fileGuard 結果）
        │
        ▼
把 prompt 貼回 Claude，進入下一輪
```

一句話：**Spec → Spec Review → Test(red) → Implement(green) → Refactor → File Guard → Verify → Import → Review → Fix**。

每一步都可用 TaskDetail 的「工作流階段」select 或「下一階段」按鈕把任務的 workflowStage 推進到對應階段（見第 4 節），讓進度一目了然。

步驟對照：

| 步驟 | 操作 | 對應工具 | workflowStage |
| --- | --- | --- | --- |
| 1 | 依粗需求產生規格 | 「複製 Spec Prompt」 | spec |
| 2 | 規格存回任務 | TaskDetail「規格草稿 Spec」（specDraft） | spec |
| 3 | 檢查規格完整性 | 「複製 Spec Review Prompt」 | spec_review |
| 4 | 依規格先寫會失敗的測試 | 「複製測試 Prompt」（red） | red_test |
| 5 | 做最小實作讓測試通過 | 「複製實作 Prompt」（green） | green_implement |
| 6 | 測試通過後重構 | 「複製重構 Prompt」（refactor） | refactor |
| 7 | 建立檔案護欄 + 跑驗證 | 「複製 File Guard 設定指令」、`pnpm verify:copy` | verify |
| 8 | 回 UI 貼上 JSON 並匯入 | TaskDetail「匯入驗證結果」→ 新增 TaskRound | verify |
| 9 | 審查 / 產生下一輪修正 prompt | 「複製審查 Prompt」/「複製修正 Prompt」 | review / fix |
| 10 | 收尾、填 summary、封存 | TaskDetail 摘要 + 封存 | done |

> 小提醒：UI 內的「複製驗證指令」與「複製 File Guard 設定指令」按鈕都只是把指令複製到剪貼簿，**不會**自己去執行——實際執行仍需由使用者在 terminal 完成。

---

## 4. workflowStage 工作流階段追蹤

每筆任務都有一個 `workflowStage`，用來標記目前所處的 SDD / TDD 流程階段，讓使用者知道「下一步該做什麼、該按哪個 Prompt」。新任務預設 `spec`，舊資料讀取時補成 `spec`。

### 4.1 九個階段

| value | 中文 | 此階段該做什麼（提示） |
| --- | --- | --- |
| `spec` | 規格撰寫 | 撰寫或產生 specDraft。建議使用「複製 Spec Prompt」。 |
| `spec_review` | 規格審查 | 檢查 specDraft 是否完整可測試。建議使用「複製 Spec Review Prompt」。 |
| `red_test` | 紅燈測試 | 根據 specDraft 產生會先失敗的測試。建議使用「複製測試 Prompt」。 |
| `green_implement` | 綠燈實作 | 根據 specDraft 與測試做最小實作。建議使用「複製實作 Prompt」。 |
| `refactor` | 重構 | 在測試通過後做不改變行為的小範圍重構。建議使用「複製重構 Prompt」。 |
| `verify` | 本機驗證 | 執行 File Guard 設定指令與 `pnpm verify:copy`，並匯入驗證結果。 |
| `review` | 審查 | 根據驗證結果審查修改。建議使用「複製審查 Prompt」。 |
| `fix` | 修正 | 根據審查結果與 nextActions 修正。建議使用「複製修正 Prompt」。 |
| `done` | 完成 | 任務已完成，可填 summary 並封存。 |

### 4.2 下一階段推進規則

「下一階段」按鈕依下列規則推進（缺值視為 `spec`）：

```
spec → spec_review → red_test → green_implement → refactor → verify → review → done
fix  → green_implement
done → done（不再推進；按鈕 disabled 並顯示「已完成」）
```

- 主線是一條單向序列；`review` 直接收斂到 `done`。
- `fix` 是「審查後需要修改」的分支：修正完回到 `green_implement` 重新走 green → refactor → verify → review。
- 推進與手動 select 共用同一條更新路徑，皆會立即寫入 `localStorage`、reload 後保留。

### 4.3 workflowStage 與 status / reviewResult 的差異

三個欄位各自獨立、彼此不互相覆寫，分別回答不同問題：

| 欄位 | 回答什麼 | 取值 |
| --- | --- | --- |
| `status` | 任務**整體進度** | `todo` / `in_progress` / `done` |
| `reviewResult` | **驗收結果** | `not_reviewed` / `passed` / `needs_fix` |
| `workflowStage` | **SDD / TDD 流程階段** | `spec` … `done`（九階段） |

- `status` 是看板層級的粗粒度進度（待處理 / 進行中 / 已完成），用來管理整體工作流。
- `reviewResult` 是某一輪修改通過驗收與否的結論，影響修正 Prompt 帶入的「驗收結果」。
- `workflowStage` 是這條 SDD + TDD 流水線上的細粒度位置，用來提示下一步操作與對應 Prompt。
- 三者可以任意組合：例如一筆 `status = in_progress`、`reviewResult = needs_fix`、`workflowStage = fix` 的任務，代表「進行中、上一輪驗收需修改、目前正在修正階段」。

---

## 4.5 AI CLI 自動執行（auto-round / auto-loop）

在 terminal（非瀏覽器）由使用者主動執行的本機自動化，把「呼叫 AI CLI → 跑驗證」這段也工具化。兩個指令都從 stdin 讀任務 JSON、輸出單一 JSON 到 stdout、**不自動 commit / push**。

### `pnpm auto:round`（一輪）

跑一輪：建立 `guard-rules.json` → 依 `mode` 產生 prompt 餵給 `aiCommand`（如 `claude`）→ 跑 `run-verification.mjs` → 輸出 `{ ok, mode, ai, verification, stoppedReason? }`。`fileGuard` 失敗時整體 `ok=false` 且 `stoppedReason` 含 `file_guard_failed`。

### `pnpm auto:loop`（多輪）

依狀態機跑多輪，每輪呼叫 `auto:round`：

| 規則 | 行為 |
| --- | --- |
| 起始 mode | 由 `task.mode` 或 `workflowStage` 推導 |
| 成功轉移 | `test→implement`、`implement→refactor`、`fix→refactor`、`refactor→done` |
| verification 失敗 | **不停止，下一輪進 `fix`** |
| fileGuard 失敗 | **立即停止**（`stoppedReason: file_guard_failed`） |
| AI 失敗 | 停止（`ai_failed`） |
| `autoApprove` | 預設 **`false` → 只跑一輪** 並輸出 `suggestedNextMode`；`true` 才允許多輪 |
| `maxRounds` | 預設 **3**，clamp 到 **1..10**；達上限 → `max_rounds_reached` |
| 成功完成 | `refactor` 成功 → `stoppedReason: done`、`ok:true` |

輸出含 `rounds: []`（每輪一筆 auto-round 結果）；stdout 是單一 JSON、stderr 每輪一行 NDJSON progress。

### UI 配合（不執行 shell）

- **產生指令**：TaskDetail 的「複製 auto-round 指令」/「複製 auto-loop 指令」依目前任務（含 `workflowStage` 推導的 `mode`、`aiCommand:"claude"`，loop 另含 `maxRounds:3`、`autoApprove:false`）產生 `cat <<'EOF' | pnpm -s auto:round/auto:loop … EOF`，複製後由使用者貼到 terminal 執行。
- **匯入結果**：TaskDetail 的匯入區塊可貼上 auto-round / auto-loop JSON；auto-round 新增一筆 TaskRound，auto-loop 依 `rounds[]` 逐筆新增多筆並以 `Loop N/M` 顯示。匯入入口自動辨識三種格式（驗證 / auto-round / auto-loop）。
- **E2E 覆蓋**：`e2e/sdd-flow.spec.ts` 已涵蓋 auto-round 與 auto-loop 的指令產生與 JSON 匯入（見第 5 節與 `docs/testing.md`）。

---

## 5. E2E 驗證結果摘要

所有 E2E 驗證皆以 Playwright（Chromium）驅動真實 UI（dev server `localhost:1420`），從乾淨 `localStorage` 啟動，過程不修改任何 src 程式碼。

> Phase 17 / 23 / 28 當時是以 `/tmp` 下的臨時腳本手動執行；自 Phase 30 起，E2E 已**正式納入專案**，可直接用 `pnpm test:e2e` 執行（測試位於 `e2e/sdd-flow.spec.ts`，會自動啟動 `pnpm dev`）。設定與用法詳見 `docs/testing.md`。

### 5.1 Phase 23 — SDD + TDD + Refactor 完整流程

授予剪貼簿權限後實際點擊每個按鈕並讀取 `navigator.clipboard` 內容；File Guard 指令以真實 shell 執行、`run-verification.mjs` 真實跑出含 `fileGuard` 的 JSON 再貼回 UI 匯入。涵蓋：新增任務 → Spec Prompt → 填入 specDraft → Spec Review Prompt → Test Prompt（red）→ Implement Prompt（green）→ File Guard 設定指令與執行 → `verify:copy` → 匯入驗證結果 → RoundTimeline 顯示 → Refactor Prompt → Review Prompt → Fix Prompt → reload 持久化。

- **27 / 27 checks passed**、**console errors：0**、**pageerror：0**。
- reload 後任務 / specDraft / RoundTimeline 皆保留。
- fileGuard 正確顯示 violations（`ok=false, violations=4`，含 `forbidden` 與 `outside_target`），並正確帶入 Refactor / Review / Fix Prompt。

### 5.2 Phase 28 — workflowStage 完整流程

實際操作 workflowStage select、「下一階段」按鈕、篩選與 reload，驗證階段追蹤的完整行為。

- **29 / 29 checks passed**、**console errors：0**、**pageerror：0**。
- 新任務預設 `spec`；每個階段顯示對應提示文字、且提到正確的 Prompt。
- 「下一階段」依序推進 `spec → spec_review → red_test → green_implement → refactor → verify → review → done`；`fix → green_implement`；`done` 時按鈕 disabled 並顯示「已完成」。
- 手動 select 正常；**reload 後 workflowStage 保留**；**Sidebar badge / 篩選 / 統計皆正常**（篩選「完成」可篩出任務、「規格撰寫」篩掉；統計顯示主要階段數量）。

### 5.3 Phase 30 — 正式 E2E 測試（`pnpm test:e2e`）

把核心流程整理成專案內正式測試 `e2e/sdd-flow.spec.ts`，由 `pnpm test:e2e` 執行。為求快速與穩定，verification JSON 改用一份含 `fileGuard` 的固定樣本貼入匯入（不再每次真跑 tsc / test / build）。

- 涵蓋：新增任務 → workflowStage 預設 `spec` → 複製 Spec Prompt → 貼入 specDraft → 複製測試 / 實作 / 重構 Prompt → 複製 File Guard 設定指令 → 匯入 verification JSON → RoundTimeline 顯示驗證與 fileGuard → reload 保留。
- 結果：**E2E 通過**；`pnpm test:run`（37 單元測試）與 `npx tsc --noEmit` 亦通過。

### 5.4 Phase 35 / 39 — auto-round 與 auto-loop 流程

`e2e/sdd-flow.spec.ts` 另外新增兩個測試，把 AI CLI 自動執行的 UI 端也納入回歸：

- **auto-round（Phase 35）**：驗證「複製 auto-round 指令」內容與 mode 依 workflowStage 推導、匯入 auto-round JSON、RoundTimeline 顯示 AI / stoppedReason / verification / fileGuard。
- **auto-loop（Phase 39）**：驗證「複製 auto-loop 指令」內容（含 `maxRounds:3` / `autoApprove:false` / `workflowStage` 與 mode 推導）、匯入多輪 auto-loop JSON、RoundTimeline 顯示 `Loop 1/3`~`3/3`、reload 持久化。
- 兩個測試都監聽 console / pageerror，**皆為 0**。

目前 `pnpm test:e2e` 共 **3 個測試**（SDD flow / auto-round / auto-loop）全數通過。

**結論：目前可視為 SDD + TDD + Refactor 半自動穩定版，且 workflowStage 階段追蹤與 auto-round / auto-loop 流程穩定。** 整條 Spec → Spec Review → Test(red) → Implement(green) → Refactor → File Guard → Verify → Import → Review → Fix → Reload 鏈路端到端串通、無錯誤、資料持久化正常。

> Phase 17（37 checks）為導入 specDraft 後的第一個 E2E 基準；Phase 23（27 checks）補齊 Spec Review 與 TDD 三相驗證；Phase 28（29 checks）補齊 workflowStage 階段追蹤驗證；Phase 30 把核心流程正式納入專案測試（`pnpm test:e2e`）；Phase 35 / 39 再補上 auto-round / auto-loop 兩條 E2E（目前共 3 個測試）。

---

## 6. 目前刻意不做的事（仍是半自動）

以下並非「還沒做完」，而是**目前階段刻意保留**的邊界：

- **瀏覽器不直接執行 shell**：UI 不會、也沒有能力直接在本機跑指令。所有指令（`verify:copy`、File Guard 設定指令、`auto:round` / `auto:loop`）都由使用者在 terminal 主動執行；UI 只負責「產生指令字串」與「匯入結果 JSON」。
- **AI CLI 只由 terminal 腳本呼叫，UI 端不直接呼叫 AI**：UI 內的七種 Prompt（Spec / Spec Review / Test / Implement / Refactor / Review / Fix）仍由使用者手動貼到外部 AI 工具。`auto:round` / `auto:loop` 雖會呼叫 `aiCommand`（如 `claude`），但那是使用者在 terminal 主動執行的 CLI 腳本，應用程式（瀏覽器 UI）本身不直接呼叫任何 AI。
- **多輪自動推進需顯式開啟**：`auto:loop` 預設 `autoApprove:false` 只跑一輪；要連續多輪必須顯式設定 `autoApprove:true`，且仍受 `maxRounds` 與 fileGuard 硬停約束。每一輪的「實際採用與否」仍由人把結果貼回 UI 時決定。
- **結果回灌仍是手動**：`auto:round` / `auto:loop` 的輸出 JSON 由使用者手動貼回 UI 匯入；沒有「CLI 自動寫入 UI 狀態」的閉環。
- **workflowStage 不會自動切換**：階段只由使用者透過 select 或「下一階段」按鈕推進，工具不會根據驗證結果自動改變階段。

---

## 7. 為什麼維持半自動

上述邊界是基於三個原則：

- **安全**：不讓瀏覽器或應用程式擁有直接執行 shell、改檔案的能力，可大幅縮小被誤用或被注入指令的風險面。
- **可控**：每一輪都有人在中間確認驗證結果與下一步 prompt，AI 的修改不會在無人監督下連續套用。
- **避免 AI 無限制修改本機檔案**：規格、審查、測試、驗證、匯入、產生 prompt 都是「唯讀 / 純資料」的操作；真正會動到檔案的修改，仍透過外部 AI 工具，由使用者逐輪審視，並由 File Guard 比對改動是否越界，避免失控的批次改動。

簡言之：機械性的步驟交給工具，需要判斷與授權的步驟留給人。

---

## 8. 下一階段可能方向

> 註：本節為 Phase 39 當時列的候選方向。其中數項已於 **Phase 48–60 落地**——「UI 直接觸發 CLI」「auto-round/auto-loop 結果自動回灌 UI（不再手動貼 JSON）」已透過本機 local runner 實現（見第 9 節）；此處保留作為歷史脈絡與尚未完成項（如逐輪互動式 approval、CLI 失敗重試）的參考。

以下為候選方向，列出供後續規劃參考，不代表已排程：

- **Workflow state tracking（已落地，Phase 25–28）**：任務已能以 `workflowStage` 記錄所處階段、提示下一步該按哪個 prompt、並快速推進。後續可再加：在跳過規格審查、或在測試未通過時就推進到 refactor 等情況加上提醒或軟性限制。
- **Codex / Claude CLI adapter（已落地，Phase 32 / 36）**：`auto:round` / `auto:loop` 已能在使用者於 terminal 主動執行下呼叫 AI CLI 跑一/多輪。後續可再加：更彈性的 `aiCommand` 設定（目前 UI 產生的指令固定 `claude`）、CLI 失敗的重試策略。
- **Human approval gate（部分落地，Phase 36）**：`auto:loop` 的 `autoApprove` 預設 `false`，只跑一輪並回報 `suggestedNextMode` 交人核准。後續可再加：在「會動到檔案」或多輪推進前，提供逐輪互動式核可。
- **最大回合數（max rounds，已落地，Phase 36）**：`auto:loop` 的 `maxRounds` 預設 3、clamp 1..10。
- **Auto run until pass**：`auto:loop` 已是「受 maxRounds 與 fileGuard 硬停約束」的有限自動循環雛形。後續可再加：在更完整的 approval gate 與安全評估後，提供把 `auto:loop` 結果**自動**回灌 UI（而非手動貼 JSON）的橋接，朝端到端自動再進一步；過程仍須受 File Guard 與 approval gate 約束。
- **UI 直接觸發 CLI**：目前一律「複製指令 → 人貼到 terminal 執行 → 貼回結果」。若要讓 UI 直接觸發（如 Tauri command runner / 受信任本機服務），需先設計授權、來源限制與安全邊界。

這些方向若要落地，都需要在「自動化便利性」與第 7 節的「安全 / 可控」原則之間取得平衡，並先補上對應的授權與防護機制。

---

## 9. Phase 48–60 成果整理（local runner 一鍵自動化、半自動穩定版）

Phase 48–60 把「auto-round / auto-loop 結果回灌 UI」這段，從「人在 terminal 跑、手動 `pbcopy` 貼回」升級為 **UI 一鍵 → 本機 local runner 執行 → 自動回灌**，並補上 Runner 健康檢查、目標專案 Preflight、修復建議、文件小改模板、自動摘要、完成建議，以及兩次穩定化。**瀏覽器仍不執行 shell**，實際呼叫 AI CLI 與跑驗證的是本機 local runner（`pnpm runner:local`，見 9.4）。

### 9.1 Phase 48–60 摘要

| Phase | 成果 |
| --- | --- |
| 48 | **auto-round verification 回灌修正**：穩健解析 `run-verification.mjs` 的 stdout（容忍前後夾雜進度訊息），正確帶出 verification / commands / fileGuard |
| 49 | **AI Command 設定**：可在 UI 設定並以 `localStorage` 持久化，預設 `claude --permission-mode acceptEdits`；auto-spec / auto-round / auto-loop 共用，**不需每次手動改** |
| 50 | **local runner `/health` 與 Runner 狀態 UI**：顯示「檢查中 / 已連線 / 未連線」、service、version、endpoints；連不上不 alert，提示 `pnpm runner:local` |
| 51 | **Target Project Preflight**：`POST /preflight` 對 `projectPath` 跑一組**固定唯讀檢查**（projectPath 存在、是資料夾、git repo、有 `run-verification.mjs` 與 `package.json`、`verify:local` script、node_modules / logs 未被追蹤、working tree 是否乾淨、`run-verification.mjs` 是否輸出可解析 JSON）|
| 52 | **Preflight 修復建議**：每個未通過檢查附 `suggestion` 與可複製的 `fixCommand`（**純文字、runner 不執行**）|
| 53 | **「文件小改 auto-round」任務模板**：自動帶入 `type=docs`、`workflowStage=green_implement`、`targetFiles`、`forbiddenFiles`、`constraints`、`acceptanceCriteria`；**不覆蓋** title / originalRequirement / projectPath |
| 54 | **auto-round / auto-loop 前自動 Preflight**：執行前先跑同一份 Preflight——有 error 不執行、只有 warning 跳 confirm、全綠直接執行 |
| 55 | **自動產生任務摘要草稿**：auto-round / auto-loop 匯入後，若任務摘要空白，自動以最後一輪產生摘要草稿（**不覆蓋既有摘要、不改狀態**）|
| 56 | **完成建議與一鍵套用**：最新自動回合通過時顯示「完成建議」，按「套用完成狀態」一次設好 `status=done` / `reviewResult=passed` / `workflowStage=done`（**不封存**）|
| 57 | **真實實測發現 blocker**：auto-round 雖成功改檔且 `verification.ok=true`，但 `auto-round.mjs` 的 result JSON 在 stdout 為 pipe 時被 flush 截斷（約 8KB），導致 UI 匯入失敗 |
| 58 | **修正 auto scripts stdout flush 截斷**：`auto-spec.mjs` / `auto-round.mjs` / `auto-loop.mjs` 改為 `process.stdout.write(json, () => process.exit(0))`，flush 完才結束 process；以 500KB 大輸出 pipe 測試驗證 |
| 59 | **真實端到端複驗通過**：真實 UI + 真實 runner + 真實 Claude 跑通整條精簡流程（見 9.5）|
| 60 | **local runner 壞 JSON 防禦**：runner 回傳前先 `JSON.parse`；不合法不把壞 JSON 原樣回，改回合法錯誤 JSON（`runner_invalid_json` / 截斷時 `runner_truncated_output`，附 `runnerError` / `stdoutBytes` / `stdoutPreview` / `stdoutTail`）|

### 9.2 目前精簡後流程（理想一鍵流程）

1. 新增任務。
2. 選擇「文件小改 auto-round」模板（自動帶入 workflowStage / targetFiles / forbiddenFiles / constraints / acceptanceCriteria）。
3. 填入 `title` / `originalRequirement` / `projectPath`。
4. 確認 UI「Runner 狀態」為**已連線**（未連線時於 ai-coding-relay 根目錄執行 `pnpm runner:local`）。
5. 直接按「執行 auto-round」。
6. 系統**自動跑 Preflight**（對 `projectPath`）。
7. 若有 **error**：停止、不執行 auto-round，並在 Preflight 區塊顯示修復建議與可複製的 `fixCommand`。
8. 若只有 **warning**（例如 `git_status_clean`）：跳 confirm，由使用者決定是否繼續。
9. 通過後，local runner 呼叫 `auto-round`。
10. Claude CLI 執行，預設 `aiCommand = claude --permission-mode acceptEdits`。
11. auto-round 在目標專案跑 `scripts/run-verification.mjs`（tsc / test / git-status / git-diff…）取得 verification。
12. UI **自動建立一筆 TaskRound**（result JSON 經 runner JSON 防禦確認合法後回灌）。
13. 若任務摘要空白，**自動產生任務摘要草稿**。
14. 最新回合通過時，**出現完成建議**。
15. 使用者按「**套用完成狀態**」→ `status=done` / `reviewResult=passed` / `workflowStage=done`。
16. 使用者**人工**封存 / commit / push（工具不自動做）。

### 9.3 目前仍保留的人工決策

以下刻意仍由**使用者**決定，不自動化：

- 填 `title` / `originalRequirement` / `projectPath`（模板只補其他欄位，不帶這三項）。
- Preflight 出現 **warning** 時是否繼續執行。
- 檢查 AI（Claude）**實際修改內容是否合理**、是否在預期範圍。
- 是否按「**套用完成狀態**」。
- 是否**封存**任務。
- 是否 **commit / push**。
- 是否採用 Preflight 提供的**修復指令**（fixCommand 只是文字，需人複製到 terminal 執行）。

### 9.4 安全邊界

- **瀏覽器不執行 shell**：UI 不直接、也沒有能力在本機跑指令。
- **local runner 只提供白名單 endpoint**：`GET /health`、`POST /preflight`、`POST /auto-spec`、`POST /auto-round`、`POST /auto-loop`；不提供任意 shell / command endpoint，未知路徑一律 404。
- **`/health` 不執行 shell**：只回報 runner 身分、version 與支援的 endpoints。
- **`/preflight` 只做固定唯讀檢查**：指令與參數都寫死在 runner 內，不接受來自 request 的任意指令，**不修改任何檔案**。
- **`fixCommand` 只是文字**：runner 不會執行它；要不要照做由使用者決定。
- **auto-round / auto-loop 由本機 local runner 端執行**（使用者自行 `pnpm runner:local` 啟動），瀏覽器只負責發 request 與顯示結果。
- **不自動 commit / push**。
- **不自動封存**。
- **runner 只在 localhost 監聽**、限定來源（預設 `http://localhost:1420`）。

### 9.5 常見問題與排查

| 症狀 | 排查 |
| --- | --- |
| **Runner 未連線** | 在 ai-coding-relay 專案根目錄執行 `pnpm runner:local`，再按「重新檢查」。 |
| **4318 被占用 / 分不清哪版 runner** | 直接看 UI「Runner 狀態」與 `GET /health` 回傳的 `service` / `version` / `endpoints`，**不必再用 `lsof` 猜**；`/health` 就是用來分辨佔用 port 的 runner 身分。 |
| **Preflight `git_status_clean` warning** | 代表目標專案有未提交變更（非乾淨 baseline）。確認這些變更是預期的後，confirm 即可繼續；否則 diff 會混在一起。 |
| **Preflight `run_verification_json` 失敗** | 檢查目標專案 `scripts/run-verification.mjs` 是否能輸出**合法、可解析**的 verification JSON（`{ "ok": boolean, "commands": [...] }`）。 |
| **stdout flush 截斷** | ai-coding-relay 端的 auto scripts 已於 **Phase 58** 修正；若**目標專案**的 `run-verification.mjs` 也是「`process.stdout.write(...)` 後立刻 `process.exit()`」，大輸出同樣會被截斷，需在**目標專案**比照修正（改用 write callback 後才結束，如 harness 於 Phase 57 的修法）。 |
| **`runner_invalid_json` / `runner_truncated_output`** | 這是 **Phase 60** 的防禦：runner 收到壞 / 截斷 JSON 時改回合法錯誤 JSON，附 `runnerError`、`stdoutBytes`、`stdoutPreview`、`stdoutTail` 供 debug，UI 不會再只顯示籠統「匯入失敗」。 |

### 9.6 Phase 59 真實驗證結論

Phase 59 以**真實 dev server（:1420）+ 真實 local runner（:4318）+ 真實 Claude CLI**，對真實目標專案（harness）跑一筆「文件小改」任務，端到端確認：

- auto-round 前**自動 Preflight**（只有 `git_status_clean` warning，confirm 後繼續）。
- Claude 成功修改目標專案的 `docs/harness-architecture.md`（且**只**改該檔）。
- **verification 自動回灌**（result JSON 完整、未截斷），UI **自動建立 TaskRound**，RoundTimeline 顯示 AI 結果 / verification / tsc / test / git-status / git-diff。
- **任務摘要自動產生**、**完成建議出現**，按「套用完成狀態」後 `status=done` / `reviewResult=passed` / `workflowStage=done`。
- **不自動封存**（封存仍人工）；目標專案 `verify:local` 通過（test 全綠）。

結論：Phase 57 的截斷 blocker 已由 Phase 58 修正、Phase 60 加上縱深防禦，整條**精簡流程已可端到端跑通**。
