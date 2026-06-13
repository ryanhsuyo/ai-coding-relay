# CE Workflow Smoke Test Guide

> 適用版本：完成 Phase 66–80 之後的 ai-coding-relay。
> 本文件是一份「照著做就能跑完一輪」的 smoke test 手冊，用來確認 runner、UI、
> 以及 readonly / work / review / fix / completion / compound / export 全鏈路可用，且安全邊界沒有被破壞。
>
> Phase 80 之後，主畫面以 **Run CE Pipeline** 為主要入口（見第 5 節）；逐步手動流程已收進
> **Advanced manual controls** 折疊區（fallback / debug，見第 6 節）。本指南以 Pipeline 為主流程。

---

## 1. 目的

驗證完整 CE（Compound Engineering）workflow 端到端可用：

```text
Requirement
  → CE Readonly Workflow（Brainstorm / Plan / Audit，唯讀）
  → CE Work（Audit gate + confirm + verification，可改檔）
  → CE Review（唯讀）
  → passed  → CE Completion（套用完成狀態）
    needs_fix → CE Fix Work（只修 recommended fixes）→ 停在 Review 前 → 再次 CE Review
  → Compound Notes（lessonLearned / reusablePrompt / compoundNotes）
  → Export CE Artifacts（docs/ai-workflows/<task-slug>/）
```

對照的實作階段：

| 階段 | 功能 |
| --- | --- |
| Phase 70 | `/ce-readonly-workflow`：自動 Brainstorm / Plan / Audit（唯讀） |
| Phase 71 | `/ce-work`：Audit gate + Work Runner + verification |
| Phase 72 | `/ce-review`：唯讀 Review Runner |
| Phase 73A | CE Review passed → CE Completion Gate |
| Phase 73B | CE Review needs_fix → CE Fix Work loop |
| Phase 74 | CE Compound Notes Generator |
| Phase 75 | `/export-ce-artifacts`：匯出 `docs/ai-workflows/<task-slug>/` |
| Phase 78 | 一鍵 **CE Pipeline**：自動串接各階段，Work 前 / Commit 前停下人工確認 |
| Phase 79B | completed workflow 防誤跑（disable Run CE Pipeline）+ desktop wide layout |
| Phase 80 | AI Workflow UI cleanup：主畫面以 Pipeline 為主，手動流程收進 Advanced manual controls，欄位收進 Workflow details |

---

## 2. 測試前準備

開兩個終端機。

終端機 A：啟動前端（Vite dev server，預設 `http://localhost:1420`）。

```bash
cd ~/Desktop/code/ai-coding-relay
pnpm dev
```

終端機 B：啟動本機 runner（監聽 `127.0.0.1:4318`）。

```bash
cd ~/Desktop/code/ai-coding-relay
pnpm runner:local
```

檢查 runner 是否正常：

```bash
curl -s http://127.0.0.1:4318/health
```

預期 `endpoints` 至少包含：

- `/ce-readonly-workflow`
- `/ce-work`
- `/ce-review`
- `/ce-fix-work`
- `/export-ce-artifacts`
- `/auto-round`
- `/auto-loop`
- `/auto-spec`
- `/preflight`
- `/health`

> 若 `version` 不是最新（Phase 75 起為 `3`），代表佔用 4318 的是舊版 runner，請先關掉舊的再 `pnpm runner:local`。

接著開瀏覽器到 `http://localhost:1420`。

---

## 3. 目標專案準備

建議使用一個**低風險、可隨意產生 diff**的測試專案。範例：

```text
/Users/ryan/Desktop/code/harness
```

（也可換成你自己的測試專案；不要拿正式產品專案做 smoke test。）

測試前先記錄基準狀態：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
npm run verify:local
```

說明：

- 若 `git status` 已有變更，請先記下這些是 **pre-existing changes**（之後比對 diff 要扣掉它們）。
- CE Readonly Workflow **不應**修改任何檔案。
- 只有 CE Work / CE Fix Work **才可能**修改檔案。
- 若該專案沒有 `verify:local`，runner 會 fallback 找 `scripts/run-verification.mjs`；兩者皆無時 verification 會被標記為 `skipped`（不阻擋 Work）。

---

## 4. 建立測試任務

在 UI 按「＋ 新增任務」，填入下列範例：

**Title**

```text
補充 harness 文件的 CE workflow 測試說明
```

**Project**

```text
harness
```

**Project Path**

```text
/Users/ryan/Desktop/code/harness
```

**Original Requirement**

```text
請在 harness 文件中補充一小段 CE workflow 測試說明，內容需說明：
1. CE Readonly Workflow 只做 Brainstorm / Plan / Audit，不應修改檔案。
2. CE Work 必須在 Audit 通過後由使用者確認才可執行。
3. CE Review 應為唯讀，不應修改檔案。
4. 完成後應能產生 Compound Notes 並匯出 CE Artifacts。

