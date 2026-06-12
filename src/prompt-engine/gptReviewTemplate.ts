import type { Task, TaskRound } from "../shared/types";
import { renderTextList, renderOptionalText } from "./promptRenderer";

function renderCommandLogs(round: TaskRound): string {
  if (!round.commandLogs || round.commandLogs.length === 0) {
    return "command result\n（無）";
  }
  const body = round.commandLogs
    .map(
      (log) =>
        `$ ${log.command} (exit ${log.exitCode})\n${log.stdout || ""}${log.stderr ? `\n[stderr]\n${log.stderr}` : ""}`
    )
    .join("\n\n");
  return `command result\n${body}`;
}

const REVIEW_FORMAT = `請用以下格式回答：

1. 是否符合原始需求
2. 已完成項目
3. 可能漏掉的項目
4. 是否有改到不該改的地方
5. TypeScript / React / UI 風險
6. 建議驗收 checklist
7. 下一輪要給 Claude Code 的 prompt`;

export function generateGptReviewPrompt(params: {
  task: Task;
  round: TaskRound;
}): string {
  const { task, round } = params;

  const sections: string[] = [
    "請幫我審查這次 Claude Code 的修改是否符合需求。",
    renderOptionalText("原始需求：", task.originalRequirement),
    renderTextList("允許修改檔案：", task.targetFiles),
    renderTextList("禁止修改範圍：", task.forbiddenFiles),
    renderTextList("限制條件：", task.constraints),
    renderTextList("驗收條件：", task.acceptanceCriteria),
    renderOptionalText("Claude 回覆：", round.claudeResponse),
    renderOptionalText("git status：", round.gitStatus),
    renderOptionalText("git diff：", round.gitDiff),
    renderCommandLogs(round),
    REVIEW_FORMAT,
  ];

  return sections.join("\n\n");
}
