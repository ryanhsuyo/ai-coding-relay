/**
 * 產生本機用的識別碼。
 *
 * 第一階段資料都存在本機，不需要全域唯一，只要在同一份 store 裡夠用即可。
 * 會優先使用 crypto.randomUUID()，環境不支援時退回時間戳 + 隨機字串。
 */
export function createId(prefix?: string): string {
  const base =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return prefix ? `${prefix}_${base}` : base;
}
