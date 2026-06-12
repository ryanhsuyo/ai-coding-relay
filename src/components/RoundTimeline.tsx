import { useState, useRef } from "react";
import type { Task, TaskRound, ChecklistItem, CommandLog, FileGuardResult, AiRunResult } from "../shared/types";
import { formatDateTime } from "../utils/date";
import { generateGptReviewPrompt } from "../prompt-engine/gptReviewTemplate";

const CHECK_STATUS_ICON: Record<ChecklistItem["status"], string> = {
  passed: "✅",
  failed: "❌",
  skipped: "⊘",
  pending: "…",
};

type RoundPatch = Partial<Omit<TaskRound, "id" | "taskId" | "roundIndex" | "createdAt">>;

type Props = {
  rounds: TaskRound[];
  task: Task;
  onEditRound: (roundId: string, patch: RoundPatch) => void;
};

export function RoundTimeline({ rounds, task, onEditRound }: Props) {
  if (rounds.length === 0) return null;

  return (
    <div className="round-timeline">
      <div className="round-timeline-title">回合紀錄（{rounds.length} 輪）</div>
      {rounds.map((round) => (
        <RoundCard key={round.id} round={round} task={task} onEditRound={onEditRound} />
      ))}
    </div>
  );
}

type CardProps = {
  round: TaskRound;
  task: Task;
  onEditRound: (roundId: string, patch: RoundPatch) => void;
};

