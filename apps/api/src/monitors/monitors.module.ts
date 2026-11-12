import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { IncidentsController } from "./incidents.controller";
import { MonitorQueueService } from "./monitor-queue.service";
import { MonitorsController } from "./monitors.controller";
import { MonitorsService } from "./monitors.service";

@Module({
  imports: [AuthModule],
  controllers: [MonitorsController, IncidentsController],
  providers: [MonitorsService, MonitorQueueService],
})
export class MonitorsModule {}

