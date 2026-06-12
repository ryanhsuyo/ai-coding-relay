import { describe, it, expect, beforeEach } from "vitest";
import { loadPreferences, updatePreferences, clearPreferences } from "./preferenceStorage";
import { PREFERENCES_KEY } from "./storageKeys";

const DEFAULTS = { lastProject: "", lastTagsText: "", sortKey: "priority" } as const;

beforeEach(() => {
  localStorage.clear();
});

describe("loadPreferences", () => {
  it("沒有任何資料時回傳預設值", () => {
    expect(loadPreferences()).toEqual(DEFAULTS);
  });

  it("壞掉的 JSON 字串會回退預設值", () => {
    localStorage.setItem(PREFERENCES_KEY, "{ this is not valid json");
    expect(loadPreferences()).toEqual(DEFAULTS);
  });

  it("JSON 是陣列（非物件）時回退預設值", () => {
    localStorage.setItem(PREFERENCES_KEY, "[1, 2, 3]");
    expect(loadPreferences()).toEqual(DEFAULTS);
  });

  it("JSON 是 null 時回退預設值", () => {
    localStorage.setItem(PREFERENCES_KEY, "null");
    expect(loadPreferences()).toEqual(DEFAULTS);
  });

  it("sortKey 不合法時只該欄位回退，其餘合法欄位保留", () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ lastProject: "p", lastTagsText: "t", sortKey: "不是合法值" })
    );
    expect(loadPreferences()).toEqual({ lastProject: "p", lastTagsText: "t", sortKey: "priority" });
  });

  it("非字串的 lastProject / lastTagsText 會回退為空字串", () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ lastProject: 123, lastTagsText: null, sortKey: "dueDate" })
    );
    expect(loadPreferences()).toEqual({ lastProject: "", lastTagsText: "", sortKey: "dueDate" });
  });

  it("完整且合法的偏好設定會原樣讀出", () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ lastProject: "my-app", lastTagsText: "frontend, bug", sortKey: "status" })
    );
    expect(loadPreferences()).toEqual({
      lastProject: "my-app",
      lastTagsText: "frontend, bug",
      sortKey: "status",
    });
  });
});

describe("updatePreferences", () => {
  it("可局部更新單一欄位，其餘欄位維持原值", () => {
    updatePreferences({ lastProject: "my-app" });
    expect(loadPreferences()).toEqual({
      lastProject: "my-app",
      lastTagsText: "",
      sortKey: "priority",
    });
    updatePreferences({ sortKey: "dueDate" });
    expect(loadPreferences()).toEqual({
      lastProject: "my-app",
      lastTagsText: "",
      sortKey: "dueDate",
    });
  });

  it("回傳合併後的完整偏好設定", () => {
    const result = updatePreferences({ lastTagsText: "tag1" });
    expect(result).toEqual({ lastProject: "", lastTagsText: "tag1", sortKey: "priority" });
  });
});

describe("clearPreferences", () => {
  it("會移除 localStorage 中的偏好設定，之後讀取回到預設值", () => {
    updatePreferences({ lastProject: "x", lastTagsText: "y", sortKey: "status" });
    expect(localStorage.getItem(PREFERENCES_KEY)).not.toBeNull();

    clearPreferences();

    expect(localStorage.getItem(PREFERENCES_KEY)).toBeNull();
    expect(loadPreferences()).toEqual(DEFAULTS);
  });
});
