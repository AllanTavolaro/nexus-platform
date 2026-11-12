import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import Redis from "ioredis";

type RateLimitBucket = { scope: "ip" | "account"; max: number; windowMs: number };
type RequestWithBody = Request & { body?: Record<string, unknown> };

const policies: Record<string, RateLimitBucket[]> = {
  "POST /api/auth/register": [{ scope: "ip", max: 5, windowMs: 60 * 60 * 1000 }],
  "POST /api/auth/login": [
    { scope: "ip", max: 30, windowMs: 15 * 60 * 1000 },
    { scope: "account", max: 10, windowMs: 15 * 60 * 1000 },
  ],
  "POST /api/analysis/incidents": [{ scope: "ip", max: 10, windowMs: 60 * 60 * 1000 }],
};

const incrementWindowScript = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return { count, redis.call('PTTL', KEYS[1]) }
`;

@Injectable()
export class RateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
  });

  constructor() {
    this.redis.on("error", () => undefined);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithBody>();
    const response = http.getResponse<Response>();
    const path = canonicalPath(request.path);
    const buckets = policies[`${request.method.toUpperCase()} ${path}`];
    if (!buckets) return true;

    const clientIp = request.ip || request.socket.remoteAddress;
    if (!clientIp) throw new ServiceUnavailableException("Request throttling is unavailable.");

    const prefix = safePrefix(process.env.RATE_LIMIT_PREFIX);
    const violations: number[] = [];
    try {
      for (const bucket of buckets) {
        const identity = bucket.scope === "ip" ? clientIp : normalizeAccount(request.body?.email);
        if (!identity) continue;
        const digest = createHash("sha256").update(identity).digest("hex");
        const key = `${prefix}:${routeName(path)}:${bucket.scope}:${digest}`;
        const result = await this.redis.eval(incrementWindowScript, 1, key, String(bucket.windowMs)) as [number, number];
        const count = Number(result[0]);
        const ttlMs = Number(result[1]);
        if (count > bucket.max) violations.push(Math.max(1, Math.ceil(ttlMs / 1000)));
      }
    } catch {
      throw new ServiceUnavailableException("Request throttling is temporarily unavailable.");
    }

    if (violations.length) {
      response.setHeader("Retry-After", String(Math.max(...violations)));
      throw new HttpException("Too many requests. Retry after the indicated delay.", HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}

function normalizeAccount(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email ? `account:${email}` : undefined;
}

function safePrefix(value: string | undefined): string {
  const prefix = value?.replace(/[^a-zA-Z0-9:_-]/g, "");
  return prefix || "nexus:rate-limit";
}

function routeName(path: string): string {
  return path.replace(/[^a-zA-Z0-9/_-]/g, "_");
}

function canonicalPath(path: string): string {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Keep malformed paths separate from protected routes. */ }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}
