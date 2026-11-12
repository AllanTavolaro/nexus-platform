import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import Redis from "ioredis";

export const MONITOR_QUEUE = "monitor-checks";

@Injectable()
export class MonitorQueueService implements OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  private readonly queue = new Queue<{ monitorId: string }>(MONITOR_QUEUE, { connection: this.connection });

  async schedule(monitorId: string, intervalSec: number) {
    const template = {
      name: "monitor-check",
      data: { monitorId },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    };
    await this.queue.upsertJobScheduler(`monitor-${monitorId}`, { every: intervalSec * 1000 }, template);
  }

  async removeSchedule(monitorId: string) {
    await this.queue.removeJobScheduler(`monitor-${monitorId}`);
  }

  async checkNow(monitorId: string) {
    const bucket = Math.floor(Date.now() / 5000);
    await this.queue.add("monitor-check", { monitorId }, {
      jobId: `manual-${monitorId}-${bucket}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
