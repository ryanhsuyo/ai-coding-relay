# AI Coding Relay Roadmap

這份文件用來記錄 AI Coding Relay 的開發路線。

核心原則：

> 先做一個自己每天真的會用的 MVP，再慢慢加入 git diff、command runner、harness 與半自動 relay。

---

## Phase 0：專案文件整理

### 目標

先把產品方向、Claude 開發限制、Prompt 模板與 Roadmap 建立起來。

### 要完成

```txt
docs/project-plan.md
docs/claude-context.md
docs/prompt-templates.md
docs/roadmap.md
README.md
```

### 完成標準

```txt
[ ] project-plan.md 已建立
[ ] claude-context.md 已建立
[ ] prompt-templates.md 已建立
[ ] roadmap.md 已建立
[ ] README.md 已建立或更新
[ ] git commit 完成
```

### 不做

```txt
不開始寫功能
不做 harness
不做 git diff
不做 command runner
不串 AI API
```

---

## Phase 1：MVP 專案骨架

### 目標

建立 AI Coding Relay 的基本 App 架構。

目前技術選型：

```txt
Tauri
React
TypeScript
pnpm
```

### 要完成

```txt
App 可以啟動
基本 layout
任務列表區
任務詳情區
基本資料型別
基本狀態管理
```

### 建議檔案

```txt
src/shared/types.ts
src/components/TaskSidebar.tsx
src/components/TaskDetail.tsx
src/components/TaskForm.tsx
src/hooks/useTasks.ts
src/core/taskService.ts
src/utils/id.ts
src/utils/date.ts
```

### 完成標準

```txt
[ ] pnpm tauri dev 可以成功啟動
[ ] 畫面有左側任務列表
[ ] 畫面有右側任務詳情
[ ] 可以新增一筆任務
[ ] 可以選取任務
[ ] 可以顯示任務內容
```

### 不做

```txt
不做 Claude Prompt Generator
不做 GPT Review Prompt
不做 git diff
不做 command runner
不做 harness
```

---

## Phase 2：Task / TaskRound 資料模型

### 目標

把任務與回合紀錄的資料模型建立清楚。

### 要完成

```txt
TaskStatus
TaskType
Task
TaskRound
ChecklistItem
CommandLog
```

### 建議檔案

```txt
src/shared/types.ts
```

### 完成標準

```txt
[ ] Task 型別完成
[ ] TaskRound 型別完成
[ ] ChecklistItem 型別完成
[ ] CommandLog 型別完成
[ ] TypeScript 無錯誤
```

### 不做

```txt
不做複雜資料庫
不做 SQLite
不做 API
```

---

## Phase 3：本機資料保存

### 目標

讓任務資料可以保存，關閉 App 後仍然存在。

第一版可以先使用：

```txt
localStorage
```

或之後改成：

```txt
data/store.json
```

### 要完成

```txt
讀取 tasks
新增 task
更新 task
刪除 task
讀取 rounds
新增 round
更新 round
```

### 建議檔案

```txt
src/storage/taskStorage.ts
src/storage/storageKeys.ts
src/hooks/useTasks.ts
```

### 完成標準

```txt
[ ] 新增任務後重新整理資料仍存在
[ ] 編輯任務後資料會保存
[ ] 刪除任務後資料會更新
[ ] 不需要後端 server
```

### 不做

```txt
不做雲端同步
不做登入
不做多人協作
不做 SQLite
```

---

## Phase 4：Claude Prompt Generator

### 目標

根據任務內容產生可以直接貼給 Claude Code 的 prompt。

### 要完成

輸入資料：

```txt
originalRequirement
taskType
targetFiles
forbiddenFiles
constraints
acceptanceCriteria
```

產出：

```txt
Claude Code Prompt
```

### 建議檔案

```txt
src/prompt-engine/claudePromptTemplate.ts
src/prompt-engine/promptRenderer.ts
src/prompt-engine/generateClaudePrompt.ts
src/components/PromptPanel.tsx
```

### 完成標準

