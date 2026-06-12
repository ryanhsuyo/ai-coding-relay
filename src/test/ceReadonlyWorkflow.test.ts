import { describe, it, expect } from "vitest";
import {
  parseCeReadonlyWorkflowResult,
  mergeCeReadonlyWorkflow,
} from "../core/ceReadonlyWorkflow";
import type { AiEngineeringWorkflow } from "../shared/types";

/**
 * Phase 70：CE Readonly Workflow 前端解析（type guard）與合併（保留 work/review/compound）測試。
 * 對應 runner /ce-readonly-workflow 的回傳：runner 不被信任，一律經 normalize 與白名單檢查。
 */

describe("parseCeReadonlyWorkflowResult", () => {
  it("ok=true：workflow 經 normalize，帶 canStartWork / recommendedNextAction / rawNotes / ai", () => {
    const raw = {
      ok: true,
      workflow: {
        brainstorm: { path: "docs/brainstorms/x.md", summary: "s", status: "reviewed" },
        plan: { path: "docs/plans/x.md", summary: "p", status: "approved" },
        audit: {
          notes: "n",
          coreAssumptions: ["a1"],
          riskNotes: ["r1"],
          acceptanceCriteria: ["ac1"],
          checklist: {
            coreAssumptionsReviewed: true,
            riskReviewed: true,
            scopeReviewed: true,
            acceptanceCriteriaReviewed: true,
            minimalChangeReviewed: true,
          },
        },
      },
      canStartWork: true,
      recommendedNextAction: "可進入 Work",
      rawNotes: "原始筆記",
      ai: { command: "claude", exitCode: 0 },
    };
    const result = parseCeReadonlyWorkflowResult(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.workflow.brainstorm?.status).toBe("reviewed");
    expect(result.workflow.plan?.status).toBe("approved");
    expect(result.workflow.audit?.coreAssumptions).toEqual(["a1"]);
    expect(result.canStartWork).toBe(true);
    expect(result.recommendedNextAction).toBe("可進入 Work");
    expect(result.rawNotes).toBe("原始筆記");
    expect(result.ai.command).toBe("claude");
    expect(result.ai.exitCode).toBe(0);
  });

  it("ok=true：髒 workflow 不 crash（非白名單 status 丟棄、非陣列欄位丟棄）", () => {
    const raw = {
      ok: true,
      workflow: {
        brainstorm: { status: "garbage", summary: 123 },
        plan: { status: "rejected" },
        audit: { coreAssumptions: "not-array" },
      },
      canStartWork: false,
    };
    const result = parseCeReadonlyWorkflowResult(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    // garbage status 被丟棄 → brainstorm 變空 → compact 後 undefined
    expect(result.workflow.brainstorm).toBeUndefined();
    expect(result.workflow.plan?.status).toBe("rejected");
    expect(result.workflow.audit?.coreAssumptions).toBeUndefined();
    expect(result.canStartWork).toBe(false);
  });

  it("ok=true 但 canStartWork 非 true → 視為 false（不信任 runner）", () => {
    const result = parseCeReadonlyWorkflowResult({ ok: true, workflow: {}, canStartWork: "yes" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.canStartWork).toBe(false);
  });

  it("ok=false：保留 stoppedReason / message 與診斷片段", () => {
    const raw = {
      ok: false,
      stoppedReason: "invalid_json",
      message: "解析失敗",
      stdoutPreview: "head",
      stdoutTail: "tail",
      stderrPreview: "errhead",
      stderrTail: "errtail",
    };
    const result = parseCeReadonlyWorkflowResult(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("invalid_json");
    expect(result.message).toBe("解析失敗");
    expect(result.stdoutPreview).toBe("head");
    expect(result.stderrTail).toBe("errtail");
  });

  it("未知 stoppedReason → 一律 runner_error", () => {
    const result = parseCeReadonlyWorkflowResult({ ok: false, stoppedReason: "weird", message: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("runner_error");
  });

  it("Phase 77A：readonly_violation 被視為合法白名單值，並保留 before / after 快照", () => {
    const raw = {
      ok: false,
      stoppedReason: "readonly_violation",
      message: "CE Readonly Workflow modified target project files.",
      before: { statusShort: "", diffStat: "", nameStatus: "" },
      after: {
        statusShort: " M docs/harness-architecture.md",
        diffStat: " docs/harness-architecture.md | 4 ++++",
        nameStatus: "M\tdocs/harness-architecture.md",
      },
    };
    const result = parseCeReadonlyWorkflowResult(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("readonly_violation");
    expect(result.before?.statusShort).toBe("");
    expect(result.after?.statusShort).toBe(" M docs/harness-architecture.md");
    expect(result.after?.nameStatus).toContain("docs/harness-architecture.md");
  });

  it("Phase 77A：readonly_violation 不回傳 workflow（失敗結果沒有 workflow 欄位）", () => {
    const result = parseCeReadonlyWorkflowResult({
      ok: false,
      stoppedReason: "readonly_violation",
      message: "modified",
      workflow: { plan: { status: "approved" } },
      after: { statusShort: " M x", diffStat: "", nameStatus: "" },
    });
    expect(result.ok).toBe(false);
    // 失敗 union 沒有 workflow；以防萬一也確認沒有被帶出來。
    expect((result as unknown as { workflow?: unknown }).workflow).toBeUndefined();
  });

  it("Phase 77A：readonly_violation 帶髒 / 缺 snapshot 不 crash（補空字串）", () => {
    const result = parseCeReadonlyWorkflowResult({
      ok: false,
      stoppedReason: "readonly_violation",
      message: "modified",
      before: "not-an-object",
      after: { statusShort: 123 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.before?.statusShort).toBe("");
    expect(result.after?.statusShort).toBe("");
    expect(result.after?.diffStat).toBe("");
  });

  it("非物件 / null → 失敗 runner_error", () => {
    expect(parseCeReadonlyWorkflowResult(null).ok).toBe(false);
    expect(parseCeReadonlyWorkflowResult("oops").ok).toBe(false);
    const arr = parseCeReadonlyWorkflowResult([]);
    expect(arr.ok).toBe(false);
    if (arr.ok) throw new Error("應為失敗");
    expect(arr.stoppedReason).toBe("runner_error");
  });

  it("ok 缺失（undefined）→ 視為失敗", () => {
    const result = parseCeReadonlyWorkflowResult({ workflow: {} });
    expect(result.ok).toBe(false);
  });

  it("Phase 77B：invalid_json 保留 rawOutputPreview 與 parseAttempts", () => {
    const result = parseCeReadonlyWorkflowResult({
      ok: false,
      stoppedReason: "invalid_json",
      message: "Claude CLI 的輸出無法解析為合法 JSON 結果",
      rawOutputPreview: "這是 Claude 的雜訊輸出，不是合法 JSON",
      parseAttempts: ["whole_stdout_failed", "no_code_fence", "object_scan_no_valid_result"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("invalid_json");
    expect(result.rawOutputPreview).toBe("這是 Claude 的雜訊輸出，不是合法 JSON");
    expect(result.parseAttempts).toEqual([
      "whole_stdout_failed",
      "no_code_fence",
      "object_scan_no_valid_result",
    ]);
  });

  it("Phase 77B：rawOutputPreview 超過 2000 字會被截斷；parseAttempts 非字串被丟棄", () => {
    const result = parseCeReadonlyWorkflowResult({
      ok: false,
      stoppedReason: "invalid_json",
      message: "x",
      rawOutputPreview: "a".repeat(5000),
      parseAttempts: ["whole_stdout_failed", 123, null, "ok"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.rawOutputPreview?.length).toBe(2000);
    expect(result.parseAttempts).toEqual(["whole_stdout_failed", "ok"]);
  });

  it("Phase 77B：invalid_json 失敗結果不含 workflow（不回填 brainstorm/plan/audit）", () => {
    const result = parseCeReadonlyWorkflowResult({
      ok: false,
      stoppedReason: "invalid_json",
      message: "x",
      rawOutputPreview: "noise",
      // 即使 runner 不小心夾帶 workflow，失敗 union 也不得帶出。
      workflow: { plan: { status: "approved" } },
    });
    expect(result.ok).toBe(false);
    expect((result as unknown as { workflow?: unknown }).workflow).toBeUndefined();
  });
});

describe("mergeCeReadonlyWorkflow", () => {
  const existing: AiEngineeringWorkflow = {
    brainstorm: { path: "old/brainstorm.md", status: "drafted" },
    plan: { path: "old/plan.md", status: "planned" },
    audit: { notes: "old audit" },
    workReview: { changedFiles: ["src/Old.tsx"], testResults: "old pass" },
    compound: { lessonLearned: "舊的經驗" },
  };

  const incoming: AiEngineeringWorkflow = {
    brainstorm: { path: "new/brainstorm.md", status: "reviewed" },
    plan: { path: "new/plan.md", status: "approved" },
    audit: { notes: "new audit", riskNotes: ["風險"] },
  };

  it("更新 brainstorm / plan / audit", () => {
    const merged = mergeCeReadonlyWorkflow(existing, incoming);
    expect(merged.brainstorm?.path).toBe("new/brainstorm.md");
    expect(merged.brainstorm?.status).toBe("reviewed");
    expect(merged.plan?.status).toBe("approved");
    expect(merged.audit?.notes).toBe("new audit");
    expect(merged.audit?.riskNotes).toEqual(["風險"]);
  });

  it("保留既有 workReview / compound（Work / Review / Compound 不被清掉）", () => {
    const merged = mergeCeReadonlyWorkflow(existing, incoming);
    expect(merged.workReview?.changedFiles).toEqual(["src/Old.tsx"]);
    expect(merged.workReview?.testResults).toBe("old pass");
    expect(merged.compound?.lessonLearned).toBe("舊的經驗");
  });

  it("current 為 undefined 時只帶入 incoming 三段，不產生 workReview / compound", () => {
    const merged = mergeCeReadonlyWorkflow(undefined, incoming);
    expect(merged.brainstorm?.path).toBe("new/brainstorm.md");
    expect(merged.workReview).toBeUndefined();
    expect(merged.compound).toBeUndefined();
  });

  it("incoming 缺某段時保留既有那段（不覆蓋成 undefined）", () => {
    const partial: AiEngineeringWorkflow = { plan: { status: "rejected" } };
    const merged = mergeCeReadonlyWorkflow(existing, partial);
    // plan 被更新
    expect(merged.plan?.status).toBe("rejected");
    // brainstorm / audit incoming 沒有 → 保留既有
    expect(merged.brainstorm?.path).toBe("old/brainstorm.md");
    expect(merged.audit?.notes).toBe("old audit");
    // work/review/compound 仍保留
    expect(merged.workReview?.testResults).toBe("old pass");
  });
});
