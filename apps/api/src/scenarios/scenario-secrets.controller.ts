import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionGuard } from "../auth/session.guard";
import { SessionUser } from "../auth/session-user";
import { CreateScenarioSecretDto, RotateScenarioSecretDto } from "./scenario-secrets.dto";
import { ScenarioSecretsService } from "./scenario-secrets.service";

@ApiTags("scenario-secrets")
@ApiCookieAuth()
@UseGuards(SessionGuard)
@Controller("scenario-secrets")
export class ScenarioSecretsController {
  constructor(private readonly secrets: ScenarioSecretsService) {}

  @Get()
  @ApiOperation({ summary: "List credential metadata without exposing secret values" })
  list(@CurrentUser() user: SessionUser) { return this.secrets.list(user); }

  @Post()
  @ApiOperation({ summary: "Create an encrypted API credential or Slack webhook" })
  create(@CurrentUser() user: SessionUser, @Body() input: CreateScenarioSecretDto) { return this.secrets.create(user, input); }

  @Patch(":id")
  @ApiOperation({ summary: "Rotate an encrypted credential" })
  rotate(@CurrentUser() user: SessionUser, @Param("id") id: string, @Body() input: RotateScenarioSecretDto) { return this.secrets.rotate(user, id, input); }

  @Delete(":id")
  @ApiOperation({ summary: "Delete an unused credential" })
  remove(@CurrentUser() user: SessionUser, @Param("id") id: string) { return this.secrets.remove(user, id); }
}