```txt
[ ] 可以根據 Task 產生 Claude Prompt
[ ] Prompt 包含任務需求
[ ] Prompt 包含允許修改檔案
[ ] Prompt 包含禁止修改範圍
[ ] Prompt 包含限制條件
[ ] Prompt 包含驗收條件
[ ] Prompt 包含完成後回報格式
[ ] 可以一鍵複製 Prompt
```

### 不做

```txt
不自動貼到 Claude Code
不自動按 Enter
不串 Claude API
```

---

## Phase 5：Claude Response 與 Round Timeline

### 目標

讓使用者可以貼回 Claude Code 的回覆，並保存成任務回合紀錄。

### 要完成

```txt
貼上 Claude Response
建立 TaskRound
顯示 Round Timeline
同一個 Task 可以有多個 Round
每一輪都有 roundIndex
```

### 建議檔案

```txt
src/core/roundService.ts
src/components/RoundTimeline.tsx
src/components/PromptPanel.tsx
src/hooks/useTasks.ts
```

### 完成標準

```txt
[ ] 可以貼上 Claude Response
[ ] 可以新增第 1 輪紀錄
[ ] 可以新增第 2 輪紀錄
[ ] Round Timeline 可以正確排序
[ ] 每輪可以看到 Claude Prompt 與 Claude Response
```

### 不做

```txt
不自動解析 Claude 回覆
不自動判斷成功或失敗
不做 git diff
```

---

## Phase 6：GPT Review Prompt Generator

### 目標

根據任務需求與 Claude 回覆產生 GPT Review Prompt。

### 要完成

輸入資料：

```txt
Task
TaskRound
Claude Response
```

產出：

```txt
GPT Review Prompt
```

Prompt 要求 GPT 回答：

```txt
1. 是否符合原始需求
2. 已完成項目
3. 可能漏掉的項目
4. 是否有改到不該改的地方
5. TypeScript / React / UI 風險
6. 建議驗收 checklist
7. 下一輪要給 Claude Code 的 prompt
```

### 建議檔案

```txt
src/prompt-engine/gptReviewTemplate.ts
src/prompt-engine/generateGptReviewPrompt.ts
src/components/PromptPanel.tsx
```

### 完成標準

```txt
[ ] Claude Response 貼回後可以產生 GPT Review Prompt
[ ] 可以一鍵複製 GPT Review Prompt
[ ] 可以貼回 GPT Review
[ ] 可以保存 GPT Review 到 TaskRound
```

### 不做

```txt
不串 OpenAI API
不自動送到 GPT
不自動解析 GPT 回覆
```

---

## Phase 7：Next Prompt 管理

### 目標

讓 GPT Review 後產生的下一步 Claude Prompt 可以被保存與複製。

### 要完成

```txt
貼上 GPT Review
填入 Next Prompt
保存 Next Prompt
複製 Next Prompt
用 Next Prompt 建立下一輪 Claude Prompt
```

### 建議檔案

```txt
src/components/PromptPanel.tsx
src/components/RoundTimeline.tsx
src/core/roundService.ts
```

### 完成標準

```txt
[ ] 可以在某一輪保存 GPT Review
[ ] 可以在某一輪保存 Next Prompt
[ ] 可以複製 Next Prompt
[ ] 下一輪可以沿用 Next Prompt
```

### 不做

```txt
不自動解析 GPT Review
不自動建立下一輪
```

---

## Phase 8：任務狀態與歸檔

### 目標

讓任務可以從建立到完成，再到歸檔。

### 狀態

```txt
draft
prompt_ready
sent_to_ai
reviewing
needs_fix
verifying
done
archived
```

### 要完成

```txt
任務狀態切換
任務完成
任務歸檔
依狀態篩選任務
```

### 建議檔案

```txt
src/components/TaskSidebar.tsx
src/components/TaskDetail.tsx
src/core/taskService.ts
```

### 完成標準

```txt
[ ] 可以切換任務狀態
[ ] 可以標記任務完成
[ ] 可以歸檔任務
[ ] 任務列表可以依狀態篩選
```

### 不做

```txt
不做複雜 dashboard
不做統計圖表
```

---

## Phase 9：Verification Panel 空殼

### 目標

先預留未來驗收區塊，但不實作 git diff 與 command runner。

### 要完成

