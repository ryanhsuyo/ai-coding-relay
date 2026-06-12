import { describe, it, expect } from "vitest";
import {
  evaluateCeWorkGate,
  parseCeWorkResult,
  mergeCeWorkResult,
} from "../core/ceWork";
import type {
  AiEngineeringWorkflow,
  CeWorkSuccess,
  PlanAuditChecklist,
  Task,
} from "../shared/types";

/**
 * Phase 71：CE Work gate 判斷、runner 回傳解析（type guard）與合併測試。
 */

const FULL_CHECKLIST: PlanAuditChecklist = {
  coreAssumptionsReviewed: true,
  riskReviewed: true,
  scopeReviewed: true,
  acceptanceCriteriaReviewed: true,
  minimalChangeReviewed: true,
};

function makeTask(aiWorkflow?: AiEngineeringWorkflow): Task {
  return {
    id: "t1",
    title: "t",
    type: "bug",
    status: "todo",
    priority: "medium",
    originalRequirement: "r",
    targetFiles: [],
    forbiddenFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    tags: [],
    aiWorkflow,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("evaluateCeWorkGate", () => {
  it("plan rejected → 不可 work", () => {
    const gate = evaluateCeWorkGate(makeTask({ plan: { status: "rejected" }, audit: { checklist: FULL_CHECKLIST } }));
    expect(gate.canWork).toBe(false);
    expect(gate.reason).toContain("rejected");
  });

  it("no audit → 不可 work（即使 plan approved）", () => {
    const gate = evaluateCeWorkGate(makeTask({ plan: { status: "approved" } }));
    expect(gate.canWork).toBe(false);
    expect(gate.reason).toContain("Audit");
  });

  it("no aiWorkflow → 不可 work", () => {
    expect(evaluateCeWorkGate(makeTask(undefined)).canWork).toBe(false);
  });

  it("plan planned（非 approved/audited）→ 不可 work", () => {
    const gate = evaluateCeWorkGate(makeTask({ plan: { status: "planned" }, audit: { checklist: FULL_CHECKLIST } }));
    expect(gate.canWork).toBe(false);
  });

  it("checklist 5/5 + plan approved → 可 work", () => {
    const gate = evaluateCeWorkGate(makeTask({ plan: { status: "approved" }, audit: { checklist: FULL_CHECKLIST } }));
    expect(gate.canWork).toBe(true);
    expect(gate.reason).toBe("");
  });

  it("plan approved + audit 存在但 checklist 未全勾 → 仍可 work（approved 即通過）", () => {
    const gate = evaluateCeWorkGate(makeTask({ plan: { status: "approved" }, audit: { checklist: { ...FULL_CHECKLIST, riskReviewed: false } } }));
    expect(gate.canWork).toBe(true);
  });

  it("plan audited + checklist 5/5 → 可 work", () => {
    const gate = evaluateCeWorkGate(makeTask({ plan: { status: "audited" }, audit: { checklist: FULL_CHECKLIST } }));
    expect(gate.canWork).toBe(true);
  });

  it("plan audited + checklist 未全勾 → 不可 work", () => {
    const gate = evaluateCeWorkGate(makeTask({ plan: { status: "audited" }, audit: { checklist: { ...FULL_CHECKLIST, scopeReviewed: false } } }));
    expect(gate.canWork).toBe(false);
    expect(gate.reason).toContain("checklist");
  });
});

describe("parseCeWorkResult", () => {
  it("valid success：work / verification / git / ai 皆解析", () => {
    const raw = {
      ok: true,
      work: {
        changedFiles: ["src/App.tsx"],
        testCommands: ["pnpm test"],
        testResults: "",
        implementationSummary: "做了 X",
        notes: "備註",
        recommendedNextAction: "請進行 code review",
      },
      verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc", ok: true }] },
      git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 2 +-" },
      ai: { command: "claude", exitCode: 0 },
    };
    const result = parseCeWorkResult(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.work.changedFiles).toEqual(["src/App.tsx"]);
    expect(result.verification.ok).toBe(true);
    expect(result.verification.commands[0].name).toBe("tsc");
    expect(result.git.diffStat).toContain("src/App.tsx");
    expect(result.ai.exitCode).toBe(0);
  });

  it("valid failure：保留 stoppedReason / message / 診斷片段", () => {
    const result = parseCeWorkResult({ ok: false, stoppedReason: "verification_failed", message: "未通過", stdoutPreview: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("verification_failed");
    expect(result.message).toBe("未通過");
    expect(result.stdoutPreview).toBe("x");
  });

  it("work_gate_failed 保留", () => {
    const result = parseCeWorkResult({ ok: false, stoppedReason: "work_gate_failed", message: "gate" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("work_gate_failed");
  });

  it("未知 stoppedReason → runner_error", () => {
    const result = parseCeWorkResult({ ok: false, stoppedReason: "weird", message: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("runner_error");
  });

  it("invalid shape（非物件 / null / 缺 ok）→ 失敗", () => {
    expect(parseCeWorkResult(null).ok).toBe(false);
    expect(parseCeWorkResult("x").ok).toBe(false);
    expect(parseCeWorkResult([]).ok).toBe(false);
    expect(parseCeWorkResult({ work: {} }).ok).toBe(false);
  });

  it("success 但 work 髒資料 → 安全補預設、不 crash", () => {
    const result = parseCeWorkResult({ ok: true, work: { changedFiles: "not-array", testCommands: [1, "ok"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.work.changedFiles).toEqual([]);
    expect(result.work.testCommands).toEqual(["ok"]);
    expect(result.verification.commands).toEqual([]);
  });

  it("Phase 77C：verification_failed 保留 rawOutputPreview 與 parseAttempts", () => {
    const result = parseCeWorkResult({
      ok: false,
      stoppedReason: "verification_failed",
      message: "verification 輸出無法解析為合法 JSON",
      rawOutputPreview: "> verify:local\nnpm warn ... 雜訊輸出",
      parseAttempts: ["whole_stdout_failed", "no_code_fence", "no_verification_report"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("verification_failed");
    expect(result.rawOutputPreview).toBe("> verify:local\nnpm warn ... 雜訊輸出");
    expect(result.parseAttempts).toEqual([
      "whole_stdout_failed",
      "no_code_fence",
      "no_verification_report",
    ]);
  });

  it("Phase 77C：rawOutputPreview 超過 2000 字會被截斷；parseAttempts 非字串被丟棄", () => {
    const result = parseCeWorkResult({
      ok: false,
      stoppedReason: "verification_failed",
      message: "x",
      rawOutputPreview: "a".repeat(5000),
      parseAttempts: ["whole_stdout_failed", 1, null, "ok"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.rawOutputPreview?.length).toBe(2000);
    expect(result.parseAttempts).toEqual(["whole_stdout_failed", "ok"]);
  });

  it("Phase 77E：verification_failed 保留 stdoutLength（number）", () => {
    const result = parseCeWorkResult({
      ok: false,
      stoppedReason: "verification_failed",
      message: "verification 輸出無法解析為合法 JSON",
      rawOutputPreview: "head",
      stdoutLength: 123456,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stdoutLength).toBe(123456);
  });

  it("Phase 77E：stdoutLength 非 number（字串 / NaN / Infinity）一律丟棄", () => {
    const asFailure = (stdoutLength: unknown) => {
      const result = parseCeWorkResult({ ok: false, stoppedReason: "verification_failed", message: "x", stdoutLength });
      if (result.ok) throw new Error("應為失敗");
      return result;
    };
    expect(asFailure("123456").stdoutLength).toBeUndefined();
    expect(asFailure(Number.NaN).stdoutLength).toBeUndefined();
    expect(asFailure(Number.POSITIVE_INFINITY).stdoutLength).toBeUndefined();
    expect(asFailure(undefined).stdoutLength).toBeUndefined();
  });

  it("Phase 77C：verification_failed 失敗結果不回填 Work result（沒有 work / verification 欄位）", () => {
    const result = parseCeWorkResult({
      ok: false,
      stoppedReason: "verification_failed",
      message: "x",
      rawOutputPreview: "noise",
      // 即使 runner 不小心夾帶 work，失敗 union 也不得帶出。
      work: { changedFiles: ["src/App.tsx"] },
      verification: { ok: true, commands: [] },
    });
    expect(result.ok).toBe(false);
    expect((result as unknown as { work?: unknown }).work).toBeUndefined();
    expect((result as unknown as { verification?: unknown }).verification).toBeUndefined();
  });
});

describe("mergeCeWorkResult", () => {
  const existing: AiEngineeringWorkflow = {
    brainstorm: { path: "b.md", status: "reviewed" },
    plan: { path: "p.md", status: "approved" },
    audit: { notes: "audit", checklist: FULL_CHECKLIST },
    compound: { lessonLearned: "舊經驗" },
  };

  function successResult(over?: Partial<CeWorkSuccess>): CeWorkSuccess {
    return {
      ok: true,
      work: {
        changedFiles: ["src/New.tsx"],
        testCommands: ["pnpm test:run"],
        testResults: "",
        implementationSummary: "實作了新功能",
        notes: "",
        recommendedNextAction: "請進行 code review",
      },
      verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc --noEmit", ok: true }] },
      git: { statusShort: " M src/New.tsx", diffStat: " src/New.tsx | 5 +++++" },
      ai: { command: "claude", exitCode: 0 },
      ...over,
    };
  }

  it("更新 workReview（changedFiles / testCommands / testResults）", () => {
    const merged = mergeCeWorkResult(existing, successResult());
    expect(merged.workReview?.changedFiles).toEqual(["src/New.tsx"]);
    expect(merged.workReview?.testCommands).toEqual(["pnpm test:run"]);
    expect(merged.workReview?.testResults).toContain("本機驗證：通過");
    expect(merged.workReview?.testResults).toContain("實作了新功能");
    expect(merged.workReview?.testResults).toContain("git diff --stat");
    // codeReviewNotes 不自動填正式 review，最多填「待 Review」。
    expect(merged.workReview?.codeReviewNotes).toBe("待 Review");
  });

  it("changedFiles 空時由 git status 推導；testCommands 空時由 verification 推導", () => {
    const merged = mergeCeWorkResult(existing, successResult({
      work: { changedFiles: [], testCommands: [], testResults: "", implementationSummary: "", notes: "", recommendedNextAction: "" },
    }));
    expect(merged.workReview?.changedFiles).toEqual(["src/New.tsx"]);
    expect(merged.workReview?.testCommands).toEqual(["npx tsc --noEmit"]);
  });

  it("保留 brainstorm / plan / audit / compound", () => {
    const merged = mergeCeWorkResult(existing, successResult());
    expect(merged.brainstorm?.path).toBe("b.md");
    expect(merged.plan?.status).toBe("approved");
    expect(merged.audit?.notes).toBe("audit");
    expect(merged.compound?.lessonLearned).toBe("舊經驗");
  });

  it("保留既有 codeReviewNotes（不覆蓋成「待 Review」）", () => {
    const withReview: AiEngineeringWorkflow = { ...existing, workReview: { codeReviewNotes: "既有 review" } };
    const merged = mergeCeWorkResult(withReview, successResult());
    expect(merged.workReview?.codeReviewNotes).toBe("既有 review");
  });

  it("保留既有 commitHash / commitMessage", () => {
    const withCommit: AiEngineeringWorkflow = { ...existing, workReview: { commitHash: "abc123", commitMessage: "feat: x" } };
    const merged = mergeCeWorkResult(withCommit, successResult());
    expect(merged.workReview?.commitHash).toBe("abc123");
    expect(merged.workReview?.commitMessage).toBe("feat: x");
  });

  it("current 為 undefined 時只產生 workReview", () => {
    const merged = mergeCeWorkResult(undefined, successResult());
    expect(merged.workReview?.changedFiles).toEqual(["src/New.tsx"]);
    expect(merged.brainstorm).toBeUndefined();
    expect(merged.compound).toBeUndefined();
  });
});
