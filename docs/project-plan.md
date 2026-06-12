# AI Coding Relay 專案規劃

## 1. 專案目標

AI Coding Relay 是一個給工程師使用的 AI coding 工作流管理工具。

它的目的不是取代 Claude Code、Codex 或 GPT，而是幫工程師管理這些 AI 工具之間的工作流程。

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

這個工具要解決的是：

- AI 改錯檔案
- 多輪對話後上下文混亂
- 不知道下一步怎麼問 Claude
- 改完不知道有沒有符合需求
- 沒有任務紀錄可以回頭查
- 每次都要重新寫 prompt
- git diff / build / test 結果沒有被整理

---

## 2. 產品定位

AI Coding Relay 不是：

- 一般 Todo App
- 一般 Chat App
- 單純剪貼簿工具
- 完整 AI Agent
- IDE Plugin
- 雲端協作平台

AI Coding Relay 是：

- AI coding 任務管理器
- Prompt 產生器
- Claude / GPT 接力工具
- Git diff 審查輔助工具
- 驗收 checklist 管理工具
- 工程任務知識庫

一句話：

> 幫工程師把 AI coding 任務從需求、prompt、修改、審查、驗收到歸檔完整串起來。

---

## 3. 使用者痛點

### 3.1 AI 修錯檔案

工程師給 Claude 一段需求後，Claude 可能會改到不該改的檔案，或重構無關區塊。

解法：

- 任務中指定 targetFiles
- 任務中指定 forbiddenFiles
- 產生 prompt 時自動加上「只准改這些檔案」
- 如果 Claude 需要改其他檔案，要求它先說明原因

---

### 3.2 多輪對話上下文混亂

AI coding 常常不是一輪完成，而是多輪修正。

常見情況：

- 第一輪改 UI
- 第二輪修 TypeScript error
- 第三輪修 build error
- 第四輪補驗收
- 最後忘記前面要求什麼

解法：

- 每個任務底下保存多個 TaskRound
- 每一輪保存：
  - Claude Prompt
  - Claude Response
  - GPT Review
  - Next Prompt
  - Git diff
  - Command log
  - Checklist

---

### 3.3 不知道下一步怎麼問 Claude

Claude 改完後，工程師常常要自己判斷下一步怎麼叫它修。

解法：

- 貼回 Claude 回覆後，產生 GPT Review Prompt
- GPT 幫忙分析：
  - 有沒有符合需求
  - 哪裡漏掉
  - 有沒有改錯方向
  - 下一步該怎麼 prompt Claude

---

### 3.4 改完不知道有沒有成功

AI 說完成，不代表真的完成。

解法：

- 讀 git status
- 讀 git diff
- 跑 build / test / lint
- 把結果放進 review prompt
- 產生驗收 checklist

---

### 3.5 任務完成後沒有紀錄

很多問題下次還會遇到，但之前怎麼解已經忘了。

解法：

- 任務完成後歸檔
- 產生任務摘要
- 可以搜尋以前任務
- 可以查 prompt、錯誤訊息、解法

---

## 4. 核心流程

### 第一版流程

```txt
1. 建立任務
2. 輸入原始需求
3. 設定目標檔案
4. 設定禁止修改範圍
5. 設定限制條件
6. 產生 Claude Prompt
7. 一鍵複製 Prompt
8. 手動貼到 Claude Code
9. Claude Code 修改專案
10. 貼回 Claude 回覆
11. 產生 GPT Review Prompt
12. 手動貼到 GPT 審查
13. 貼回 GPT Review
14. 產生下一步 Claude Prompt
15. 重複直到驗收完成
16. 任務歸檔
```

---

### 未來流程

```txt
1. 建立任務
2. 產生 Claude Prompt
3. Claude Code 修改專案
4. 工具讀取 git diff
5. 工具執行 build / test
6. GPT 根據 diff 和 log 審查
7. 自動產生下一步 prompt
8. 產出任務完成摘要
9. 歸檔為可搜尋知識
```

---

## 5. 第一版 MVP 範圍

第一版重點是：

> 做出一個自己真的可以開始使用的半自動工具。

### 5.1 第一版要做

第一版需要完成：

```txt
任務管理
Prompt 產生
手動複製
手動貼回 Claude 結果
GPT Review Prompt 產生
多輪紀錄
任務狀態管理
本機 JSON 儲存
```

具體功能：

- 新增任務
- 編輯任務
- 刪除任務
- 任務列表
- 任務詳情
- 任務狀態切換
- 輸入原始需求
- 輸入目標檔案
- 輸入禁止修改檔案
- 輸入限制條件
- 輸入驗收條件
- 產生 Claude Prompt
- 複製 Claude Prompt
- 貼上 Claude Response
- 建立 TaskRound
- 顯示 Round Timeline
- 產生 GPT Review Prompt
- 複製 GPT Review Prompt
- 貼上 GPT Review
- 產生下一步 Prompt
- 任務完成後歸檔

---

### 5.2 第一版不要做

