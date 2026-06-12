/** 將字串陣列轉成帶編號的清單，空陣列時輸出「（無）」。 */
export function renderTextList(title: string, items: string[]): string {
  if (items.length === 0) {
    return `${title}\n（無）`;
  }
  const body = items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  return `${title}\n${body}`;
}

/** 選填欄位：有值時輸出，沒有值時輸出「（無）」。 */
export function renderOptionalText(title: string, value?: string): string {
  const content = value?.trim();
  return `${title}\n${content && content.length > 0 ? content : "（無）"}`;
}
