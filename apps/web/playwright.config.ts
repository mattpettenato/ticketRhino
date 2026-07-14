import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "pnpm dev --port 3100",
    port: 3100,
    reuseExistingServer: true,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@localhost:5433/postgres",
      TM_API_KEY: process.env.TM_API_KEY ?? "unset",
      SG_CLIENT_ID: process.env.SG_CLIENT_ID ?? "unset",
    },
  },
});