請以最小修改完成，不要額外重構。
```

建立後進入該任務的 TaskDetail，展開「AI Workflow」區塊。

> 提示：右上的 AI Command 設定（預設 `claude`）會被 CE Pipeline 與 Advanced manual controls 內的 CE Readonly / Work / Review / Fix 使用，確認它指向你要用的 CLI。

---

## 5. 主流程：Run CE Pipeline（主要入口）

Phase 80 之後，AI Workflow 主畫面的主要入口是 **「Run CE Pipeline」**：一鍵自動串接 Readonly → Work → Review → Commit → Compound → Save，只在 **Work 前** 與 **Commit 前** 兩個高風險點停下等人工確認。

### 5.1 啟動 Pipeline，自動跑 Readonly

操作：

- 在 AI Workflow 區塊按 **「Run CE Pipeline」**。

預期：

- 狀態顯示 `running_readonly`（正在執行 CE Readonly Workflow…）。
- 自動完成 Readonly（Brainstorm / Plan / Audit 回填到 Workflow details，唯讀不改檔）。
- 若 Audit 通過且可進入 Work，**停在 `waiting_work_confirmation`**，顯示「即將開始 Work」確認卡（plan 摘要、Audit checklist x/5、驗收標準）。
- **不會自動進 Work**（這是第一個人工確認點）。

驗證（Readonly 為唯讀，與第 3 節記錄的基準比較）：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
```

- Readonly 後 `git status` 應與基準相同；若出現新修改代表 readonly 邊界有問題，請停止並回報。

### 5.2 Confirm Work → 自動 Work + Review

操作：

- 在確認卡按 **「Confirm Work」**。

預期：

- 狀態 `running_work`：呼叫 `/ce-work`，Claude 依已審核 plan 改檔並跑 verification。
- Work 成功後 **自動** 進入 `running_review`，呼叫 `/ce-review`（唯讀）。
- 若 Review = passed，**停在 `waiting_commit_confirmation`**，顯示 commit message（可編輯）、changed files、`git diff --stat`、verification 摘要；若 target 有與本次無關的既有變更會顯示警告。
- 若 Review = needs_fix，**停在 `needs_fix`**，列出 recommended fixes，**不會自動修**（見 5.6）。
- 若 Work verification 未通過，**停在 `failed`**，不會進 Review、不會 commit。

