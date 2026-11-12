import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import Redis from "ioredis";

export const API_SCENARIO_QUEUE = "api-scenario-runs";
type ApiScenarioJob = { runId: string } | { scenarioId: string } | { runIds: string[] };

@Injectable()
export class ScenarioQueueService implements OnModuleDestroy {
  private readonly connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  private readonly queue = new Queue<ApiScenarioJob>(API_SCENARIO_QUEUE, { connection: this.connection });

  async enqueue(runId: string) {
    await this.queue.add("api-scenario-run", { runId }, {
      jobId: `api-scenario-${runId}`,
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  async enqueueSequence(runIds: string[]) {
    if (!runIds.length) throw new Error("A sequential scenario job needs at least one run.");
    await this.queue.add("api-scenario-sequence", { runIds }, {
      jobId: `api-scenario-sequence-${runIds[0]}`,
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  async schedule(scenarioId: string, intervalSec: number) {
    await this.queue.upsertJobScheduler(`api-scenario-${scenarioId}`, { every: intervalSec * 1000 }, {
      name: "api-scenario-scheduled",
      data: { scenarioId },
      opts: { removeOnComplete: 1000, removeOnFail: 1000 },
    });
  }

  async removeSchedule(scenarioId: string) {
    await this.queue.removeJobScheduler(`api-scenario-${scenarioId}`);
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
