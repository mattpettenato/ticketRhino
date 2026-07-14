import { expect, test, vi } from "vitest";

vi.mock("@ticketrhino/core", async (orig) => ({
  ...(await orig()) as object,
  dbHttp: vi.fn(() => ({})),
  tmClient: vi.fn(() => ({})),
  sgClient: vi.fn(() => ({})),
  runPollCycle: vi.fn().mockResolvedValue({ polled: 1, failed: 0 }),
  runNightly: vi.fn().mockResolvedValue(undefined),
}));
import worker from "../src/index";
import { runNightly, runPollCycle } from "@ticketrhino/core";

const env = { DATABASE_URL: "postgres://x", TM_API_KEY: "k", SG_CLIENT_ID: "c" } as any;
const ctx = { waitUntil: (p: Promise<unknown>) => p } as any;

test("10-min cron runs poll cycle; 5am cron runs nightly", async () => {
  await worker.scheduled({ cron: "*/10 * * * *" } as any, env, ctx);
  expect(runPollCycle).toHaveBeenCalledTimes(1);
  await worker.scheduled({ cron: "0 5 * * *" } as any, env, ctx);
  expect(runNightly).toHaveBeenCalledTimes(1);
});