第一版不要做：

```txt
不串 OpenAI API
不串 Claude API
不自動控制 Claude Code 視窗
不自動按 Enter
不自動修改使用者專案檔案
不做 write_file
不做雲端同步
不做多人協作
不做 marketplace
不做完整 agent
```

原因：

第一版的目標不是自動化，而是先驗證這個工作流對自己有沒有用。

---

## 6. 技術選型

### 6.1 桌面 App

使用 Tauri。

原因：

這個工具未來需要：

- 讀取本機檔案
- 讀取 git diff
- 執行 build / test command
- 操作 clipboard
- 保存本機任務資料

Web App 在本機權限上會受限制。

---

### 6.2 前端

使用：

```txt
React
TypeScript
Tailwind CSS 或 Chakra UI
```

目前第一版可以先用 Tauri 預設 React 結構，之後再決定 UI library。

---

### 6.3 本機資料儲存

第一版建議用 JSON file。

例如：

```txt
data/store.json
```

先不要一開始就用 SQLite。

原因：

- 開發快
- 好 debug
- 好備份
- 資料結構還會變

等資料模型穩定後，再改 SQLite。

---

### 6.4 核心能力

第一階段會用到：

```txt
React state
TypeScript types
Prompt generator
Clipboard copy
Local JSON storage
```

第二階段再加入：

```txt
git status
git diff
run command
```

---

## 7. 第一版資料模型

### 7.1 Task

Task 代表一個 AI coding 任務。

```ts
type Task = {
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

### 7.2 TaskStatus

```ts
type TaskStatus =
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

### 7.3 TaskType

