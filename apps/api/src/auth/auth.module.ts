import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionGuard } from "./session.guard";

@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: process.env.JWT_SECRET }) })],
  controllers: [AuthController],
  providers: [AuthService, SessionGuard],
  exports: [SessionGuard, JwtModule],
})
export class AuthModule {}
