import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ScenariosController } from "./scenarios.controller";
import { ScenarioQueueService } from "./scenario-queue.service";
import { ScenarioSecretsController } from "./scenario-secrets.controller";
import { ScenarioSecretsService } from "./scenario-secrets.service";
import { ScenariosService } from "./scenarios.service";

@Module({
  imports: [AuthModule],
  controllers: [ScenariosController, ScenarioSecretsController],
  providers: [ScenariosService, ScenarioQueueService, ScenarioSecretsService],
})
export class ScenariosModule {}
