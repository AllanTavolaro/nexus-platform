import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { IncidentStatus, MembershipRole, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SessionUser } from "../auth/session-user";
import { CreateMonitorDto, UpdateMonitorDto } from "./monitor.dto";
import { MonitorQueueService } from "./monitor-queue.service";

const latestCheckInclude = { checks: { select: { id: true, success: true, statusCode: true, latencyMs: true, checkedAt: true, error: true }, orderBy: { checkedAt: "desc" as const }, take: 1 } };

@Injectable()
export class MonitorsService {
  constructor(private readonly prisma: PrismaService, private readonly queue: MonitorQueueService) {}

  async list(user: SessionUser) {
    const monitors = await this.prisma.monitor.findMany({
      where: { organizationId: user.organizationId },
      include: latestCheckInclude,
      orderBy: { createdAt: "desc" },
    });
    if (monitors.length === 0) return [];

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const where: Prisma.MonitorCheckWhereInput = { monitorId: { in: monitors.map((monitor) => monitor.id) }, checkedAt: { gte: since } };
    const [totals, successes] = await Promise.all([
      this.prisma.monitorCheck.groupBy({ by: ["monitorId"], where, _count: { _all: true } }),
      this.prisma.monitorCheck.groupBy({ by: ["monitorId"], where: { ...where, success: true }, _count: { _all: true } }),
    ]);
    const totalMap = new Map(totals.map((row) => [row.monitorId, row._count._all]));
    const successMap = new Map(successes.map((row) => [row.monitorId, row._count._all]));

    return monitors.map((monitor) => {
      const lastCheck = monitor.checks[0] ?? null;
      const total = totalMap.get(monitor.id) ?? 0;
      const successful = successMap.get(monitor.id) ?? 0;
      return {
        id: monitor.id,
        name: monitor.name,
        url: monitor.url,
        intervalSec: monitor.intervalSec,
        isActive: monitor.isActive,
        createdAt: monitor.createdAt,
        lastCheck,
        uptimePercent: total ? (successful / total) * 100 : null,
      };
    });
  }

  async create(user: SessionUser, input: CreateMonitorDto) {
    this.requireWriteAccess(user);
    const url = this.normalizeUrl(input.url);
    const monitor = await this.prisma.monitor.create({
      data: {
        organizationId: user.organizationId,
        name: input.name,
        url,
        intervalSec: input.intervalSec ?? 60,
      },
    });
    try {
      await this.queue.schedule(monitor.id, monitor.intervalSec);
    } catch {
      try { await this.queue.removeSchedule(monitor.id); } catch { /* The scheduler may not have been created. */ }
      await this.prisma.monitor.delete({ where: { id: monitor.id } });
      throw new ServiceUnavailableException("The monitoring queue is not available. Try again shortly.");
    }
    try { await this.queue.checkNow(monitor.id); } catch { /* The recurring scheduler will perform the next check. */ }
    return monitor;
  }

  async update(user: SessionUser, id: string, input: UpdateMonitorDto) {
    this.requireWriteAccess(user);
    const current = await this.findOwned(user, id);
    const data: Prisma.MonitorUpdateInput = { ...input };
    if (input.url) data.url = this.normalizeUrl(input.url);
    const scheduleChanged = input.isActive !== undefined || input.intervalSec !== undefined;
    const updated = await this.prisma.monitor.update({ where: { id: current.id }, data });
    if (!scheduleChanged) return updated;

    try {
      if (updated.isActive) await this.queue.schedule(updated.id, updated.intervalSec);
      else await this.queue.removeSchedule(updated.id);
    } catch {
      await this.prisma.monitor.update({
        where: { id: current.id },
        data: { name: current.name, url: current.url, isActive: current.isActive, intervalSec: current.intervalSec },
      });
      try {
        if (current.isActive) await this.queue.schedule(current.id, current.intervalSec);
        else await this.queue.removeSchedule(current.id);
      } catch {
        // Keep the saved settings consistent; the next update can reconcile the scheduler.
      }
      throw new ServiceUnavailableException("The monitoring queue could not be updated. Please retry.");
    }
    return updated;
  }

  async remove(user: SessionUser, id: string) {
    this.requireWriteAccess(user);
    const monitor = await this.findOwned(user, id);
    try {
      await this.queue.removeSchedule(monitor.id);
    } catch {
      throw new ServiceUnavailableException("The monitoring schedule could not be removed. Please retry.");
    }
    try {
      await this.prisma.monitor.delete({ where: { id: monitor.id } });
    } catch (error) {
      if (monitor.isActive) {
        try { await this.queue.schedule(monitor.id, monitor.intervalSec); } catch { /* A later retry can reconcile this schedule. */ }
      }
      throw error;
    }
    return { status: "deleted" };
  }

  async checkNow(user: SessionUser, id: string) {
    this.requireWriteAccess(user);
    const monitor = await this.findOwned(user, id);
    if (!monitor.isActive) throw new BadRequestException("This monitor is paused.");
    try {
      await this.queue.checkNow(monitor.id);
    } catch {
      throw new ServiceUnavailableException("The monitoring queue is not available. Try again shortly.");
    }
    return { status: "queued" };
  }

  async history(user: SessionUser, id: string, limit = 50) {
    await this.findOwned(user, id);
    return this.prisma.monitorCheck.findMany({
      where: { monitor: { organizationId: user.organizationId, id } },
      select: { id: true, checkedAt: true, success: true, statusCode: true, latencyMs: true, error: true },
      orderBy: { checkedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  private async findOwned(user: SessionUser, id: string) {
    const monitor = await this.prisma.monitor.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!monitor) throw new NotFoundException("Monitor not found.");
    return monitor;
  }

  private requireWriteAccess(user: SessionUser) {
    if (user.role === MembershipRole.VIEWER) throw new ForbiddenException("Your role cannot change monitors.");
  }

  private normalizeUrl(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException("Enter a valid HTTP or HTTPS URL.");
    }
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || !url.hostname) {
      throw new BadRequestException("Only credential-free HTTP or HTTPS URLs are supported.");
    }
    const expectedPort = url.protocol === "http:" ? "80" : "443";
    if (url.port && url.port !== expectedPort) throw new BadRequestException("Only standard HTTP and HTTPS ports are allowed.");
    url.hash = "";
    return url.toString();
  }
}
