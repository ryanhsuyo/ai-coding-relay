# AI Coding Relay

AI Coding Relay 是一個給工程師使用的 AI coding 工作流管理工具。

它不是一般 Todo App，也不是一般 Chat App，**更不是只做複製貼上**。它的核心是「任務」與「回合」：管理工程師在 Claude Code、GPT、Codex 等 AI coding 工具之間的任務流程，並負責紀錄、審查、驗收、搜尋、摘要與歸檔。複製貼上只是其中一種「把任務推進到下一步」的執行方式，而不是產品本身。

核心流程：

```txt
需求整理
→ 產生 Claude Prompt
→ Claude Code 改 code
→ 貼回 Claude 結果
→ GPT 審查
→ 產生下一步 Prompt
→ 驗收
→ 任務歸檔
```

「下一步怎麼被執行」可以是手動，也可以交給外部 pipeline / executor —— 見下方「工作模式」。

---

## 工作模式（Working Modes）

AI Coding Relay 支援兩種工作模式。兩者共用同一套任務模型（Task / TaskRound）、紀錄、審查、搜尋、摘要與歸檔；差別只在「下一步由誰執行」。

### 1. Manual Relay Mode（MVP，目前實作）

使用者親手在 AI Coding Relay 與 AI 工具之間「接力」傳遞：

```txt
使用者建立任務並輸入需求
→ AI Coding Relay 產生 Claude Prompt
→ 使用者手動貼給 Claude Code
→ 使用者把 Claude Response 貼回
→ AI Coding Relay 保存 Round / GPT Review / 下一步 Prompt
```

這是第一階段 MVP 的主要模式：不串 API、不自動送出，所有 AI 互動都由使用者掌控，AI Coding Relay 專注在任務管理與回合紀錄。

### 2. Pipeline Mode（未來重要方向）

由外部 pipeline / executor 負責執行下一步，AI Coding Relay 退居「任務經理 + 驗收員 + 紀錄員」：

```txt
使用者建立任務並輸入需求
→ 外部 pipeline / executor 執行下一步（讀需求、改 code、跑驗證…）
→ 使用者可按「下一步」推進流程，並在高風險點確認
→ AI Coding Relay 負責保存任務狀態、Claude 回覆、驗收、summary、歸檔
```

未來可對接的 executor / adapter 包含：

```txt
CE Pipeline（Compound Engineering 一鍵流程）
Claude Code
Codex CLI
harness
OpenClaw
```

**關鍵概念：CE Pipeline 這類工具是「executor / adapter」，不是產品核心。** 它們負責「實際執行」一個步驟；AI Coding Relay 負責「管理整條任務流程」—— 任務管理、回合紀錄、審查、搜尋、摘要與歸檔。換掉任何一個 executor，任務模型與紀錄都不變。

> 目前 repo 內已有 CE（Compound Engineering）workflow 的雛形（readonly → work → review → commit checkpoint → compound → export），可視為 Pipeline Mode 的第一個 executor adapter；它仍遵守「高風險步驟（改檔、commit）必須人工確認、預設 read-only、不自動 push」的安全原則。

---

## CE Pipeline 操作流程（目前主要入口）

AI Workflow 區塊目前以 **Run CE Pipeline** 為主要入口（一鍵串接各階段，只在兩個高風險點停下等人工確認）。日常操作流程：

```txt
1. 建立任務
2. 填入 Project Path（目標專案路徑）
3. 按「Run CE Pipeline」
   → 自動執行 CE Readonly（Brainstorm / Plan / Audit，唯讀）
4. 在 Work 前確認（會修改目標專案檔案）→ 按「Confirm Work」
   → 自動執行 CE Work（實作 + verification），通過後自動執行 CE Review（唯讀）
5. 在 Commit 前確認（檢視 commit message / changed files / verification 摘要）→ 按「Confirm Commit」
6. Commit 成功後自動產生 Compound Notes 並自動保存 AI Workflow
7. 需要時按「Export CE Artifacts」匯出（預設不自動，可勾選「完成後自動匯出」）
```

重點：

- **兩個人工確認點**：Work 前、Commit 前。其餘步驟自動接續。
- **不會自動 push**：Pipeline 只做到本機 git commit，從不 push、不動 remote。
- **Review needs_fix 不會自動修**：Pipeline 會停下並提示，請改用 Advanced manual controls 的 CE Fix Work。
- **completed workflow 會 disable「Run CE Pipeline」**：已完成（已 commit + Review passed + Compound 已記錄）的任務不能重跑 Pipeline，避免再跑到 commit 階段的 `nothing_to_commit` 錯誤；要重跑請建立新任務。

### Advanced manual controls（fallback / debug，非日常主流程）

主畫面預設收合的「Advanced manual controls」內保留舊的逐步手動流程：手動 CE Readonly Workflow、CE Work、CE Review、CE Fix Work、Commit checkpoint。這些是 **fallback / debug 用途**，例如 Pipeline 中途失敗、Review needs_fix 需手動 Fix、或想單獨重跑某一階段時才展開使用，**不是日常主要流程**。

### Workflow details（查看 / 編輯詳情）

同樣預設收合的「Workflow details」用來查看與編輯各階段的詳細欄位：Brainstorm / Plan / Audit / Work · Review / Compound，以及各階段的 Copy Prompt 與手動 Compound 產生器。

### 右側 Summary panel（主要狀態摘要）

