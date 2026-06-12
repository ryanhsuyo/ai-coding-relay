import { describe, it, expect } from "vitest";
import {
  ARTIFACT_FILE_NAMES,
  artifactRelativeDir,
  buildAuditMarkdown,
  buildBrainstormMarkdown,
  buildCeArtifactFiles,
  buildCompoundMarkdown,
  buildMetadataJson,
  buildRequirementMarkdown,
  buildWorkResultMarkdown,
  parseCeArtifactExportResult,
  slugifyTaskForArtifact,
} from "../core/ceArtifactExport";
import type { AiEngineeringWorkflow, Task, TaskCompletionEvent } from "../shared/types";

/**
 * Phase 75：OpenSpec-like Artifact Export 內容產生器測試。
 */

function makeTask(opts?: {
  id?: string;
  title?: string;
  originalRequirement?: string;
  project?: string;
  projectPath?: string;
  aiWorkflow?: AiEngineeringWorkflow;
  completedAt?: string;
  completionHistory?: TaskCompletionEvent[];
}): Task {
  return {
    id: opts?.id ?? "task-id-123",
    title: opts?.title ?? "Export Demo Task",
    type: "bug",
    status: "todo",
    priority: "medium",
    workflowStage: "spec",
    originalRequirement: opts?.originalRequirement ?? "",
    targetFiles: [],
    forbiddenFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    tags: [],
    project: opts?.project,
    projectPath: opts?.projectPath,
    aiWorkflow: opts?.aiWorkflow,
    completedAt: opts?.completedAt,
    completionHistory: opts?.completionHistory,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("slugifyTaskForArtifact", () => {
  it("1. 英文 title 正常 slug 化", () => {
    expect(slugifyTaskForArtifact(makeTask({ title: "Add Login Error Hint" }))).toBe("add-login-error-hint");
    expect(slugifyTaskForArtifact(makeTask({ title: "  Fix:  Bug #42!! " }))).toBe("fix-bug-42");
  });

  it("2. 中文 / 空 title 不 crash，fallback 到 id 或 task", () => {
    expect(slugifyTaskForArtifact(makeTask({ title: "新增登入錯誤提示", id: "abc-123" }))).toBe("abc-123");
    expect(slugifyTaskForArtifact(makeTask({ title: "", id: "xyz-9" }))).toBe("xyz-9");
    expect(slugifyTaskForArtifact(makeTask({ title: "中文", id: "中文" }))).toBe("task");
  });

  it("限制長度在 80 字以內，且不含路徑分隔字元", () => {
    const longTitle = "a".repeat(200);
    const slug = slugifyTaskForArtifact(makeTask({ title: longTitle }));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).not.toMatch(/[/\\.]/);
  });

  it("artifactRelativeDir 使用 slug", () => {
    expect(artifactRelativeDir(makeTask({ title: "Hello World" }))).toBe("docs/ai-workflows/hello-world");
  });
});

describe("buildCeArtifactFiles", () => {
  it("3. 產生固定 9 個檔案，名稱與 ARTIFACT_FILE_NAMES 一致", () => {
    const files = buildCeArtifactFiles(makeTask());
    expect(files).toHaveLength(9);
    expect(files.map((f) => f.name)).toEqual([...ARTIFACT_FILE_NAMES]);
    for (const f of files) {
      expect(typeof f.content).toBe("string");
      expect(f.content.length).toBeGreaterThan(0);
    }
  });
});

describe("markdown builders", () => {
  it("4. requirement.md 包含 originalRequirement", () => {
    const md = buildRequirementMarkdown(makeTask({ originalRequirement: "需求：補上登入失敗提示" }));
    expect(md).toContain("# Requirement");
    expect(md).toContain("需求：補上登入失敗提示");
  });

  it("5. audit.md 包含 checklist 與各項", () => {
    const md = buildAuditMarkdown(
      makeTask({
        aiWorkflow: {
          audit: {
            notes: "審計筆記",
            riskNotes: ["風險一"],
            checklist: {
              coreAssumptionsReviewed: true,
              riskReviewed: false,
              scopeReviewed: false,
              acceptanceCriteriaReviewed: false,
              minimalChangeReviewed: false,
            },
          },
        },
      })
    );
    expect(md).toContain("## Checklist");
    expect(md).toContain("- [x] 核心假設已審查");
    expect(md).toContain("- [ ] 風險已審查");
    expect(md).toContain("風險一");
  });

  it("6. work-result.md 包含 changedFiles / testCommands / testResults", () => {
    const md = buildWorkResultMarkdown(
      makeTask({
        aiWorkflow: {
          workReview: {
            changedFiles: ["src/App.tsx"],
            testCommands: ["pnpm test:run"],
            testResults: "120 passed",
          },
        },
      })
    );
    expect(md).toContain("src/App.tsx");
    expect(md).toContain("pnpm test:run");
    expect(md).toContain("120 passed");
  });

  it("7. compound.md 包含 lessonLearned / reusablePrompt / compoundNotes", () => {
    const md = buildCompoundMarkdown(
      makeTask({
        aiWorkflow: {
          compound: {
            lessonLearned: "學到了 A",
            reusablePrompt: "下次的 prompt B",
            compoundNotes: "完整紀錄 C",
          },
        },
      })
    );
    expect(md).toContain("學到了 A");
    expect(md).toContain("下次的 prompt B");
    expect(md).toContain("完整紀錄 C");
  });

  it("9. 缺資料時 markdown 有「尚未產生...」提示", () => {
    expect(buildBrainstormMarkdown(makeTask())).toContain("尚未產生 Brainstorm 紀錄。");
    expect(buildAuditMarkdown(makeTask())).toContain("尚未產生 Audit 紀錄。");
    expect(buildWorkResultMarkdown(makeTask())).toContain("尚未產生 Work 紀錄。");
    expect(buildCompoundMarkdown(makeTask())).toContain("尚未產生 Compound Notes。");
  });
});

describe("buildMetadataJson", () => {
  it("8. 是合法 JSON，含 schemaVersion / source / task / artifact.files", () => {
    const relativeDir = artifactRelativeDir(makeTask({ title: "Meta Task" }));
    const json = buildMetadataJson(makeTask({ title: "Meta Task", project: "demo" }), relativeDir);
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      source: string;
      exportedAt: string;
      task: { title: string; project: string };
      artifact: { relativeDir: string; files: string[] };
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.source).toBe("ai-coding-relay");
    expect(typeof parsed.exportedAt).toBe("string");
    expect(parsed.task.title).toBe("Meta Task");
    expect(parsed.task.project).toBe("demo");
    expect(parsed.artifact.relativeDir).toBe("docs/ai-workflows/meta-task");
    expect(parsed.artifact.files).toEqual([...ARTIFACT_FILE_NAMES]);
  });

  it("completedAt / completionHistory 反映在 completion 內容", () => {
    const files = buildCeArtifactFiles(
      makeTask({
        completedAt: "2026-06-11T00:00:00.000Z",
        completionHistory: [
          {
            id: "c1",
            type: "completion_applied",
            createdAt: "2026-06-11T00:00:00.000Z",
            summarySaved: true,
            status: "done",
            reviewResult: "passed",
            workflowStage: "done",
            message: "已套用完成狀態",
          },
        ],
      })
    );
    const completion = files.find((f) => f.name === "completion.md");
    expect(completion?.content).toContain("2026-06-11T00:00:00.000Z");
    expect(completion?.content).toContain("已套用完成狀態");
    expect(completion?.content).not.toContain("尚未套用完成狀態。");
  });
});

