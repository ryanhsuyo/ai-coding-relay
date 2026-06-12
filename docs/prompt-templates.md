# AI Coding Relay Prompt Templates

這份文件用來保存 AI Coding Relay 會使用的 prompt 模板。

第一階段先做兩個核心模板：

1. Claude Code Prompt
2. GPT Review Prompt

之後再慢慢擴充不同任務類型的模板。

---

## 1. Claude Code Prompt Template

用途：

讓使用者把任務需求整理成可以直接貼給 Claude Code 的 prompt。

---

```txt
你是資深 React + TypeScript 工程師，請協助我修改專案。

任務：
{{requirement}}

任務類型：
{{taskType}}

請只修改以下檔案：
{{targetFiles}}

請不要修改以下檔案或範圍：
{{forbiddenFiles}}

限制條件：
{{constraints}}

驗收條件：
{{acceptanceCriteria}}

請依照以下原則：
1. 優先做最小修改，不要大範圍重構。
2. 不要新增與需求無關的欄位或功能。
3. 如果發現需要修改其他檔案，請先說明原因。
4. 不要用 any 草率解決 TypeScript 問題。
5. 保留既有命名與程式風格。
6. 不要改動未列入需求的 UI 或 business logic。

完成後請回報：
1. 修改了哪些檔案
2. 每個檔案修改了什麼
3. 如何驗收
4. 有哪些風險
5. 如果還沒完成，下一步要做什麼
```

---

## 2. GPT Review Prompt Template

用途：

Claude Code 修改完後，使用者把 Claude 回覆、git diff、build log 貼回來，讓 GPT 幫忙審查是否符合原始需求。

第一階段 git status、git diff、command result 可以先留空。

---

```txt
請幫我審查這次 Claude Code 的修改是否符合需求。

原始需求：
{{requirement}}

允許修改檔案：
{{targetFiles}}

禁止修改範圍：
{{forbiddenFiles}}

限制條件：
{{constraints}}

驗收條件：
{{acceptanceCriteria}}

Claude 回覆：
{{claudeResponse}}

git status：
{{gitStatus}}

git diff：
{{gitDiff}}

command result：
{{commandLogs}}

請用以下格式回答：

1. 是否符合原始需求
2. 已完成項目
3. 可能漏掉的項目
4. 是否有改到不該改的地方
5. TypeScript / React / UI 風險
6. 建議驗收 checklist
7. 下一輪要給 Claude Code 的 prompt
```

---

## 3. UI 修改模板

適用情境：

- 畫面排版
- 表單欄位
- modal
- tab
- list
- button
- Chakra UI / Tailwind UI 調整

---

```txt
請協助我修改 UI。

需求：
{{requirement}}

請只修改以下檔案：
{{targetFiles}}

請不要修改以下範圍：
{{forbiddenFiles}}

限制條件：
{{constraints}}

請注意：
1. 優先維持既有 UI 風格。
2. 不要改動 business logic。
3. 不要新增需求外的欄位。
4. 不要大範圍重構。
5. 若有 layout 調整，請保持畫面可讀性。
6. 若需要修改共用元件，請先說明原因。

完成後請回報：
1. 修改了哪些 UI
2. 修改了哪些檔案
3. 如何驗收畫面
4. 有沒有可能影響其他頁面
```

---

## 4. TypeScript Error 模板

適用情境：

- TS2322
- Cannot find module
- props 不存在
- type mismatch
- function 參數型別錯誤
- Zustand / React Query / component props 型別問題

---

```txt
請協助我修正 TypeScript 錯誤。

錯誤訊息：
{{errorMessage}}

相關檔案：
{{targetFiles}}

限制條件：
{{constraints}}

請注意：
1. 不要用 any 草率解決問題。
2. 不要用 as unknown as 硬轉，除非有充分理由。
3. 優先修正正確的型別定義。
4. 如果是 props 問題，請檢查呼叫端與 component 定義是否一致。
5. 如果是 import 問題，請檢查檔案路徑與 tsconfig alias。
6. 不要重構無關程式碼。

完成後請回報：
1. 錯誤原因
2. 修改了哪些檔案
3. 如何驗證錯誤已修正
4. 有沒有其他潛在型別風險
```

