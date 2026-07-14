import { dbHttp, runNightly, runPollCycle, sgClient, tmClient } from "@ticketrhino/core";

export interface Env { DATABASE_URL: string; TM_API_KEY: string; SG_CLIENT_ID: string }

export default {
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const db = dbHttp(env.DATABASE_URL);
    const tm = tmClient(env.TM_API_KEY);
    const sg = sgClient(env.SG_CLIENT_ID);
    if (event.cron === "0 5 * * *") {
      await runNightly(db, tm, sg);
    } else {
      const res = await runPollCycle(db, tm, sg);
      console.log(`poll cycle: ${res.polled} ok, ${res.failed} failed`);
    }
  },
};
