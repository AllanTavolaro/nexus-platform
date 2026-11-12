import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsRealtimeService } from "./notifications-realtime.service";

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsRealtimeService],
})
export class NotificationsModule {}
