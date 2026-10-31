import { Cron } from "croner";
import type { Service } from "../core/service.js";

// In-process scheduler (no Redis). Each job is protected against overlapping runs.

export function startScheduler(svc: Service): () => void {
  const jobs: Cron[] = [];
  const every = (pattern: string, name: string, fn: () => Promise<unknown>) =>
    jobs.push(
      new Cron(pattern, { protect: true, catch: (e) => svc.log.warn({ job: name, err: (e as Error).message }, "job failed") }, async () => {
        await fn();
      }),
    );

  if (svc.config.pollEnabled) {
    every("*/2 * * * *", "poll:dm", () => svc.sync({ src: "ig.dm", force: true }));
    every("1-59/5 * * * *", "poll:cm", () => svc.sync({ src: "ig.cm", force: true }));
    every("3-59/15 * * * *", "poll:mn", () => svc.sync({ src: "ig.mn", force: true }));
  }
  every("* * * * *", "outbox", () => svc.retryDue());
  every("17 3 * * *", "retention", async () => svc.log.info(svc.purge(), "retention purge"));

  return () => jobs.forEach((j) => j.stop());
}
