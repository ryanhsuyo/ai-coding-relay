import { useState } from "react";
import "./App.css";
import { useTasks } from "./hooks/useTasks";
import { TaskSidebar } from "./components/TaskSidebar";
import { TaskDetail } from "./components/TaskDetail";
import { TaskForm } from "./components/TaskForm";
import { taskToFormValues } from "./core/taskService";
import { updatePreferences } from "./storage/preferenceStorage";

function App() {
  const store = useTasks();
  const [showForm, setShowForm] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  // 「建立並執行 auto-round」：記住要在進入 TaskDetail 後自動觸發 auto-round 的任務 id。
  // TaskDetail 觸發後會呼叫 onAutoRunConsumed 清空，避免重複執行。
  const [pendingAutoRoundTaskId, setPendingAutoRoundTaskId] = useState<string | null>(null);

  return (
    <div className="app-layout">
      <TaskSidebar
        tasks={store.tasks}
        rounds={store.rounds}
        selectedTaskId={store.selectedTaskId}
        onSelect={store.selectTask}
        onAdd={() => setShowForm(true)}
        onExport={store.exportTasks}
        onImport={(json) => {
          try {
            store.importTasks(json);
          } catch (e) {
            alert(`匯入失敗：${e instanceof Error ? e.message : "未知錯誤"}`);
          }
        }}
      />

      <main className="app-main">
        <TaskDetail
          task={store.selectedTask}
          rounds={store.selectedTaskRounds}
          autoRunOnMount={
            store.selectedTask !== null && store.selectedTask.id === pendingAutoRoundTaskId
          }
          onAutoRunConsumed={() => setPendingAutoRoundTaskId(null)}
          onAddRound={(prompt, claudeResponse) => {
            if (!store.selectedTask) return;
            const round = store.addRound(store.selectedTask.id, prompt);
            store.editRound(round.id, { claudeResponse });
          }}
          onEditRound={store.editRound}
          onSaveSummary={(summary) => {
            if (store.selectedTask) store.saveSummary(store.selectedTask.id, summary);
          }}
          onSetTaskStatus={(status) => {
            if (store.selectedTask) store.setTaskStatus(store.selectedTask.id, status);
          }}
          onSetTaskPriority={(priority) => {
            if (store.selectedTask) store.setTaskPriority(store.selectedTask.id, priority);
          }}
          onSetDueDate={(dueDate) => {
            if (store.selectedTask) store.setDueDate(store.selectedTask.id, dueDate);
          }}
          onSetReviewResult={(reviewResult) => {
            if (store.selectedTask) store.editTask(store.selectedTask.id, { reviewResult });
          }}
          onSetWorkflowStage={(workflowStage) => {
            if (store.selectedTask) store.editTask(store.selectedTask.id, { workflowStage });
          }}
          onApplyCompletion={(summaryText) => {
            if (!store.selectedTask) return;
            // 一鍵套用完成狀態：保存目前摘要 + status=done/passed/done + completedAt + 完成紀錄事件。不封存。
            store.applyCompletion(store.selectedTask.id, summaryText);
          }}
          onSaveTitle={(title) => {
            if (store.selectedTask) store.editTask(store.selectedTask.id, { title });
          }}
          onSaveRequirement={(req) => {
            if (store.selectedTask) store.editTask(store.selectedTask.id, { originalRequirement: req });
          }}
          onSaveTags={(tagsText) => {
            if (store.selectedTask) store.editTask(store.selectedTask.id, { tagsText });
          }}
          onSaveProject={(project) => {
            if (store.selectedTask) store.editTask(store.selectedTask.id, { project });
          }}
          onSaveClaudeResponse={(value) => {
            if (store.selectedTask) store.saveClaudeResponse(store.selectedTask.id, value);
          }}
          onSaveNextActions={(value) => {
            if (store.selectedTask) store.saveNextActions(store.selectedTask.id, value);
          }}
          onSaveSpecDraft={(value) => {
            if (store.selectedTask) store.saveSpecDraft(store.selectedTask.id, value);
          }}
          onSaveAiWorkflow={(aiWorkflow) => {
            if (store.selectedTask) store.saveAiWorkflow(store.selectedTask.id, aiWorkflow);
          }}
          onApplyCeReadonlyWorkflow={(aiWorkflow) => {
            if (store.selectedTask) store.applyCeReadonlyWorkflow(store.selectedTask.id, aiWorkflow);
          }}
          onApplyCeWorkResult={(result) => {
            if (store.selectedTask) store.applyCeWorkResult(store.selectedTask.id, result);
          }}
          onApplyCeReviewResult={(result) => {
            if (store.selectedTask) store.applyCeReviewResult(store.selectedTask.id, result);
          }}
          onApplyCeFixWorkResult={(result) => {
            if (store.selectedTask) store.applyCeFixWorkResult(store.selectedTask.id, result);
          }}
          onImportVerification={(jsonText) => {
            if (store.selectedTask) store.importVerificationResult(store.selectedTask.id, jsonText);
          }}
          onArchiveTask={() => {
            if (store.selectedTask) store.archiveTask(store.selectedTask.id);
          }}
          onRestoreTask={() => {
            if (store.selectedTask) store.restoreTask(store.selectedTask.id);
          }}
          onEditTask={() => setShowEditForm(true)}
          onDuplicateTask={() => {
            if (store.selectedTask) {
              const copy = store.duplicateTask(store.selectedTask.id);
              if (copy) store.selectTask(copy.id);
            }
          }}
          onDeleteTask={() => {
            if (store.selectedTask) store.deleteTask(store.selectedTask.id);
          }}
        />
      </main>

      {showForm && (
        <TaskForm
          onSubmit={(values) => {
            const task = store.addTask(values);
            store.selectTask(task.id);
            // 記錄這次使用的 project / tagsText，下次開啟新增表單時帶入
            updatePreferences({
              lastProject: values.project ?? "",
              lastTagsText: values.tagsText ?? "",
            });
            setShowForm(false);
          }}
          onCreateAndRun={(values) => {
            // 建立任務 → 選中 → 標記為待自動執行 auto-round（TaskDetail mount 後觸發一次）。
            const task = store.addTask(values);
            store.selectTask(task.id);
            setPendingAutoRoundTaskId(task.id);
            updatePreferences({
              lastProject: values.project ?? "",
              lastTagsText: values.tagsText ?? "",
            });
            setShowForm(false);
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {showEditForm && store.selectedTask && (
        <TaskForm
          mode="edit"
          initialValues={taskToFormValues(store.selectedTask)}
          onSubmit={(values) => {
            if (store.selectedTask) store.editTask(store.selectedTask.id, values);
            setShowEditForm(false);
          }}
          onCancel={() => setShowEditForm(false)}
        />
      )}
    </div>
  );
}

export default App;