驗證：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
git diff --stat
npm run verify:local
```

### 5.3 Confirm Commit → 自動 Compound + Save

操作：

- 檢視 commit message（可編輯）後按 **「Confirm Commit」**。

預期：

- 狀態 `committing`：呼叫 `/ce-commit-checkpoint`。runner **會先再跑一次 verification**，通過才 `git add`（只加 tracked 變更，排除 .env / node_modules / build artifacts）→ `git commit`。
- commit 成功後 **自動** 產生 Compound Notes（`generating_compound`）並 **自動保存 AI Workflow**（`saving_workflow`）。
- 狀態 `completed`：顯示 commit hash、Compound 已產生、Export 結果（或 Export 按鈕）。
- **不會自動 push、不動 remote。**
- 若沒有可 commit 的 tracked 變更，runner 回 `nothing_to_commit`，Pipeline 停在 `failed`（這是正確保護）。

驗證：

```bash
cd /Users/ryan/Desktop/code/harness
git log --oneline -1   # 應看到剛建立的 commit
git status --short      # 已 commit 的 tracked 變更不再出現
```

### 5.4 Export CE Artifacts（可選）

- 預設 **不自動匯出**。`completed` 後可按 **「Export CE Artifacts」** 手動匯出（見第 8 節）。
- 若想自動：在按 Run CE Pipeline 前先勾選 **「完成後自動匯出 CE Artifacts」**，commit + compound 後會自動呼叫 `/export-ce-artifacts`。

### 5.5 Cancel / failed

- Pipeline 進行中可按 **「Cancel Pipeline」**：取消後不再執行任何後續步驟。
- 任一步失敗（Readonly / Work / Review / Commit）→ 狀態 `failed`，顯示 stoppedReason / message / preview，**不會** commit、**不會** push。

### 5.6 Review needs_fix（不自動修）

- Pipeline 在 Review = needs_fix 時 **停下**並列出 recommended fixes，**不會自動進 CE Fix Work**。
- 請展開 **Advanced manual controls**，用 **「開始 CE Fix Work」** 手動修正（見第 6 節），修完再重新按 Run CE Pipeline。

### 5.7 completed workflow 不可重跑

- 已完成（已 commit + Review passed + Compound 已記錄）的任務，**「Run CE Pipeline」會 disabled**（文字顯示「Pipeline 已完成」），避免再跑一次又跑到 commit 階段的 `nothing_to_commit`。
- 要重跑請建立新任務。

---

## 6. Advanced manual controls（fallback / debug：逐步手動流程）

> 以下逐步手動流程已收進主畫面的 **Advanced manual controls** 折疊區（預設收合），是 **fallback / debug** 用途：Pipeline 中途失敗、Review needs_fix 需手動 Fix、或想單獨重跑某一階段時才展開使用。日常請優先用第 5 節的 Run CE Pipeline。
>
> 操作前先展開主畫面的 **Advanced manual controls**。

### 6.1 手動 CE Readonly Workflow

操作：

- 展開 Advanced manual controls，按 **「開始 CE Readonly Workflow」**。

預期：

- 按鈕進入「CE Readonly Workflow 執行中…」，狀態列顯示 loading。
- 完成後回填 Workflow details 的 A. Brainstorm / B. Plan / C. Audit 欄位（summary / notes / coreAssumptions / riskNotes / acceptanceCriteria / checklist 五項）。
- **不應**修改 target project 任何檔案（`git status` 與基準相同）。

### 6.2 檢查 Audit gate

預期（AI Workflow 進度區 / 進度面板）：

- 顯示 `Audit checklist：x/5`。
- 若可進入 Work，顯示「可進入 Work 階段」。
- 若 `plan.status = rejected` 或 audit 不完整，會顯示「尚不建議進入 Work」，且 **「開始 CE Work」按鈕為 disabled**。

Gate 規則（與 runner / `src/core/ceWork.ts` 一致）：

- `plan.status = rejected` → 不可。
- `plan.status` 必須是 `approved` 或 `audited`，否則不可。
- 必須有 `audit.checklist`。
- `plan.status = approved` → 直接可。
- `plan.status = audited` → 需 checklist 五項全 true 才可。

> 若要手動測 gate：把 Plan 狀態改成 `rejected` 並保存，確認 CE Work 按鈕變 disabled；再改回 `approved` 確認恢復。

---

### 6.3 手動 CE Work

操作：

- 在 Advanced manual controls 按 **「開始 CE Work」**。
- 出現 confirm 對話框（內容：「CE Work 會允許 Claude 修改目標專案檔案…」）後按確定。

預期：

- **只有 confirm 後**才會呼叫 runner `/ce-work`（按取消則不呼叫）。
- Claude 可修改 target project（依已審核 plan）。
- runner 完成後會執行 verification。
- 完成後回填 D. Work / Review：
  - changedFiles
  - testCommands
  - testResults（含實作摘要 + 驗證結果 + `git diff --stat`）
- **不**自動 commit、**不**自動 push、**不**自動完成任務、**不**自動封存。
- `codeReviewNotes` 此時為「待 Review」。

驗證：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
git diff --stat
npm run verify:local
```

說明：

- 應看到 Claude 實作造成的 diff（扣掉 pre-existing changes）。
- 不應出現新的 commit（`git log` 不變）。

---

### 6.4 手動 CE Review

操作：

- Work 完成後在 Advanced manual controls 按 **「開始 CE Review」**。
- 出現 confirm（「CE Review 只會讀取目標專案與 git diff，不會修改檔案。」）後確認。

預期：

- Review 為**唯讀**，不修改任何檔案。
- 回填 `codeReviewNotes`。
- `codeReviewNotes` 內含其中一個精確標記：
  - `Review result: passed`，或
  - `Review result: needs_fix`
- 狀態列顯示 Review verdict（passed / needs_fix）。

