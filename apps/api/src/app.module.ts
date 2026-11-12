import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AnalysisModule } from "./analysis/analysis.module";
import { AuthModule } from "./auth/auth.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { HealthController } from "./health.controller";
import { MonitorsModule } from "./monitors/monitors.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RateLimitGuard } from "./security/rate-limit.guard";
import { ScenariosModule } from "./scenarios/scenarios.module";

@Module({
  imports: [PrismaModule, AuthModule, AnalysisModule, MonitorsModule, DashboardModule, NotificationsModule, ScenariosModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
