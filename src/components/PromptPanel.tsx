import { useState, useRef } from "react";
import type { Task } from "../shared/types";
import { generateClaudePrompt } from "../prompt-engine/claudePromptTemplate";
import { getTemplateLabel } from "../prompt-engine/templateRegistry";

type Props = {
  task: Task;
  onAddRound: (prompt: string, claudeResponse: string) => void;
};

export function PromptPanel({ task, onAddRound }: Props) {
  const prompt = generateClaudePrompt(task);
  const templateLabel = getTemplateLabel(task.type);
  const [copied, setCopied] = useState(false);
  const [responseText, setResponseText] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleCopy() {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleAddRound() {
    const trimmed = responseText.trim();
    if (!trimmed) return;
    onAddRound(prompt, trimmed);
    setResponseText("");
  }

  return (
    <div className="prompt-panel">
      <div className="prompt-panel-header">
        <div className="prompt-panel-title">
          <span className="detail-label">Claude Prompt</span>
          <span className="template-badge">目前模板：{templateLabel}</span>
        </div>
        <button
          className={`btn btn-copy${copied ? " copied" : ""}`}
          onClick={handleCopy}
        >
          {copied ? "✓ 已複製" : "複製 Prompt"}
        </button>
      </div>
      <textarea className="prompt-preview" readOnly value={prompt} />

      <div className="response-section">
        <div className="response-section-header">
          <span className="detail-label">貼上 Claude 回覆</span>
        </div>
        <textarea
          className="response-textarea"
          value={responseText}
          onChange={(e) => setResponseText(e.target.value)}
          placeholder="把 Claude Code 的回覆貼到這裡，然後點「建立回合紀錄」..."
        />
        <div className="response-actions">
          <button
            className="btn btn-primary"
            onClick={handleAddRound}
            disabled={!responseText.trim()}
          >
            建立回合紀錄
          </button>
        </div>
      </div>
    </div>
  );
}
