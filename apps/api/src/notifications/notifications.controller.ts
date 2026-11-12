import { BadRequestException, Body, ConflictException, Controller, Get, MessageEvent, NotFoundException, Param, Patch, Sse, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Observable } from "rxjs";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionGuard } from "../auth/session.guard";
import { SessionUser } from "../auth/session-user";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRealtimeService } from "./notifications-realtime.service";

@ApiTags("notifications")
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly prisma: PrismaService, private readonly realtime: NotificationsRealtimeService) {}

  @Get()
  @ApiOperation({ summary: "List recent notifications for the current organization" })
  async list(@CurrentUser() user: SessionUser) {
    const incidentWhere = {
      userId: user.id,
      event: { is: { incident: { is: { organizationId: user.organizationId } } } },
    };
    const scenarioWhere = { userId: user.id, scenario: { is: { organizationId: user.organizationId } } };
    const [incidents, scenarios, unreadIncidents, unreadScenarios, preferences] = await Promise.all([
      this.prisma.incidentNotification.findMany({
        where: incidentWhere,
        include: {
          event: {
            select: {
              id: true,
              type: true,
              message: true,
              createdAt: true,
              incident: {
                select: {
                  id: true,
                  title: true,
                  status: true,
                  monitor: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      this.prisma.apiScenarioNotification.findMany({
        where: scenarioWhere,
        include: {
          scenario: { select: { id: true, name: true, method: true } },
          run: { select: { status: true, responseStatusCode: true, responseTimeMs: true, error: true, completedAt: true, queuedAt: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      this.prisma.incidentNotification.count({ where: { ...incidentWhere, readAt: null } }),
      this.prisma.apiScenarioNotification.count({ where: { ...scenarioWhere, readAt: null } }),
      this.prisma.user.findUnique({ where: { id: user.id }, select: { emailAlertsEnabled: true } }),
    ]);
    const items = [
      ...incidents.map((item) => ({ ...item, kind: "INCIDENT" as const })),
      ...scenarios.map((item) => ({ ...item, kind: "SCENARIO" as const })),
    ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).slice(0, 20);
    return {
      items,
      unreadCount: unreadIncidents + unreadScenarios,
      emailPreferences: {
        emailAlertsEnabled: preferences?.emailAlertsEnabled ?? false,
        deliveryConfigured: this.isEmailDeliveryConfigured(),
      },
    };
  }

  @Sse("stream")
  @ApiOperation({ summary: "Stream notification changes for the current organization" })
  stream(@CurrentUser() user: SessionUser): Observable<MessageEvent> {
    return this.realtime.stream(user.organizationId);
  }

  @Patch("email-preferences")
  @ApiOperation({ summary: "Update the current user's email alert preference" })
  async updateEmailPreference(@CurrentUser() user: SessionUser, @Body() body: { emailAlertsEnabled?: unknown }) {
    if (!body || typeof body.emailAlertsEnabled !== "boolean") {
      throw new BadRequestException("emailAlertsEnabled must be a boolean.");
    }
    if (body.emailAlertsEnabled && !this.isEmailDeliveryConfigured()) {
      throw new ConflictException("Email delivery is not configured yet.");
    }
    const preference = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailAlertsEnabled: body.emailAlertsEnabled },
      select: { emailAlertsEnabled: true },
    });
    return { ...preference, deliveryConfigured: this.isEmailDeliveryConfigured() };
  }

  @Patch("read-all")
  @ApiOperation({ summary: "Mark all notifications in the current organization as read" })
  async markAllRead(@CurrentUser() user: SessionUser) {
    const incidentResult = await this.prisma.incidentNotification.updateMany({
      where: {
        userId: user.id,
        readAt: null,
        event: { is: { incident: { is: { organizationId: user.organizationId } } } },
      },
      data: { readAt: new Date() },
    });
    const scenarioResult = await this.prisma.apiScenarioNotification.updateMany({
      where: {
        userId: user.id,
        readAt: null,
        scenario: { is: { organizationId: user.organizationId } },
      },
      data: { readAt: new Date() },
    });
    const updated = incidentResult.count + scenarioResult.count;
    if (updated) await this.realtime.publishUpdate(user.organizationId);
    return { updated };
  }

  @Patch(":id/read")
  @ApiOperation({ summary: "Mark a notification as read" })
  async markRead(@CurrentUser() user: SessionUser, @Param("id") id: string) {
    const incident = await this.prisma.incidentNotification.findFirst({
      where: {
        id,
        userId: user.id,
        event: { is: { incident: { is: { organizationId: user.organizationId } } } },
      },
      select: { id: true },
    });
    if (incident) {
      await this.prisma.incidentNotification.updateMany({
        where: { id: incident.id, userId: user.id, readAt: null },
        data: { readAt: new Date() },
      });
      await this.realtime.publishUpdate(user.organizationId);
      return { ok: true };
    }
    const scenario = await this.prisma.apiScenarioNotification.findFirst({
      where: { id, userId: user.id, scenario: { is: { organizationId: user.organizationId } } },
      select: { id: true },
    });
    if (!scenario) throw new NotFoundException("Notification not found.");
    await this.prisma.apiScenarioNotification.updateMany({
      where: { id: scenario.id, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    await this.realtime.publishUpdate(user.organizationId);
    return { ok: true };
  }

  private isEmailDeliveryConfigured() {
    return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());
  }
}
