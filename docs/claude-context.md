# Claude Context：AI Coding Relay 專案開發指南

## 1. 專案名稱

AI Coding Relay

---

## 2. 專案目標

AI Coding Relay 是一個給工程師使用的 AI coding 工作流管理工具。

它不是一般 Todo App，也不是一般 Chat App。

它的目標是管理工程師使用 Claude Code、GPT、Codex 等 AI coding 工具時的流程。

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

這個工具要負責保存與管理：

```txt
任務需求
Claude Prompt
Claude Response
GPT Review Prompt
GPT Review
Next Prompt
Git Diff
Build / Test Log
驗收 Checklist
任務紀錄
```

---

## 3. 產品定位

請將本專案理解為：

```txt
AI coding task workflow manager
```

不要把它做成：

```txt
一般 Todo App
一般 Chat App
單純 Clipboard 工具
完整 AI Agent
IDE Plugin
雲端 SaaS
多人協作平台
```

目前只專注在：

```txt
需求 → Prompt → Claude 回覆 → GPT Review → 下一步 Prompt → 驗收 → 歸檔
```

---

## 4. 技術選型

目前專案使用：

```txt
Tauri
React
TypeScript
pnpm
```

第一階段只做本機桌面 App。

前端主要使用 React + TypeScript。

Tauri / Rust 主要負責未來的本機能力，例如：

```txt
讀寫本機 JSON
讀 git status
讀 git diff
執行 command
操作 clipboard
```

第一階段請不要過度實作 Rust 邏輯。

---

## 5. 第一階段開發目標

第一階段目標是完成 MVP 手動 Relay 版。

需要完成：

```txt
1. 任務列表
2. 新增任務
3. 任務詳情
4. Task / TaskRound 型別
5. Claude Prompt Generator
6. 複製 Claude Prompt
7. 貼上 Claude Response
8. 建立 TaskRound
9. 顯示 Round Timeline
10. GPT Review Prompt Generator
11. 本機資料保存
```

第一階段完成後，使用者應該可以：

```txt
新增一個任務
輸入需求
輸入目標檔案
輸入限制條件
產生 Claude Prompt
複製 Prompt 到 Claude Code
貼回 Claude Response
產生 GPT Review Prompt
保存這一輪紀錄
```

---

## 6. 第一階段不要做的事情

請不要在第一階段實作以下功能：

```txt
不要串 OpenAI API
不要串 Claude API
不要串 Codex API
不要自動控制 Claude Code 視窗
不要自動按 Enter
不要自動送出 Prompt
不要實作完整 agent
不要實作 harness
不要實作 write_file
不要實作 delete_file
不要實作 git reset
不要實作 git clean
不要做雲端同步
不要做多人協作
不要做 marketplace
不要做登入系統
```

如果需要本機能力，第一階段只允許做非常基礎的資料保存與 clipboard copy。

---

## 7. 開發原則

請遵守以下原則：

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

## 8. 建議資料夾結構

第一版可以使用以下結構：

```txt
src/
├─ components/
│  ├─ TaskSidebar.tsx
│  ├─ TaskDetail.tsx
│  ├─ TaskForm.tsx
│  ├─ PromptPanel.tsx
│  ├─ RoundTimeline.tsx
│  └─ VerificationPanel.tsx
│
├─ hooks/
│  └─ useTasks.ts
│
├─ shared/
│  └─ types.ts
│
├─ core/
│  ├─ taskService.ts
│  └─ roundService.ts
│
├─ prompt-engine/
│  ├─ claudePromptTemplate.ts
│  ├─ gptReviewTemplate.ts
│  └─ promptRenderer.ts
│
├─ storage/
│  ├─ taskStorage.ts
│  └─ storagePaths.ts
│
└─ utils/
   ├─ date.ts
   └─ id.ts
```

如果目前 Tauri template 預設結構不同，可以在不破壞啟動的前提下逐步整理。

不要一次大規模重構。

---

## 9. 主要資料型別

主要型別請放在：

```txt
src/shared/types.ts
```

第一版至少要有以下型別。

### TaskStatus

