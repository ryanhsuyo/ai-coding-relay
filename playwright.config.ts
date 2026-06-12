import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright 設定：驗證 SDD + TDD + Refactor 半自動流程的核心 UI 行為。
 * 由 `pnpm test:e2e` 執行；會自動啟動 vite dev server（port 1420）。
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:1420",
    // 流程會用 navigator.clipboard 複製 / 讀取各種 Prompt，需要剪貼簿權限
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