---

## 5. Bug Investigation 模板

適用情境：

- 功能卡住
- 流程不符合預期
- API 回傳異常
- button 沒反應
- 狀態沒有更新
- build 可以過，但行為錯誤

---

```txt
請先協助我調查 bug 原因，不要直接大改。

問題描述：
{{requirement}}

相關檔案：
{{targetFiles}}

限制條件：
{{constraints}}

請先做：
1. 找出可能原因。
2. 列出最可能出問題的檔案與函式。
3. 說明資料流或狀態流。
4. 提出最小修改方案。
5. 不要修改無關功能。

如果你確認需要修改，請只做最小必要修改。

完成後請回報：
1. 根本原因
2. 修改了哪些檔案
3. 修改內容
4. 如何驗收
5. 是否有其他風險
```

---

## 6. Refactor 模板

適用情境：

- 拆 component
- 拆 hook
- 抽 utils
- 減少 useEffect
- 改善可讀性
- 移除重複邏輯

---

```txt
請協助我重構這段程式，但不要改變既有行為。

重構目標：
{{requirement}}

目標檔案：
{{targetFiles}}

限制條件：
{{constraints}}

請遵守：
1. 不要改變既有功能行為。
2. 不要新增需求外功能。
3. 優先小步重構。
4. 若要拆檔，請說明拆分理由。
5. 保留既有命名風格。
6. 不要用 any 放寬型別。

完成後請回報：
1. 重構前的問題
2. 重構後的結構
3. 修改了哪些檔案
4. 如何確認行為沒有改變
5. 下一步是否還有可拆分項目
```

---

## 7. Claude 修錯模板

適用情境：

Claude 上一輪修改不符合需求，需要修正方向。

---

```txt
你上一輪修改有部分不符合需求，請只針對以下問題修正。

原始需求：
{{requirement}}

上一輪問題：
{{problem}}

請只修改以下檔案：
{{targetFiles}}

請不要修改以下範圍：
{{forbiddenFiles}}

修正要求：
{{constraints}}

請注意：
1. 不要重寫整個功能。
2. 不要重構無關區塊。
3. 不要改動已經正確的部分。
4. 只針對這次指出的問題做最小修正。
5. 如果需要改其他檔案，請先說明原因。

完成後請回報：
1. 修正了什麼問題
2. 修改了哪些檔案
3. 如何驗收
4. 是否還有未處理項目
```

---

## 8. API 串接模板

適用情境：

- 新增 API service
- 修改 request / response type
- 接 React Query
- 接 Zustand store
- 調整錯誤處理

---

```txt
請協助我處理 API 串接。

需求：
{{requirement}}

相關檔案：
{{targetFiles}}

限制條件：
{{constraints}}

請注意：
1. request / response 型別要明確。
2. 不要用 any。
3. API service 與 UI 邏輯要分離。
4. 錯誤處理要保守，不要讓頁面 crash。
5. 不要修改無關 API。
6. 如果需要新增 type，請放在合適位置。

完成後請回報：
1. 新增或修改了哪些 API
2. request / response 型別是什麼
3. UI 如何使用
4. 錯誤如何處理
5. 如何驗收
```

---

## 9. Test / 驗收模板

適用情境：

- 補測試
- 跑 build
- 跑 lint
- 驗收 Claude 修改是否完成
- 產生 checklist

---

```txt
請協助我驗收這次修改。

原始需求：
{{requirement}}

Claude 回覆：
{{claudeResponse}}

git diff：
{{gitDiff}}

command result：
{{commandLogs}}

請幫我產生：
1. 功能是否完成
2. 需要手動驗收的項目
3. 需要自動測試的項目
4. 可能的 regression 風險
5. 如果沒有完成，下一步 Claude Prompt 應該怎麼寫
```

---

## 10. 模板擴充原則

未來新增模板時，請遵守：

```txt
1. 每個模板只處理一種任務類型。
2. 模板要有明確適用情境。
3. 模板要包含限制條件。
4. 模板要要求 AI 回報修改檔案與驗收方式。
5. 模板不要鼓勵大範圍重構。
6. 模板不要允許 AI 任意修改未指定檔案。
7. 模板不要要求 AI 執行危險 command。
```