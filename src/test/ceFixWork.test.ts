import { describe, it, expect } from "vitest";
import {
  evaluateCeFixWorkGate,
  parseCeFixWorkResult,
  mergeCeFixWorkResult,
} from "../core/ceFixWork";
import type {
  AiEngineeringWorkflow,
  CeFixWorkSuccess,
  Task,
} from "../shared/types";

/**
 * Phase 73B：CE Fix Work gate 判斷、runner 回傳解析（type guard）與合併測試。
 */

function makeTask(workReview?: AiEngineeringWorkflow["workReview"]): Task {
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
    aiWorkflow: workReview ? { workReview } : undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const NEEDS_FIX = "Review result: needs_fix\n\nRecommended fixes:\n- 補測試";
const PASSED = "Review result: passed";

describe("evaluateCeFixWorkGate", () => {
  it("no codeReviewNotes → 不可 fix", () => {
    expect(evaluateCeFixWorkGate(makeTask({ changedFiles: ["src/App.tsx"] })).canFix).toBe(false);
    expect(evaluateCeFixWorkGate(makeTask(undefined)).canFix).toBe(false);
  });

  it("Review result: passed → 不可 fix", () => {
    const gate = evaluateCeFixWorkGate(makeTask({ changedFiles: ["src/App.tsx"], codeReviewNotes: PASSED }));
    expect(gate.canFix).toBe(false);
    expect(gate.reason).toContain("needs_fix");
  });

  it("needs_fix 但無 Work 結果 → 不可 fix", () => {
    const gate = evaluateCeFixWorkGate(makeTask({ codeReviewNotes: NEEDS_FIX }));
    expect(gate.canFix).toBe(false);
    expect(gate.reason).toContain("Work");
  });

  it("needs_fix 且 changedFiles 有值 → 可 fix", () => {
    expect(evaluateCeFixWorkGate(makeTask({ codeReviewNotes: NEEDS_FIX, changedFiles: ["src/App.tsx"] })).canFix).toBe(true);
  });

  it("needs_fix 且 testResults 有值 → 可 fix", () => {
    expect(evaluateCeFixWorkGate(makeTask({ codeReviewNotes: NEEDS_FIX, testResults: "本機驗證：通過" })).canFix).toBe(true);
  });
});

describe("parseCeFixWorkResult", () => {
  it("valid success：fix / verification / git / ai 皆解析", () => {
    const raw = {
      ok: true,
      fix: { changedFiles: ["src/App.tsx"], testCommands: ["pnpm test"], fixSummary: "補了測試", notes: "", recommendedNextAction: "請再次執行 CE Review" },
      verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc", ok: true }] },
      git: { statusShort: " M src/App.tsx", diffStat: " src/App.tsx | 2 +-" },
      ai: { command: "claude", exitCode: 0 },
    };
    const result = parseCeFixWorkResult(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.fix.changedFiles).toEqual(["src/App.tsx"]);
    expect(result.fix.fixSummary).toBe("補了測試");
    expect(result.verification.ok).toBe(true);
    expect(result.git.diffStat).toContain("src/App.tsx");
    expect(result.ai.exitCode).toBe(0);
  });

  it("valid failure：保留 stoppedReason / message / 診斷片段", () => {
    const result = parseCeFixWorkResult({ ok: false, stoppedReason: "fix_blocked", message: "無法修正", stdoutPreview: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("fix_blocked");
    expect(result.message).toBe("無法修正");
    expect(result.stdoutPreview).toBe("x");
  });

  it("fix_gate_failed / verification_failed 保留；未知 → runner_error", () => {
    expect((parseCeFixWorkResult({ ok: false, stoppedReason: "fix_gate_failed", message: "x" }) as { stoppedReason: string }).stoppedReason).toBe("fix_gate_failed");
    expect((parseCeFixWorkResult({ ok: false, stoppedReason: "verification_failed", message: "x" }) as { stoppedReason: string }).stoppedReason).toBe("verification_failed");
    expect((parseCeFixWorkResult({ ok: false, stoppedReason: "weird", message: "x" }) as { stoppedReason: string }).stoppedReason).toBe("runner_error");
  });

  it("invalid shape（非物件 / null / 缺 ok）→ 失敗", () => {
    expect(parseCeFixWorkResult(null).ok).toBe(false);
    expect(parseCeFixWorkResult("x").ok).toBe(false);
    expect(parseCeFixWorkResult([]).ok).toBe(false);
    expect(parseCeFixWorkResult({ fix: {} }).ok).toBe(false);
  });

  it("success 但 fix 髒資料 → 安全補預設", () => {
    const result = parseCeFixWorkResult({ ok: true, fix: { changedFiles: "no", testCommands: [1, "ok"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.fix.changedFiles).toEqual([]);
    expect(result.fix.testCommands).toEqual(["ok"]);
    expect(result.verification.commands).toEqual([]);
  });
});

describe("mergeCeFixWorkResult", () => {
  const existing: AiEngineeringWorkflow = {
    brainstorm: { path: "b.md", status: "reviewed" },
    plan: { path: "p.md", status: "approved" },
    audit: { notes: "audit" },
    workReview: {
      changedFiles: ["src/App.tsx"],
      testCommands: ["pnpm test:run"],
      testResults: "本機驗證：通過",
      codeReviewNotes: "Review result: needs_fix\n\nRecommended fixes:\n- 補測試",
      commitHash: "abc123",
      commitMessage: "feat: x",
    },
    compound: { lessonLearned: "經驗" },
  };

  function fixSuccess(over?: Partial<CeFixWorkSuccess>): CeFixWorkSuccess {
    return {
      ok: true,
      fix: {
        changedFiles: ["src/App.tsx", "src/App.test.tsx"],
        testCommands: ["pnpm test:run", "npx tsc --noEmit"],
        fixSummary: "補上測試並修正型別",
        notes: "",
        recommendedNextAction: "請再次執行 CE Review",
      },
      verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc --noEmit", ok: true }] },
      git: { statusShort: " M src/App.tsx\n?? src/App.test.tsx", diffStat: " src/App.tsx | 3 +-" },
      ai: { command: "claude", exitCode: 0 },
      ...over,
    };
  }

  it("合併 changedFiles 並去重", () => {
    const merged = mergeCeFixWorkResult(existing, fixSuccess());
    // 既有 src/App.tsx + fix src/App.test.tsx + git 推導，去重後不重複。
    expect(merged.workReview?.changedFiles).toEqual(["src/App.tsx", "src/App.test.tsx"]);
  });

  it("合併 testCommands 並去重", () => {
    const merged = mergeCeFixWorkResult(existing, fixSuccess());
    expect(merged.workReview?.testCommands).toEqual(["pnpm test:run", "npx tsc --noEmit"]);
  });

  it("append testResults（保留既有 + 新增 Fix 區段）", () => {
    const merged = mergeCeFixWorkResult(existing, fixSuccess());
    expect(merged.workReview?.testResults).toContain("本機驗證：通過");
    expect(merged.workReview?.testResults).toContain("--- CE Fix Work ---");
    expect(merged.workReview?.testResults).toContain("補上測試並修正型別");
  });

  it("codeReviewNotes 設為 '待 Review'（清掉 needs_fix 標記）", () => {
    const merged = mergeCeFixWorkResult(existing, fixSuccess());
    expect(merged.workReview?.codeReviewNotes).toBe("待 Review");
    expect(merged.workReview?.codeReviewNotes).not.toContain("needs_fix");
  });

  it("保留 brainstorm / plan / audit / compound 與 commitHash / commitMessage", () => {
    const merged = mergeCeFixWorkResult(existing, fixSuccess());
    expect(merged.brainstorm?.path).toBe("b.md");
    expect(merged.plan?.status).toBe("approved");
    expect(merged.audit?.notes).toBe("audit");
    expect(merged.compound?.lessonLearned).toBe("經驗");
    expect(merged.workReview?.commitHash).toBe("abc123");
    expect(merged.workReview?.commitMessage).toBe("feat: x");
  });

  it("current 為 undefined 時只產生 workReview（codeReviewNotes='待 Review'）", () => {
    const merged = mergeCeFixWorkResult(undefined, fixSuccess());
    expect(merged.workReview?.codeReviewNotes).toBe("待 Review");
    expect(merged.workReview?.changedFiles).toEqual(["src/App.tsx", "src/App.test.tsx"]);
    expect(merged.brainstorm).toBeUndefined();
  });
});
