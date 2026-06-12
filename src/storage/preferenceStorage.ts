import { PREFERENCES_KEY } from "./storageKeys";

/** 任務清單的排序欄位，與 TaskSidebar 的排序選項對應。 */
export type SortKey = "priority" | "dueDate" | "status" | "createdAt";

/**
 * 使用者偏好設定。存在獨立的 localStorage key（PREFERENCES_KEY），
 * 與任務資料（TASK_STORE_KEY）完全分開，因此不影響 tasks 的匯出 / 匯入。
 */
export type Preferences = {
  /** 上次新增任務使用的專案分類。 */
  lastProject: string;
  /** 上次新增任務使用的標籤文字（逗號分隔）。 */
  lastTagsText: string;
  /** 上次選擇的任務清單排序。 */
  sortKey: SortKey;
};

const SORT_KEYS: readonly SortKey[] = ["priority", "dueDate", "status", "createdAt"];

const DEFAULT_PREFERENCES: Preferences = {
  lastProject: "",
  lastTagsText: "",
  sortKey: "priority",
};

function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && (SORT_KEYS as readonly string[]).includes(value);
}

/** 讀取偏好設定；缺漏或格式錯誤的欄位會回退為預設值。 */
export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_PREFERENCES };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      lastProject:
        typeof obj.lastProject === "string" ? obj.lastProject : DEFAULT_PREFERENCES.lastProject,
      lastTagsText:
        typeof obj.lastTagsText === "string" ? obj.lastTagsText : DEFAULT_PREFERENCES.lastTagsText,
      sortKey: isSortKey(obj.sortKey) ? obj.sortKey : DEFAULT_PREFERENCES.sortKey,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** 覆寫整份偏好設定。 */
export function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略寫入失敗（例如 localStorage 已滿或被停用）
  }
}

/** 局部更新偏好設定：先讀取目前值，套用 patch 後存回，並回傳更新後的結果。 */
export function updatePreferences(patch: Partial<Preferences>): Preferences {
  const next: Preferences = { ...loadPreferences(), ...patch };
  savePreferences(next);
  return next;
}

/**
 * 清除偏好設定：移除 PREFERENCES_KEY 對應的 localStorage。
 * 只動偏好設定，不影響任務（TASK_STORE_KEY）的 tasks / rounds 資料。
 * 清除後 loadPreferences() 會回退為 DEFAULT_PREFERENCES。
 */
export function clearPreferences(): void {
  try {
    localStorage.removeItem(PREFERENCES_KEY);
  } catch {
    // 忽略移除失敗（例如 localStorage 被停用）
  }
}