```ts
export type TaskStatus =
  | "draft"
  | "prompt_ready"
  | "sent_to_ai"
  | "reviewing"
  | "needs_fix"
  | "verifying"
  | "done"
  | "archived";
```

---

### TaskType

```ts
export type TaskType =
  | "ui"
  | "bug"
  | "typescript"
  | "refactor"
  | "api"
  | "test"
  | "docs"
  | "other";
```

---

### Task

```ts
export type Task = {
  id: string;
  title: string;
  type: TaskType;
  status: TaskStatus;

  originalRequirement: string;

  targetFiles: string[];
  forbiddenFiles: string[];
  constraints: string[];
  acceptanceCriteria: string[];

  projectPath?: string;

  createdAt: string;
  updatedAt: string;
};
```

---

### TaskRound

```ts
export type TaskRound = {
  id: string;
  taskId: string;
  roundIndex: number;

  promptToClaude: string;
  claudeResponse?: string;

  gptReviewPrompt?: string;
  gptReview?: string;
  nextPrompt?: string;

  gitStatus?: string;
  gitDiff?: string;

  commandLogs?: CommandLog[];

  checklist: ChecklistItem[];

  createdAt: string;
  updatedAt: string;
};
```

---

### ChecklistItem

```ts
export type ChecklistItem = {
  id: string;
  label: string;
  status: "pending" | "passed" | "failed" | "skipped";
  note?: string;
};
```

---

### CommandLog

```ts
export type CommandLog = {
  id: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
};
```

---

## 10. Prompt Engine 規則

Prompt engine 請獨立於 UI。

不要把 prompt template 直接寫在 React component 裡。

建議放在：

```txt
src/prompt-engine/
```

建議函式：

```ts
export function generateClaudePrompt(task: Task): string;

export function generateGptReviewPrompt(params: {
  task: Task;
  round: TaskRound;
}): string;
```

---

## 11. Claude Prompt Generator 內容原則

產生 Claude Prompt 時，應該包含：

```txt
任務需求
任務類型
允許修改檔案
禁止修改範圍
限制條件
驗收條件
開發原則
完成後回報格式
```

所有 Claude Prompt 都應該自動加入以下規則：

```txt
優先做最小修改，不要大範圍重構。
不要新增與需求無關的欄位或功能。
如果發現需要修改其他檔案，請先說明原因。
不要用 any 草率解決 TypeScript 問題。
保留既有命名與程式風格。
不要改動未列入需求的 UI 或 business logic。
```

---

## 12. GPT Review Prompt Generator 內容原則

產生 GPT Review Prompt 時，應該包含：

```txt
原始需求
允許修改檔案
禁止修改範圍
限制條件
驗收條件
Claude 回覆
git status
git diff
command result
```

第一階段 git status / git diff / command result 可以先是空值。

GPT Review Prompt 要請 GPT 輸出：

```txt
1. 是否符合原始需求
2. 已完成項目
3. 可能漏掉的項目
4. 是否有改到不該改的地方
5. TypeScript / React / UI 風險
6. 建議驗收 checklist
7. 下一輪要給 Claude Code 的 prompt
```

---

## 13. Storage 規則

第一版使用本機資料保存。

可以先用 localStorage 或 JSON file。

如果使用 JSON file，建議：

```txt
data/store.json
```

資料至少要保存：

```txt
tasks
rounds
```

Storage 層應該集中管理，不要讓 React component 直接處理底層儲存細節。

建議建立：

```txt
src/storage/taskStorage.ts
```

負責：

```txt
讀取 tasks
新增 task
更新 task
刪除 task
讀取 rounds
新增 round
更新 round
```

---

## 14. UI 原則

UI 先求清楚，不追求炫。

主要畫面：

```txt
左側：任務列表
右側：任務詳情
下方或右側：Prompt / 回合紀錄 / 驗收
```

第一版不需要複雜動畫。

必須清楚呈現：

```txt
目前是哪個任務
目前是哪一輪
目前 Claude Prompt 是什麼
Claude 回覆是什麼
GPT Review Prompt 是什麼
下一步 Prompt 是什麼
```

---

## 15. 第一版主要元件

建議元件：

