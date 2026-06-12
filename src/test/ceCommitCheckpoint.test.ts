import { describe, it, expect } from "vitest";
import {
  SMOKE_CHECKPOINT_HASH,
  generateCeCommitMessage,
  mergeCeCommitCheckpointResult,
  mergeCeCommitSmokeCheckpoint,
  parseCeCommitCheckpointResult,
  shouldShowCeCommitCheckpoint,
} from "../core/ceCommitCheckpoint";
import type {
  AiEngineeringWorkflow,
  CeCommitCheckpointSuccess,
  Task,
} from "../shared/types";

/**
 * Phase 77F：CE Commit checkpoint 純函式層測試。
 * commit message 產生、runner 回傳解析（type guard）、合併、smoke checkpoint。
 */

function makeTask(overrides?: Partial<Task>): Task {
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** 帶 Review passed 與指定 changedFiles 的 task。 */
function makeReviewPassedTask(changedFiles: string[], overrides?: Partial<Task>): Task {
  return makeTask({
    aiWorkflow: {
      workReview: {
        changedFiles,
        testResults: "本機驗證：通過",
        codeReviewNotes: "Review result: passed",
      },
    },
    ...overrides,
  });
}

describe("shouldShowCeCommitCheckpoint", () => {
  it("Review passed → 顯示", () => {
    expect(shouldShowCeCommitCheckpoint(makeReviewPassedTask(["src/App.tsx"]))).toBe(true);
  });

  it("Review 未 passed 且無 commit → 不顯示", () => {
    expect(shouldShowCeCommitCheckpoint(makeTask())).toBe(false);
    expect(
      shouldShowCeCommitCheckpoint(
        makeTask({ aiWorkflow: { workReview: { codeReviewNotes: "Review result: needs_fix" } } })
      )
    ).toBe(false);
  });

  it("已有 commitHash（即使 notes 變動）→ 仍顯示完成狀態", () => {
    expect(
      shouldShowCeCommitCheckpoint(makeTask({ aiWorkflow: { workReview: { commitHash: "abc1234" } } }))
    ).toBe(true);
  });
});

describe("generateCeCommitMessage", () => {
  it("只有 docs 檔案 → docs: prefix", () => {
    const msg = generateCeCommitMessage(makeReviewPassedTask(["docs/harness-architecture.md"], { title: "smoke note" }));
    expect(msg).toBe("docs: smoke note");
  });

  it("docs/ 底下非 .md 也算 docs", () => {
    const msg = generateCeCommitMessage(makeReviewPassedTask(["docs/diagram.svg"], { title: "更新文件" }));
    expect(msg.startsWith("docs: ")).toBe(true);
  });

  it("只有測試檔案 → test: prefix", () => {
    const msg = generateCeCommitMessage(makeReviewPassedTask(["e2e/local-runner.spec.ts", "src/test/ceWork.test.ts"], { title: "add coverage" }));
    expect(msg).toBe("test: add coverage");
  });

  it("title / requirement 含 fix / 修復 → fix: prefix", () => {
    expect(generateCeCommitMessage(makeReviewPassedTask(["src/a.ts"], { title: "fix stdout capture" }))).toBe(
      "fix: fix stdout capture"
    );
    expect(
      generateCeCommitMessage(makeReviewPassedTask(["src/a.ts"], { title: "修復 verification 截斷" })).startsWith("fix: ")
    ).toBe(true);
  });

  it("一般變更 → feat: prefix；英文標題直接當 subject（首字母小寫、去尾句點）", () => {
    expect(generateCeCommitMessage(makeReviewPassedTask(["src/a.ts"], { title: "Add CE commit checkpoint." }))).toBe(
      "feat: add CE commit checkpoint"
    );
  });

  it("中文標題 → 由 changedFiles 推導 subject", () => {
    expect(generateCeCommitMessage(makeReviewPassedTask(["docs/harness-architecture.md"], { title: "煙霧測試" }))).toBe(
      "docs: update harness-architecture.md"
    );
    expect(generateCeCommitMessage(makeReviewPassedTask(["src/a.ts", "src/b.ts"], { title: "多檔修改" }))).toBe(
      "feat: update 2 files"
    );
  });

  it("無 changedFiles 且中文標題 → fallback subject", () => {
    expect(generateCeCommitMessage(makeTask({ title: "純中文" }))).toBe("feat: update project files");
  });

  it("第一行不超過 72 字元", () => {
    const longTitle = "a very long english title ".repeat(10);
    const msg = generateCeCommitMessage(makeReviewPassedTask(["src/a.ts"], { title: longTitle }));
    expect(msg.length).toBeLessThanOrEqual(72);
    expect(msg.startsWith("feat: ")).toBe(true);
    expect(msg.includes("\n")).toBe(false);
  });
});

describe("parseCeCommitCheckpointResult", () => {
  const SUCCESS_RAW = {
    ok: true,
    commitMessage: "docs: add note",
    commitHash: "abc1234",
    committedAt: "2026-06-13T00:00:00.000Z",
    committedFiles: ["docs/harness-architecture.md"],
    untrackedFiles: ["tmp.txt"],
    verification: { ok: true, commands: [{ name: "tsc", command: "npx tsc --noEmit", ok: true }] },
    statusBefore: " M docs/harness-architecture.md",
    diffStatBefore: " 1 file changed",
  };

  it("成功：欄位齊全且型別正確", () => {
    const result = parseCeCommitCheckpointResult(SUCCESS_RAW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.commitHash).toBe("abc1234");
    expect(result.committedFiles).toEqual(["docs/harness-architecture.md"]);
    expect(result.untrackedFiles).toEqual(["tmp.txt"]);
    expect(result.verification.ok).toBe(true);
    expect(result.verification.commands[0].name).toBe("tsc");
    expect(result.statusBefore).toContain("harness-architecture");
  });

  it("成功但欄位缺漏 / 型別錯誤 → 補預設值，不 throw", () => {
    const result = parseCeCommitCheckpointResult({ ok: true, committedFiles: ["a", 1, null] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("應為成功");
    expect(result.commitHash).toBe("");
    expect(result.committedFiles).toEqual(["a"]);
    expect(result.verification.commands).toEqual([]);
  });

  it("失敗：白名單 stoppedReason 保留；preview 與 untrackedFiles 保留", () => {
    const result = parseCeCommitCheckpointResult({
      ok: false,
      stoppedReason: "nothing_to_commit",
      message: "沒有可 commit 的 tracked 變更",
      stderrPreview: "err",
      verificationPreview: "ver",
      untrackedFiles: ["x.txt"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("nothing_to_commit");
    expect(result.stderrPreview).toBe("err");
    expect(result.verificationPreview).toBe("ver");
    expect(result.untrackedFiles).toEqual(["x.txt"]);
  });

  it("失敗：所有規格內 stoppedReason 皆保留；未知 → runner_error", () => {
    const reasons = [
      "nothing_to_commit",
      "verification_failed",
      "git_commit_failed",
      "invalid_commit_message",
      "git_status_failed",
      "project_path_invalid",
    ] as const;
    for (const reason of reasons) {
      const result = parseCeCommitCheckpointResult({ ok: false, stoppedReason: reason, message: "x" });
      if (result.ok) throw new Error("應為失敗");
      expect(result.stoppedReason).toBe(reason);
    }
    const unknown = parseCeCommitCheckpointResult({ ok: false, stoppedReason: "wat", message: "x" });
    if (unknown.ok) throw new Error("應為失敗");
    expect(unknown.stoppedReason).toBe("runner_error");
  });

  it("非物件 → runner_error", () => {
    const result = parseCeCommitCheckpointResult("not an object");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("應為失敗");
    expect(result.stoppedReason).toBe("runner_error");
  });
});

describe("mergeCeCommitCheckpointResult", () => {
  const SUCCESS: CeCommitCheckpointSuccess = {
    ok: true,
    commitMessage: "docs: add note",
    commitHash: "abc1234",
    committedAt: "2026-06-13T00:00:00.000Z",
    committedFiles: ["docs/harness-architecture.md"],
    untrackedFiles: [],
    verification: { ok: true, commands: [] },
    statusBefore: "",
    diffStatBefore: "",
  };

  const EXISTING: AiEngineeringWorkflow = {
    brainstorm: { path: "b.md" },
    plan: { status: "approved" },
    audit: { notes: "audit" },
    workReview: {
      changedFiles: ["docs/harness-architecture.md"],
      testCommands: ["npm run verify:local"],
      testResults: "本機驗證：通過",
      codeReviewNotes: "Review result: passed",
    },
    compound: { lessonLearned: "經驗" },
  };

  it("寫入 commit 四欄位，保留 workReview 其他欄位與其他段", () => {
    const merged = mergeCeCommitCheckpointResult(EXISTING, SUCCESS);
    expect(merged.workReview?.commitMessage).toBe("docs: add note");
    expect(merged.workReview?.commitHash).toBe("abc1234");
    expect(merged.workReview?.committedAt).toBe("2026-06-13T00:00:00.000Z");
    expect(merged.workReview?.committedFiles).toEqual(["docs/harness-architecture.md"]);
    expect(merged.workReview?.changedFiles).toEqual(["docs/harness-architecture.md"]);
    expect(merged.workReview?.codeReviewNotes).toBe("Review result: passed");
    expect(merged.brainstorm?.path).toBe("b.md");
    expect(merged.plan?.status).toBe("approved");
    expect(merged.audit?.notes).toBe("audit");
    expect(merged.compound?.lessonLearned).toBe("經驗");
  });

  it("current undefined 也可合併", () => {
    const merged = mergeCeCommitCheckpointResult(undefined, SUCCESS);
    expect(merged.workReview?.commitHash).toBe("abc1234");
  });
});

describe("mergeCeCommitSmokeCheckpoint", () => {
  it("commitHash 寫入固定標記、保留其他欄位", () => {
    const merged = mergeCeCommitSmokeCheckpoint(
      { workReview: { codeReviewNotes: "Review result: passed" } },
      "docs: smoke note",
      "2026-06-13T01:00:00.000Z"
    );
    expect(merged.workReview?.commitHash).toBe(SMOKE_CHECKPOINT_HASH);
    expect(merged.workReview?.commitHash).toBe("not committed - smoke test only");
    expect(merged.workReview?.commitMessage).toBe("docs: smoke note");
    expect(merged.workReview?.committedAt).toBe("2026-06-13T01:00:00.000Z");
    expect(merged.workReview?.codeReviewNotes).toBe("Review result: passed");
  });
});
