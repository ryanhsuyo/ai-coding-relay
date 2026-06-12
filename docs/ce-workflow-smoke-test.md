# CE Workflow Smoke Test Guide

> 適用版本：完成 Phase 66–75 之後的 ai-coding-relay。
> 本文件是一份「照著做就能跑完一輪」的手動 smoke test 手冊，用來確認 runner、UI、
> 以及 readonly / work / review / fix / completion / compound / export 全鏈路可用，且安全邊界沒有被破壞。

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

> 提示：右上的 AI Command 設定（預設 `claude`）會被 CE Readonly / Work / Review / Fix 使用，確認它指向你要用的 CLI。

---

## 5. Step 1：執行 CE Readonly Workflow

操作：

- 在 AI Workflow 區塊按 **「開始 CE Readonly Workflow」**。

預期：

- 按鈕進入「CE Readonly Workflow 執行中…」，狀態列顯示 loading。
- 完成後回填以下欄位（A. Brainstorm / B. Plan / C. Audit）：
  - Brainstorm summary
  - Plan summary
  - Audit notes
  - coreAssumptions（每行一項）
  - riskNotes（每行一項）
  - acceptanceCriteria（每行一項）
  - checklist（五項）
- 狀態列顯示「已完成 CE Readonly Workflow，請確認 Audit 後再進入 Work。」
- **不應**修改 target project 任何檔案。

驗證（與 Step 0 的基準比較）：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
```

說明：

- Readonly workflow 後 `git status` 應與基準相同（沒有新增 / 修改）。
- 若出現新的修改，代表 readonly 邊界有問題，請停止並回報。

---

## 6. Step 2：檢查 Audit gate

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

## 7. Step 3：執行 CE Work

操作：

- 按 **「開始 CE Work」**。
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

## 8. Step 4：執行 CE Review

操作：

- Work 完成後按 **「開始 CE Review」**。
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

接著依結果走 Step 5A 或 Step 5B。

---

## 9. Step 5A：Review passed path

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

## 10. Step 5B：Review needs_fix path

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

接著回到 **Step 4** 再跑一次 CE Review，直到 passed 進入 Step 5A。

驗證：

```bash
cd /Users/ryan/Desktop/code/harness
git status --short
git diff --stat
```

---

## 11. Step 6：產生 Compound Notes

操作：

- 展開 **E. Compound** 區塊，按 **「產生 Compound Notes」**。

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

> 注意：Step 7 的匯出使用「已保存」的資料，所以這一步的「保存 AI Workflow」很重要——沒保存的草稿不會被匯出。

---

## 12. Step 7：匯出 CE Artifacts

操作：

- 在 **E. Compound** 區塊底部按 **「匯出 CE Artifacts」**。

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

## 13. 安全邊界檢查

跑完一輪後，逐項確認：

- [ ] CE Readonly Workflow 不修改檔案（Step 1 git status 與基準相同）。
- [ ] CE Work 必須 confirm 才執行（取消不呼叫 runner）。
- [ ] CE Review 不修改檔案（Step 4 前後 git status 相同）。
- [ ] CE Fix Work 必須 `needs_fix` + confirm 才執行。
- [ ] Export 只寫在 `docs/ai-workflows/<slug>/` 底下（沒有寫到 projectPath 以外）。
- [ ] Export 不刪除目錄內的未知檔案（事先放一個檔，匯出後仍在）。
- [ ] 任何流程都不自動 commit（`git log` 不變）。
- [ ] 任何流程都不 push。
- [ ] Completion 不自動封存（`archived` 不為 true）。
- [ ] Compound 產生不自動保存（產生後不按保存則 reload 不保留）。
- [ ] Export 使用已保存資料，不包含 unsaved draft（改了欄位但沒保存時，匯出內容不含該變更）。

---

## 14. 常見問題（Troubleshooting）

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

「開始 CE Review」是 disabled，通常是沒有 Work result：

- `changedFiles` 與 `testResults` 都空。
- 先跑 CE Work，或在 D. Work / Review 手動填入並保存。

### CE Fix Work 不顯示

「開始 CE Fix Work」沒出現，通常是：

- Review 不是 `needs_fix`（passed 不會顯示）。
- 沒有 Work result。
- 任務已完成（done / passed / done）。

### Export artifacts 沒有最新 Compound Notes

原因：Export 使用**已保存**的 task 資料。

- 先按「保存 AI Workflow」，再按「匯出 CE Artifacts」。

---

## 15. 完成標準

本 smoke test 視為通過的定義：

- Readonly 成功且不改檔。
- Work 成功且 verification 可追蹤（diff / verify 可對照）。
- Review 成功且唯讀。
- passed path 可套用完成狀態（status/review/stage/completedAt/history 正確）。
- needs_fix path 可進 Fix Work 並停在 Review 前。
- Compound Notes 可產生並保存。
- Artifacts 可匯出到 `docs/ai-workflows/<task-slug>/`（9 個檔案）。
- 第 13 節所有安全邊界符合預期。

---

> 本文件為手動操作手冊，不會自動執行任何 CE workflow、不呼叫 Claude CLI、不修改 target project。
> 文件中的 shell 指令需由你在終端機手動執行，並自行確認輸出。
