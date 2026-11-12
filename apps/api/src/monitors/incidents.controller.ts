import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IncidentStatus } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionGuard } from "../auth/session.guard";
import { SessionUser } from "../auth/session-user";
import { PrismaService } from "../prisma/prisma.service";

@ApiTags("incidents")
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller("incidents")
export class IncidentsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "List recent incidents for the current organization" })
  list(@CurrentUser() user: SessionUser, @Query("status") status?: string) {
    if (status && !Object.values(IncidentStatus).includes(status as IncidentStatus)) {
      throw new BadRequestException("Status must be OPEN or RESOLVED.");
    }
    return this.prisma.incident.findMany({
      where: { organizationId: user.organizationId, ...(status ? { status: status as IncidentStatus } : {}) },
      include: {
        monitor: { select: { id: true, name: true, url: true } },
        events: { orderBy: { createdAt: "asc" }, select: { id: true, type: true, message: true, createdAt: true } },
      },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  }
}
