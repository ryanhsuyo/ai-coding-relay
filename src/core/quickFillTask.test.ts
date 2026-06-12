import { describe, it, expect } from "vitest";
import {
  deriveTitle,
  deriveTargetFiles,
  deriveConstraints,
  deriveAcceptanceCriteria,
  quickFillTaskFields,
  QUICK_FILL_FORBIDDEN_FILES,
} from "./quickFillTask";

const SAMPLE_REQUIREMENT = `請在 docs/harness-architecture.md 補充一小段「測試小節」。
1. run loop 實作應保持 TypeScript 檢查通過。
2. 每個 phase 應有最小測試保護。
3. verification JSON 是 auto-round 回灌的重要依據。`;

describe("deriveTitle", () => {
  it("從『補充 XXX』句子推導 title", () => {
    const title = deriveTitle(SAMPLE_REQUIREMENT);
    expect(title.length).toBeGreaterThan(0);
    expect(title.startsWith("補充")).toBe(true);
    expect(title).not.toContain("「");
  });

  it("從『新增 XXX』句子推導 title", () => {
    expect(deriveTitle("請新增一個說明段落")).toContain("新增");
  });

  it("無法推導時使用預設 title", () => {
    expect(deriveTitle("這是一段沒有關鍵字的需求")).toBe("文件小改 auto-round 任務");
  });
});

describe("deriveTargetFiles", () => {
  it("抓出 docs/xxx.md 相對路徑", () => {
    expect(deriveTargetFiles(SAMPLE_REQUIREMENT)).toEqual(["docs/harness-architecture.md"]);
  });

  it("支援 README.md 與 *.txt", () => {
    expect(deriveTargetFiles("請更新 README.md 與 notes.txt")).toEqual(["README.md", "notes.txt"]);
  });

  it("抓不到時回傳空陣列（不亂猜）", () => {
    expect(deriveTargetFiles("請補充說明，但沒有指定檔案")).toEqual([]);
  });

  it("不會把 projectPath 填進 targetFiles", () => {
    const req = "請在 docs/harness-architecture.md 補充內容";
    const files = deriveTargetFiles(req, "/Users/ryan/Desktop/code/harness");
    expect(files).toEqual(["docs/harness-architecture.md"]);
    expect(files).not.toContain("/Users/ryan/Desktop/code/harness");
  });

  it("略過絕對路徑", () => {
    expect(deriveTargetFiles("見 /Users/ryan/docs/a.md")).toEqual([]);
  });

  it("去除重複路徑", () => {
    expect(deriveTargetFiles("docs/a.md 與 docs/a.md")).toEqual(["docs/a.md"]);
  });
});

describe("deriveConstraints", () => {
  it("有 targetFiles 時第一條鎖定該檔案", () => {
    expect(deriveConstraints(["docs/harness-architecture.md"])[0]).toBe(
      "只修改 docs/harness-architecture.md。"
    );
  });

  it("無 targetFiles 時第一條為通則", () => {
    expect(deriveConstraints([])[0]).toBe("只修改 targetFiles 列出的文件。");
  });
});

describe("deriveAcceptanceCriteria", () => {
  it("有條列時逐條轉成 AC 並附加固定結尾", () => {
    const ac = deriveAcceptanceCriteria(SAMPLE_REQUIREMENT, ["docs/harness-architecture.md"]);
    expect(ac[0]).toContain("docs/harness-architecture.md");
    expect(ac.some((line) => line.includes("run loop 實作應保持 TypeScript 檢查通過"))).toBe(true);
    expect(ac.some((line) => line.includes("每個 phase 應有最小測試保護"))).toBe(true);
    expect(ac[ac.length - 1]).toBe("npm run verify:local 通過。");
  });

  it("抓不到條列時回傳最小集合", () => {
    const ac = deriveAcceptanceCriteria("請補充說明", []);
    expect(ac[0]).toBe("指定文件已完成補充或修改。");
    expect(ac).toContain("npm run verify:local 通過。");
  });
});

describe("quickFillTaskFields（docs_auto_round）", () => {
  it("從原始需求自動填入完整欄位", () => {
    const result = quickFillTaskFields({
      originalRequirement: SAMPLE_REQUIREMENT,
      projectPath: "/Users/ryan/Desktop/code/harness",
      currentTitle: "",
      template: "docs_auto_round",
    });

    expect(result.title?.length).toBeGreaterThan(0);
    expect(result.type).toBe("docs");
    expect(result.workflowStage).toBe("green_implement");
    expect(result.reviewResult).toBe("not_reviewed");
    expect(result.targetFilesText).toBe("docs/harness-architecture.md");

    for (const forbidden of QUICK_FILL_FORBIDDEN_FILES) {
      expect(result.forbiddenFilesText).toContain(forbidden);
    }

    expect(result.constraintsText).toContain("只修改 docs/harness-architecture.md。");
    expect(result.acceptanceCriteriaText).toContain("npm run verify:local 通過。");
  });

  it("title 已有內容時不覆蓋", () => {
    const result = quickFillTaskFields({
      originalRequirement: SAMPLE_REQUIREMENT,
      currentTitle: "我自己的標題",
      template: "docs_auto_round",
    });
    expect(result.title).toBeUndefined();
  });

  it("不會把 projectPath 填進 targetFiles，也不輸出 projectPath", () => {
    const result = quickFillTaskFields({
      originalRequirement: "請在 docs/harness-architecture.md 補充內容",
      projectPath: "/Users/ryan/Desktop/code/harness",
      currentTitle: "",
      template: "docs_auto_round",
    });
    expect(result.targetFilesText).toBe("docs/harness-architecture.md");
    expect(result.targetFilesText).not.toContain("/Users/ryan");
    expect("projectPath" in result).toBe(false);
  });

  it("抓不到檔案時 targetFiles 留空（不亂猜）", () => {
    const result = quickFillTaskFields({
      originalRequirement: "請補充一段說明文字",
      currentTitle: "",
      template: "docs_auto_round",
    });
    expect(result.targetFilesText).toBe("");
  });
});

describe("quickFillTaskFields（非 docs 模板）", () => {
  it("僅推導 title / targetFiles，不覆蓋 type / workflowStage / 限制條件", () => {
    const result = quickFillTaskFields({
      originalRequirement: "請補充 docs/a.md 的內容",
      currentTitle: "",
      template: "other",
    });
    expect(result.title?.length).toBeGreaterThan(0);
    expect(result.targetFilesText).toBe("docs/a.md");
    expect(result.type).toBeUndefined();
    expect(result.workflowStage).toBeUndefined();
    expect(result.forbiddenFilesText).toBeUndefined();
    expect(result.constraintsText).toBeUndefined();
    expect(result.acceptanceCriteriaText).toBeUndefined();
  });
});
