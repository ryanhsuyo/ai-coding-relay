/**
 * 日期/時間工具。
 *
 * 任務與回合紀錄的時間欄位一律存 ISO 字串（getNowIso），
 * 要顯示給使用者時再用 formatDateTime 轉成本地可讀格式。
 */

/** 取得目前時間的 ISO 8601 字串，用於 createdAt / updatedAt 等欄位。 */
export function getNowIso(): string {
  return new Date().toISOString();
}

/**
 * 將 ISO 字串格式化成本地可讀的日期時間。
 * 若傳入的值無法解析，原樣回傳，避免畫面壞掉。
 */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
