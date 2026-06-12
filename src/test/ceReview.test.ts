import { describe, it, expect } from "vitest";
import {
  evaluateCeReviewGate,
  parseCeReviewResult,
  buildCeReviewNotes,
  mergeCeReviewResult,
} from "../core/ceReview";
import type {
  AiEngineeringWorkflow,
  CeReviewDetail,
  CeReviewSuccess,
  Task,
} from "../shared/types";

/**
 * Phase 72：CE Review gate 判斷、runner 回傳解析（type guard）、codeReviewNotes 格式化與合併測試。
 */

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

describe("evaluateCeReviewGate", () => {
  it("no workReview → 不可 review", () => {
    expect(evaluateCeReviewGate(makeTask(undefined)).canReview).toBe(false);
    expect(evaluateCeReviewGate(makeTask({ plan: { status: "approved" } })).canReview).toBe(false);
  });

  it("workReview 空（無 changedFiles / testResults）→ 不可 review", () => {
    const gate = evaluateCeReviewGate(makeTask({ workReview: { codeReviewNotes: "x" } }));
    expect(gate.canReview).toBe(false);
    expect(gate.reason).toContain("Work");
  });

  it("changedFiles 有值 → 可 review", () => {
    expect(evaluateCeReviewGate(makeTask({ workReview: { changedFiles: ["src/App.tsx"] } })).canReview).toBe(true);
  });

  it("testResults 有值 → 可 review", () => {
    expect(evaluateCeReviewGate(makeTask({ workReview: { testResults: "本機驗證：通過" } })).canReview).toBe(true);
  });

  it("changedFiles 全空白字串 → 不可 review", () => {
    expect(evaluateCeReviewGate(makeTask({ workReview: { changedFiles: ["", "  "] } })).canReview).toBe(false);
  });
});