驗證：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
```

說明：

- CE Review **前後** `git status` 應完全相同（唯讀，不改檔）。

接著依結果走 6.5（passed）或 6.6（needs_fix）。

---

### 6.5 Review passed path

若 `codeReviewNotes` 包含：

```text
Review result: passed
```

預期：

- 顯示 **CE Completion Gate**（`detail-label` 為「CE Completion」）。
- 訊息：「CE Review 已通過，建議套用完成狀態。」
- 列出理由：`Review result: passed` / `Work result 已存在` / `不會自動封存`。
- 可按 **「套用 CE 完成狀態」**。

按下「套用 CE 完成狀態」後預期：

- 保存目前 summary（若 summary 為空會提示可稍後補，不影響套用）。
- `status = done`
- `reviewResult = passed`
- `workflowStage = done`
- `completedAt` 有值（ISO 字串）。
- `completionHistory` 新增一筆。
- **不**自動封存。
- **不** commit / push。

---

### 6.6 Review needs_fix path

若 `codeReviewNotes` 包含：

```text
Review result: needs_fix
```

預期：

- 顯示「CE Review 需要修正」相關提示。
- 顯示 **「開始 CE Fix Work」**（needs_fix 且尚未完成時才出現）。
- 按下後需 confirm（「CE Fix Work 會允許 Claude 修改目標專案檔案，但只應修正 Review 提出的 recommended fixes…」）。
- **confirm 後**才呼叫 `/ce-fix-work`。

Fix Work 完成後預期：

- 更新 changedFiles / testCommands / testResults（去重 / append）。
- `codeReviewNotes` 設為「待 Review」。
- 狀態列顯示「Fix Work 已完成，請再次執行 CE Review」。
- **不**自動重新 Review。
- **不**自動完成、**不**自動封存。
- **不** commit / push。

接著回到 **6.4** 再跑一次 CE Review，直到 passed 進入 6.5。

驗證：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
git diff --stat
```

---

### 6.7 手動產生 Compound Notes

> 走 Pipeline 時 Compound 會在 commit 成功後自動產生（5.3）；此處為手動 fallback。

操作：

- 展開 **Workflow details → E. Compound** 區塊，按 **「產生 Compound Notes」**。

預期：

- 以目前畫面最新 draft 產生並填入：
  - lessonLearned
  - reusablePrompt
  - compoundNotes
- **不**自動保存。
- 顯示提示：「已產生 Compound Notes 草稿，請確認後保存 AI Workflow。」

接著按 **「保存 AI Workflow」**。

預期：

- 顯示「✓ 已保存 AI Workflow」。
- reload 頁面後，重新進入任務，Compound 欄位仍保留。

> 注意：第 8 節的匯出使用「已保存」的資料，所以這一步的「保存 AI Workflow」很重要——沒保存的草稿不會被匯出。

---

## 7. Workflow details（查看 / 編輯各階段欄位）

主畫面預設收合的 **Workflow details** 折疊區，用來查看與編輯各階段詳細欄位：

- **A. Brainstorm / B. Plan / C. Audit / D. Work · Review / E. Compound** 五個 accordion。
- 每個 accordion 內含對應欄位、Copy Prompt 按鈕，E. Compound 內含手動 Compound 產生器與「匯出 CE Artifacts」。
- 右側 **Summary panel** 是主要狀態摘要（進度、下一步、Project Path、Audit checklist、Review 結果、commit hash、changed files），只顯示精簡資訊，不顯示超長 stdout / 完整 prompt / 完整 review notes。

> Pipeline 跑完後，這裡可用來核對回填的欄位內容是否正確。

---

## 8. 匯出 CE Artifacts（Export）

操作：

- 走 Pipeline：在 `completed` 狀態按 **「Export CE Artifacts」**（或事先勾選自動匯出）。
- 手動：展開 **Workflow details → E. Compound** 區塊底部按 **「匯出 CE Artifacts」**。

預期：

- 顯示 loading（「正在匯出 CE Artifacts...」）。
- 成功後顯示輸出目錄，例如：

```text
docs/ai-workflows/<task-slug>
```

- 並列出 9 個檔案：
  - `requirement.md`
  - `brainstorm.md`
  - `plan.md`
  - `audit.md`
  - `work-result.md`
  - `review.md`
  - `completion.md`
  - `compound.md`
  - `metadata.json`

> `<task-slug>` 由 task title 推導（只保留 ASCII 英數，其餘轉連字號）；純中文 title 會 fallback 到 task id，再不行則為 `task`。

驗證：

```bash
cd /Users/ryan/Desktop/code/harness
find docs/ai-workflows -maxdepth 2 -type f | sort
```

檢查 metadata（把 `<task-slug>` 換成實際值）：

```bash
cat docs/ai-workflows/<task-slug>/metadata.json
```

預期 `metadata.json`：

- `schemaVersion: 1`
- `source: "ai-coding-relay"`
- 有 `exportedAt`（ISO 字串）
- `task`：id / title / project / projectPath / status / reviewResult / workflowStage / createdAt / updatedAt / completedAt
- `artifact.relativeDir = docs/ai-workflows/<task-slug>`
- `artifact.files` 列出上述 9 個檔名

---

## 9. 安全邊界檢查

跑完一輪後，逐項確認：

