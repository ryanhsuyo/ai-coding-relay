import { describe, it, expect } from "vitest";
import {
  CE_PIPELINE_STATUS_TEXT,
  buildCommitConfirmationSummary,
  buildWorkConfirmationSummary,
  findUnrelatedChanges,
  isCeWorkflowCompleted,
  isPipelineActive,
  isPipelineAutoStep,
  isPipelineWaiting,
  type CePipelineStatus,
} from "../core/cePipeline";
import type { AiEngineeringWorkflow, CeWorkSuccess } from "../shared/types";

/**
 * Phase 78：CE Pipeline 純函式層測試（狀態分類、確認摘要、無關變更偵測）。
 */

const ALL_STATUSES: CePipelineStatus[] = [
  "idle",
  "running_readonly",
  "waiting_work_confirmation",
  "running_work",
  "running_review",
  "waiting_commit_confirmation",
  "committing",
  "generating_compound",
  "saving_workflow",
  "exporting_artifacts",
  "completed",
  "failed",
  "needs_fix",
  "cancelled",
];

describe("CE_PIPELINE_STATUS_TEXT / 狀態分類", () => {
  it("所有狀態都有對應文字（idle 為空）", () => {
    for (const status of ALL_STATUSES) {
      expect(typeof CE_PIPELINE_STATUS_TEXT[status]).toBe("string");
      if (status !== "idle") expect(CE_PIPELINE_STATUS_TEXT[status].length).toBeGreaterThan(0);
    }
  });

  it("auto step / waiting / active 分類正確", () => {
    const auto: CePipelineStatus[] = ["running_readonly", "running_work", "running_review", "committing", "generating_compound", "saving_workflow", "exporting_artifacts"];
    const waiting: CePipelineStatus[] = ["waiting_work_confirmation", "waiting_commit_confirmation"];
    const inactive: CePipelineStatus[] = ["idle", "completed", "failed", "needs_fix", "cancelled"];
    for (const s of auto) {
      expect(isPipelineAutoStep(s), s).toBe(true);
      expect(isPipelineActive(s), s).toBe(true);
    }
    for (const s of waiting) {
      expect(isPipelineAutoStep(s), s).toBe(false);
      expect(isPipelineWaiting(s), s).toBe(true);
      expect(isPipelineActive(s), s).toBe(true);
    }
    for (const s of inactive) {
      expect(isPipelineActive(s), s).toBe(false);
    }
  });
});

describe("buildWorkConfirmationSummary", () => {
  it("彙整 plan 摘要 / 狀態、audit checklist 完成數與驗收標準", () => {
    const summary = buildWorkConfirmationSummary({
      plan: { summary: "  已審核的 plan  ", status: "approved" },
      audit: {
        notes: "audit 筆記",
        acceptanceCriteria: ["驗收一", " ", "驗收二"],
        checklist: {
          coreAssumptionsReviewed: true,
          riskReviewed: true,
          scopeReviewed: true,
          acceptanceCriteriaReviewed: false,
          minimalChangeReviewed: false,
        },
      },
    });
    expect(summary.planSummary).toBe("已審核的 plan");
    expect(summary.planStatus).toBe("approved");
    expect(summary.auditNotes).toBe("audit 筆記");
    expect(summary.checklistDone).toBe(3);
    expect(summary.checklistTotal).toBe(5);
    expect(summary.acceptanceCriteria).toEqual(["驗收一", "驗收二"]);
  });

  it("wf undefined / 空 audit 時回傳安全預設", () => {
    const summary = buildWorkConfirmationSummary(undefined);
    expect(summary.planSummary).toBe("");
    expect(summary.checklistDone).toBe(0);
    expect(summary.checklistTotal).toBe(5);
    expect(summary.acceptanceCriteria).toEqual([]);
  });
});