主畫面右側的 Summary panel 是主要狀態摘要區：顯示 AI Workflow 進度、目前狀態、下一步、Project Path、Audit checklist、Review 結果、commit hash、changed files 等精簡資訊（不顯示超長 stdout / 完整 prompt / 完整 review notes）。

---

## 專案目標

AI Coding Relay 要解決的是 AI coding 過程中的流程管理問題：

- AI 改錯檔案
- 多輪對話後上下文混亂
- 不知道下一步怎麼問 Claude
- 改完不知道有沒有符合需求
- 沒有任務紀錄可以回頭查
- 每次都要重新寫 prompt
- git diff / build / test 結果沒有被整理

本工具的定位是：

```txt
AI coding task workflow manager
```

也就是：

```txt
Claude / Codex / Copilot = 執行者
AI Coding Relay = 任務經理 + 驗收員 + 紀錄員
```

---

## 目前技術選型

```txt
Tauri
React
TypeScript
pnpm
```

第一階段只做本機桌面 App。

前端主要使用 React + TypeScript。

Tauri / Rust 主要負責未來的本機能力，例如：

- 讀寫本機資料
- 讀取 git status
- 讀取 git diff
- 執行安全 command
- 操作 clipboard

---

## 第一階段 MVP

第一階段目標是完成「手動 Relay 版」。

使用者可以：

```txt
新增任務
輸入需求
輸入目標檔案
輸入限制條件
產生 Claude Prompt
複製 Prompt 到 Claude Code
貼回 Claude Response
產生 GPT Review Prompt
保存回合紀錄
```

---

## 第一階段要做

```txt
[ ] 任務列表
[ ] 新增任務
[ ] 任務詳情
[ ] Task / TaskRound 型別
[ ] Claude Prompt Generator
[ ] 複製 Claude Prompt
[ ] 貼上 Claude Response
[ ] 建立 TaskRound
[ ] Round Timeline
[ ] GPT Review Prompt Generator
[ ] 本機資料保存
```

---

## 第一階段不做

```txt
[ ] 不串 OpenAI API
[ ] 不串 Claude API
[ ] 不自動控制 Claude Code 視窗
[ ] 不自動按 Enter
[ ] 不自動送出 Prompt
[ ] 不實作完整 agent
[ ] 不實作 harness
[ ] 不實作 write_file
[ ] 不實作 delete_file
[ ] 不實作 git reset
[ ] 不實作 git clean
[ ] 不做雲端同步
[ ] 不做多人協作
[ ] 不做 marketplace
[ ] 不做登入系統
```

---

## 專案文件

```txt
docs/project-plan.md       # 給自己看的完整專案規劃
docs/claude-context.md     # 給 Claude Code 的專案上下文與開發限制
docs/prompt-templates.md   # Prompt 模板
docs/roadmap.md            # 開發路線圖
```

---

## 開發環境需求

需要先安裝：

```txt
Node.js
pnpm
Rust
Tauri prerequisites
```

---

## 啟動專案

安裝依賴：

```bash
pnpm install
```

啟動 Tauri 開發模式：

```bash
pnpm tauri dev
```

如果上面指令不能跑，可以使用：

```bash
pnpm run tauri dev
```

---

## 目前開發狀態

目前已完成：

```txt
[x] 建立 Tauri + React + TypeScript 專案
[ ] 建立專案文件
[ ] 建立 MVP 任務管理功能
```

---

## 建議開發順序

短期：

```txt
1. 建立專案文件
2. 建立 Task / TaskRound 型別
3. 建立任務列表
4. 建立新增任務功能
5. 建立任務詳情
6. 建立 Claude Prompt Generator
7. 建立複製 Prompt 功能
8. 建立 Claude Response 貼回區
9. 建立 Round Timeline
10. 建立 GPT Review Prompt Generator
```

中期：

```txt
1. 任務狀態管理
2. 任務歸檔
3. Git status
4. Git diff
5. Command runner
6. Verification Panel
```

後期：

```txt
1. Harness 整合
2. Prompt Template Library
3. 任務搜尋
4. 任務完成摘要
5. 半自動 Clipboard Relay
6. AI API 整合
7. 打包產品化
```

---

## 安全原則

這個工具未來會接觸使用者本機專案，因此安全優先。

第一階段不允許：

```txt
write_file
delete_file
rm -rf
git reset --hard
git clean -fd
sudo
curl | sh
```

未來 command runner 必須有白名單。

允許 command 範例：

```txt
git status
git diff
pnpm build
pnpm test
npm run build
npm test
yarn build
yarn test
```

---

## 開發原則

```txt
1. 先做 MVP，不要過度設計。
2. 優先完成可使用的任務流程。
3. 不要一開始串 AI API。
4. 不要一開始做自動化 agent。
5. 不要讓 AI 自動寫入使用者專案檔案。
6. 預設所有本機專案操作都是 read-only。
7. 優先用明確資料結構管理 Task / TaskRound。
8. Prompt template 要可讀、可維護、可擴充。
9. UI 先追求清楚，不追求炫。
10. 所有功能都要能用在一般 React / Node 專案，不要綁特定業務場景。
```

---

## 最重要的方向

目前最重要的是完成：

```txt
需求 → Claude Prompt → Claude Response → GPT Review Prompt → 下一步 Prompt → 回合紀錄
```

請不要提前做：

```txt
harness
git diff
command runner
自動化 relay
AI API
多人協作
```

先完成一個自己每天真的能用的 MVP。