```txt
VerificationPanel 元件
顯示 checklist
顯示待加入功能提示
```

### 建議檔案

```txt
src/components/VerificationPanel.tsx
```

### 完成標準

```txt
[ ] 任務詳情中可以看到 Verification Panel
[ ] 可以看到 checklist
[ ] 顯示 git diff / command runner 將在未來加入
```

### 不做

```txt
不做 git status
不做 git diff
不做 command runner
```

---

## Phase 10：Git Status / Git Diff

### 目標

開始讀取本機專案狀態。

### 要完成

```txt
設定 projectPath
執行 git status
執行 git diff
保存 git status
保存 git diff
把 git diff 放入 GPT Review Prompt
```

### 建議檔案

```txt
src-tauri/src/commands.rs
src-tauri/src/git.rs
src/components/VerificationPanel.tsx
src/shared/types.ts
```

### 完成標準

```txt
[ ] 可以設定 projectPath
[ ] 可以按鈕執行 git status
[ ] 可以按鈕執行 git diff
[ ] 結果可以顯示在 Verification Panel
[ ] 結果可以保存到 TaskRound
[ ] GPT Review Prompt 可以帶入 git status / git diff
```

### 安全限制

```txt
只允許 git status
只允許 git diff
不允許 git reset
不允許 git clean
不允許 git checkout
```

---

## Phase 11：Command Runner

### 目標

讓使用者可以執行安全的驗收 command，例如 build / test。

### 要完成

```txt
設定 command
執行 command
保存 stdout
保存 stderr
保存 exitCode
顯示 command log
把 command log 放入 GPT Review Prompt
```

### 建議檔案

```txt
src-tauri/src/commands.rs
src-tauri/src/command_runner.rs
src/components/VerificationPanel.tsx
src/shared/types.ts
```

### 完成標準

```txt
[ ] 可以執行 pnpm build
[ ] 可以執行 pnpm test
[ ] 可以執行 npm run build
[ ] 可以保存 command log
[ ] command 失敗時可以看到 stderr
```

### 安全限制

允許：

```txt
pnpm build
pnpm test
pnpm lint
npm run build
npm test
yarn build
yarn test
```

禁止：

```txt
rm -rf
git reset --hard
git clean -fd
sudo
chmod -R
curl | sh
```

---

## Phase 12：Harness 整合

### 目標

把之前的 harness 變成 AI Coding Relay 的底層 tool execution engine。

### Harness 負責

```txt
解析 tool_request
執行安全工具
回傳 ToolResult
```

### 第一版工具

```txt
read_file
list_dir
git_status
git_diff
run_command
```

### 暫不開放

```txt
write_file
delete_file
dangerous command
```

### 建議檔案

```txt
src/harness/types.ts
src/harness/toolParser.ts
src/harness/toolExecutor.ts
src/harness/tools/readFile.ts
src/harness/tools/listDir.ts
src/harness/tools/gitStatus.ts
src/harness/tools/gitDiff.ts
src/harness/tools/runCommand.ts
```

或如果放在 Tauri 後端：

```txt
src-tauri/src/harness.rs
src-tauri/src/tools/
```

### 完成標準

```txt
[ ] 可以解析 tool_request JSON
[ ] 可以拒絕未知 tool
[ ] 可以執行 git_diff
[ ] 可以回傳 ToolResult
[ ] 危險 command 會被拒絕
```

---

## Phase 13：Prompt Template Library

### 目標

讓不同任務類型使用不同 prompt 模板。

### 模板類型

```txt
UI 修改
TypeScript Error
Bug Investigation
Refactor
API 串接
Test / 驗收
Claude 修錯
```

### 要完成

```txt
選擇任務類型
套用對應模板
支援自訂模板
保存模板
```

### 建議檔案

```txt
src/prompt-engine/templates/
src/prompt-engine/templateRegistry.ts
src/components/TemplateSelector.tsx
```

### 完成標準

```txt
[ ] taskType = ui 時使用 UI 修改模板
[ ] taskType = typescript 時使用 TypeScript Error 模板
[ ] taskType = bug 時使用 Bug Investigation 模板
[ ] 使用者可以看到目前使用的模板
```

---

## Phase 14：任務搜尋與知識庫