describe("buildCommitConfirmationSummary", () => {
  const WORK: CeWorkSuccess = {
    ok: true,
    work: {
      changedFiles: ["docs/harness-architecture.md"],
      testCommands: ["npm run verify:local"],
      testResults: "",
      implementationSummary: "完成",
      notes: "",
      recommendedNextAction: "",
    },
    verification: {
      ok: true,
      commands: [
        { name: "tsc", command: "npx tsc --noEmit", ok: true },
        { name: "test", command: "node --test", ok: true },
      ],
    },
    git: { statusShort: " M docs/harness-architecture.md", diffStat: " 1 file changed, 11 insertions(+)" },
    ai: { command: "claude", exitCode: 0 },
  };

  it("彙整 changed files / diff stat / verification 摘要", () => {
    const summary = buildCommitConfirmationSummary(WORK);
    expect(summary.changedFiles).toEqual(["docs/harness-architecture.md"]);
    expect(summary.diffStat).toBe("1 file changed, 11 insertions(+)");
    expect(summary.verificationSummary).toContain("verification 通過（2 項指令）");
    expect(summary.verificationSummary).toContain("- tsc: 通過");
    expect(summary.verificationSummary).toContain("- test: 通過");
  });

  it("changedFiles 空時由 git status 推導", () => {
    const summary = buildCommitConfirmationSummary({
      ...WORK,
      work: { ...WORK.work, changedFiles: [] },
      git: { statusShort: " M src/App.tsx\n?? new.txt", diffStat: "" },
    });
    expect(summary.changedFiles).toEqual(["src/App.tsx", "new.txt"]);
  });

  it("verification 未通過時摘要標示未通過", () => {
    const summary = buildCommitConfirmationSummary({
      ...WORK,
      verification: { ok: false, commands: [{ name: "test", command: "node --test", ok: false }] },
    });
    expect(summary.verificationSummary).toContain("verification 未通過");
    expect(summary.verificationSummary).toContain("- test: 未通過");
  });
});

describe("isCeWorkflowCompleted", () => {
  const COMPLETED: AiEngineeringWorkflow = {
    workReview: { commitHash: "abc1234", codeReviewNotes: "Review result: passed\n\nNotes: ok" },
    compound: { lessonLearned: "本次經驗" },
  };

  it("commit + review passed + compound 皆具備 → true", () => {
    expect(isCeWorkflowCompleted(COMPLETED)).toBe(true);
  });

  it("smoke checkpoint hash 也算已 commit", () => {
    expect(
      isCeWorkflowCompleted({ ...COMPLETED, workReview: { ...COMPLETED.workReview, commitHash: "not committed - smoke test only" } })
    ).toBe(true);
  });

  it("compound 任一欄位有內容即可（compoundNotes / reusablePrompt）", () => {
    expect(isCeWorkflowCompleted({ ...COMPLETED, compound: { compoundNotes: "n" } })).toBe(true);
    expect(isCeWorkflowCompleted({ ...COMPLETED, compound: { reusablePrompt: "p" } })).toBe(true);
  });

  it("缺 commitHash → false", () => {
    expect(isCeWorkflowCompleted({ ...COMPLETED, workReview: { codeReviewNotes: "Review result: passed" } })).toBe(false);
  });

  it("review 非 passed（needs_fix / 無 notes）→ false", () => {
    expect(
      isCeWorkflowCompleted({ ...COMPLETED, workReview: { commitHash: "abc1234", codeReviewNotes: "Review result: needs_fix" } })
    ).toBe(false);
    expect(isCeWorkflowCompleted({ ...COMPLETED, workReview: { commitHash: "abc1234" } })).toBe(false);
  });

  it("缺 compound → false", () => {
    expect(isCeWorkflowCompleted({ ...COMPLETED, compound: undefined })).toBe(false);
    expect(isCeWorkflowCompleted({ ...COMPLETED, compound: { lessonLearned: "   " } })).toBe(false);
  });

  it("wf undefined / 空 → false", () => {
    expect(isCeWorkflowCompleted(undefined)).toBe(false);
    expect(isCeWorkflowCompleted({})).toBe(false);
  });
});

describe("findUnrelatedChanges", () => {
  it("git status 有 changedFiles 以外的檔案 → 回報無關變更", () => {
    const statusShort = " M docs/harness-architecture.md\n M src/unrelated.ts\n?? scratch.txt";
    expect(findUnrelatedChanges(statusShort, ["docs/harness-architecture.md"])).toEqual([
      "src/unrelated.ts",
      "scratch.txt",
    ]);
  });

  it("完全吻合 → 空陣列", () => {
    expect(findUnrelatedChanges(" M a.ts\n M b.ts", ["a.ts", "b.ts"])).toEqual([]);
  });

  it("changedFiles 為空（無從比對）→ 空陣列，不誤報", () => {
    expect(findUnrelatedChanges(" M a.ts", [])).toEqual([]);
  });

  it("git status 為空 → 空陣列", () => {
    expect(findUnrelatedChanges("", ["a.ts"])).toEqual([]);
  });
});