```txt
TaskSidebar.tsx
TaskDetail.tsx
TaskForm.tsx
PromptPanel.tsx
RoundTimeline.tsx
VerificationPanel.tsx
```

### TaskSidebar

負責：

```txt
顯示任務列表
依狀態篩選
選取任務
新增任務按鈕
```

### TaskDetail

負責：

```txt
顯示任務內容
編輯任務
切換任務狀態
顯示任務操作按鈕
```

### TaskForm

負責：

```txt
新增 / 編輯任務表單
```

### PromptPanel

負責：

```txt
顯示 Claude Prompt
顯示 GPT Review Prompt
顯示 Next Prompt
複製 prompt
```

### RoundTimeline

負責：

```txt
顯示每一輪 TaskRound
顯示 Claude Response
顯示 GPT Review
顯示 Next Prompt
```

### VerificationPanel

第一階段可以先保留空殼。

未來負責：

```txt
git status
git diff
build result
test result
checklist
```

---

## 16. 安全限制

這個工具未來會接觸使用者本機專案，因此安全限制很重要。

第一階段：

```txt
不要實作 write_file。
不要實作 delete_file。
不要自動執行危險 command。
不要自動修改 git 狀態。
不要執行 git reset、git clean、rm -rf。
```

未來 command runner 必須有白名單。

允許 command 範例：

```txt
git status
git diff
yarn build
yarn test
npm run build
npm test
pnpm build
pnpm test
```

禁止或需二次確認：

```txt
rm -rf
git reset --hard
git clean -fd
sudo
chmod -R
curl | sh
```

---

## 17. 第一階段驗收標準

第一階段完成時，必須符合：

```txt
[ ] App 可以啟動
[ ] 可以新增任務
[ ] 可以編輯任務
[ ] 可以看到任務列表
[ ] 可以點選任務查看詳情
[ ] 可以輸入目標檔案
[ ] 可以輸入限制條件
[ ] 可以產生 Claude Prompt
[ ] 可以複製 Claude Prompt
[ ] 可以貼上 Claude Response
[ ] 可以建立 TaskRound
[ ] 可以顯示 Round Timeline
[ ] 可以產生 GPT Review Prompt
[ ] 可以保存資料
[ ] 關閉 App 後資料仍存在
```

---

## 18. 開發時請遵守

如果你是 Claude Code，請遵守：

```txt
1. 每次修改前先說明要改哪些檔案。
2. 優先小步修改。
3. 不要一次重構整個專案。
4. 不要新增超出目前階段的功能。
5. 不要引入不必要的套件。
6. 不要把 prompt template 寫死在 UI component。
7. 不要用 any 草率處理型別。
8. 不要做自動 agent 行為。
9. 不要實作危險 command。
10. 修改完成後請回報修改檔案、修改內容、驗收方式。
```

---

## 19. 第一個 Claude Code 任務 Prompt

如果要開始第一階段開發，可以使用以下 prompt：

```txt
請依照 docs/project-plan.md 與 docs/claude-context.md，開始建立 AI Coding Relay 的 MVP 手動 Relay 版本。

目前專案已經是 Tauri + React + TypeScript，可以正常啟動。

第一階段只做以下功能：

1. 建立 Task / TaskRound 型別
2. 建立基本任務列表
3. 建立新增任務功能
4. 建立任務詳情區
5. 建立 Claude Prompt Generator
6. 建立複製 Claude Prompt 的功能
7. 建立貼上 Claude Response 的區塊
8. 建立 Round Timeline
9. 建立 GPT Review Prompt Generator
10. 使用本機方式保存資料

請不要做以下事情：

- 不要串 OpenAI API
- 不要串 Claude API
- 不要自動控制 Claude Code 視窗
- 不要自動按 Enter
- 不要實作 harness
- 不要實作 git diff
- 不要實作 command runner
- 不要實作 write_file
- 不要做雲端同步
- 不要做多人協作

請優先保持小步修改。

請完成後回報：

1. 建立或修改了哪些檔案
2. 每個檔案負責什麼
3. 如何啟動專案
4. 如何驗收目前功能
5. 下一步建議做什麼
```

---

## 20. 最重要提醒

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