function RoundCard({ round, task, onEditRound }: CardProps) {
  const [gptCopied, setGptCopied] = useState(false);
  const [nextCopied, setNextCopied] = useState(false);
  const [gptReviewInput, setGptReviewInput] = useState("");
  const [nextPromptInput, setNextPromptInput] = useState("");
  const gptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleGenerateGptPrompt() {
    const prompt = generateGptReviewPrompt({ task, round });
    onEditRound(round.id, { gptReviewPrompt: prompt });
  }

  function handleCopyGptPrompt() {
    if (!round.gptReviewPrompt) return;
    navigator.clipboard.writeText(round.gptReviewPrompt).then(() => {
      setGptCopied(true);
      if (gptTimer.current) clearTimeout(gptTimer.current);
      gptTimer.current = setTimeout(() => setGptCopied(false), 2000);
    });
  }

  function handleCopyNextPrompt() {
    if (!round.nextPrompt) return;
    navigator.clipboard.writeText(round.nextPrompt).then(() => {
      setNextCopied(true);
      if (nextTimer.current) clearTimeout(nextTimer.current);
      nextTimer.current = setTimeout(() => setNextCopied(false), 2000);
    });
  }

  function handleSaveGptReview() {
    const v = gptReviewInput.trim();
    if (!v) return;
    onEditRound(round.id, { gptReview: v });
    setGptReviewInput("");
  }

  function handleSaveNextPrompt() {
    const v = nextPromptInput.trim();
    if (!v) return;
    onEditRound(round.id, { nextPrompt: v });
    setNextPromptInput("");
  }

  return (
    <div className="round-card">
      <div className="round-card-header">
        <span className="round-index">第 {round.roundIndex} 輪</span>
        {round.loopRoundIndex !== undefined && (
          <span className="loop-badge">
            Loop {round.loopRoundIndex}/{round.loopTotalRounds ?? round.loopRoundIndex}
          </span>
        )}
        {round.autoRoundMode !== undefined && (
          <span className={`verify-badge${round.autoRoundOk ? " ok" : " fail"}`}>
            🤖 auto-round：{round.autoRoundMode || "—"}{round.autoRoundOk ? " ✅" : " ❌"}
          </span>
        )}
        {round.verificationOk !== undefined && (
          <span className={`verify-badge${round.verificationOk ? " ok" : " fail"}`}>
            {round.verificationOk ? "✅ 驗證通過" : "❌ 驗證未通過"}
          </span>
        )}
        {round.fileGuard && (
          <span className={`verify-badge${round.fileGuard.ok ? " ok" : " fail"}`}>
            {round.fileGuard.ok ? "✅ 檔案範圍通過" : "❌ 檔案範圍未通過"}
          </span>
        )}
        <span className="round-date">{formatDateTime(round.createdAt)}</span>
      </div>

      <div className="round-body">
        <AutoRoundSection round={round} />
        <VerificationSection round={round} />

        {/* Claude Prompt — collapsible to save space */}
        <div className="round-section">
          <details>
            <summary className="round-section-label round-summary">Claude Prompt ▸</summary>
            <div className="round-section-text">{round.promptToClaude}</div>
          </details>
        </div>

        {/* Claude Response */}
        {round.claudeResponse && (
          <div className="round-section">
            <div className="round-section-label">Claude 回覆</div>
            <div className="round-section-text">{round.claudeResponse}</div>
          </div>
        )}

        {/* GPT Review Prompt */}
        <div className="round-section">
          <div className="round-section-label-row">
            <span className="round-section-label">GPT Review Prompt</span>
            <div style={{ display: "flex", gap: 5 }}>
              <button
                className="btn"
                style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={handleGenerateGptPrompt}
              >
                {round.gptReviewPrompt ? "重新產生" : "產生"}
              </button>
              {round.gptReviewPrompt && (
                <button
                  className={`btn btn-copy${gptCopied ? " copied" : ""}`}
                  style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={handleCopyGptPrompt}
                >
                  {gptCopied ? "✓ 已複製" : "複製"}
                </button>
              )}
            </div>
          </div>
          {round.gptReviewPrompt && (
            <div className="round-section-text">{round.gptReviewPrompt}</div>
          )}
        </div>

        {/* GPT Review */}
        <div className="round-section">
          <div className="round-section-label">GPT Review</div>
          {round.gptReview ? (
            <div className="round-section-text">{round.gptReview}</div>
          ) : (
            <div className="round-input-area">
              <textarea
                value={gptReviewInput}
                onChange={(e) => setGptReviewInput(e.target.value)}
                placeholder="把 GPT 的審查結果貼到這裡..."
                rows={4}
              />
              <div className="round-input-actions">
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 12 }}
                  onClick={handleSaveGptReview}
                  disabled={!gptReviewInput.trim()}
                >
                  儲存 GPT Review
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Next Prompt */}
        <div className="round-section">
          <div className="round-section-label-row">
            <span className="round-section-label">下一輪 Prompt</span>
            {round.nextPrompt && (
              <button
                className={`btn btn-copy${nextCopied ? " copied" : ""}`}
                style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={handleCopyNextPrompt}
              >
                {nextCopied ? "✓ 已複製" : "複製"}
              </button>
            )}
          </div>
          {round.nextPrompt ? (
            <div className="round-section-text">{round.nextPrompt}</div>
          ) : (
            <div className="round-input-area">
              <textarea
                value={nextPromptInput}
                onChange={(e) => setNextPromptInput(e.target.value)}
                placeholder="填入 GPT 建議的下一輪 Claude Prompt..."
                rows={3}
              />
              <div className="round-input-actions">
                <button
                  className="btn btn-primary"
                  style={{ fontSize: 12 }}
                  onClick={handleSaveNextPrompt}
                  disabled={!nextPromptInput.trim()}
                >
                  儲存下一輪 Prompt
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const AUTO_ROUND_MODE_LABEL: Record<string, string> = {
  test: "紅燈測試 test",
  implement: "綠燈實作 implement",
  refactor: "重構 refactor",
  fix: "修正 fix",
};

/** 顯示由 auto-round JSON 匯入的資料：mode、AI 執行結果、stoppedReason。 */
function AutoRoundSection({ round }: { round: TaskRound }) {
  // 只有 auto-round 匯入的回合才有 autoRoundMode（即使為空字串也算）
  if (round.autoRoundMode === undefined) return null;
  const modeLabel = AUTO_ROUND_MODE_LABEL[round.autoRoundMode] ?? (round.autoRoundMode || "—");

  return (
    <div className="round-section auto-round-section">
      <div className="auto-round-head">
        {round.loopRoundIndex !== undefined && (
          <span className="auto-round-mode">
            ♻️ Loop {round.loopRoundIndex}/{round.loopTotalRounds ?? round.loopRoundIndex}
          </span>
        )}
        <span className="auto-round-mode">🤖 auto-round · {modeLabel}</span>
        <span className={`verify-badge${round.autoRoundOk ? " ok" : " fail"}`}>
          {round.autoRoundOk ? "✅ 整體通過" : "❌ 整體未通過"}
        </span>
      </div>

      {round.stoppedReason && (
        <div className="auto-round-stopped">停止原因：{round.stoppedReason}</div>
      )}

      {round.loopStoppedReason && (
        <div className="detail-empty-text">Loop 結束原因：{round.loopStoppedReason}</div>
      )}

      {round.aiResult && <AiResultRow ai={round.aiResult} />}
    </div>
  );
}

function AiResultRow({ ai }: { ai: AiRunResult }) {
  const ok = ai.exitCode === 0;
  const detail = ai.stdout || ai.stderr;
  return (
    <div className="command-log-row">
      <div className="command-log-head">
        <span className={`verify-dot${ok ? " ok" : " fail"}`} />
        <span className="auto-round-ai-label">AI</span>
        <code>{ai.command || "—"}</code>
        <span className="command-log-exit">exit {ai.exitCode ?? "—"}</span>
        <span className="command-log-exit">{ai.durationMs} ms</span>
      </div>
      {detail && (
        <details>
          <summary className="round-section-label round-summary">AI 輸出 ▸</summary>
          <pre className="round-pre">{detail}</pre>
        </details>
      )}
    </div>
  );
}

/** 顯示由本機驗證 JSON 匯入的資料：checklist、command logs、git status / diff、file guard。 */
function VerificationSection({ round }: { round: TaskRound }) {
  const checklist = round.checklist;
  const commandLogs = round.commandLogs ?? [];
  const hasGit = Boolean(round.gitStatus || round.gitDiff);
  const fileGuard = round.fileGuard;

  // 沒有任何驗證相關資料就不渲染（一般人工建立的回合）
  if (checklist.length === 0 && commandLogs.length === 0 && !hasGit && !fileGuard) {
    return null;
  }

  return (
    <div className="round-section verification-section">
      {checklist.length > 0 && (
        <div className="verify-checklist">
          {checklist.map((item) => (
            <span key={item.id} className={`verify-check ${item.status}`}>
              {CHECK_STATUS_ICON[item.status]} {item.label}
            </span>
          ))}
        </div>
      )}

      {commandLogs.length > 0 && (
        <details>
          <summary className="round-section-label round-summary">
            指令結果（{commandLogs.length}）▸
          </summary>
          {commandLogs.map((log) => (
            <CommandLogRow key={log.id} log={log} />
          ))}
        </details>
      )}

      {round.gitStatus && (
        <details>
          <summary className="round-section-label round-summary">git status ▸</summary>
          <pre className="round-pre">{round.gitStatus}</pre>
        </details>
      )}

      {round.gitDiff && (
        <details>
          <summary className="round-section-label round-summary">git diff --stat ▸</summary>
          <pre className="round-pre">{round.gitDiff}</pre>
        </details>
      )}

      {fileGuard && <FileGuardSection fileGuard={fileGuard} />}
    </div>
  );
}

/** 顯示檔案範圍檢查結果：狀態、各檔案清單、違規與錯誤。 */
function FileGuardSection({ fileGuard }: { fileGuard: FileGuardResult }) {
  return (
    <details className="file-guard" open={!fileGuard.ok}>
      <summary className="round-section-label round-summary">
        <span className={`verify-dot${fileGuard.ok ? " ok" : " fail"}`} />
        檔案範圍檢查（File Guard）：{fileGuard.ok ? "通過" : "未通過"} ▸
      </summary>

      {fileGuard.error && (
        <div className="file-guard-error">⚠ {fileGuard.error}</div>
      )}

      {fileGuard.violations.length > 0 && (
        <div className="file-guard-violations">
          <div className="round-section-label">違規（{fileGuard.violations.length}）</div>
          <ul className="file-guard-list">
            {fileGuard.violations.map((v, i) => (
              <li key={i} className="file-guard-violation">
                <span className="file-guard-violation-type">{v.type}</span>
                <code>{v.file}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <FileGuardFileList label="實際修改檔案" files={fileGuard.modifiedFiles} />
      <FileGuardFileList label="目標檔案" files={fileGuard.targetFiles} />
      <FileGuardFileList label="禁止修改檔案" files={fileGuard.forbiddenFiles} />
    </details>
  );
}

function FileGuardFileList({ label, files }: { label: string; files: string[] }) {
  return (
    <div className="file-guard-group">
      <div className="round-section-label">{label}（{files.length}）</div>
      {files.length === 0 ? (
        <div className="detail-empty-text">（無）</div>
      ) : (
        <ul className="file-guard-list">
          {files.map((f, i) => (
            <li key={i}><code>{f}</code></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CommandLogRow({ log }: { log: CommandLog }) {
  const ok = log.ok ?? log.exitCode === 0;
  const detail = log.stdout || log.stderr;
  return (
    <div className="command-log-row">
      <div className="command-log-head">
        <span className={`verify-dot${ok ? " ok" : " fail"}`} />
        <code>{log.command}</code>
        <span className="command-log-exit">exit {log.exitCode ?? "—"}</span>
        {typeof log.durationMs === "number" && (
          <span className="command-log-exit">{log.durationMs} ms</span>
        )}
      </div>
      {detail && <pre className="round-pre">{detail}</pre>}
    </div>
  );
}