```ts
type TaskType =
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

### 7.4 TaskRound

TaskRound 代表同一個任務中的某一輪 AI 互動。

```ts
type TaskRound = {
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

### 7.5 ChecklistItem

```ts
type ChecklistItem = {
  id: string;
  label: string;
  status: "pending" | "passed" | "failed" | "skipped";
  note?: string;
};
```

---

### 7.6 CommandLog

```ts
type CommandLog = {
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

## 8. 第一版畫面規劃

### 8.1 主畫面結構

```txt
左側：任務列表
右側：任務詳情
下方或右側：Prompt / 回合紀錄 / 驗收資訊
```

---

### 8.2 任務列表

顯示：

```txt
全部
草稿
進行中
需要修正
驗收中
完成
歸檔
```

每個任務卡片顯示：

```txt
任務標題
任務類型
任務狀態
最後更新時間
```

---

### 8.3 任務詳情

欄位：

```txt
任務標題
任務類型
任務狀態
原始需求
目標檔案
禁止修改檔案
限制條件
驗收條件
Project Path
```

按鈕：

```txt
產生 Claude Prompt
複製 Claude Prompt
貼上 Claude 回覆
產生 GPT Review Prompt
複製 GPT Review Prompt
新增下一輪
標記完成
歸檔
```

---

### 8.4 Prompt Panel

顯示：

```txt
Claude Prompt 預覽
GPT Review Prompt 預覽
下一步 Claude Prompt 預覽
```

---

### 8.5 Round Timeline

每一輪顯示：

```txt
第 1 輪
- Claude Prompt
- Claude Response
- GPT Review Prompt
- GPT Review
- Next Prompt
- Checklist
```

未來再加：

```txt
- Git Diff
- Git Status
- Build Result
- Test Result
```

---

## 9. 開發階段規劃

### Phase 0：文件整理

目標：

先把產品方向整理清楚，避免做歪。

產出：

```txt
docs/project-plan.md
docs/claude-context.md
docs/prompt-templates.md
docs/roadmap.md
README.md
```

完成標準：

```txt
自己看得懂這個產品要做什麼
Claude 看得懂專案架構與限制
未來每次開發都可以參考文件
```

---

### Phase 1：建立 MVP 專案骨架

目標：

建立 Tauri + React + TypeScript 專案。

功能：

```txt
App 可以啟動
有基本版面
有任務列表
有新增任務表單
有任務詳情區
```

完成標準：

```txt
可以新增任務
可以看到任務列表
可以點選任務查看詳情
重開 App 後資料還在
```

---

### Phase 2：Prompt 產生器

目標：

可以根據 Task 產生 Claude Prompt。

功能：

```txt
輸入原始需求
輸入目標檔案
輸入禁止修改檔案
輸入限制條件
輸入驗收條件
產生 Claude Prompt
一鍵複製 Prompt
```

完成標準：

```txt
建立一個任務後，可以產生可直接貼給 Claude Code 的 prompt
```

---

### Phase 3：Claude 回覆與回合紀錄

目標：

可以保存每一輪 Claude 回覆。

功能：

```txt
貼上 Claude Response
建立 TaskRound
顯示 Round Timeline
同一任務可保存多輪紀錄
```

完成標準：

```txt
同一個任務可以保存第 1 輪、第 2 輪、第 3 輪紀錄
```

---

### Phase 4：GPT Review Prompt

目標：

根據任務需求與 Claude 回覆，產生 GPT Review Prompt。

功能：

```txt
產生 GPT Review Prompt
複製 GPT Review Prompt
貼上 GPT Review
產生下一步 Claude Prompt
```

完成標準：

```txt
Claude 回覆貼回後，可以產生一段 GPT 審查 prompt
GPT 審查後，可以整理出下一步 Claude Prompt
```

---

### Phase 5：任務狀態與歸檔

目標：

讓任務可以完整管理生命週期。

狀態：

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

功能：

```txt
任務狀態切換
任務完成
任務歸檔
歸檔列表
```

完成標準：

```txt
任務可以從建立到完成，最後進入歸檔
```

---

### Phase 6：Git Diff / Command Runner

目標：

工具開始讀取本機專案狀態。

功能：

```txt
設定 project path
執行 git status
執行 git diff
執行自訂 command
保存 command log
```

完成標準：

```txt
Claude 修改完專案後，工具可以讀取 git diff
並把 git diff 放進 GPT Review Prompt
```

---

### Phase 7：Harness 整合

目標：

把之前的 harness 變成工具底層執行引擎。

harness 負責：

```txt
read_file
list_dir
run_command
git_status
git_diff
```

第一版不開放：

```txt
write_file
delete_file
dangerous command
```

完成標準：

```txt
AI 可以透過 tool_request 要求 git_diff
harness 執行後回傳結果
```

---

### Phase 8：Prompt Template Library

目標：

建立不同任務類型的 Prompt 模板。

模板：

```txt
UI 修改
TypeScript Error
Refactor
Bug Investigation
API 串接
Test 補強
Claude 修錯
```

完成標準：

```txt
使用者選擇任務類型後，系統產生對應風格的 prompt
```

---

### Phase 9：任務搜尋與知識庫

目標：

讓完成的任務變成可查詢的知識庫。

功能：

```txt
任務搜尋
依任務類型篩選
依專案篩選
依錯誤訊息搜尋
依檔案名稱搜尋
任務完成摘要
```

完成標準：

```txt
可以回頭查以前怎麼解某個 TypeScript error 或 Claude 修錯問題
```

---

### Phase 10：半自動 Relay

目標：

減少手動複製貼上的操作。

功能：

```txt
一鍵複製 Claude Prompt
監聽 clipboard
自動偵測 Claude 回覆
自動建立新 round
自動產生下一步 prompt
```

暫時不做：

```txt
自動切換視窗
自動按 Enter
自動送出 prompt
```

完成標準：

```txt
不用一直手動整理文字，工具可以自動接住回覆並建立下一輪
```

---

## 10. 安全規劃

### 10.1 預設 Read-only

第一版不要讓 AI 自動修改使用者專案。

允許：

```txt
read_file
list_dir
git_status
git_diff
run_command with confirmation
```

不允許：

```txt
write_file
delete_file
rm -rf
git reset --hard
git clean -fd
sudo
curl | sh
```

---

### 10.2 Command 白名單

可以允許：

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

高風險 command 需要禁止或二次確認：

```txt
rm -rf
git reset --hard
git clean -fd
sudo
chmod -R
curl | sh
```

---

### 10.3 敏感資料遮罩

未來需要支援：

```txt
.env 遮罩
API key 遮罩
token 遮罩
個資遮罩
```

---

## 11. 第一個版本完成後應該長什麼樣

第一版完成後，使用流程：

```txt
1. 開啟 AI Coding Relay
2. 新增任務
3. 輸入需求：
   「DM 表單新增當年新收案與當月新收案」
4. 輸入目標檔案：
   DmForms.tsx
   index.tsx
5. 輸入限制：
   不要改 CKD / DKD
   不要重構無關元件
6. 點擊「產生 Claude Prompt」
7. 點擊「複製」
8. 貼到 Claude Code
9. Claude 修改完成後，把回覆貼回 AI Coding Relay
10. 點擊「產生 GPT Review Prompt」
11. 貼到 GPT 審查
12. 把 GPT 審查結果貼回
13. 取得下一步 Claude Prompt
14. 重複直到完成
15. 標記任務完成並歸檔
```

---

## 12. 第一階段成功標準

第一階段完成時，要符合：

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

## 13. 未來產品化方向

後續可以慢慢加：

```txt
Git diff 自動審查
Build / test 自動驗收
PR summary generator
Prompt template library
任務搜尋
任務歸檔摘要
Local LLM review
OpenAI API review
Claude Code CLI relay
Codex CLI relay
多專案管理
敏感資料遮罩
團隊模板共享
```

---

## 14. 最重要的開發原則

這個專案最重要的是不要一開始做太大。

第一階段只做：

```txt
需求 → Claude Prompt → Claude Response → GPT Review Prompt → 下一步 Prompt → 回合紀錄
```

等這個流程真的順了，再做：

```txt
git diff
build / test
harness
自動化 relay
任務搜尋
產品化
```

核心原則：

> 先做一個自己每天真的會用的工具，再慢慢產品化。