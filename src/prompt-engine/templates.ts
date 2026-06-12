import type { TaskType } from "../shared/types";

export type PromptTemplate = {
  label: string;
  role: string;
  specificPrinciples: string;
  reportFormat: string;
};

const UI_TEMPLATE: PromptTemplate = {
  label: "UI 修改",
  role: "你是資深 React + TypeScript 工程師，請協助我修改 UI。",
  specificPrinciples: `請注意：
1. 優先維持既有 UI 風格，不要大幅重設計。
2. 不要改動 business logic 或資料流。
3. 不要新增需求外的欄位或互動元素。
4. 不要大範圍重構，優先做最小修改。
5. 若需要修改共用元件，請先說明原因與影響範圍。
6. 保留既有 CSS class 命名風格。`,
  reportFormat: `完成後請回報：
1. 修改了哪些 UI 元件
2. 修改了哪些檔案
3. 如何驗收畫面
4. 是否可能影響其他頁面
5. 有哪些風險`,
};

const TYPESCRIPT_TEMPLATE: PromptTemplate = {
  label: "TypeScript 錯誤",
  role: "你是資深 TypeScript 工程師，請協助我修正 TypeScript 錯誤。",
  specificPrinciples: `請注意：
1. 不要用 any 草率解決問題。
2. 不要用 as unknown as 硬轉，除非有充分理由並說明。
3. 優先修正正確的型別定義，而不是繞過型別檢查。
4. 如果是 props 問題，請檢查呼叫端與 component 定義是否一致。
5. 如果是 import 問題，請檢查檔案路徑與 tsconfig alias。
6. 不要重構無關程式碼。`,
  reportFormat: `完成後請回報：
1. 錯誤原因
2. 修改了哪些檔案
3. 如何驗證錯誤已修正
4. 是否有其他潛在型別風險
5. 如果還沒完成，下一步要做什麼`,
};

const BUG_TEMPLATE: PromptTemplate = {
  label: "Bug 修正",
  role: "你是資深 React + TypeScript 工程師，請先協助我調查 bug 原因，不要直接大改。",
  specificPrinciples: `請先做：
1. 找出可能原因，列出最可能出問題的檔案與函式。
2. 說明資料流或狀態流。
3. 提出最小修改方案。
4. 不要修改無關功能。

確認需要修改時，請只做最小必要修改，不要大範圍重構。`,
  reportFormat: `完成後請回報：
1. 根本原因
2. 修改了哪些檔案
3. 修改內容
4. 如何驗收
5. 是否有其他風險`,
};

const REFACTOR_TEMPLATE: PromptTemplate = {
  label: "重構",
  role: "你是資深 React + TypeScript 工程師，請協助我重構這段程式，但不要改變既有行為。",
  specificPrinciples: `請遵守：
1. 不要改變既有功能行為。
2. 不要新增需求外功能。
3. 優先小步重構，不要一次大改。
4. 若要拆檔，請說明拆分理由。
5. 保留既有命名風格。
6. 不要用 any 放寬型別。`,
  reportFormat: `完成後請回報：
1. 重構前的問題
2. 重構後的結構
3. 修改了哪些檔案
4. 如何確認行為沒有改變
5. 下一步是否還有可拆分項目`,
};

const API_TEMPLATE: PromptTemplate = {
  label: "API 串接",
  role: "你是資深 React + TypeScript 工程師，請協助我處理 API 串接。",
  specificPrinciples: `請注意：
1. request / response 型別要明確，不要用 any。
2. API service 與 UI 邏輯要分離。
3. 錯誤處理要保守，不要讓頁面 crash。
4. 不要修改無關 API。
5. 如果需要新增 type，請放在合適位置。
6. 不要修改與此 API 無關的功能。`,
  reportFormat: `完成後請回報：
1. 新增或修改了哪些 API
2. request / response 型別是什麼
3. UI 如何使用
4. 錯誤如何處理
5. 如何驗收`,
};

const TEST_TEMPLATE: PromptTemplate = {
  label: "測試補強",
  role: "你是資深 React + TypeScript 工程師，請協助我補強測試與驗收。",
  specificPrinciples: `請幫我產生：
1. 需要手動驗收的項目（含操作步驟與預期結果）。
2. 需要自動測試的項目（unit test / integration test）。
3. 可能的 regression 風險。
4. 若需要補 test 檔案，請指出哪些函式或元件需要優先覆蓋。`,
  reportFormat: `完成後請回報：
1. 驗收 checklist（手動）
2. 建議補寫的自動測試項目
3. Regression 風險清單
4. 測試覆蓋後的信心程度
5. 如果還沒完成，下一步要做什麼`,
};

const DOCS_TEMPLATE: PromptTemplate = {
  label: "文件修改",
  role: "你是資深開發者，請協助我修改或補充專案文件。",
  specificPrinciples: `請注意：
1. 只修改文件檔案（.md、.txt、README 等），不要碰功能程式碼。
2. 不要新增套件或依賴。
3. 文件內容要正確反映現有程式行為，不要寫未實作的功能。
4. 保持文件風格一致。`,
  reportFormat: `完成後請回報：
1. 修改了哪些文件
2. 每份文件修改了什麼
3. 是否有描述與實際程式不符的地方
4. 建議後續補充的文件項目`,
};

const OTHER_TEMPLATE: PromptTemplate = {
  label: "一般任務",
  role: "你是資深 React + TypeScript 工程師，請協助我修改專案。",
  specificPrinciples: `請依照以下原則：
1. 優先做最小修改，不要大範圍重構。
2. 不要新增與需求無關的欄位或功能。
3. 如果發現需要修改其他檔案，請先說明原因。
4. 不要用 any 草率解決 TypeScript 問題。
5. 保留既有命名與程式風格。
6. 不要改動未列入需求的 UI 或 business logic。`,
  reportFormat: `完成後請回報：
1. 修改了哪些檔案
2. 每個檔案修改了什麼
3. 如何驗收
4. 有哪些風險
5. 如果還沒完成，下一步要做什麼`,
};

export const TEMPLATE_MAP: Record<TaskType, PromptTemplate> = {
  ui: UI_TEMPLATE,
  bug: BUG_TEMPLATE,
  typescript: TYPESCRIPT_TEMPLATE,
  refactor: REFACTOR_TEMPLATE,
  api: API_TEMPLATE,
  test: TEST_TEMPLATE,
  docs: DOCS_TEMPLATE,
  other: OTHER_TEMPLATE,
};