describe("parseCeArtifactExportResult", () => {
  it("非物件 → runner_error 失敗", () => {
    const r = parseCeArtifactExportResult(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stoppedReason).toBe("runner_error");
  });

  it("ok=false 保留白名單 stoppedReason，未知值轉 runner_error", () => {
    const known = parseCeArtifactExportResult({ ok: false, stoppedReason: "path_escape_detected", message: "x" });
    expect(known.ok).toBe(false);
    if (!known.ok) expect(known.stoppedReason).toBe("path_escape_detected");
    const unknown = parseCeArtifactExportResult({ ok: false, stoppedReason: "weird", message: "y" });
    if (!unknown.ok) expect(unknown.stoppedReason).toBe("runner_error");
  });

  it("ok=true 解析 artifact / files（過濾無效項）", () => {
    const r = parseCeArtifactExportResult({
      ok: true,
      artifact: {
        relativeDir: "docs/ai-workflows/x",
        absoluteDir: "/p/docs/ai-workflows/x",
        files: [
          { name: "requirement.md", relativePath: "docs/ai-workflows/x/requirement.md" },
          { name: "", relativePath: "skip" },
          "bad",
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.relativeDir).toBe("docs/ai-workflows/x");
      expect(r.artifact.files).toHaveLength(1);
      expect(r.artifact.files[0].name).toBe("requirement.md");
    }
  });
});