describe("parseCeReviewResult", () => {
  it("valid success：review / git / ai 皆解析", () => {
    const raw = {
      ok: true,
      review: {
        result: "passed",
        notes: "看起來不錯",
        issues: ["i1"],
        testGaps: ["t1"],
        riskNotes: ["r1"],
        recommendedFixes: ["f1"],
        recommendedNextAction: "可標記完成",
      },
      git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 2 +-" },
      ai: { command: "claude", exitCode: 0 },
    };
    const result = parseCeReviewResult(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.review.result).toBe("passed");
    expect(result.review.issues).toEqual(["i1"]);
    expect(result.git.diffStat).toContain("src/App.tsx");
    expect(result.ai.exitCode).toBe(0);
  });

  it("result 非 passed/needs_fix → 視為 needs_fix（保守）", () => {
    const result = parseCeReviewResult({ ok: true, review: { result: "maybe" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.review.result).toBe("needs_fix");
  });

  it("valid failure：保留 stoppedReason / message / 診斷片段", () => {
    const result = parseCeReviewResult({ ok: false, stoppedReason: "review_blocked", message: "無法 review", stderrPreview: "e" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("review_blocked");
    expect(result.message).toBe("無法 review");
    expect(result.stderrPreview).toBe("e");
  });

  it("review_gate_failed 保留；未知 stoppedReason → runner_error", () => {
    expect((parseCeReviewResult({ ok: false, stoppedReason: "review_gate_failed", message: "x" }) as { stoppedReason: string }).stoppedReason).toBe("review_gate_failed");
    expect((parseCeReviewResult({ ok: false, stoppedReason: "weird", message: "x" }) as { stoppedReason: string }).stoppedReason).toBe("runner_error");
  });

  it("invalid shape（非物件 / null / 缺 ok）→ 失敗", () => {
    expect(parseCeReviewResult(null).ok).toBe(false);
    expect(parseCeReviewResult("x").ok).toBe(false);
    expect(parseCeReviewResult([]).ok).toBe(false);
    expect(parseCeReviewResult({ review: {} }).ok).toBe(false);
  });

  it("success 但 review 髒資料 → 安全補預設", () => {
    const result = parseCeReviewResult({ ok: true, review: { issues: "not-array", testGaps: [1, "ok"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.review.issues).toEqual([]);
    expect(result.review.testGaps).toEqual(["ok"]);
    expect(result.review.result).toBe("needs_fix");
  });
});

describe("buildCeReviewNotes", () => {
  const base: CeReviewDetail = {
    result: "passed",
    notes: "",
    issues: [],
    testGaps: [],
    riskNotes: [],
    recommendedFixes: [],
    recommendedNextAction: "",
  };

  it("passed 包含 Review result: passed", () => {
    expect(buildCeReviewNotes({ ...base, result: "passed" })).toContain("Review result: passed");
  });

  it("needs_fix 包含 Review result: needs_fix", () => {
    expect(buildCeReviewNotes({ ...base, result: "needs_fix" })).toContain("Review result: needs_fix");
  });

  it("issues / testGaps / recommendedFixes 正確列出", () => {
    const notes = buildCeReviewNotes({
      ...base,
      notes: "整體 OK",
      issues: ["問題一", "問題二"],
      testGaps: ["缺測試 A"],
      riskNotes: ["風險 X"],
      recommendedFixes: ["修正 1"],
      recommendedNextAction: "請補測試",
    });
    expect(notes).toContain("Notes:\n整體 OK");
    expect(notes).toContain("Issues:\n- 問題一\n- 問題二");
    expect(notes).toContain("Test gaps:\n- 缺測試 A");
    expect(notes).toContain("Risks:\n- 風險 X");
    expect(notes).toContain("Recommended fixes:\n- 修正 1");
    expect(notes).toContain("Recommended next action:\n請補測試");
  });

  it("空段落不列出（只剩 Review result）", () => {
    const notes = buildCeReviewNotes(base);
    expect(notes).toBe("Review result: passed");
    expect(notes).not.toContain("Issues");
    expect(notes).not.toContain("Notes:");
  });
});

describe("mergeCeReviewResult", () => {
  const existing: AiEngineeringWorkflow = {
    brainstorm: { path: "b.md", status: "reviewed" },
    plan: { path: "p.md", status: "approved" },
    audit: { notes: "audit" },
    workReview: {
      changedFiles: ["src/App.tsx"],
      testCommands: ["pnpm test:run"],
      testResults: "本機驗證：通過",
      commitHash: "abc123",
      commitMessage: "feat: x",
    },
    compound: { lessonLearned: "經驗" },
  };

  function reviewSuccess(over?: Partial<CeReviewDetail>): CeReviewSuccess {
    return {
      ok: true,
      review: {
        result: "needs_fix",
        notes: "需補測試",
        issues: ["問題一"],
        testGaps: ["缺 A"],
        riskNotes: [],
        recommendedFixes: ["修 1"],
        recommendedNextAction: "請修正",
        ...over,
      },
      git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 2 +-" },
      ai: { command: "claude", exitCode: 0 },
    };
  }

  it("更新 codeReviewNotes（含 Review result）", () => {
    const merged = mergeCeReviewResult(existing, reviewSuccess());
    expect(merged.workReview?.codeReviewNotes).toContain("Review result: needs_fix");
    expect(merged.workReview?.codeReviewNotes).toContain("問題一");
  });

  it("保留 changedFiles / testCommands / testResults / commitHash / commitMessage", () => {
    const merged = mergeCeReviewResult(existing, reviewSuccess());
    expect(merged.workReview?.changedFiles).toEqual(["src/App.tsx"]);
    expect(merged.workReview?.testCommands).toEqual(["pnpm test:run"]);
    expect(merged.workReview?.testResults).toBe("本機驗證：通過");
    expect(merged.workReview?.commitHash).toBe("abc123");
    expect(merged.workReview?.commitMessage).toBe("feat: x");
  });

  it("保留 brainstorm / plan / audit / compound", () => {
    const merged = mergeCeReviewResult(existing, reviewSuccess());
    expect(merged.brainstorm?.path).toBe("b.md");
    expect(merged.plan?.status).toBe("approved");
    expect(merged.audit?.notes).toBe("audit");
    expect(merged.compound?.lessonLearned).toBe("經驗");
  });

  it("current 為 undefined 時只產生 workReview.codeReviewNotes", () => {
    const merged = mergeCeReviewResult(undefined, reviewSuccess({ result: "passed" }));
    expect(merged.workReview?.codeReviewNotes).toContain("Review result: passed");
    expect(merged.workReview?.changedFiles).toBeUndefined();
    expect(merged.brainstorm).toBeUndefined();
  });
});
