import type { TaskType } from "../shared/types";
import { TEMPLATE_MAP, type PromptTemplate } from "./templates";

export function getTemplate(type: TaskType): PromptTemplate {
  return TEMPLATE_MAP[type] ?? TEMPLATE_MAP.other;
}

export function getTemplateLabel(type: TaskType): string {
  return getTemplate(type).label;
}
