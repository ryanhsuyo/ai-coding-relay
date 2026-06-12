import type { Task } from "../shared/types";
import { renderTextList, renderOptionalText } from "./promptRenderer";
import { getTemplate } from "./templateRegistry";

export function generateClaudePrompt(task: Task): string {
  const template = getTemplate(task.type);

  const sections: string[] = [
    template.role,
    renderOptionalText("任務：", task.originalRequirement),
    `任務類型：\n${template.label}`,
    renderTextList("請只修改以下檔案：", task.targetFiles),
    renderTextList("請不要修改以下檔案或範圍：", task.forbiddenFiles),
    renderTextList("限制條件：", task.constraints),
    renderTextList("驗收條件：", task.acceptanceCriteria),
    template.specificPrinciples,
    template.reportFormat,
  ];

  return sections.join("\n\n");
}
