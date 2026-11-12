import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service";
import { SessionGuard } from "../auth/session.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionUser } from "../auth/session-user";

type HourlyAvailabilityRow = {
  hourIndex: number;
  checks: number;
  successfulChecks: number;
};

@ApiTags("dashboard")
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "Return monitoring metrics for the current organization" })
  async summary(@CurrentUser() user: SessionUser) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const monitorWhere = { organizationId: user.organizationId };
    const checkWhere = { monitor: monitorWhere, checkedAt: { gte: since } };
    const [totalMonitors, activeMonitors, totalChecks, successfulChecks, latency, activeIncidents] = await Promise.all([
      this.prisma.monitor.count({ where: monitorWhere }),
      this.prisma.monitor.count({ where: { ...monitorWhere, isActive: true } }),
      this.prisma.monitorCheck.count({ where: checkWhere }),
      this.prisma.monitorCheck.count({ where: { ...checkWhere, success: true } }),
      this.prisma.monitorCheck.aggregate({ where: checkWhere, _avg: { latencyMs: true } }),
      this.prisma.incident.count({ where: { organizationId: user.organizationId, status: "OPEN" } }),
    ]);
    return {
      totalMonitors,
      activeMonitors,
      checks24h: totalChecks,
      availabilityPercent: totalChecks ? (successfulChecks / totalChecks) * 100 : null,
      averageLatencyMs: latency._avg.latencyMs,
      activeIncidents,
    };
  }

  @Get("availability")
  @ApiOperation({ summary: "Return hourly availability for the current organization" })
  async availability(@CurrentUser() user: SessionUser) {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const rows = await this.prisma.$queryRaw<HourlyAvailabilityRow[]>`
      SELECT FLOOR(EXTRACT(EPOCH FROM (check_row."checkedAt" - ${windowStart})) / 3600)::int AS "hourIndex",
             COUNT(*)::int AS "checks",
             COUNT(*) FILTER (WHERE check_row."success")::int AS "successfulChecks"
      FROM "MonitorCheck" AS check_row
      INNER JOIN "Monitor" AS monitor ON monitor."id" = check_row."monitorId"
      WHERE monitor."organizationId" = ${user.organizationId}
        AND check_row."checkedAt" >= ${windowStart}
        AND check_row."checkedAt" < ${now}
      GROUP BY "hourIndex"
      ORDER BY "hourIndex" ASC
    `;

    const rowsByHour = new Map<number, HourlyAvailabilityRow>();
    rows.forEach((row) => rowsByHour.set(row.hourIndex, row));

    const points = Array.from({ length: 24 }, (_, index) => {
      const at = new Date(windowStart.getTime() + (index + 0.5) * 60 * 60 * 1000);
      const row = rowsByHour.get(index);
      const checks = row?.checks ?? 0;
      const successfulChecks = row?.successfulChecks ?? 0;
      return {
        at: at.toISOString(),
        checks,
        availabilityPercent: checks ? (successfulChecks / checks) * 100 : null,
      };
    });

    return { periodHours: 24, windowStart: windowStart.toISOString(), windowEnd: now.toISOString(), points };
  }
}