### 目標

讓完成的任務變成可查詢的工程知識庫。

### 要完成

```txt
搜尋任務標題
搜尋原始需求
搜尋 Claude Response
搜尋 GPT Review
搜尋錯誤訊息
依任務類型篩選
依專案篩選
依狀態篩選
```

### 建議檔案

```txt
src/components/SearchPanel.tsx
src/core/searchService.ts
```

### 完成標準

```txt
[ ] 可以搜尋以前的任務
[ ] 可以找到以前用過的 prompt
[ ] 可以找到以前解過的錯誤
[ ] 可以開啟歸檔任務查看完整紀錄
```

---

## Phase 15：任務完成摘要

### 目標

任務完成時產生一份摘要，方便未來回顧。

### 摘要內容

```txt
任務目標
修改檔案
遇到問題
最後解法
驗收結果
下次注意事項
```

### 要完成

```txt
手動填寫摘要
根據 GPT Review 產生摘要草稿
歸檔時保存摘要
```

### 建議檔案

```txt
src/components/TaskSummary.tsx
src/core/summaryService.ts
```

### 完成標準

```txt
[ ] 任務完成前可以填寫 summary
[ ] 任務歸檔後可以看到 summary
[ ] 搜尋可以搜到 summary
```

---

## Phase 16：半自動 Clipboard Relay

### 目標

減少手動複製貼上的成本。

### 要完成

```txt
一鍵複製 Claude Prompt
一鍵複製 GPT Review Prompt
監聽 clipboard
偵測貼回內容
手動確認後建立新 round
```

### 完成標準

```txt
[ ] 複製 prompt 後狀態會更新
[ ] 貼回內容可以快速存成 Claude Response
[ ] 不會自動送出 prompt
[ ] 不會自動切換視窗
```

### 暫不做

```txt
不自動控制 Claude Code 視窗
不自動按 Enter
不自動送出
```

---

## Phase 17：AI API 整合

### 目標

在產品流程穩定後，才加入 API 整合。

### 可選整合

```txt
OpenAI API
Claude API
Local Ollama
```

### 要完成

```txt
設定 API key
選擇模型
送出 GPT Review Prompt
取得 Review 結果
保存 Review
```

### 完成標準

```txt
[ ] 可以用 API 產生 GPT Review
[ ] 可以保存模型回覆
[ ] API key 不寫死在程式碼
[ ] API key 不進 git
```

---

## Phase 18：產品化

### 目標

整理成可展示、可發佈的工具。

### 要完成

```txt
README 完整化
Demo 影片
打包桌面 App
icon
基本設定頁
錯誤處理
資料備份
匯出 Markdown
```

### 完成標準

```txt
[ ] 可以打包 macOS app
[ ] README 說明清楚
[ ] 3 分鐘 demo 可以展示核心流程
[ ] 使用者能理解這不是 Todo App，而是 AI coding workflow manager
```

---

## 優先順序總結

短期只做：

```txt
Phase 0：文件
Phase 1：MVP 專案骨架
Phase 2：Task / TaskRound 型別
Phase 3：本機資料保存
Phase 4：Claude Prompt Generator
Phase 5：Claude Response 與 Round Timeline
Phase 6：GPT Review Prompt Generator
```

中期再做：

```txt
Phase 7：Next Prompt 管理
Phase 8：任務狀態與歸檔
Phase 9：Verification Panel 空殼
Phase 10：Git Status / Git Diff
Phase 11：Command Runner
```

後期再做：

```txt
Phase 12：Harness 整合
Phase 13：Prompt Template Library
Phase 14：任務搜尋與知識庫
Phase 15：任務完成摘要
Phase 16：半自動 Clipboard Relay
Phase 17：AI API 整合
Phase 18：產品化
```

---

## 開發原則

每一個 Phase 都要遵守：

```txt
1. 小步完成。
2. 每一階段都要可以驗收。
3. 不要提前做後面階段的功能。
4. 不要為了酷而做 agent。
5. 先讓自己每天能用，再談自動化。
6. 安全優先，不讓 AI 自動修改使用者專案。
7. 所有 prompt 與任務紀錄都要可追蹤。
```