- [ ] Run CE Pipeline 在 **Work 前** 與 **Commit 前** 各停下一次人工確認（不會一路自動改檔 / commit）。
- [ ] completed workflow 的 **「Run CE Pipeline」為 disabled**（不會誤跑到 `nothing_to_commit`）。
- [ ] Review = needs_fix 時 Pipeline 停下，**不自動** 進 CE Fix Work。
- [ ] CE Readonly Workflow 不修改檔案（Readonly 後 git status 與基準相同）。
- [ ] 手動 CE Work 必須 confirm 才執行（取消不呼叫 runner）。
- [ ] CE Review 不修改檔案（Review 前後 git status 相同）。
- [ ] CE Fix Work 必須 `needs_fix` + confirm 才執行。
- [ ] Export 只寫在 `docs/ai-workflows/<slug>/` 底下（沒有寫到 projectPath 以外）。
- [ ] Export 不刪除目錄內的未知檔案（事先放一個檔，匯出後仍在）。
- [ ] 除了使用者按 Confirm Commit 後的 commit checkpoint，任何流程都不自動 commit（`git log` 不變）。
- [ ] 任何流程都不 push（含 Run CE Pipeline；只做到本機 commit）。
- [ ] Completion 不自動封存（`archived` 不為 true）。
- [ ] Compound 產生不自動保存（產生後不按保存則 reload 不保留）。
- [ ] Export 使用已保存資料，不包含 unsaved draft（改了欄位但沒保存時，匯出內容不含該變更）。

---

## 10. 常見問題（Troubleshooting）

### Run CE Pipeline disabled

「Run CE Pipeline」是 disabled（文字「Pipeline 已完成」），代表此 workflow 已完成（已 commit + Review passed + Compound 已記錄）。這是 Phase 79B 的防誤跑設計，避免再跑到 `nothing_to_commit`。要重跑請建立新任務。

### Pipeline 停在 needs_fix

Review = needs_fix 時 Pipeline 會停下且不自動修。請展開 **Advanced manual controls**，用「開始 CE Fix Work」修正後，再重新按 Run CE Pipeline。

### Runner 未連線

UI 顯示「無法連線到 local runner…請先執行 pnpm runner:local」。

```bash
cd ~/Desktop/code/ai-coding-relay
pnpm runner:local
curl -s http://127.0.0.1:4318/health
```

### projectPath invalid

runner 回 `project_path_invalid`。確認 Task 的 Project Path 是**實際存在的資料夾**（絕對路徑），且不是檔案。

### CE Work disabled

「開始 CE Work」是 disabled，通常是 Audit gate 未過：

- Plan 是 `rejected`。
- Audit checklist 未全部通過（且 plan 只是 `audited`）。
- 沒有 `approved` / `audited` 的 plan。

### CE Review disabled

Advanced manual controls 內的「開始 CE Review」是 disabled，通常是沒有 Work result：

- `changedFiles` 與 `testResults` 都空。
- 先跑 CE Work，或在 Workflow details → D. Work / Review 手動填入並保存。

### CE Fix Work 不顯示

「開始 CE Fix Work」沒出現，通常是：

- Review 不是 `needs_fix`（passed 不會顯示）。
- 沒有 Work result。
- 任務已完成（done / passed / done）。

### Export artifacts 沒有最新 Compound Notes

原因：Export 使用**已保存**的 task 資料。

- 先按「保存 AI Workflow」，再按「匯出 CE Artifacts」。

---

## 11. 完成標準

本 smoke test 視為通過的定義：

- **主流程（Run CE Pipeline）**：能一鍵跑到 Work 確認 → Confirm Work → 自動 Review → Commit 確認 → Confirm Commit → 自動 Compound + Save → `completed`，全程不自動 push。
- completed 後「Run CE Pipeline」為 disabled（防誤跑）。
- Readonly 成功且不改檔。
- Work 成功且 verification 可追蹤（diff / verify 可對照）。
- Review 成功且唯讀。
- passed path 可 commit 並回填 commit hash / Compound（或經 CE Completion 套用完成狀態）。
- needs_fix path 可（在 Advanced manual controls）進 Fix Work 並停在 Review 前。
- Compound Notes 可產生並保存。
- Artifacts 可匯出到 `docs/ai-workflows/<task-slug>/`（9 個檔案）。
- 第 9 節所有安全邊界符合預期。

---

> 本文件為手動操作手冊，不會自動執行任何 CE workflow、不呼叫 Claude CLI、不修改 target project。
> 文件中的 shell 指令需由你在終端機手動執行，並自行確認輸出。
