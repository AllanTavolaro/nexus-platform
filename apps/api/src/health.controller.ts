import { Controller, Get, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import Redis from "ioredis";
import { PrismaService } from "./prisma/prisma.service";

@ApiTags("health")
@Controller()
export class HealthController implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
  });

  constructor(private readonly prisma: PrismaService) {
    this.redis.on("error", () => undefined);
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  @Get("health")
  @ApiOperation({ summary: "Check whether the API process is responding" })
  health() {
    return { status: "ok", service: "nexus-api", timestamp: new Date().toISOString() };
  }

  @Get("health/ready")
  @ApiOperation({ summary: "Check whether the API dependencies are ready" })
  async readiness() {
    const [database, redis] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
    ]);
    const checks = {
      database: database.status === "fulfilled" ? "ok" : "unavailable",
      redis: redis.status === "fulfilled" ? "ok" : "unavailable",
    } as const;
    if (database.status === "rejected" || redis.status === "rejected") {
      throw new ServiceUnavailableException({ status: "not_ready", service: "nexus-api", checks });
    }
    return { status: "ready", service: "nexus-api", checks, timestamp: new Date().toISOString() };
  }
}
